'use strict';
/*
 * Upgrade Lab: "will this project run on PHP X?", answered with the project's own code.
 *
 *   1. Packages: composer.lock packages whose own `php` constraint excludes PHP X, the composer.json
 *      constraint, and required ext-* extensions that PHP X does not load.
 *   2. Code: every app file linted with PHP X, with the compile-time deprecations PHP X reports
 *      (implicit nullable parameters in 8.4 ...). Files that also fail on the current PHP are marked.
 *   3. Pages: the running project (current PHP) and a second, temporary server of the same folder on
 *      PHP X answer the same GET routes one after the other. Status, time, PHP error markers in the page
 *      and the log lines each request added (laravel.log, the PHP server logs) are compared per route.
 *
 * Nothing in the project is changed. The crawl is GET-only, skips routes that sound like they change
 * something (logout, delete, reset ...), and runs with the Inbox prepend, so mail is caught. A Time
 * Machine restore point can be saved first. A session cookie, when given, is used for the requests
 * only and never stored or logged.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const util = require('./util');
const semver = require('./semver');
const runtimes = require('./runtimes');
const projects = require('./projects');
const procs = require('./procs');
const ports = require('./ports');
const devtools = require('./devtools');
const devlogs = require('./devlogs');
const dbservers = require('./dbservers');
const timemachine = require('./timemachine');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;

const RISKY_URI = /(^|\/|[-_.])(logout|log-out|signout|sign-out|delete|destroy|remove|reset|clear|flush|wipe|truncate|purge|cancel|unsubscribe|deactivate|disable|kill|stop|cron|webhook|install|uninstall|migrate|seed|backup|restore|import|export|download|sync|run|execute|send|approve|reject|toggle)(\/|[-_.]|$)/i;
const SKIP_URI = /^\/?(_ignition|_debugbar|telescope|horizon|pulse|livewire|sanctum|broadcasting|storage\/|vendor\/|log-viewer|clockwork|__clockwork|up$)/i;
const ASSET_RE = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip|gz|rar|7z|mp4|mp3|webm|xml|txt|csv|xlsx?|docx?)(\?|$)/i;
const MARKER_RE = /(?:<b>)?\s*(Fatal error|Parse error|Warning|Deprecated|Notice|Uncaught)(?:<\/b>)?:\s*(.{0,300}?)\s+in\s+(?:<b>)?([^<\n]+?)(?:<\/b>)?\s+on line\s+(?:<b>)?(\d+)/g;

// ------------------------------------------------------------------------------------------ PURE helpers

/** composer.lock -> packages whose `php` requirement excludes `version`. PURE. */
function incompatiblePackages(lock, version) {
  const out = [];
  for (const list of [lock && lock.packages, lock && lock['packages-dev']]) {
    for (const pkg of Array.isArray(list) ? list : []) {
      const c = pkg && pkg.require && typeof pkg.require.php === 'string' ? pkg.require.php : null;
      if (!c) continue;
      if (semver.satisfies(version, c) === false) out.push({ name: pkg.name, version: pkg.version, constraint: c, dev: list === lock['packages-dev'] });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** ext-* names required by composer.json and composer.lock (lowercase, without "ext-"). PURE. */
function requiredExtensions(composerJson, lock) {
  const set = new Set();
  const add = (req) => { for (const k of Object.keys(req || {})) if (/^ext-/i.test(k)) set.add(k.slice(4).toLowerCase()); };
  add(composerJson && composerJson.require);
  for (const list of [lock && lock.packages, lock && lock['packages-dev']]) for (const pkg of Array.isArray(list) ? list : []) add(pkg && pkg.require);
  return [...set].sort();
}

/** `php -m` output -> set of lowercase module names ("Zend OPcache" -> "opcache"). PURE. */
function parseModules(text) {
  const set = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim().toLowerCase();
    if (!l || l.startsWith('[')) continue;
    set.add(l === 'zend opcache' ? 'opcache' : l.replace(/\s+/g, '_'));
  }
  return set;
}

/** route:list --json -> GET paths worth comparing (no parameters, nothing that sounds like a change). PURE. */
function filterRoutes(list, max = 120) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.uri !== 'string' || r.domain) continue;
    const methods = String(r.method || '').toUpperCase().split('|');
    if (!methods.includes('GET')) continue;
    const uri = r.uri === '/' ? '/' : `/${r.uri.replace(/^\/+/, '')}`;
    if (uri.includes('{') || SKIP_URI.test(uri.slice(1)) || RISKY_URI.test(uri) || RISKY_URI.test(String(r.name || '').replace(/\./g, '/'))) continue;
    if (seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
  }
  out.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  return out.slice(0, max);
}

