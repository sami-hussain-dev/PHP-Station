'use strict';
/*
 * Dumps: dump() / dd() of projects started by PHP Station show up in the panel (Inbox -> Dumps)
 * instead of breaking the page layout.
 *
 *  - The dev-tools prepend sets VAR_DUMPER_FORMAT=server for web requests (lib/devtools.js), so
 *    Symfony's ServerDumper sends each dump as one base64 line to this TCP server (127.0.0.1 only).
 *    When the panel is closed, the dumper falls back to the page by itself.
 *  - Decoding needs VarDumper's classes: a small PHP helper (tools\dumpdecode.php) runs with the
 *    project's own PHP and only the project's vendor\symfony\var-dumper classes. One helper per
 *    project, kept alive while used (idle ones end after IDLE_MS).
 *  - Cross-protocol guard: a connection whose first line is not base64 (an HTTP request from a web
 *    page) is closed before anything is decoded.
 *  - Dumps live in memory only (newest MAX_KEEP); they are gone when the panel restarts.
 */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const util = require('./util');
const projects = require('./projects');
const runtimes = require('./runtimes');

const MAX_KEEP = 300;
const MAX_LINE = 32 * 1024 * 1024;
const IDLE_MS = 5 * 60 * 1000;
const DECODE_TIMEOUT_MS = 15000;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Source file of a dump from the raw payload (the context is serialized after the data). PURE. */
function sourceFileOf(b64) {
  let s;
  try { s = Buffer.from(String(b64), 'base64').toString('latin1'); } catch { return null; }
  const i = s.lastIndexOf('s:6:"source";a:');
  if (i < 0) return null;
  const m = /s:4:"file";s:(\d+):"/.exec(s.slice(i));
  if (!m) return null;
  const start = i + m.index + m[0].length;
  const raw = Buffer.from(s.slice(start, start + Number(m[1])), 'latin1').toString('utf8');
  return raw || null;
}

/** Registered project that contains `file` (longest path wins). PURE over the list. */
function projectForFile(list, file) {
  if (!file) return null;
  const f = String(file).replace(/\//g, '\\').toLowerCase();
  let best = null;
  for (const p of list || []) {
    const root = String(p.path || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (!root || !(f === root || f.startsWith(`${root}\\`))) continue;
    if (!best || root.length > best.root.length) best = { p, root };
  }
  return best ? best.p : null;
}

function portOf(settings) {
  const n = Number(settings && settings.dumpPort);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 9912;
}

function state(ctx) {
  if (!ctx.dumps) ctx.dumps = { server: null, listening: false, port: null, error: null, items: [], seq: 0, seenSeq: 0, decoders: new Map(), sockets: new Set() };
  return ctx.dumps;
}

function hasVarDumper(dir) {
  return util.existsDir(path.join(dir, 'vendor', 'symfony', 'var-dumper', 'Cloner'));
}

/** {proj, vendor, php} used to decode a payload (the sending project, else any project with VarDumper). */
function decoderTarget(ctx, file) {
  const list = ctx.store.data.projects || [];
  const own = projectForFile(list, file);
  const pick = own && hasVarDumper(own.path) ? own : list.find((p) => hasVarDumper(p.path)) || null;
  if (!pick) return { proj: own, error: 'NO_VAR_DUMPER' };
  const php = projects.resolveProjectPhp(ctx, pick);
  if (!php) return { proj: own, error: 'NO_PHP' };
  return { proj: own, key: pick.id, vendor: path.join(pick.path, 'vendor'), php };
}

function decoder(ctx, t) {
  const st = state(ctx);
  let d = st.decoders.get(t.key);
  if (d && d.alive) { d.lastUsed = Date.now(); return d; }
  const inv = runtimes.phpInvocation(t.php);
  const script = path.join(ctx.toolDir || path.resolve(__dirname, '..'), 'tools', 'dumpdecode.php');
  const child = spawn(inv.file, [...inv.preArgs, '-d', 'memory_limit=512M', '-d', 'auto_prepend_file=', script, t.vendor], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  d = { child, alive: true, pending: new Map(), buf: '', lastUsed: Date.now(), err: '' };
  st.decoders.set(t.key, d);
  const fail = (msg) => {
    d.alive = false;
    for (const [, cb] of d.pending) cb({ ok: false, error: msg });
    d.pending.clear();
    if (st.decoders.get(t.key) === d) st.decoders.delete(t.key);
  };
  child.on('error', (e) => fail(e.message));
  child.on('close', () => fail(d.err.trim().split('\n').slice(-2).join(' ') || 'decoder ended'));
  child.stderr.on('data', (x) => { d.err = (d.err + x.toString('utf8')).slice(-4000); });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (x) => {
    d.buf += x.toString('utf8');
    let nl;
    while ((nl = d.buf.indexOf('\n')) >= 0) {
      const line = d.buf.slice(0, nl);
      d.buf = d.buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.fatal) { fail(msg.fatal); return; }
      const cb = msg.id != null ? d.pending.get(msg.id) : null;
      if (cb) { d.pending.delete(msg.id); cb(msg); }
    }
  });
  return d;
}

function decode(ctx, t, payload) {
  return new Promise((resolve) => {
    let d;
    try { d = decoder(ctx, t); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    const st = state(ctx);
    st.reqSeq = (st.reqSeq || 0) + 1;
    const id = st.reqSeq;
    const timer = setTimeout(() => { d.pending.delete(id); resolve({ ok: false, error: 'timeout' }); }, DECODE_TIMEOUT_MS);
    d.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    try { d.child.stdin.write(`${JSON.stringify({ id, payload })}\n`); } catch (e) { d.pending.delete(id); clearTimeout(timer); resolve({ ok: false, error: e.message }); }
  });
}

/** One received payload line -> stored dump item. */
async function receive(ctx, b64) {
  const st = state(ctx);
  const file = sourceFileOf(b64);
  const t = decoderTarget(ctx, file);
  const r = t.error ? { ok: false, error: t.error } : await decode(ctx, t, b64);
  const c = (r && r.context) || {};
  const src = c.source || {};
  const req = c.request || {};
  const item = {
    id: ++st.seq, at: c.timestamp ? new Date(Number(c.timestamp) * 1000).toISOString() : util.nowIso(),
    project: t.proj ? t.proj.id : null,
    file: src.file || file || null, line: Number.isInteger(src.line) ? src.line : null, name: src.name || null,
    uri: req.uri || null, method: req.method || null, cli: c.cli ? c.cli.command_line || null : null,
    label: r.label || null, ok: !!r.ok, error: r.ok ? null : String(r.error || 'decode failed').slice(0, 300),
    tree: r.ok ? r.tree : null, truncated: !!r.truncated, text: r.ok ? String(r.text || '') : null,
  };
  st.items.unshift(item);
  if (st.items.length > MAX_KEEP) st.items.length = MAX_KEEP;
  return item;
}

function handleSocket(ctx, sock) {
  let buf = '';
  let first = true;
  let chain = Promise.resolve();
  sock.setTimeout(10 * 60 * 1000, () => sock.destroy());
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    if (first && buf.length >= 16 && !B64_RE.test(buf.slice(0, Math.min(buf.length, 64)).replace(/\r?\n[\s\S]*$/, ''))) { sock.destroy(); return; }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (!B64_RE.test(line)) { sock.destroy(); return; }
      first = false;
      chain = chain.then(() => receive(ctx, line)).catch((e) => ctx.log(`dumps: ${e.message}`));
    }
    if (buf.length > MAX_LINE) sock.destroy();
  });
}

