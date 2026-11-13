'use strict';
/*
 * Mail Catcher: a tiny SMTP server on 127.0.0.1 that KEEPS every email a project sends.
 * Nothing is ever relayed to a real mailbox, so a test OTP / password reset / voucher can never
 * reach a real student or customer by mistake.
 *
 *  - Projects started by PHP Station send their mail here without any .env change: the dev-tools
 *    prepend (lib/devtools.js) sets MAIL_MAILER/MAIL_HOST/MAIL_PORT for the request (process env wins
 *    over .env in Laravel) and SMTP/smtp_port for PHP's mail() on Windows.
 *  - The SMTP user name tells which project sent a message (phpstation-<projectId>).
 *  - Messages are stored as .eml files in <data>\mail (newest MAX_KEEP kept) plus a small index.
 *  - Cross-protocol guard: a connection that speaks HTTP (a web page posting to this port) is closed.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');

const MAX_MESSAGE = 25 * 1024 * 1024;
const MAX_KEEP = 500;
const MAX_CONN = 50;
const MAX_RCPT = 500;
const ID_RE = /^[a-z0-9]{6,14}-[a-f0-9]{8}$/;
const HTTP_RE = /^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH|CONNECT|TRACE)\s|\sHTTP\/\d/i;

// ------------------------------------------------------------------------------------------ MIME (PURE)

function decodeCharset(buf, charset) {
  let cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (cs === 'us-ascii' || cs === 'ascii' || cs === 'ansi_x3.4-1968') cs = 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

/** Quoted-printable -> bytes. PURE. */
function decodeQP(text) {
  const s = String(text).replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; } else {
      const code = s.charCodeAt(i);
      if (code < 256) out.push(code); else for (const b of Buffer.from(c, 'utf8')) out.push(b);
    }
  }
  return Buffer.from(out);
}

/** RFC 2047 encoded words (=?utf-8?B?...?= / =?iso-8859-1?Q?...?=) -> text. PURE. */
function decodeWords(value) {
  const s = String(value || '');
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  // whitespace between two encoded words is not part of the text
  return s.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
    .replace(re, (m, cs, enc, txt) => {
      try {
        const charset = cs.split('*')[0];
        const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : decodeQP(txt.replace(/_/g, ' '));
        return decodeCharset(buf, charset);
      } catch { return m; }
    });
}