/** Same-site page links of an HTML page (path + query), without assets and risky links. PURE. */
function extractLinks(html, basePath = '/') {
  const out = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    let href = m[2].trim().replace(/&amp;/g, '&');
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, `http://lab.local${basePath}`); } catch { continue; }
    if (u.host !== 'lab.local' && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(u.host)) continue;
    const p = u.pathname + u.search;
    if (ASSET_RE.test(u.pathname) || RISKY_URI.test(u.pathname) || SKIP_URI.test(u.pathname.slice(1))) continue;
    out.add(p);
  }
  return [...out];
}

/** PHP error messages printed into a page ("<b>Deprecated</b>: ... in x.php on line 5"). PURE. */
function pageMarkers(body) {
  const out = [];
  const text = String(body || '').slice(0, 2 * 1024 * 1024);
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null && out.length < 10) {
    out.push({ level: m[1], message: m[2].replace(/<[^>]+>/g, '').trim(), file: m[3].trim(), line: Number(m[4]) });
  }
  return out;
}

/** Text a log grew by -> [{level, message, deprecation}] (Laravel entries and PHP lines). PURE. */
function parseLogChunk(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[\w-]+\.([A-Z]+):\s?(.*)$/.exec(line);
    if (m) { out.push({ level: m[1], message: m[2].slice(0, 400) }); continue; }
    m = /(?:PHP\s+)?(Fatal error|Parse error|Warning|Notice|Deprecated|Recoverable fatal error):\s+(.*)$/.exec(line);
    if (m && !/\[\d{3}\]:\s+(GET|POST|HEAD)\b/.test(line)) out.push({ level: m[1].toUpperCase().replace(/\s+/g, '_'), message: m[2].slice(0, 400) });
  }
  for (const e of out) {
    e.deprecation = /deprecat/i.test(e.level) || /deprecat/i.test(e.message);
    // "... in C:\app\x.php on line 5" / "... in C:\app\x.php:5" -> message, file, line
    const w = /^(.*?)\s+in\s+([A-Za-z]:[\\/][^:]*?|\/[^:]*?)(?:\s+on line\s+|:)(\d+)\s*$/.exec(e.message);
    if (w) { e.message = w[1]; e.file = w[2]; e.line = Number(w[3]); }
  }
  return out.slice(0, 20);
}

const BAD = (e) => !e.deprecation && /^(EMERGENCY|ALERT|CRITICAL|ERROR|FATAL_ERROR|PARSE_ERROR|RECOVERABLE_FATAL_ERROR|WARNING)$/.test(e.level);

/** One route, both sides -> 'broken' | 'changed' | 'deprecated' | 'bothFail' | 'same'. PURE. */
function verdict(a, b) {
  const aBad = a.log.filter(BAD).length + a.markers.filter((x) => !/deprecat/i.test(x.level)).length;
  const bBad = b.log.filter(BAD).length + b.markers.filter((x) => !/deprecat/i.test(x.level)).length;
  const bDep = b.log.filter((e) => e.deprecation).length + b.markers.filter((x) => /deprecat/i.test(x.level)).length;
  const aDep = a.log.filter((e) => e.deprecation).length + a.markers.filter((x) => /deprecat/i.test(x.level)).length;
  if ((b.status === 0 || b.status >= 500) && a.status > 0 && a.status < 500) return 'broken';
  if (bBad > aBad) return 'broken';
  if (a.status !== b.status || (a.location || '') !== (b.location || '')) return 'changed';
  if (bDep > aDep) return 'deprecated';
  if (a.status >= 500 || a.status === 0 || (aBad && bBad)) return 'bothFail';
  return 'same';
}