function sync(ctx, onChange) {
  const want = ctx.store.data.settings.catchDumps !== false;
  const port = portOf(ctx.store.data.settings);
  const st = state(ctx);
  if (st.server && (!want || st.port !== port)) {
    try { st.server.close(); } catch { /* ignore */ }
    for (const s of st.sockets) try { s.destroy(); } catch { /* ignore */ }
    st.server = null; st.listening = false; st.error = null;
  }
  if (!want || st.server) { if (onChange) onChange(); return; }
  const server = net.createServer((sock) => {
    if (st.sockets.size >= 100) { sock.destroy(); return; }
    st.sockets.add(sock);
    sock.on('close', () => st.sockets.delete(sock));
    handleSocket(ctx, sock);
  });
  st.server = server;
  st.port = port;
  server.on('error', (e) => {
    st.listening = false;
    st.error = e.code === 'EADDRINUSE' ? 'PORT_BUSY' : (e.code || 'ERROR');
    st.server = null;
    ctx.log(`dump server: cannot listen on 127.0.0.1:${port} (${e.code || e.message})`);
    if (onChange) onChange();
  });
  server.listen(port, '127.0.0.1', () => {
    st.listening = true;
    st.error = null;
    ctx.log(`dump server listening on 127.0.0.1:${port}`);
    if (onChange) onChange();
  });
  if (!st.idleTimer) {
    st.idleTimer = setInterval(() => {
      for (const [k, d] of st.decoders) {
        if (Date.now() - d.lastUsed > IDLE_MS && !d.pending.size) { try { d.child.kill(); } catch { /* ignore */ } st.decoders.delete(k); }
      }
    }, 60000);
    if (st.idleTimer.unref) st.idleTimer.unref();
  }
}

function stop(ctx) {
  const st = state(ctx);
  if (st.server) { try { st.server.close(); } catch { /* ignore */ } st.server = null; st.listening = false; }
  for (const [, d] of st.decoders) try { d.child.kill(); } catch { /* ignore */ }
  st.decoders.clear();
}

function status(ctx) {
  const st = state(ctx);
  return {
    enabled: ctx.store.data.settings.catchDumps !== false, listening: st.listening, port: st.port || portOf(ctx.store.data.settings),
    error: st.error, count: st.items.length, unread: st.items.filter((x) => x.id > st.seenSeq).length, newest: st.items[0] ? st.items[0].id : 0,
  };
}

function list(ctx, { project = null, after = 0 } = {}) {
  const st = state(ctx);
  const items = st.items.filter((x) => (!project || x.project === project) && x.id > (Number(after) || 0));
  return { items, status: status(ctx) };
}

function markSeen(ctx) {
  const st = state(ctx);
  st.seenSeq = st.items[0] ? st.items[0].id : st.seenSeq;
  return {};
}

function clear(ctx, project = null) {
  const st = state(ctx);
  const before = st.items.length;
  st.items = project ? st.items.filter((x) => x.project !== project) : [];
  return { removed: before - st.items.length };
}

module.exports = { sourceFileOf, projectForFile, portOf, sync, stop, status, list, markSeen, clear, receive, MAX_KEEP };