/** Header block text -> [{name, value}] (unfolded, values decoded). PURE. */
function parseHeaders(text) {
  const out = [];
  const unfolded = String(text || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

function headerOf(headers, name) {
  const n = name.toLowerCase();
  const h = headers.find((x) => x.name.toLowerCase() === n);
  return h ? h.value : null;
}

/** "text/html; charset=utf-8; name*=utf-8''r%C3%A9.pdf" -> {value, params}. Handles quotes and RFC 2231. PURE. */
function parseParams(value) {
  const s = String(value || '');
  const parts = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') q = !q;
    if (c === ';' && !q) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const params = {};
  const cont = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(k);
    if (m) {
      // RFC 2231: name*=charset''%XX  /  name*0*=...  name*1*=...
      k = m[1];
      const enc = !!m[3] || m[2] === undefined;
      (cont[k] = cont[k] || []).push({ n: m[2] === undefined ? 0 : Number(m[2]), v, enc });
      continue;
    }
    params[k] = decodeWords(v);
  }
  for (const [k, list] of Object.entries(cont)) {
    list.sort((a, b) => a.n - b.n);
    let charset = 'utf-8';
    const bytes = [];
    list.forEach((x, idx) => {
      let v = x.v;
      if (x.enc && idx === 0) {
        const mm = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (mm) { charset = mm[1] || 'utf-8'; v = mm[2]; }
      }
      if (x.enc) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(...Buffer.from(v[i], 'utf8'));
        }
      } else bytes.push(...Buffer.from(v, 'utf8'));
    });
    params[k] = decodeCharset(Buffer.from(bytes), charset);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/** "A <a@x>, \"B, Jr\" <b@y>, c@z" -> [{name, address}]. PURE. */
function parseAddresses(value) {
  const s = decodeWords(String(value || ''));
  const items = [];
  let cur = '';
  let q = false;
  let angle = 0;
  for (const c of s) {
    if (c === '"') q = !q;
    else if (!q && c === '<') angle++;
    else if (!q && c === '>') angle = Math.max(0, angle - 1);
    if (c === ',' && !q && !angle) { items.push(cur); cur = ''; } else cur += c;
  }
  items.push(cur);
  const out = [];
  for (const raw of items) {
    const x = raw.trim();
    if (!x) continue;
    const m = /^(.*)<([^<>]*)>\s*$/.exec(x);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'), address: m[2].trim() });
    else out.push({ name: '', address: x.replace(/^"|"$/g, '') });
  }
  return out;
}

function splitHead(buf) {
  const s = buf.toString('latin1');
  let i = s.indexOf('\r\n\r\n');
  let sep = 4;
  const j = s.indexOf('\n\n');
  if (j >= 0 && (i < 0 || j < i)) { i = j; sep = 2; }
  if (i < 0) return { head: buf, body: Buffer.alloc(0) };
  return { head: buf.subarray(0, i), body: buf.subarray(i + sep) };
}

function headText(buf) {
  // headers are 7-bit by the RFCs; SMTPUTF8 senders put raw UTF-8 in them
  const u = buf.toString('utf8');
  return u.includes('�') ? buf.toString('latin1') : u;
}

function decodeBody(buf, cte) {
  const e = String(cte || '').trim().toLowerCase();
  if (e === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') return decodeQP(buf.toString('latin1'));
  return buf;
}

/** Splits a multipart body into its part buffers. PURE. */
function splitMultipart(body, boundary) {
  const s = body.toString('latin1');
  const delim = '--' + boundary;
  const parts = [];
  let pos = 0;
  // the first delimiter may be the very first line
  let start = s.startsWith(delim) ? 0 : s.indexOf('\n' + delim);
  if (start < 0) return parts;
  if (start > 0) start += 1;
  pos = start;
  for (;;) {
    const lineEnd = s.indexOf('\n', pos);
    if (lineEnd < 0) break;
    const line = s.slice(pos, lineEnd).replace(/\r$/, '');
    if (line.startsWith(delim + '--')) break;
    const next = s.indexOf('\n' + delim, lineEnd);
    const end = next < 0 ? s.length : next;
    let chunk = s.slice(lineEnd + 1, end);
    if (chunk.endsWith('\r')) chunk = chunk.slice(0, -1);
    parts.push(Buffer.from(chunk, 'latin1'));
    if (next < 0) break;
    pos = next + 1;
  }
  return parts;
}

/** One MIME entity -> leaves [{type, charset, disposition, filename, cid, body}]. PURE. */
function collectLeaves(buf, depth = 0, out = []) {
  const { head, body } = splitHead(buf);
  const headers = parseHeaders(headText(head));
  const ct = parseParams(headerOf(headers, 'content-type') || 'text/plain; charset=us-ascii');
  const cd = parseParams(headerOf(headers, 'content-disposition') || '');
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 20) {
    for (const part of splitMultipart(body, ct.params.boundary)) collectLeaves(part, depth + 1, out);
    return out;
  }
  const cid = (headerOf(headers, 'content-id') || '').trim().replace(/^<|>$/g, '');
  out.push({
    type: ct.value || 'text/plain', charset: ct.params.charset || null,
    disposition: cd.value || null, filename: cd.params.filename || ct.params.name || null,
    cid: cid || null, body: decodeBody(body, headerOf(headers, 'content-transfer-encoding')),
  });
  return out;
}

/** Raw message -> {headers, subject, from, to, cc, replyTo, date, messageId, text, html, attachments[]}. PURE. */
function parseMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const { head } = splitHead(buf);
  const headers = parseHeaders(headText(head)).map((x) => ({ name: x.name, value: decodeWords(x.value) }));
  const rawHeaders = parseHeaders(headText(head));
  const leaves = collectLeaves(buf);
  let text = null;
  let html = null;
  const attachments = [];
  for (const l of leaves) {
    const isAtt = l.disposition === 'attachment' || (l.filename && l.disposition !== 'inline' && !/^text\/(plain|html)$/.test(l.type));
    if (!isAtt && l.type === 'text/html' && html == null) { html = decodeCharset(l.body, l.charset); continue; }
    if (!isAtt && l.type === 'text/plain' && text == null && !l.filename) { text = decodeCharset(l.body, l.charset); continue; }
    attachments.push({
      index: attachments.length, filename: l.filename || (l.cid ? `${l.cid}` : `part-${attachments.length + 1}`),
      type: l.type, size: l.body.length, cid: l.cid, inline: l.disposition === 'inline' || (!!l.cid && l.disposition !== 'attachment'), body: l.body,
    });
  }
  const one = (n) => headerOf(rawHeaders, n);
  return {
    headers,
    subject: decodeWords(one('subject') || ''),
    from: parseAddresses(one('from') || ''),
    to: parseAddresses(one('to') || ''),
    cc: parseAddresses(one('cc') || ''),
    replyTo: parseAddresses(one('reply-to') || ''),
    date: one('date'),
    messageId: one('message-id'),
    text, html, attachments,
  };
}