/** Cookie header from what the user pasted (a header line or "name=value; ..."), or null. PURE. */
function cleanCookie(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).replace(/^\s*cookie\s*:\s*/i, '').trim();
  if (!s) return null;
  if (s.length > 8000 || /[\r\n\0]/.test(s) || !/^[^=;\s]+=/.test(s)) throw new AppError('BAD_INPUT', tr('lab.badCookie'), 400);
  return s;
}

// ------------------------------------------------------------------------------------------ helpers with I/O

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function fetchPage(port, urlPath, cookie) {
  return new Promise((resolve) => {
    const started = Date.now();
    const headers = { Host: `127.0.0.1:${port}`, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'User-Agent': 'PHPStation-UpgradeLab' };
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers, timeout: 60000 }, (res) => {
      const chunks = [];
      let len = 0;
      res.on('data', (d) => { if (len < 2 * 1024 * 1024) { chunks.push(d); len += d.length; } });
      res.on('end', () => {
        let location = res.headers.location ? String(res.headers.location) : null;
        if (location) { try { const u = new URL(location, `http://127.0.0.1:${port}`); location = u.pathname + u.search; } catch { /* keep as is */ } }
        resolve({ status: res.statusCode, ms: Date.now() - started, bytes: len, location, body: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] || '') });
      });
      res.on('error', () => resolve({ status: 0, ms: Date.now() - started, bytes: 0, location: null, body: '', error: 'read' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, ms: Date.now() - started, bytes: 0, location: null, body: '', error: e.message }));
    req.end();
  });
}

function sizeOf(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

/** Every log a request can write to, with its size now. */
function logSizes(files) {
  const m = new Map();
  for (const f of files()) m.set(f, sizeOf(f));
  return m;
}

/** What the logs grew by since `before` (at most 256 KB per file). */
function logGrowth(files, before) {
  let text = '';
  for (const f of files()) {
    const from = before.has(f) ? before.get(f) : 0;
    const now = sizeOf(f);
    if (now <= from) continue;
    const len = Math.min(now - from, 256 * 1024);
    try {
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        text += `${buf.toString('utf8')}\n`;
      } finally { fs.closeSync(fd); }
    } catch { /* rotated or locked */ }
  }
  return parseLogChunk(text);
}

function appFiles(dir) {
  const files = [];
  for (const sub of ['app', 'bootstrap', 'config', 'database', 'routes', 'src', 'tests', 'public', 'includes', 'inc', 'lib', 'modules', 'pages', 'classes']) {
    const d = win.join(dir, sub);
    if (!util.existsDir(d)) continue;
    const list = [];
    collectPhp(d, list, 20000);
    for (const f of list) if (!util.isInside(f, win.join(dir, 'bootstrap', 'cache')) && !/\.blade\.php$/i.test(f)) files.push(f);
  }
  // plain PHP: the .php files next to composer.json too (index.php, config.php ...)
  for (const n of util.listFileNames(dir)) if (/\.php$/i.test(n)) files.push(win.join(dir, n));
  if (!files.length) collectPhp(dir, files, 5000);
  return files;
}

function collectPhp(dir, out, max) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= max) return;
    const full = win.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(vendor|node_modules|\.git|storage|build|hot)$/i.test(e.name)) continue;
      collectPhp(full, out, max);
    } else if (e.isFile() && /\.php$/i.test(e.name)) out.push(full);
  }
}

