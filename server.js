#!/usr/bin/env node
'use strict';
/*
 * PHP Station: CLI (--serve / --launch / --stop) and the local HTTP server (127.0.0.1 only,
 * Host/Origin checks, per-start token, strict CSP, JSON API).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const util = require('./lib/util');
const stateLib = require('./lib/state');
const jobs = require('./lib/jobs');
const procs = require('./lib/procs');
const runtimes = require('./lib/runtimes');
const projects = require('./lib/projects');
const dbservers = require('./lib/dbservers');
const dbmove = require('./lib/dbmove');
const dbprovision = require('./lib/dbprovision');
const setup = require('./lib/setup');
const installer = require('./lib/installer');
const wizard = require('./lib/wizard');
const pma = require('./lib/pma');
const guard = require('./lib/guard');
const shortcuts = require('./lib/shortcuts');
const backups = require('./lib/backups');
const dbrepair = require('./lib/dbrepair');
const i18n = require('./lib/i18n');

const { AppError } = util;
const { tr, trConsole } = i18n;
const TOOL_DIR = __dirname;
const PACKAGE = util.readJson(path.join(TOOL_DIR, 'package.json'), {}) || {};
const VERSION = PACKAGE.version || '1.1.0';
const PUBLIC_DIR = path.join(TOOL_DIR, 'public');
const STATIC = {
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/i18n.js': { file: 'i18n.js', type: 'text/javascript; charset=utf-8' },
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const MAX_BODY = 1024 * 1024;

// ------------------------------------------------------------------------------------------ CLI args

function parseArgs(argv) {
  const a = { mode: null, port: null, data: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--serve') a.mode = 'serve';
    else if (x === '--launch') a.mode = 'launch';
    else if (x === '--stop') a.mode = 'stop';
    else if (x === '--no-open') a.open = false;
    else if (x === '--port') a.port = Number(argv[++i]);
    else if (x.startsWith('--port=')) a.port = Number(x.slice(7));
    else if (x === '--data') a.data = argv[++i];
    else if (x.startsWith('--data=')) a.data = x.slice(7);
  }
  return a;
}

function resolveDataDir(arg) {
  const d = arg || process.env.DEVPANEL_DATA || path.join(TOOL_DIR, 'data');
  return path.resolve(d);
}

function panelFile(dataDir) {
  return path.join(dataDir, 'panel.json');
}

/** Saved settings.lang of a data dir (CLI modes run before/without loading the state). */
function langOfDataDir(dataDir) {
  const st = util.readJson(path.join(dataDir, 'state.json'), null);
  const lang = st && st.settings && st.settings.lang;
  return i18n.isLang(lang) ? lang : i18n.DEFAULT_LANG;
}

// ------------------------------------------------------------------------------------------ helpers shared by CLI modes

async function pingPanel(port) {
  try {
    const r = await util.httpJson({ port, urlPath: '/api/ping', timeoutMs: 1500 });
    return !!(r.status === 200 && r.json && r.json.app === 'devpanel');
  } catch {
    return false;
  }
}

/** panel.json of a live PHP Station for this data dir, or null. */
async function runningPanel(dataDir, { checkCmd = true } = {}) {
  const info = util.readJson(panelFile(dataDir), null);
  if (!info || !Number.isInteger(info.port) || !Number.isInteger(info.pid)) return null;
  if (!procs.pidExists(info.pid)) return null;
  if (checkCmd) {
    try {
      const list = await procs.listProcesses({ maxAgeMs: 0 });
      const p = list.find((x) => x.pid === info.pid);
      if (p && p.cmd && !/server\.js/i.test(p.cmd)) return null;
      if (p && p.name !== 'node.exe') return null;
    } catch { /* the ping below still guards */ }
  }
  if (!(await pingPanel(info.port))) return null;
  return info;
}

function openAppWindow(url) {
  const opts = { detached: true, stdio: 'ignore', shell: false };
  for (const b of BROWSERS) {
    if (!util.existsFile(b)) continue;
    try {
      const c = spawn(b, [`--app=${url}`, '--window-size=1440,900'], opts);
      c.on('error', () => {});
      c.unref();
      return b;
    } catch { /* try next */ }
  }
  try {
    const c = spawn('explorer.exe', [url], opts);
    c.on('error', () => {});
    c.unref();
  } catch { /* nothing else to try */ }
  return 'explorer.exe';
}

// ------------------------------------------------------------------------------------------ --launch / --stop

