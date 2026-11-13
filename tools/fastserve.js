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
 */
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// ------------------------------------------------------------------------------------------ args
function parseArgs(argv) {
  const a = { port: null, docroot: null, php: null, router: null, workers: 4, pre: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--port') { a.port = Number(v); i++; } else if (k === '--docroot') { a.docroot = v; i++; } else if (k === '--php') { a.php = v; i++; } else if (k === '--router') { a.router = v; i++; } else if (k === '--workers') { a.workers = Number(v); i++; } else if (k === '--pre') {
      try { const x = JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); if (Array.isArray(x)) a.pre = x.map(String); } catch { /* none */ }
      i++;
    }
  }
  a.workers = Number.isInteger(a.workers) ? Math.min(16, Math.max(1, a.workers)) : 4;
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

  async function startWorker(w) {
    w.port = await freePort();
    w.ready = false;
    const args = [...a.pre, '-S', `127.0.0.1:${w.port}`, '-t', a.docroot];
    if (a.router) args.push(a.router);
    const child = spawn(a.php, args, { cwd: a.docroot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

  const server = http.createServer(async (req, res) => {
    // 1. static files straight from disk
    if (req.method === 'GET' || req.method === 'HEAD') {
      const sf = staticFile(a.docroot, req.url);
      if (sf) {
        const etag = `W/"${sf.size.toString(16)}-${Math.floor(sf.mtime.getTime() / 1000).toString(16)}"`;
        const headers = {
          'Content-Type': MIME[path.extname(sf.file).toLowerCase()] || 'application/octet-stream',
          'Last-Modified': sf.mtime.toUTCString(), ETag: etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
        headers['Content-Length'] = sf.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(sf.file).on('error', () => res.destroy()).pipe(res);
        return;
      }
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
      for (let i = 0; i < pres.rawHeaders.length; i += 2) {
        if (!/^(connection|keep-alive)$/i.test(pres.rawHeaders[i])) raw.push(pres.rawHeaders[i], pres.rawHeaders[i + 1]);
      }
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

module.exports = { parseArgs, staticFile, MIME };