/** php -l with every error shown -> {ok, error, deprecations[]}. */
async function lintOne(inv, file, cwd) {
  const r = await util.run(inv.file, [...inv.preArgs, '-d', 'error_reporting=-1', '-d', 'display_errors=stderr', '-d', 'log_errors=0', '-l', file],
    { env: util.cleanEnv(), cwd, timeoutMs: 30000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const deps = [];
  let error = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /(?:PHP\s+)?(Deprecated|Fatal error|Parse error|Warning):\s*(.+?)\s+in\s+(.+?)\s+on line\s+(\d+)/.exec(line);
    if (!m) continue;
    if (m[1] === 'Deprecated') deps.push({ line: Number(m[4]), message: m[2] });
    else if (!error) error = { line: Number(m[4]), message: `${m[1]}: ${m[2]}` };
  }
  if (r.code !== 0 && !error) error = { line: null, message: util.firstLine(text) || util.describeExit(r, inv.file) };
  return { ok: r.code === 0, error, deprecations: deps };
}

// ------------------------------------------------------------------------------------------ API

/** What the dialog needs: the current PHP, the other PHP versions, and whether a crawl can run. */
function info(ctx, id) {
  const p = projects.getProject(ctx, id);
  const cur = projects.resolveProjectPhp(ctx, p);
  const inf = projects.inspectProject(p.path);
  const all = runtimes.getCache(ctx).php.filter((r) => r.ok);
  const targets = all.filter((r) => !cur || !util.samePath(r.path, cur.path))
    .sort((a, b) => semver.compare(b.version, a.version))
    .map((r) => ({ version: r.version, path: r.path, label: r.label || r.version, satisfies: inf.composerPhp ? semver.satisfies(r.version, inf.composerPhp) : null, newer: cur ? semver.compare(r.version, cur.version) > 0 : null }));
  return {
    current: cur ? { version: cur.version, path: cur.path } : null,
    targets,
    isLaravel: !!inf.isLaravel,
    hasLock: util.existsFile(win.join(p.path, 'composer.lock')),
    hasDb: !!p.dbServerId,
    configCached: !!inf.configCached,
  };
}

async function runJob(ctx, id, opts, log, job) {
  const p = projects.getProject(ctx, id);
  const cur = projects.resolveProjectPhp(ctx, p);
  if (!cur) throw projects.phpMissingError(p.phpVersion);
  const target = runtimes.getCache(ctx).php.find((r) => r.ok && util.samePath(r.path, String(opts.phpPath || '')));
  if (!target) throw new AppError('BAD_INPUT', tr('lab.noTarget'), 400);
  const cookie = cleanCookie(opts.cookie);
  const inf = projects.inspectProject(p.path);
  const curInv = runtimes.phpInvocation(cur);
  const tgtInv = runtimes.phpInvocation(target);
  const result = { current: { version: cur.version }, target: { version: target.version, path: target.path }, startedAt: util.nowIso() };
  const progress = (phase, done, total) => { if (job) job.progress = { phase, done, total }; };
  log('info', tr('lab.start', { name: p.name, from: cur.version, to: target.version }));

  // 1. packages ---------------------------------------------------------------------------
  if (opts.packages !== false) {
    progress('packages', 0, 1);
    const cj = util.readJson(win.join(p.path, 'composer.json'), null);
    const lock = util.readJson(win.join(p.path, 'composer.lock'), null);
    const pk = { constraint: inf.composerPhp || null, constraintOk: inf.composerPhp ? semver.satisfies(target.version, inf.composerPhp) : null, incompatible: [], missingExt: [], lock: !!lock };
    if (lock) pk.incompatible = incompatiblePackages(lock, target.version);
    const need = requiredExtensions(cj, lock);
    if (need.length) {
      const [mc, mt] = await Promise.all([
        util.run(curInv.file, [...curInv.preArgs, '-m'], { env: util.cleanEnv(), timeoutMs: 30000 }),
        util.run(tgtInv.file, [...tgtInv.preArgs, '-m'], { env: util.cleanEnv(), timeoutMs: 30000 }),
      ]);
      const hasC = parseModules(mc.stdout);
      const hasT = parseModules(mt.stdout);
      pk.missingExt = need.filter((x) => !hasT.has(x) && !['json', 'pcre', 'spl', 'standard', 'core', 'date', 'hash', 'random', 'reflection'].includes(x))
        .map((x) => ({ name: x, onCurrent: hasC.has(x) }));
    }
    if (pk.constraintOk === false) log('bad', tr('lab.constraintBad', { constraint: pk.constraint, version: target.version }));
    log(pk.incompatible.length ? 'bad' : 'ok', tr('lab.packages', { n: pk.incompatible.length }));
    for (const x of pk.incompatible.slice(0, 15)) log('bad', `  ${x.name} ${x.version}  (php ${x.constraint})`);
    for (const x of pk.missingExt) log('warn', tr('lab.missingExt', { ext: x.name, version: target.version }));
    result.packages = pk;
  }

  // 2. code ---------------------------------------------------------------------------------
  if (opts.lint !== false) {
    const files = appFiles(p.path);
    log('info', tr('lab.lintStart', { n: files.length, version: target.version }));
    const lint = { files: files.length, errors: [], deprecations: [] };
    let done = 0;
    await util.mapLimit(files, 6, async (f) => {
      const r = await lintOne(tgtInv, f, p.path);
      const rel = win.relative(p.path, f);
      if (r.error) {
        const before = await lintOne(curInv, f, p.path);
        lint.errors.push({ file: rel, line: r.error.line, message: r.error.message, alsoOnCurrent: !!before.error });
      }
      for (const d of r.deprecations) lint.deprecations.push({ file: rel, line: d.line, message: d.message });
      done++;
      progress('lint', done, files.length);
      if (done % 100 === 0) log('info', tr('lab.lintProgress', { done, total: files.length }));
    });
    lint.errors.sort((a, b) => a.file.localeCompare(b.file));
    lint.deprecations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    log(lint.errors.length ? 'bad' : 'ok', tr('lab.lintErrors', { n: lint.errors.length }));
    log(lint.deprecations.length ? 'warn' : 'ok', tr('lab.lintDeps', { n: lint.deprecations.length }));
    result.lint = lint;
  }

  // 3. pages --------------------------------------------------------------------------------
  if (opts.crawl !== false) {
    result.crawl = await crawl(ctx, p, { cur, curInv, target, tgtInv, inf, cookie, opts, log, progress });
  }

  const pk = result.packages || {};
  const blockers = (pk.incompatible || []).length + (pk.constraintOk === false ? 1 : 0) + (pk.missingExt || []).length
    + ((result.lint && result.lint.errors.filter((e) => !e.alsoOnCurrent).length) || 0) + ((result.crawl && result.crawl.counts.broken) || 0);
  const warnings = ((result.lint && result.lint.deprecations.length) || 0) + ((result.crawl && (result.crawl.counts.changed + result.crawl.counts.deprecated)) || 0);
  result.verdict = blockers ? 'blocked' : warnings ? 'warnings' : 'ready';
  result.blockers = blockers;
  result.warnings = warnings;
  result.endedAt = util.nowIso();
  log(blockers ? 'bad' : warnings ? 'warn' : 'ok', tr(`lab.verdict.${result.verdict}`, { version: target.version, blockers, warnings }));
  return result;
}

async function crawl(ctx, p, { cur, target, tgtInv, inf, cookie, opts, log, progress }) {
  const out = { routes: [], counts: { same: 0, broken: 0, changed: 0, deprecated: 0, bothFail: 0 }, source: null, note: null };
  const snap = await procs.getSnapshot({ fresh: true });
  const view = projects.views(ctx, snap, dbservers.views(ctx, snap).list).find((x) => x.id === p.id);
  if (!view || view.status !== 'running' || !view.run) {
    out.note = 'NOT_RUNNING';
    log('warn', tr('lab.notRunning'));
    return out;
  }
  const portA = view.run.port;

  if (opts.restorePoint !== false && p.dbServerId) {
    log('info', tr('lab.point'));
    await timemachine.createPoint(ctx, p.id, { reason: 'manual', log });
  }

  // the routes to compare
  let paths = [];
  const max = Math.min(400, Math.max(5, Number(opts.maxRoutes) || 120));
  const curInv = runtimes.phpInvocation(cur);
  const dbEntry = projects.dbEntryFor(ctx, p);
  const dbOverride = dbEntry ? projects.dbEnvOverride(ctx.store.data.settings, inf.env, { port: dbEntry.effectivePort }) : null;
  if (inf.isLaravel) {
    const r = await util.run(curInv.file, [...curInv.preArgs, 'artisan', 'route:list', '--json', '--method=GET'],
      { cwd: p.path, env: projects.projectEnv(ctx, p, cur, dbEntry, dbOverride), timeoutMs: 90000 });
    try {
      const start = r.stdout.indexOf('[');
      paths = filterRoutes(JSON.parse(r.stdout.slice(start)), max);
      out.source = 'routes';
    } catch {
      log('warn', tr('lab.routeListFailed'));
    }
  }
  if (!paths.length) {
    // crawl the links of the running site, breadth first
    out.source = 'links';
    const queue = ['/'];
    const seen = new Set(queue);
    while (queue.length && paths.length < Math.min(max, 80)) {
      const u = queue.shift();
      paths.push(u);
      const r = await fetchPage(portA, u, cookie);
      if (!/html/i.test(r.type)) continue;
      for (const l of extractLinks(r.body, u)) if (!seen.has(l)) { seen.add(l); queue.push(l); }
    }
  }
  log('info', tr('lab.routes', { n: paths.length }));

  // second server: the same folder on the target PHP
  const portB = await freePort();
  const labLog = path.join(ctx.dataDir, 'logs', 'upgrade-lab', `${p.id}.log`);
  util.ensureDir(path.dirname(labLog));
  fs.writeFileSync(labLog, `===== ${util.nowIso()} Upgrade Lab: PHP ${target.version} port ${portB} =====\r\n`);
  const set = Object.assign({}, dbOverride || {});
  // Laravel's deprecation channel (null by default) -> stderr -> this log, when the app has that channel
  const logging = util.readText(win.join(p.path, 'config', 'logging.php'), '') || '';
  if (inf.isLaravel && /['"]stderr['"]\s*=>/.test(logging)) set.LOG_DEPRECATIONS_CHANNEL = 'stderr';
  const router = inf.router === 'root' ? win.join(p.path, 'server.php') : inf.router === 'vendor' ? win.join(p.path, projects.VENDOR_ROUTER) : null;
  const toolDir = ctx.toolDir || path.resolve(__dirname, '..');
  const ht = !router && ctx.store.data.settings.htaccess !== false && util.existsFile(win.join(inf.docroot, '.htaccess'));
  // The test server reports what the current one reports, plus deprecations (many php.ini files hide
  // E_DEPRECATED). Its PHP errors also go to their own file; only the deprecations of that file count,
  // so the two sides stay comparable. Opcache is off there: it does not report compile-time deprecations again.
  const er = await util.run(curInv.file, [...curInv.preArgs, '-r', 'echo error_reporting();'], { env: util.cleanEnv(), timeoutMs: 20000 });
  const curLevel = Number.parseInt(er.stdout, 10);
  const level = (Number.isInteger(curLevel) ? curLevel : 32767) | 8192 | 16384; // | E_DEPRECATED | E_USER_DEPRECATED
  const labErr = path.join(ctx.dataDir, 'logs', 'upgrade-lab', `${p.id}.php-errors.log`);
  fs.writeFileSync(labErr, '');
  const args = projects.fastServeArgs({
    script: path.join(toolDir, 'tools', 'fastserve.js'), port: portB, docroot: inf.docroot, php: tgtInv.file, router, workers: 2,
    pre: [...tgtInv.preArgs, '-d', `auto_prepend_file=${devtools.prependFile(ctx)}`, '-d', `error_reporting=${level}`, '-d', 'log_errors=1', '-d', `error_log=${labErr}`, '-d', 'opcache.enable=0'],
    htrouter: ht ? path.join(toolDir, 'tools', 'htrouter.php') : null,
  });
  const pid = procs.spawnDetached(process.execPath, args, { cwd: inf.docroot, env: projects.projectEnv(ctx, p, target, dbEntry, set), logFile: labLog });
  if (!pid) throw new AppError('START_FAILED', tr('err.phpSpawnFailed'), 500);
  try {
    const up = await ports.waitForPort(portB, { timeoutMs: 20000, intervalMs: 200, isAlive: () => procs.pidExists(pid) });
    if (!up) throw new AppError('START_FAILED', tr('lab.labStartFailed', { version: target.version }), 500, { logTail: util.tailFile(labLog, 30).text });
    log('info', tr('lab.labUp', { version: target.version, port: portB }));

    const projLog = path.join(ctx.dataDir, 'logs', 'projects', `${p.id}.log`);
    const logsA = () => [...devlogs.laravelLogFiles(p.path), projLog];
    const logsB = () => [...devlogs.laravelLogFiles(p.path), labLog];
    let i = 0;
    for (const u of paths) {
      i++;
      progress('crawl', i, paths.length);
      let before = logSizes(logsA);
      const ra = await fetchPage(portA, u, cookie);
      const a = { status: ra.status, ms: ra.ms, bytes: ra.bytes, location: ra.location, markers: pageMarkers(ra.body), log: logGrowth(logsA, before) };
      before = logSizes(logsB);
      const errBefore = logSizes(() => [labErr]);
      const rb = await fetchPage(portB, u, cookie);
      const phpErr = logGrowth(() => [labErr], errBefore);
      const deps = phpErr.filter((e) => e.deprecation);
      const b = { status: rb.status, ms: rb.ms, bytes: rb.bytes, location: rb.location, markers: pageMarkers(rb.body).filter((m) => !/deprecat/i.test(m.level)), log: [...logGrowth(logsB, before), ...deps] };
      // the test server's own PHP errors: shown as the reason, not counted (the current server's are not read)
      b.phpErrors = phpErr.filter((e) => !e.deprecation).slice(0, 3);
      const v = verdict(a, b);
      out.counts[v]++;
      out.routes.push({ path: u, verdict: v, a, b });
      if (v === 'broken') log('bad', `${u}  ${a.status} → ${b.status}${b.log.find(BAD) ? `  ${b.log.find(BAD).message.slice(0, 160)}` : b.markers[0] ? `  ${b.markers[0].level}: ${b.markers[0].message.slice(0, 160)}` : ''}`);
      else if (v === 'changed') log('warn', `${u}  ${a.status} → ${b.status}`);
    }
  } finally {
    await procs.killTree(pid);
    procs.invalidateCaches();
  }
  const order = { broken: 0, changed: 1, deprecated: 2, bothFail: 3, same: 4 };
  out.routes.sort((x, y) => order[x.verdict] - order[y.verdict] || x.path.localeCompare(y.path));
  log(out.counts.broken ? 'bad' : 'ok', tr('lab.crawlDone', out.counts));
  return out;
}

module.exports = {
  // pure
  incompatiblePackages, requiredExtensions, parseModules, filterRoutes, extractLinks, pageMarkers, parseLogChunk, verdict, cleanCookie, fetchPage,
  // manager
  info, runJob,
};