async function cmdLaunch(args) {
  const dataDir = resolveDataDir(args.data);
  i18n.setLang(langOfDataDir(dataDir));
  util.ensureDir(path.join(dataDir, 'logs'));
  let info = await runningPanel(dataDir);
  if (!info) {
    const logFile = path.join(dataDir, 'logs', 'panel.log');
    util.rotateIfLarge(logFile);
    const childArgs = [path.join(TOOL_DIR, 'server.js'), '--serve', '--data', dataDir, '--no-open'];
    if (Number.isInteger(args.port)) childArgs.push('--port', String(args.port));
    const pid = procs.spawnDetached(process.execPath, childArgs, { cwd: TOOL_DIR, env: process.env, logFile });
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      await util.sleep(250);
      const pj = util.readJson(panelFile(dataDir), null);
      if (pj && pj.pid === pid && (await pingPanel(pj.port))) { info = pj; break; }
      if (!procs.pidExists(pid)) break;
    }
    if (!info) {
      procs.stopHelper();
      console.error(trConsole('cli.startFailed', { log: logFile }));
      process.exitCode = 1;
      return;
    }
  }
  const url = `http://127.0.0.1:${info.port}/`;
  if (args.open) openAppWindow(url);
  console.log(trConsole('cli.running', { url }));
  procs.stopHelper();
}

async function cmdStop(args) {
  const dataDir = resolveDataDir(args.data);
  i18n.setLang(langOfDataDir(dataDir));
  const info = util.readJson(panelFile(dataDir), null);
  if (!info || !Number.isInteger(info.pid)) {
    console.log(trConsole('cli.notRunning'));
    procs.stopHelper();
    return;
  }
  let done = false;
  try {
    const r = await util.httpJson({ port: info.port, method: 'POST', urlPath: '/api/shutdown', token: info.token, body: {}, timeoutMs: 3000 });
    done = r.status === 200 && r.json && r.json.ok === true;
  } catch { /* fall back below */ }
  if (done) {
    const end = Date.now() + 5000;
    while (Date.now() < end && procs.pidExists(info.pid)) await util.sleep(200);
  } else if (procs.pidExists(info.pid)) {
    let isOurs = false;
    try {
      const list = await procs.listProcesses({ maxAgeMs: 0 });
      const p = list.find((x) => x.pid === info.pid);
      isOurs = !!(p && p.name === 'node.exe' && p.cmd && /server\.js/i.test(p.cmd));
    } catch { isOurs = false; }
    if (isOurs) {
      await util.run('taskkill.exe', ['/PID', String(info.pid), '/F'], { timeoutMs: 15000 });
      done = true;
    }
  } else {
    done = true;
  }
  if (done) {
    try { fs.unlinkSync(panelFile(dataDir)); } catch { /* already gone */ }
    console.log(trConsole('cli.stopped'));
  } else {
    console.log(trConsole('cli.stopFailed'));
    process.exitCode = 1;
  }
  procs.stopHelper();
}

// ------------------------------------------------------------------------------------------ --serve