/** html with cid: references replaced by data: URLs of the inline parts (each at most 5 MB). PURE. */
function inlineCids(html, attachments) {
  const map = new Map();
  for (const a of attachments) if (a.cid && a.size <= 5 * 1024 * 1024) map.set(a.cid.toLowerCase(), a);
  return String(html || '').replace(/cid:([^"'\s)>]+)/gi, (m, id) => {
    const a = map.get(decodeURIComponent(id).toLowerCase());
    return a ? `data:${a.type.replace(/[^\w.+/-]/g, '')};base64,${a.body.toString('base64')}` : m;
  });
}

// ------------------------------------------------------------------------------------------ SMTP session (PURE state machine)

/**
 * SMTP command handler. feed(line) -> {reply, close?, startData?}. The DATA content itself is
 * collected by the server (it is not line based); finishData() resets the transaction.
 */
function createSession(hostName = 'phpstation') {
  const s = { helo: null, from: null, rcpt: [], user: null, auth: null, first: true };
  const reset = () => { s.from = null; s.rcpt = []; };
  return {
    state: s,
    greeting: `220 ${hostName} ESMTP PHP Station Mail Catcher`,
    feed(line) {
      const first = s.first;
      s.first = false;
      if (first && HTTP_RE.test(line)) return { reply: null, close: true };
      if (s.auth) {
        const a = s.auth;
        if (line === '*') { s.auth = null; return { reply: '501 5.7.0 Authentication cancelled' }; }
        let dec = '';
        try { dec = Buffer.from(line.trim(), 'base64').toString('utf8'); } catch { dec = ''; }
        if (a.kind === 'plain') { s.user = dec.split('\0')[1] || dec.split('\0')[0] || ''; s.auth = null; return { reply: '235 2.7.0 Authentication successful' }; }
        if (a.step === 'user') { s.user = dec; a.step = 'pass'; return { reply: '334 UGFzc3dvcmQ6' }; }
        s.auth = null;
        return { reply: '235 2.7.0 Authentication successful' };
      }
      const m = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(line.trim());
      if (!m) return { reply: '500 5.5.2 Syntax error' };
      const cmd = m[1].toUpperCase();
      const arg = (m[2] || '').trim();
      switch (cmd) {
        case 'EHLO':
          s.helo = arg; reset();
          return { reply: `250-${hostName}\r\n250-SIZE ${MAX_MESSAGE}\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250-AUTH PLAIN LOGIN\r\n250 HELP` };
        case 'HELO':
          s.helo = arg; reset();
          return { reply: `250 ${hostName}` };
        case 'AUTH': {
          const [mech, initial] = arg.split(/\s+/);
          const mu = String(mech || '').toUpperCase();
          if (mu === 'PLAIN') {
            if (initial && initial !== '=') {
              const dec = Buffer.from(initial, 'base64').toString('utf8');
              s.user = dec.split('\0')[1] || dec.split('\0')[0] || '';
              return { reply: '235 2.7.0 Authentication successful' };
            }
            s.auth = { kind: 'plain' };
            return { reply: '334 ' };
          }
          if (mu === 'LOGIN') {
            if (initial) { s.user = Buffer.from(initial, 'base64').toString('utf8'); s.auth = { kind: 'login', step: 'pass' }; return { reply: '334 UGFzc3dvcmQ6' }; }
            s.auth = { kind: 'login', step: 'user' };
            return { reply: '334 VXNlcm5hbWU6' };
          }
          return { reply: '504 5.5.4 Unrecognized authentication type' };
        }
        case 'MAIL': {
          const mm = /^FROM:\s*<([^>]*)>/i.exec(arg) || /^FROM:\s*(\S+)/i.exec(arg);
          if (!mm) return { reply: '501 5.5.4 Syntax: MAIL FROM:<address>' };
          reset();
          s.from = mm[1];
          return { reply: '250 2.1.0 Ok' };
        }
        case 'RCPT': {
          const mm = /^TO:\s*<([^>]*)>/i.exec(arg) || /^TO:\s*(\S+)/i.exec(arg);
          if (!mm) return { reply: '501 5.5.4 Syntax: RCPT TO:<address>' };
          if (s.from == null) return { reply: '503 5.5.1 Need MAIL first' };
          if (s.rcpt.length >= MAX_RCPT) return { reply: '452 4.5.3 Too many recipients' };
          s.rcpt.push(mm[1]);
          return { reply: '250 2.1.5 Ok' };
        }
        case 'DATA':
          if (!s.rcpt.length) return { reply: '503 5.5.1 Need RCPT first' };
          return { reply: '354 End data with <CR><LF>.<CR><LF>', startData: true };
        case 'RSET': reset(); return { reply: '250 2.0.0 Ok' };
        case 'NOOP': return { reply: '250 2.0.0 Ok' };
        case 'VRFY': return { reply: '252 2.1.5 Cannot verify, but will accept' };
        case 'STARTTLS': return { reply: '454 4.7.0 TLS not available (local catcher)' };
        case 'QUIT': return { reply: '221 2.0.0 Bye', close: true };
        case 'HELP': return { reply: '214 PHP Station Mail Catcher' };
        default: return { reply: '502 5.5.2 Command not recognized' };
      }
    },
    finishData() { const env = { from: s.from, rcpt: s.rcpt.slice(), user: s.user, helo: s.helo }; reset(); return env; },
  };
}

/** DATA content (without the final ".") with dot-stuffing removed. PURE. */
function unstuff(buf) {
  const s = buf.toString('latin1');
  return Buffer.from(s.replace(/(^|\n)\.\./g, '$1.'), 'latin1');
}

/** Index of the end-of-data marker ("\r\n.\r\n" or "\n.\n" style) in buf, searching from `from`. PURE. */
function findDataEnd(buf, from = 0) {
  // the data starts right after the DATA line, so a "." alone on the very first line ends it too
  if (from === 0 && (buf.subarray(0, 3).toString('latin1') === '.\r\n' || buf.subarray(0, 2).toString('latin1') === '.\n')) {
    return { at: 0, len: buf[1] === 0x0d ? 3 : 2 };
  }
  for (let i = Math.max(0, from); i < buf.length - 2; i++) {
    if (buf[i] !== 0x0a || buf[i + 1] !== 0x2e) continue;
    if (buf[i + 2] === 0x0a) return { at: i + 1, len: 2 };
    if (buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return { at: i + 1, len: 3 };
  }
  return null;
}

// ------------------------------------------------------------------------------------------ store

function mailDir(ctx) { return path.join(ctx.dataDir, 'mail'); }
function indexFile(ctx) { return path.join(mailDir(ctx), 'index.json'); }

function loadIndex(ctx) {
  if (!ctx.mailIndex) {
    const raw = util.readJson(indexFile(ctx), null);
    ctx.mailIndex = Array.isArray(raw) ? raw.filter((x) => x && ID_RE.test(String(x.id))) : [];
  }
  return ctx.mailIndex;
}

function saveIndex(ctx) {
  util.ensureDir(mailDir(ctx));
  util.writeJsonAtomic(indexFile(ctx), loadIndex(ctx));
}

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Project id from the SMTP user name "phpstation-<id>" (only ids that exist). */
function projectFromUser(ctx, user) {
  const m = /^phpstation-([A-Za-z0-9_-]{1,64})$/.exec(String(user || ''));
  if (!m) return null;
  const p = (ctx.store.data.projects || []).find((x) => x.id === m[1]);
  return p ? p.id : null;
}

/** Stores one received message; returns its index entry. */
function store(ctx, raw, env) {
  const list = loadIndex(ctx);
  const id = newId();
  util.ensureDir(mailDir(ctx));
  fs.writeFileSync(path.join(mailDir(ctx), `${id}.eml`), raw);
  let msg;
  try { msg = parseMessage(raw); } catch { msg = { subject: '', from: [], to: [], cc: [], attachments: [], html: null, text: null }; }
  const listed = new Set([...msg.to, ...msg.cc].map((a) => a.address.toLowerCase()));
  const entry = {
    id, at: util.nowIso(), size: raw.length,
    subject: util.cleanText(msg.subject || '', 300),
    from: msg.from[0] ? msg.from[0] : (env.from ? { name: '', address: env.from } : null),
    to: msg.to.slice(0, 20), cc: msg.cc.slice(0, 20),
    bcc: env.rcpt.filter((r) => !listed.has(String(r).toLowerCase())).slice(0, 20),
    envelope: { from: env.from, rcpt: env.rcpt.slice(0, 50) },
    project: projectFromUser(ctx, env.user),
    html: msg.html != null, attachments: msg.attachments.filter((a) => !a.inline).length,
    preview: util.cleanText(String(msg.text || stripHtml(msg.html || '')).replace(/\s+/g, ' ').trim(), 160),
    read: false,
  };
  list.unshift(entry);
  while (list.length > MAX_KEEP) {
    const old = list.pop();
    try { fs.unlinkSync(path.join(mailDir(ctx), `${old.id}.eml`)); } catch { /* already gone */ }
  }
  saveIndex(ctx);
  ctx.log(`mail: caught "${entry.subject}" (${entry.size} bytes${entry.project ? `, project ${entry.project}` : ''})`);
  return entry;
}

function stripHtml(html) {
  return String(html || '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function getEntry(ctx, id) {
  if (!ID_RE.test(String(id || ''))) throw new util.AppError('NOT_FOUND', 'mail not found', 404);
  const e = loadIndex(ctx).find((x) => x.id === id);
  if (!e) throw new util.AppError('NOT_FOUND', 'mail not found', 404);
  return e;
}

function readRaw(ctx, id) {
  getEntry(ctx, id);
  try { return fs.readFileSync(path.join(mailDir(ctx), `${id}.eml`)); } catch { throw new util.AppError('NOT_FOUND', 'mail file missing', 404); }
}

/** Key for the per-message view URLs (iframes cannot send the API token header). */
function viewKey(ctx, id) {
  return crypto.createHmac('sha256', ctx.token).update(`mail:${id}`).digest('hex').slice(0, 32);
}

function keyOk(ctx, id, given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(viewKey(ctx, id));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------------------------------ API helpers

function matchesQ(e, q) {
  if (!q) return true;
  const hay = [e.subject, e.preview, e.from && e.from.address, e.from && e.from.name,
    ...(e.to || []).map((a) => `${a.name} ${a.address}`), ...(e.envelope ? e.envelope.rcpt : [])].join(' ').toLowerCase();
  return hay.includes(String(q).toLowerCase());
}

function list(ctx, { project = null, q = null, limit = 200 } = {}) {
  const all = loadIndex(ctx);
  const items = all.filter((e) => (!project || e.project === project) && matchesQ(e, q)).slice(0, Math.min(500, Math.max(1, Number(limit) || 200)));
  return { items, total: all.length, unread: all.filter((e) => !e.read).length, status: status(ctx) };
}

function detail(ctx, id) {
  const e = getEntry(ctx, id);
  const msg = parseMessage(readRaw(ctx, id));
  if (!e.read) { e.read = true; saveIndex(ctx); }
  const k = viewKey(ctx, id);
  return {
    mail: Object.assign({}, e, { read: true }),
    headers: msg.headers.slice(0, 200).map((x) => ({ name: x.name, value: String(x.value).slice(0, 2000) })),
    text: msg.text != null ? msg.text.slice(0, 500000) : null,
    htmlUrl: msg.html != null ? `/mail-view/${id}?k=${k}` : null,
    rawUrl: `/mail-view/${id}/raw?k=${k}`,
    date: msg.date, replyTo: msg.replyTo,
    attachments: msg.attachments.map((a) => ({ index: a.index, filename: a.filename, type: a.type, size: a.size, inline: a.inline, url: `/mail-view/${id}/att/${a.index}?k=${k}` })),
  };
}

function remove(ctx, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).filter((x) => ID_RE.test(String(x))));
  const all = loadIndex(ctx);
  let n = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (!want.has(all[i].id)) continue;
    try { fs.unlinkSync(path.join(mailDir(ctx), `${all[i].id}.eml`)); } catch { /* gone */ }
    all.splice(i, 1);
    n++;
  }
  saveIndex(ctx);
  return { removed: n };
}

function clear(ctx, project = null) {
  return remove(ctx, loadIndex(ctx).filter((e) => !project || e.project === project).map((e) => e.id));
}

function markAllRead(ctx) {
  for (const e of loadIndex(ctx)) e.read = true;
  saveIndex(ctx);
  return {};
}

const SAFE_HTML_CSP = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:; media-src data: http: https:; sandbox allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/** GET /mail-view/<id>[/raw|/att/<n>]?k=<key> (no API token: the key is bound to the message). */
function serveView(ctx, pathname, query, res) {
  const m = /^\/mail-view\/([a-z0-9-]+)(?:\/(raw|att)(?:\/(\d{1,4}))?)?$/.exec(pathname);
  const send = (status, headers, body) => {
    res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }, headers));
    res.end(body);
  };
  if (!m || !ID_RE.test(m[1]) || !keyOk(ctx, m[1], query.get('k'))) {
    send(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" }, 'Not found');
    return;
  }
  let raw;
  try { raw = readRaw(ctx, m[1]); } catch { send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found'); return; }
  const safeName = (n) => String(n || 'file').replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';
  if (m[2] === 'raw') {
    send(200, { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${m[1]}.eml"`, 'Content-Security-Policy': "default-src 'none'" }, raw);
    return;
  }
  const msg = parseMessage(raw);
  if (m[2] === 'att') {
    const a = msg.attachments[Number(m[3])];
    if (!a) { send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found'); return; }
    send(200, {
      'Content-Type': 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `attachment; filename="${safeName(a.filename)}"; filename*=UTF-8''${encodeURIComponent(a.filename || 'file')}`,
    }, a.body);
    return;
  }
  const html = msg.html != null ? inlineCids(msg.html, msg.attachments) : `<pre>${String(msg.text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer"><style>html,body{margin:0}</style></head><body>${html}</body></html>`;
  send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SAFE_HTML_CSP, 'X-Frame-Options': 'SAMEORIGIN' }, doc);
}

// ------------------------------------------------------------------------------------------ server

function portOf(settings) {
  const n = Number(settings && settings.mailPort);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 1025;
}

function status(ctx) {
  const st = ctx.mail || {};
  const all = loadIndex(ctx);
  return {
    enabled: ctx.store.data.settings.mailCatcher !== false,
    listening: !!st.listening, port: st.port || portOf(ctx.store.data.settings), error: st.error || null,
    count: all.length, unread: all.filter((e) => !e.read).length,
    latest: all[0] ? { id: all[0].id, subject: all[0].subject, at: all[0].at } : null,
  };
}

function handleSocket(ctx, sock) {
  const session = createSession();
  let buf = Buffer.alloc(0);
  let data = null; // Buffer while in DATA mode
  let scanFrom = 0;
  let tooBig = false;
  sock.setTimeout(120000, () => sock.destroy());
  sock.on('error', () => {});
  const write = (txt) => { try { sock.write(`${txt}\r\n`); } catch { /* closed */ } };
  write(session.greeting);
  const pump = () => {
    for (;;) {
      if (data) {
        const end = findDataEnd(data, scanFrom);
        if (!end) {
          scanFrom = Math.max(0, data.length - 4);
          if (data.length > MAX_MESSAGE * 2) { sock.destroy(); return; }
          if (data.length > MAX_MESSAGE) tooBig = true;
          return;
        }
        const content = unstuff(data.subarray(0, end.at));
        const rest = data.subarray(end.at + end.len);
        data = null;
        scanFrom = 0;
        const env = session.finishData();
        if (tooBig) { tooBig = false; write('552 5.3.4 Message too big'); } else {
          try {
            const e = store(ctx, content, env);
            write(`250 2.0.0 Ok: queued as ${e.id}`);
          } catch (err) {
            ctx.log(`mail: store failed: ${err.message}`);
            write('451 4.3.0 Could not store the message');
          }
        }
        buf = Buffer.concat([rest, buf]);
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 8192) sock.destroy();
        return;
      }
      const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
      buf = buf.subarray(nl + 1);
      const r = session.feed(line);
      if (r.reply) write(r.reply);
      if (r.close) { sock.end(); return; }
      if (r.startData) { data = buf; buf = Buffer.alloc(0); scanFrom = 0; }
    }
  };
  sock.on('data', (chunk) => {
    if (data) data = Buffer.concat([data, chunk]); else buf = Buffer.concat([buf, chunk]);
    pump();
  });
}

/** Starts (or restarts on a port change) / stops the catcher to match the settings. Never throws. */
function sync(ctx, onChange) {
  const want = ctx.store.data.settings.mailCatcher !== false;
  const port = portOf(ctx.store.data.settings);
  const st = ctx.mail || (ctx.mail = { server: null, listening: false, port: null, error: null });
  if (st.server && (!want || st.port !== port)) {
    try { st.server.close(); } catch { /* ignore */ }
    for (const s of st.sockets || []) try { s.destroy(); } catch { /* ignore */ }
    st.server = null; st.listening = false; st.error = null;
  }
  if (!want || st.server) { if (onChange) onChange(); return; }
  const server = net.createServer((sock) => {
    if (st.sockets.size >= MAX_CONN) { sock.destroy(); return; }
    st.sockets.add(sock);
    sock.on('close', () => st.sockets.delete(sock));
    handleSocket(ctx, sock);
  });
  st.server = server;
  st.port = port;
  st.sockets = new Set();
  server.on('error', (e) => {
    st.listening = false;
    st.error = e.code === 'EADDRINUSE' ? 'PORT_BUSY' : (e.code || 'ERROR');
    st.server = null;
    ctx.log(`mail catcher: cannot listen on 127.0.0.1:${port} (${e.code || e.message})`);
    if (onChange) onChange();
  });
  server.listen(port, '127.0.0.1', () => {
    st.listening = true;
    st.error = null;
    ctx.log(`mail catcher listening on 127.0.0.1:${port}`);
    if (onChange) onChange();
  });
}

function stop(ctx) {
  const st = ctx.mail;
  if (st && st.server) { try { st.server.close(); } catch { /* ignore */ } st.server = null; st.listening = false; }
}

module.exports = {
  MAX_MESSAGE, MAX_KEEP, ID_RE,
  decodeQP, decodeWords, parseHeaders, parseParams, parseAddresses, splitMultipart, parseMessage, inlineCids,
  createSession, unstuff, findDataEnd, portOf, projectFromUser,
  sync, stop, status, list, detail, remove, clear, markAllRead, store, viewKey, keyOk, serveView, loadIndex,
};
