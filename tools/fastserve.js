#!/usr/bin/env node
'use strict';
/*
 * PHP Station fast server for one project.
 *
 * On Windows `php -S` handles ONE request at a time: while a slow page (or an AJAX / DataTables
 * call) runs, every CSS / JS / image request of the same page waits behind it. This small server
 * listens on the project's port instead and
 *   - serves existing static files from the docroot itself (never .php files, never dot-files),
 *   - passes every other request to one of N `php -S` workers on private ports (least busy first),
 *   - restarts a worker that dies.
 * The PHP side is exactly the same `php -S <docroot> <router>` as before, so the app behaves the
 * same; requests just no longer queue behind each other.
 *
 *   node tools\fastserve.js --port 8000 --docroot D:\app\public --php C:\php\php.exe
 *        [--router D:\app\server.php] [--workers 4] [--pre <base64 JSON array of php args>]
 *        [--htaccess --htrouter D:\ps\tools\htrouter.php]
 *
 * --htaccess: the docroot's .htaccess files are applied (lib/htaccess.js) before anything else:
 * access rules, redirects, rewrites, DirectoryIndex, ErrorDocument and Header lines. A rewrite to
 * a PHP script reaches the workers through tools\htrouter.php with the ORIGINAL URL (REQUEST_URI
 * stays what the browser asked for, as under Apache) and an internal header that carries the
 * script, the new query string and a per-run token; the same header from a client is dropped.
 */
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const htaccess = require('../lib/htaccess');

// ------------------------------------------------------------------------------------------ args
function parseArgs(argv) {
  const a = { port: null, docroot: null, php: null, router: null, workers: 4, pre: [], htaccess: false, htrouter: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--htaccess') { a.htaccess = true; continue; }
    if (k === '--htrouter') { a.htrouter = v; i++; continue; }
    if (k === '--port') { a.port = Number(v); i++; } else if (k === '--docroot') { a.docroot = v; i++; } else if (k === '--php') { a.php = v; i++; } else if (k === '--router') { a.router = v; i++; } else if (k === '--workers') { a.workers = Number(v); i++; } else if (k === '--pre') {
      try { const x = JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); if (Array.isArray(x)) a.pre = x.map(String); } catch { /* none */ }
      i++;
    }
  }
  a.workers = Number.isInteger(a.workers) ? Math.min(16, Math.max(1, a.workers)) : 4;
  // .htaccess needs the router that runs rewritten scripts; a project's own router (Laravel) wins
  if (a.htaccess && (a.router || !a.htrouter)) a.htaccess = false;
  if (a.htaccess) a.router = a.htrouter;
  return a;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.csv': 'text/csv; charset=utf-8', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const SCRIPT_EXT = /\.(php\d?|phtml|phar|inc)$/i;

/**
 * The static file a request maps to, or null (then PHP handles it). PURE apart from fs.statSync.
 * Refuses paths outside the docroot, PHP files and dot-files (except /.well-known/).
 */