async function cmdServe(args) {
  const dataDir = resolveDataDir(args.data);
  i18n.setLang(langOfDataDir(dataDir));
  util.ensureDir(path.join(dataDir, 'logs'));
  const existing = await runningPanel(dataDir);
  if (existing) {
    console.log(trConsole('cli.alreadyRunning', { url: `http://127.0.0.1:${existing.port}/` }));
    procs.stopHelper();
    return;
  }
  const log = util.createLogger(path.join(dataDir, 'logs', 'panel.log'));
  const store = stateLib.loadState(dataDir);
  i18n.setLang(store.data.settings.lang);
  const ctx = {
    dataDir,
    toolDir: TOOL_DIR,
    version: VERSION,
    store,
    log,
    token: crypto.randomBytes(32).toString('hex'),
    port: null,
    startedAt: util.nowIso(),
    dirty: false,
  };
  jobs.setLogger(log);

  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((e) => {
      log(`internal error ${req.method} ${String(req.url).split('?')[0]}: ${e && e.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', error: tr('err.internal') }, true);
      else try { res.end(); } catch { /* ignore */ }
    });
  });
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 0;

  const preferred = Number.isInteger(args.port) && args.port > 0 ? args.port : store.data.settings.panelPort;
  let bound = null;
  for (let p = preferred; p < preferred + 10 && p <= 65535; p++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      const onErr = (e) => { server.removeListener('listening', onOk); resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? false : Promise.reject(e)); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    if (ok) { bound = p; break; }
    log(`port ${p} busy, trying next`);
  }
  if (!bound) {
    console.error(trConsole('cli.noPort', { from: preferred, to: preferred + 9 }));
    procs.stopHelper();
    process.exitCode = 1;
    return;
  }
  ctx.port = bound;
  util.writeJsonAtomic(panelFile(dataDir), { pid: process.pid, port: bound, token: ctx.token, startedAt: ctx.startedAt, version: VERSION });
  log(`PHP Station ${VERSION} listening on 127.0.0.1:${bound} (data ${dataDir})`);
  console.log(trConsole('cli.running', { url: `http://127.0.0.1:${bound}/` }));

  if (!runtimes.hasCache(ctx)) runtimes.startScan(ctx, jobs);

  // shutdown guard (stops DB servers cleanly when Windows shuts down / signs out)
  guard.ensure(ctx).then((g) => log(`guard: ${JSON.stringify(g)}`), (e) => log(`guard failed: ${e.message}`));
  // Desktop + Start Menu shortcuts, once per install folder
  shortcuts.ensureAuto(ctx, { toolDir: TOOL_DIR, description: tr('shortcut.description') })
    .then((r) => { if (!r.skipped) log(`shortcuts: ${JSON.stringify(r)}`); });
  // daily dump of every running DB server (one job at a time, checked every 10 min)
  const dumpTick = async () => {
    try {
      if (jobs.findRunning('backup')) return;
      const due = backups.dueForDailyDump(ctx, await dbViewList(ctx));
      if (!due.length) return;
      const id = due[0];
      const st = ctx.store.data.backupState || (ctx.store.data.backupState = {});
      st[id] = Object.assign({}, st[id], { lastTryAt: util.nowIso() });
      ctx.store.save();
      const e = dbservers.getEntry(ctx, id);
      jobs.createJob('backup', tr('job.dailyDump', { label: e.label }), (jl, job) => backups.dump(ctx, id, { reason: 'auto', log: jl, job }));
    } catch (e) { log(`daily dump check: ${e.message}`); }
  };
  const t1 = setTimeout(dumpTick, 2 * 60 * 1000);
  const t2 = setInterval(dumpTick, 10 * 60 * 1000);
  if (t1.unref) t1.unref();
  if (t2.unref) t2.unref();

  let exiting = false;
  ctx.shutdown = (reason) => {
    if (exiting) return;
    exiting = true;
    log(`shutdown (${reason})`);
    try { if (ctx.dirty) store.save(); } catch { /* ignore */ }
    try {
      const pj = util.readJson(panelFile(dataDir), null);
      if (pj && pj.pid === process.pid) fs.unlinkSync(panelFile(dataDir));
    } catch { /* ignore */ }
    procs.stopHelper();
    server.close();
    const t = setTimeout(() => process.exit(0), 400);
    if (t.unref) t.unref();
  };
  process.on('SIGINT', () => ctx.shutdown('SIGINT'));
  process.on('SIGTERM', () => ctx.shutdown('SIGTERM'));
  process.on('SIGBREAK', () => ctx.shutdown('SIGBREAK'));

  if (args.open) openAppWindow(`http://127.0.0.1:${bound}/`);
}

// ------------------------------------------------------------------------------------------ HTTP plumbing

function baseHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res, status, obj, api = true) {
  const body = Buffer.from(JSON.stringify(obj));
  baseHeaders(res);
  if (api) res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function sendText(res, status, text) {
  baseHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function tokenOk(ctx, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ctx.token);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let tooBig = false;
    req.on('data', (d) => {
      if (tooBig) return;
      len += d.length;
      if (len > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
      chunks.push(d);
    });
    req.on('end', () => {
      if (tooBig) { reject(new AppError('TOO_LARGE', tr('err.tooLarge'), 413)); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function serveIndex(ctx, res) {
  let html;
  try {
    html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  } catch {
    sendText(res, 500, tr('http.indexMissing'));
    return;
  }
  html = html.split('__DEVPANEL_TOKEN__').join(ctx.token);
  const body = Buffer.from(html);
  baseHeaders(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, item) {
  let data;
  try {
    data = fs.readFileSync(path.join(PUBLIC_DIR, item.file));
  } catch {
    sendText(res, 404, tr('http.notFound'));
    return;
  }
  baseHeaders(res);
  res.writeHead(200, { 'Content-Type': item.type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
}

async function handle(ctx, req, res) {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${ctx.port}` && host !== `localhost:${ctx.port}`) {
    sendText(res, 403, 'Forbidden (Host)');
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${ctx.port}` && origin !== `http://localhost:${ctx.port}`) {
    sendText(res, 403, 'Forbidden (Origin)');
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${ctx.port}`);
  const pathname = url.pathname;
  const method = req.method;

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') { sendText(res, 405, 'Method not allowed'); return; }
    if (pathname === '/' || pathname === '/index.html') { await serveIndex(ctx, res); return; }
    if (STATIC[pathname]) { serveStatic(res, STATIC[pathname]); return; }
    sendText(res, 404, tr('http.notFound'));
    return;
  }

  if (method === 'GET' && pathname === '/api/ping') {
    sendJson(res, 200, { app: 'devpanel', version: VERSION });
    return;
  }
  if (!tokenOk(ctx, req.headers['x-devpanel-token'])) {
    sendJson(res, 401, { ok: false, code: 'BAD_TOKEN', error: tr('err.badToken') });
    return;
  }
  if (method !== 'GET' && method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD', error: tr('err.method') });
    return;
  }

  let body = {};
  if (method === 'POST') {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      sendJson(res, e.status || 400, { ok: false, code: e.code || 'BAD_BODY', error: e.message });
      return;
    }
    if (raw.trim()) {
      if (!/^application\/json\s*(;|$)/.test(ct)) {
        sendJson(res, 415, { ok: false, code: 'BAD_CONTENT_TYPE', error: tr('err.contentType') });
        return;
      }
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, code: 'BAD_JSON', error: tr('err.badJson') });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, code: 'BAD_JSON', error: tr('err.jsonObject') });
        return;
      }
    } else if (ct && !/^application\/json\s*(;|$)/.test(ct)) {
      sendJson(res, 415, { ok: false, code: 'BAD_CONTENT_TYPE', error: tr('err.contentType') });
      return;
    }
  }

  const route = matchRoute(method, pathname);
  let status = 200;
  let out;
  if (!route) {
    status = 404;
    out = { ok: false, code: 'NOT_FOUND', error: tr('err.apiNotFound') };
  } else {
    try {
      out = await route.fn(ctx, { params: route.params, body, query: url.searchParams, res });
      if (out === undefined) return; // handler responded itself
      if (out && out.__status) { status = out.__status; delete out.__status; }
      if (out && out.ok === undefined) out.ok = true;
    } catch (e) {
      if (e instanceof AppError) {
        status = e.status || 400;
        out = Object.assign({ ok: false, code: e.code, error: e.message }, e.extra && typeof e.extra === 'object' ? e.extra : {});
      } else {
        status = 500;
        out = { ok: false, code: 'INTERNAL', error: tr('err.internalWith', { message: e && e.message ? e.message : String(e) }) };
        ctx.log(`error ${method} ${pathname}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      }
    }
  }
  if (ctx.dirty) { ctx.dirty = false; try { ctx.store.save(); } catch { /* ignore */ } }
  if (method === 'POST') ctx.log(`${method} ${pathname} -> ${status}${out && out.code && out.ok === false ? ` ${out.code}` : ''}`);
  sendJson(res, status, out);
  if (route && route.after) route.after(ctx);
}

// ------------------------------------------------------------------------------------------ routes

const routes = [];
function route(method, pattern, fn, after) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (m, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, fn, after });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; }
    });
    return { fn: r.fn, params, after: r.after };
  }
  return null;
}

function linesParam(q, def) {
  const n = Number.parseInt(q.get('lines'), 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : def;
}

async function dbViewList(ctx) {
  const snap = await procs.getSnapshot();
  return dbservers.views(ctx, snap).list;
}

async function buildState(ctx) {
  const snap = await procs.getSnapshot();
  const db = dbservers.views(ctx, snap);
  // the shutdown guard stops exactly the DB servers that run now
  if (snap.ok) try { guard.writeList(ctx, db.list); } catch (e) { ctx.log(`guard list: ${e.message}`); }
  const projectViews = projects.views(ctx, snap, db.list);
  const ext = projects.externalViews(ctx, snap);
  return {
    ok: true,
    panel: { version: VERSION, port: ctx.port, pid: process.pid, startedAt: ctx.startedAt, dataDir: ctx.dataDir },
    settings: ctx.store.data.settings,
    runtimes: runtimes.getCache(ctx),
    projects: projectViews,
    dbServers: db.list,
    external: { php: ext, db: db.unknown },
    jobs: jobs.listJobs(10),
    processError: snap.ok ? null : snap.error,
  };
}

route('GET', '/api/state', (ctx) => buildState(ctx));

route('POST', '/api/runtimes/scan', (ctx) => ({ jobId: runtimes.startScan(ctx, jobs) }));

route('POST', '/api/runtimes/add', (ctx, { body }) => {
  const p = util.checkUserPath(body.path, { kind: 'file', label: tr('label.path') });
  if (!runtimes.classifyExtraPath(p)) throw new AppError('BAD_PATH', tr('err.extraPathKind'));
  const s = ctx.store.data.settings;
  if (!s.extraPaths.some((x) => util.samePath(x, p))) {
    s.extraPaths = [...s.extraPaths, p];
    ctx.store.save();
  }
  return { jobId: runtimes.startScan(ctx, jobs) };
});

route('POST', '/api/projects/inspect', async (ctx, { body }) => {
  const dir = util.checkUserPath(body.path, { kind: 'dir', label: tr('label.projectFolder') });
  const info = projects.inspectProject(dir);
  const dbList = await dbViewList(ctx);
  const already = ctx.store.data.projects.find((p) => util.samePath(p.path, dir));
  return {
    info: Object.assign({}, info, { laravel: projects.laravelVersionOf(info), path: dir, alreadyAdded: already ? already.id : null }),
    suggestions: {
      php: projects.suggestPhp(info, runtimes.getCache(ctx).php).map(({ version, path: pp, satisfies, hint }) => ({ version, path: pp, satisfies, hint })),
      dbServerId: projects.suggestDbServer(info, dbList),
    },
  };
});

route('POST', '/api/projects', async (ctx, { body }) => ({ project: await projects.addProject(ctx, body) }));
route('POST', '/api/projects/:id/update', async (ctx, { params, body }) => ({ project: await projects.updateProject(ctx, params.id, body) }));
route('POST', '/api/projects/:id/remove', async (ctx, { params }) => { await projects.removeProject(ctx, params.id); return {}; });

function startResult(r) {
  if (r.ok === false) return Object.assign({ __status: ['DB_STOPPED', 'DB_MISSING', 'PORT_CONFIRM'].includes(r.code) ? 409 : 500 }, r);
  return r;
}
/** Start options from the request body: startDb, skipDbCheck (booleans) and port (validated later). */
function startOpts(body) {
  const o = { startDb: body.startDb === true, skipDbCheck: body.skipDbCheck === true };
  if (body.port !== undefined && body.port !== null && body.port !== '') o.port = body.port;
  return o;
}
route('POST', '/api/projects/:id/start', async (ctx, { params, body }) => startResult(await projects.startProject(ctx, params.id, startOpts(body))));
route('POST', '/api/projects/:id/stop', async (ctx, { params }) => { await projects.stopProject(ctx, params.id); return {}; });
route('POST', '/api/projects/:id/restart', async (ctx, { params, body }) => startResult(await projects.restartProject(ctx, params.id, startOpts(body))));
route('POST', '/api/projects/:id/db-provision', (ctx, { params, body }) => {
  const input = dbprovision.prepare(ctx, params.id, body);
  return { jobId: jobs.createJob('db-provision', tr('job.dbProvision', { db: input.database, label: input.label }), (log, job) => dbprovision.provisionJob(ctx, input, log, job)) };
});
route('GET', '/api/projects/:id/setup', (ctx, { params }) => setup.setupInfo(ctx, params.id));
route('POST', '/api/projects/:id/setup', (ctx, { params, body }) => {
  const actions = setup.prepare(ctx, params.id, body);
  const p = projects.getProject(ctx, params.id);
  return { jobId: jobs.createJob('setup', tr('job.setup', { name: p.name }), (log, job) => setup.setupJob(ctx, p.id, actions, log, job)) };
});
route('POST', '/api/projects/:id/terminal', (ctx, { params, body }) => projects.openTerminal(ctx, params.id, String(body.action || 'shell')));
route('POST', '/api/projects/:id/open-folder', (ctx, { params }) => projects.openFolder(ctx, params.id));
route('POST', '/api/projects/:id/write-env-db', (ctx, { params, body }) => projects.writeEnvDb(ctx, params.id, body));
route('POST', '/api/projects/:id/check', (ctx, { params }) => {
  const p = projects.getProject(ctx, params.id);
  return { jobId: jobs.createJob('check', tr('job.check', { name: p.name }), (log) => projects.checkJob(ctx, p.id, log)) };
});
route('POST', '/api/projects/:id/lint', (ctx, { params }) => {
  const p = projects.getProject(ctx, params.id);
  return { jobId: jobs.createJob('lint', tr('job.lint', { name: p.name }), (log) => projects.lintJob(ctx, p.id, log)) };
});
route('POST', '/api/projects/:id/clear-cache', (ctx, { params }) => {
  const p = projects.getProject(ctx, params.id);
  return { jobId: jobs.createJob('clear-cache', tr('job.clearCache', { name: p.name }), (log) => projects.clearCacheJob(ctx, p.id, log)) };
});
route('GET', '/api/projects/:id/log', (ctx, { params, query }) => projects.getLog(ctx, params.id, linesParam(query, 300)));
route('POST', '/api/projects/:id/log/clear', (ctx, { params }) => projects.clearLog(ctx, params.id));

route('POST', '/api/scan-projects', async (ctx) => ({ items: projects.scanProjects(ctx, await dbViewList(ctx)) }));

const PICK_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = [string]$env:DP_DESC
$d.ShowNewFolderButton = $false
if ($env:DP_START -and (Test-Path -LiteralPath $env:DP_START -PathType Container)) { $d.SelectedPath = $env:DP_START }
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $d.SelectedPath) {
  [Console]::Out.WriteLine((DP-Ascii (ConvertTo-Json -InputObject @{ ok = $true; path = [string]$d.SelectedPath } -Compress)))
} else {
  [Console]::Out.WriteLine('{"ok":true,"path":null}')
}
`;

route('POST', '/api/pick-folder', async (ctx, { body }) => {
  let start = '';
  if (typeof body.start === 'string' && body.start.trim()) {
    try { start = util.checkUserPath(body.start, { kind: 'dir' }); } catch { start = ''; }
  }
  const env = util.cleanEnv({ remove: [], set: { DP_START: start || undefined, DP_DESC: tr('pick.description') } });
  if (!start) delete env.DP_START;
  const r = await procs.psOneShot(PICK_SCRIPT, { sta: true, env, timeoutMs: 15 * 60 * 1000 });
  if (!r.json) throw new AppError('PICK_FAILED', tr('err.pickFailed'), 500);
  return { path: r.json.path || null };
});

const PICK_FILE_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = [string]$env:DP_DESC
$d.Filter = 'SQL (*.sql)|*.sql'
$d.CheckFileExists = $true
$d.Multiselect = $false
if ($env:DP_START -and (Test-Path -LiteralPath $env:DP_START -PathType Container)) { $d.InitialDirectory = $env:DP_START }
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $d.FileName) {
  [Console]::Out.WriteLine((DP-Ascii (ConvertTo-Json -InputObject @{ ok = $true; path = [string]$d.FileName } -Compress)))
} else {
  [Console]::Out.WriteLine('{"ok":true,"path":null}')
}
`;

route('POST', '/api/pick-file', async (ctx, { body }) => {
  if (body.kind !== 'sql') throw new AppError('BAD_INPUT', tr('err.pickFileKind'), 400);
  let start = '';
  if (typeof body.start === 'string' && body.start.trim()) {
    try {
      const p = util.checkUserPath(body.start, { kind: 'any' });
      start = util.existsDir(p) ? p : path.win32.dirname(p);
    } catch { start = ''; }
  }
  const env = util.cleanEnv({ remove: [], set: { DP_START: start || undefined, DP_DESC: tr('pick.sqlTitle') } });
  if (!start) delete env.DP_START;
  const r = await procs.psOneShot(PICK_FILE_SCRIPT, { sta: true, env, timeoutMs: 15 * 60 * 1000 });
  if (!r.json) throw new AppError('PICK_FAILED', tr('err.pickFileFailed'), 500);
  return { path: r.json.path || null };
});

route('POST', '/api/external/adopt', async (ctx, { body }) => ({ project: await projects.adoptExternal(ctx, body.pid) }));
route('POST', '/api/external/stop', (ctx, { body }) => projects.stopExternal(ctx, body.pid));

route('POST', '/api/db/create', (ctx, { body }) => {
  const name = String(body.name || '');
  return { jobId: jobs.createJob('db-create', tr('job.dbCreate', { name: name.slice(0, 30) }), (log) => dbservers.createInstance(ctx, body, log)) };
});
route('POST', '/api/db/:id/start', (ctx, { params, body }) => {
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', tr('err.confirmRequired'));
  const e = dbservers.getEntry(ctx, params.id);
  return { jobId: jobs.createJob('db-start', tr('job.dbStart', { label: e.label }), (log) => dbservers.startServer(ctx, e.id, { log })) };
});
route('POST', '/api/db/:id/stop', (ctx, { params, body }) => {
  const e = dbservers.getEntry(ctx, params.id);
  const opts = {
    user: typeof body.user === 'string' ? body.user : undefined,
    password: typeof body.password === 'string' ? body.password : undefined,
    force: body.force === true,
  };
  return { jobId: jobs.createJob('db-stop', tr('job.dbStop', { label: e.label }), (log) => dbservers.stopServer(ctx, e.id, opts, log)) };
});
route('POST', '/api/db/:id/update', (ctx, { params, body }) => { dbservers.update(ctx, params.id, body); return {}; });

// Backups (snapshots of a stopped datadir, dumps of a running server), repair and rescue.
function needConfirm(body) {
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', tr('err.confirmRequired'));
}
function oneBackupJob() {
  if (jobs.findRunning('backup') || jobs.findRunning('repair')) throw new AppError('BUSY', tr('bk.busy'), 409);
}
route('GET', '/api/db/:id/backups', (ctx, { params }) => backups.overview(ctx, params.id));
route('POST', '/api/db/:id/snapshot', (ctx, { params, body }) => {
  needConfirm(body); oneBackupJob();
  const e = dbservers.getEntry(ctx, params.id);
  return { jobId: jobs.createJob('backup', tr('job.snapshot', { label: e.label }), (log) => backups.snapshot(ctx, e.id, { reason: 'manual', log })) };
});
route('POST', '/api/db/:id/dump', (ctx, { params, body }) => {
  needConfirm(body); oneBackupJob();
  const e = dbservers.getEntry(ctx, params.id);
  return { jobId: jobs.createJob('backup', tr('job.dump', { label: e.label }), (log, job) => backups.dump(ctx, e.id, { reason: 'manual', log, job })) };
});
route('POST', '/api/db/:id/restore-snapshot', (ctx, { params, body }) => {
  needConfirm(body); oneBackupJob();
  const e = dbservers.getEntry(ctx, params.id);
  const name = String(body.name || '');
  if (!backups.NAME_RE.test(name)) throw new AppError('BAD_INPUT', tr('bk.badName'), 400);
  return { jobId: jobs.createJob('backup', tr('job.restoreSnapshot', { label: e.label, name }), (log) => backups.restoreSnapshot(ctx, e.id, name, log)) };
});
route('POST', '/api/db/:id/restore-dump', (ctx, { params, body }) => {
  needConfirm(body); oneBackupJob();
  const e = dbservers.getEntry(ctx, params.id);
  const { name, db, target } = body;
  return { jobId: jobs.createJob('backup', tr('job.restoreDump', { db: String(db || ''), target: String(target || '') }), (log, job) => backups.restoreDump(ctx, e.id, String(name || ''), String(db || ''), String(target || ''), log, job)) };
});
route('GET', '/api/db/:id/diagnose', (ctx, { params }) => dbrepair.diagnose(ctx, params.id));
route('POST', '/api/db/:id/repair', (ctx, { params, body }) => {
  needConfirm(body); oneBackupJob();
  const e = dbservers.getEntry(ctx, params.id);
  return { jobId: jobs.createJob('repair', tr('job.repair', { label: e.label }), (log, job) => dbrepair.repairJob(ctx, e.id, log, job)) };
});
route('POST', '/api/db/:id/rescue', (ctx, { params, body }) => {
  needConfirm(body); oneBackupJob();
  const e = dbservers.getEntry(ctx, params.id);
  return { jobId: jobs.createJob('repair', tr('job.rescue', { label: e.label }), (log, job) => dbrepair.rescueJob(ctx, e.id, { createServer: body.createServer !== false }, log, job)) };
});
route('GET', '/api/guard', (ctx) => guard.status(ctx));
route('GET', '/api/db/:id/log', (ctx, { params, query }) => dbservers.getLog(ctx, params.id, linesParam(query, 200)));
route('POST', '/api/db/:id/databases', async (ctx, { params, body }) => {
  const creds = dbservers.resolveCreds(ctx, { user: body.user, password: body.password }, body.projectId || null);
  return { databases: await dbservers.listDatabases(ctx, params.id, creds) };
});
route('POST', '/api/db/:id/remove', async (ctx, { params }) => {
  const r = await dbservers.remove(ctx, params.id);
  return { datadir: r.datadir, message: r.datadir ? tr('msg.dbRemovedKeepData', { datadir: r.datadir }) : tr('msg.dbRemoved') };
});

route('POST', '/api/dbmove', (ctx, { body }) => {
  dbmove.validate(ctx, body);
  const input = {
    fromServerId: body.fromServerId, fromDb: body.fromDb, toServerId: body.toServerId, toDb: body.toDb,
    from: body.from && typeof body.from === 'object' ? { user: body.from.user, password: body.from.password } : null,
    to: body.to && typeof body.to === 'object' ? { user: body.to.user, password: body.to.password } : null,
    projectId: body.projectId || null,
  };
  return { jobId: jobs.createJob('dbmove', tr('job.dbmove', { from: body.fromDb, to: body.toDb }), (log, job) => dbmove.moveJob(ctx, input, log, job)) };
});

route('GET', '/api/jobs/:id', (ctx, { params }) => {
  const j = jobs.getJob(params.id);
  if (!j) throw new AppError('JOB_NOT_FOUND', tr('err.jobNotFound'), 404);
  return { job: j };
});

route('POST', '/api/dumps/delete', (ctx, { body }) => {
  const f = util.checkUserPath(body.file, { kind: 'file', label: tr('label.dumpFile') });
  const root = path.join(ctx.store.data.settings.dumpDir, 'devpanel');
  if (!util.isInside(f, root) || !/\.sql$/i.test(f)) throw new AppError('BAD_PATH', tr('err.dumpDeleteOutside'), 403);
  fs.unlinkSync(f);
  ctx.log(`dump deleted ${f}`);
  return {};
});

route('POST', '/api/settings', (ctx, { body }) => {
  const next = stateLib.validateSettings(body, ctx.store.data.settings);
  const guardChanged = ctx.store.data.settings.shutdownGuard !== next.shutdownGuard;
  ctx.store.data.settings = next;
  ctx.store.save();
  i18n.setLang(next.lang);
  if (guardChanged) guard.ensure(ctx).catch((e) => ctx.log(`guard: ${e.message}`));
  return { settings: next };
});

// Desktop + Start Menu shortcuts (also made automatically on the first start, see lib/shortcuts.js)
route('POST', '/api/shortcut', async (ctx) => {
  let r;
  try {
    r = await shortcuts.create({ toolDir: TOOL_DIR, description: tr('shortcut.description') });
  } catch (e) {
    if (e.code === 'NO_LAUNCHER') throw new AppError('NO_LAUNCHER', tr('err.noLauncher', { path: e.target }), 404);
    throw new AppError('SHORTCUT_FAILED', tr('err.shortcutFailed'), 500);
  }
  ctx.store.data.shortcuts = { for: path.resolve(TOOL_DIR), at: new Date().toISOString(), paths: r.paths };
  ctx.store.save();
  ctx.log(`shortcuts created ${r.paths.join(' | ')}`);
  return { path: r.paths[0] || '', paths: r.paths };
});

// ------------------------------------------------------------------------------------------ installer

route('GET', '/api/installer/system', (ctx) => installer.systemSummary(ctx));
route('GET', '/api/installer/catalog', (ctx, { query }) => installer.getCatalog(ctx, String(query.get('kind') || '')));
// Only kind/version/confirm are read from the request: sources, hosts and folders are fixed.
route('POST', '/api/installer/install', (ctx, { body }) => installer.startInstall(ctx, jobs, { kind: body.kind, version: body.version, confirm: body.confirm }));
// phpMyAdmin (DB admin): PHP Station's own copy, served on 127.0.0.1; config written on every open.
route('GET', '/api/pma', (ctx) => pma.info(ctx));
route('POST', '/api/pma/open', (ctx, { body }) => pma.open(ctx, { dbServerId: body.dbServerId, projectId: body.projectId }));
route('POST', '/api/pma/stop', (ctx) => pma.stop(ctx));
route('POST', '/api/pma/copy-local', (ctx, { body }) => {
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', tr('err.confirmRequired'));
  const src = pma.detectLocal(ctx).find((x) => util.samePath(x.path, String(body.path || '')));
  if (!src) throw new AppError('BAD_INPUT', tr('pma.notDetected'), 400);
  if (jobs.findRunning('install')) throw new AppError('BUSY', tr('inst.busy'), 409);
  return { jobId: jobs.createJob('install', tr('job.pmaCopy', { version: src.version, stack: src.stack }), (log) => pma.copyLocalJob(ctx, src.path, log)) };
});
// Setup Wizard: plan (read-only, uses the catalogs) and one job for several installs.
route('GET', '/api/wizard/plan', (ctx) => wizard.plan(ctx));
route('POST', '/api/installer/install-batch', (ctx, { body }) => installer.startBatchInstall(ctx, jobs, {
  items: Array.isArray(body.items) ? body.items.map((x) => ({ kind: x && x.kind, version: x && x.version })) : body.items,
  confirm: body.confirm,
}));

// ------------------------------------------------------------------------------------------ about

/** URLs the About card may open: x8code.com and a GitHub homepage from package.json (if set). */
function allowedOpenUrls() {
  const out = ['https://x8code.com', 'https://x8code.com/'];
  const home = typeof PACKAGE.homepage === 'string' ? PACKAGE.homepage.trim() : '';
  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(home)) out.push(home);
  return out;
}

route('POST', '/api/open-url', (ctx, { body }) => {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!allowedOpenUrls().includes(url)) throw new AppError('URL_NOT_ALLOWED', tr('err.openUrlNotAllowed'), 403);
  openInDefaultBrowser(url);
  return {};
});