function staticFile(docroot, rawUrl, stat = fs.statSync) {
  let p = String(rawUrl || '/').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch { return null; }
  if (!p.startsWith('/') || p.includes('\0') || p.endsWith('/')) return null;
  const segs = p.split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return null;
  if (segs.some((s) => s === '..' || (s.startsWith('.') && s !== '.well-known'))) return null;
  if (SCRIPT_EXT.test(segs[segs.length - 1])) return null;
  const root = path.resolve(docroot);
  const file = path.resolve(root, ...segs);
  if (file !== root && !file.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) return null;
  try {
    const st = stat(file);
    return st.isFile() ? { file, size: st.size, mtime: st.mtime } : null;
  } catch { return null; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function portOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

/** File system access for lib/htaccess.js: stat results for 1 s, .htaccess texts by mtime. */
function makeIo() {
  const kinds = new Map();
  const texts = new Map();
  const statOf = (p) => {
    const hit = kinds.get(p);
    const now = Date.now();
    if (hit && now - hit.at < 1000) return hit.st;
    let st = null;
    try { st = fs.statSync(p); } catch { st = null; }
    kinds.set(p, { at: now, st });
    if (kinds.size > 5000) kinds.clear();
    return st;
  };
  return {
    kind: (p) => { const st = statOf(p); return st ? (st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null) : null; },
    size: (p) => { const st = statOf(p); return st ? st.size : 0; },
    read: (p) => {
      const st = statOf(p);
      if (!st || !st.isFile()) return null;
      const hit = texts.get(p);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.text;
      let text = null;
      try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
      texts.set(p, { mtime: st.mtimeMs, size: st.size, text });
      return text;
    },
  };
}

/** Header lines of the .htaccess applied to a header map (lower-case keys). PURE. */
function applyHeaderRules(headers, rules) {
  for (const h of rules || []) {
    const k = String(h.name).toLowerCase();
    if (h.action === 'unset') delete headers[k];
    else if (h.action === 'set') headers[k] = h.value;
    else if (h.action === 'append' && headers[k]) headers[k] = `${headers[k]}, ${h.value}`;
    else headers[k] = headers[k] ? [].concat(headers[k], h.value) : h.value;
  }
  return headers;
}

// ------------------------------------------------------------------------------------------ main
async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(a.port) || !a.docroot || !a.php) {
    console.error('fastserve: --port, --docroot and --php are required');
    process.exit(2);
  }
  const workers = [];
  let stopping = false;
  const restarts = [];
  const htToken = crypto.randomBytes(16).toString('hex');
  const io = a.htaccess ? makeIo() : null;
  const htCache = new Map();

  async function startWorker(w) {
    w.port = await freePort();
    w.ready = false;
    const args = [...a.pre, '-S', `127.0.0.1:${w.port}`, '-t', a.docroot];
    if (a.router) args.push(a.router);
    const env = a.htaccess ? Object.assign({}, process.env, { PS_HT_TOKEN: htToken }) : process.env;
    const child = spawn(a.php, args, { cwd: a.docroot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    w.child = child;
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stdout.write(d));
    child.on('exit', (code) => {
      w.ready = false;
      if (stopping) return;
      const now = Date.now();
      restarts.push(now);
      while (restarts.length && now - restarts[0] > 60000) restarts.shift();
      console.log(`${stamp()} PHP Station: worker ${w.id} exited (${code}), ${restarts.length > 10 ? 'too many restarts, not restarting' : 'restarting'}`);
      if (restarts.length <= 10) setTimeout(() => startWorker(w).catch(() => {}), 500);
    });
    for (let i = 0; i < 75; i++) {
      if (child.exitCode !== null) return false;
      if (await portOpen(w.port)) { w.ready = true; return true; }
      await sleep(200);
    }
    return false;
  }

  for (let i = 0; i < a.workers; i++) workers.push({ id: i + 1, active: 0, port: null, ready: false, child: null });
  const first = await Promise.all(workers.map((w) => startWorker(w).catch(() => false)));
  if (!first.some(Boolean)) {
    console.error(`${stamp()} PHP Station: no PHP worker could start (see the lines above)`);
    stopping = true;
    for (const w of workers) { try { w.child && w.child.kill(); } catch { /* gone */ } }
    process.exit(1);
  }

  const pick = () => {
    const ready = workers.filter((w) => w.ready);
    if (!ready.length) return null;
    return ready.reduce((best, w) => (w.active < best.active ? w : best), ready[0]);
  };

  function sendStatic(req, res, sf, status = 200, extra = null) {
    const etag = `W/"${sf.size.toString(16)}-${Math.floor(sf.mtime.getTime() / 1000).toString(16)}"`;
    const headers = {
      'content-type': MIME[path.extname(sf.file).toLowerCase()] || 'application/octet-stream',
      'last-modified': sf.mtime.toUTCString(), etag, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
    };
    applyHeaderRules(headers, extra);
    if (status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    headers['content-length'] = sf.size;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(sf.file).on('error', () => res.destroy()).pipe(res);
  }
  function sendText(res, status, text, extra = null) {
    res.writeHead(status, applyHeaderRules({ 'content-type': 'text/html; charset=utf-8' }, extra));
    res.end(text);
  }
  const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 500: 'Internal Server Error' };

  const server = http.createServer(async (req, res) => {
    // an internal header from outside is never trusted
    delete req.headers['x-ps-ht'];
    let ht = null; // what the .htaccess made of this request
    if (a.htaccess) {
      let ev;
      try {
        ev = htaccess.evaluate(a.docroot, { method: req.method, url: req.url, headers: req.headers, port: a.port }, io, htCache);
      } catch (e) {
        console.log(`${stamp()} PHP Station: .htaccess error ${e.message}`);
        ev = { action: 'pass', headers: [] };
      }
      if (ev.action === 'redirect') {
        res.writeHead(ev.status, applyHeaderRules({ location: ev.location, 'content-type': 'text/plain; charset=utf-8' }, ev.headers));
        res.end(`Redirecting to ${ev.location}`);
        return;
      }
      if (ev.action === 'status') {
        const doc = ev.errorDoc;
        if (doc && typeof doc === 'object' && doc.redirect) { res.writeHead(302, { location: doc.redirect }); res.end(); return; }
        if (doc && typeof doc === 'object' && doc.text != null) { sendText(res, ev.status, doc.text, ev.headers); return; }
        if (typeof doc === 'string') {
          const q = doc.indexOf('?');
          ht = { path: q >= 0 ? doc.slice(0, q) : doc, query: q >= 0 ? doc.slice(q + 1) : '', status: ev.status, headers: ev.headers };
        } else {
          const title = `${ev.status} ${STATUS_TEXT[ev.status] || ''}`;
          sendText(res, ev.status, `<!doctype html><title>${title}</title><h1>${title}</h1>`, ev.headers);
          return;
        }
      } else if (ev.action === 'serve') {
        ht = { path: ev.path, query: ev.query || '', status: 0, headers: ev.headers };
      } else {
        ht = { path: null, headers: ev.headers };
      }
      if (ht.path) {
        // the target: a static file straight from disk, else a script for the router
        const sf = staticFile(a.docroot, encodeURI(ht.path));
        if (sf) { sendStatic(req, res, sf, ht.status || 200, ht.headers); return; }
        if (ht.path.split('/').some((x) => x.startsWith('.') && x !== '.well-known')) { sendText(res, 403, '<h1>403 Forbidden</h1>', ht.headers); return; }
        req.headers['x-ps-ht'] = Buffer.from([htToken, ht.path, ht.query, String(ht.status || 0)].join('\n')).toString('base64');
      }
    }
    // 1. static files straight from disk
    if ((req.method === 'GET' || req.method === 'HEAD') && !(ht && ht.path)) {
      const sf = staticFile(a.docroot, req.url);
      if (sf) { sendStatic(req, res, sf, 200, ht && ht.headers); return; }
    }
    // 2. PHP: the least busy worker (wait a little when none is ready, e.g. during a restart)
    let w = pick();
    for (let i = 0; !w && i < 50; i++) { await sleep(100); w = pick(); }
    if (!w) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('PHP Station: PHP is restarting, try again in a moment.'); return; }
    w.active++;
    let released = false;
    const release = () => { if (!released) { released = true; w.active--; } };
    const up = http.request({ host: '127.0.0.1', port: w.port, method: req.method, path: req.url, headers: req.headers, agent: false }, (pres) => {
      // php -S always answers "Connection: close"; the browser may keep ITS connection to us
      const raw = [];
      const extra = (ht && ht.headers) || [];
      const drop = new Set(extra.filter((h) => h.action === 'set' || h.action === 'unset').map((h) => String(h.name).toLowerCase()));
      for (let i = 0; i < pres.rawHeaders.length; i += 2) {
        const k = pres.rawHeaders[i];
        if (!/^(connection|keep-alive)$/i.test(k) && !drop.has(k.toLowerCase())) raw.push(k, pres.rawHeaders[i + 1]);
      }
      for (const h of extra) if (h.action !== 'unset') raw.push(h.name, h.value);
      res.writeHead(pres.statusCode || 502, pres.statusMessage, raw);
      pres.pipe(res);
      pres.on('end', release);
      pres.on('error', release);
    });
    up.on('error', (e) => {
      release();
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`PHP Station: the PHP worker did not answer (${e.code || e.message}).`); } else res.destroy();
    });
    res.on('close', () => { release(); if (!up.destroyed && !res.writableFinished) up.destroy(); });
    req.pipe(up);
  });
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.on('error', (e) => { console.error(`${stamp()} PHP Station: ${e.message}`); stopping = true; for (const w of workers) { try { w.child.kill(); } catch { /* gone */ } } process.exit(1); });
  server.listen(a.port, '127.0.0.1', () => {
    console.log(`${stamp()} PHP Station fast server on 127.0.0.1:${a.port} — ${workers.filter((w) => w.ready).length} PHP workers, static files served directly`);
  });

  const quit = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    for (const w of workers) { try { w.child && w.child.kill(); } catch { /* gone */ } }
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('SIGBREAK', quit);
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });

module.exports = { parseArgs, staticFile, applyHeaderRules, MIME };