/**
 * Local URL (a project, phpMyAdmin) opened in the user's DEFAULT browser (explorer.exe hands it to
 * the registered http handler) instead of inside the panel's app window. Only plain
 * http://127.0.0.1:<port>/... or http://localhost:<port>/... is accepted.
 */
function localOpenUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' || u.username || u.password) return null;
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return null;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const s = u.toString();
  return s.length <= 2000 && !/["\s]/.test(s) ? s : null;
}
route('POST', '/api/open-local', (ctx, { body }) => {
  const url = localOpenUrl(body.url);
  if (!url) throw new AppError('URL_NOT_ALLOWED', tr('err.openUrlNotAllowed'), 403);
  openInDefaultBrowser(url);
  return {};
});

/**
 * Hands an http(s) URL to the registered default browser. explorer.exe is NOT used: given a URL
 * it sometimes opens the Documents folder instead. url.dll's FileProtocolHandler is the shell's
 * own "open this URL" entry point (no cmd.exe, so & and ? in the URL need no escaping).
 */
function openInDefaultBrowser(url) {
  const rundll = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
  const child = spawn(rundll, ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', shell: false, windowsVerbatimArguments: true });
  child.on('error', () => {});
  child.unref();
}

route('POST', '/api/shutdown', () => ({}), (ctx) => setTimeout(() => ctx.shutdown('api'), 100));

// ------------------------------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'serve') return cmdServe(args);
  if (args.mode === 'launch') return cmdLaunch(args);
  if (args.mode === 'stop') return cmdStop(args);
  i18n.setLang(langOfDataDir(resolveDataDir(args.data)));
  console.log(trConsole('cli.usage'));
  process.exitCode = 2;
  return null;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`PHP Station error: ${e && e.message ? e.message : e}`);
    procs.stopHelper();
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, matchRoute, allowedOpenUrls, VERSION };
