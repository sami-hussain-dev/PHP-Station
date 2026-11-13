'use strict';
/*
 * Projects: inspection (read-only), PHP suggestions, records, start/stop/reconcile, external
 * php -S servers (adopt/stop), shims + terminal, check/lint/clear-cache jobs and the explicit
 * .env DB_PORT writer (with a backup in the data dir).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const util = require('./util');
const semver = require('./semver');
const envfile = require('./envfile');
const procs = require('./procs');
const ports = require('./ports');
const runtimes = require('./runtimes');
const dbservers = require('./dbservers');
const share = require('./share');
const { tr, trConsole } = require('./i18n');

const { AppError } = util;
const win = path.win32;

const VENDOR_ROUTER = 'vendor\\laravel\\framework\\src\\Illuminate\\Foundation\\resources\\server.php';
const TERMINAL_ACTIONS = {
  shell: null,
  'composer-install': 'call composer install',
  'composer-update-dry': 'call composer update -W --dry-run',
  'check-platform': 'call composer check-platform-reqs',
  'migrate-status': 'call php artisan migrate:status',
  'optimize-clear': 'call php artisan optimize:clear',
  tinker: 'call php artisan tinker',
};

// ------------------------------------------------------------------------------------------ inspection (fs reads only)

function readJsonSafe(file) {
  return util.readJson(file, null);
}

function packageVersion(list, name) {
  if (!Array.isArray(list)) return null;
  const p = list.find((x) => x && String(x.name).toLowerCase() === name);
  if (!p || !p.version) return null;
  return String(p.version).replace(/^v/i, '');
}

function envSummary(dir) {
  const file = win.join(dir, '.env');
  const text = util.readText(file, null);
  if (text == null) return { exists: false, connection: null, host: null, port: null, database: null, username: null, passwordSet: false };
  const env = envfile.parseEnv(text);
  const portNum = Number.parseInt(env.DB_PORT, 10);
  return {
    exists: true,
    connection: env.DB_CONNECTION || null,
    host: env.DB_HOST || null,
    port: Number.isInteger(portNum) ? portNum : null,
    database: env.DB_DATABASE || null,
    username: env.DB_USERNAME || null,
    passwordSet: typeof env.DB_PASSWORD === 'string' && env.DB_PASSWORD !== '',
  };
}

/** Project facts from the folder (never writes). Fields per spec 5.7. */
function inspectProject(dir) {
  const d = util.cleanPath(dir);
  const exists = util.existsDir(d);
  const info = {
    exists,
    isLaravel: false,
    name: win.basename(d),
    composerPhp: null,
    laravelConstraint: null,
    laravelLocked: null,
    laravelInstalled: null,
    vendor: false,
    docroot: d,
    router: 'none',
    configCached: false,
    env: { exists: false, connection: null, host: null, port: null, database: null, username: null, passwordSet: false },
    requiredExt: [],
    hasComposerJson: false,
    hasIndexPhp: false,
  };
  if (!exists) return info;
  info.isLaravel = util.existsFile(win.join(d, 'artisan'));
  const cj = readJsonSafe(win.join(d, 'composer.json'));
  info.hasComposerJson = util.existsFile(win.join(d, 'composer.json'));
  if (cj && typeof cj === 'object') {
    const req = cj.require && typeof cj.require === 'object' ? cj.require : {};
    info.composerPhp = typeof req.php === 'string' ? req.php : null;
    info.laravelConstraint = typeof req['laravel/framework'] === 'string' ? req['laravel/framework'] : null;
    info.requiredExt = Object.keys(req).filter((k) => /^ext-/i.test(k)).map((k) => k.toLowerCase()).sort();
  }
  const lock = readJsonSafe(win.join(d, 'composer.lock'));
  if (lock && typeof lock === 'object') info.laravelLocked = packageVersion(lock.packages, 'laravel/framework');
  const installed = readJsonSafe(win.join(d, 'vendor', 'composer', 'installed.json'));
  if (installed) info.laravelInstalled = packageVersion(Array.isArray(installed) ? installed : installed.packages, 'laravel/framework');
  info.vendor = util.existsDir(win.join(d, 'vendor'));
  info.docroot = util.existsDir(win.join(d, 'public')) ? win.join(d, 'public') : d;
  if (util.existsFile(win.join(d, 'server.php'))) info.router = 'root';
  else if (util.existsFile(win.join(d, VENDOR_ROUTER))) info.router = 'vendor';
  info.configCached = util.existsFile(win.join(d, 'bootstrap', 'cache', 'config.php'));
  info.env = envSummary(d);
  info.hasIndexPhp = util.existsFile(win.join(d, 'index.php')) || util.existsFile(win.join(d, 'public', 'index.php'));
  return info;
}

const inspectCache = new Map();

function statSig(dir) {
  const parts = [];
  for (const f of ['composer.json', 'composer.lock', 'vendor\\composer\\installed.json', '.env', 'bootstrap\\cache\\config.php', 'server.php', 'artisan', 'public']) {
    try {
      const st = fs.statSync(win.join(dir, f));
      parts.push(`${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

/** inspectProject with a stat-signature cache (used on every /api/state). */
function inspectCached(dir) {
  const key = util.normPath(dir);
  const sig = util.existsDir(dir) ? statSig(dir) : 'missing';
  const c = inspectCache.get(key);
  if (c && c.sig === sig) return c.info;
  const info = inspectProject(dir);
  inspectCache.set(key, { sig, info });
  return info;
}

function laravelVersionOf(info) {
  return info.laravelLocked || info.laravelInstalled || null;
}

function laravelMajorOf(info) {
  const v = laravelVersionOf(info);
  if (v) return semver.majorOf(v);
  if (info.laravelConstraint) return semver.majorOf(info.laravelConstraint);
  return null;
}

/** Warning (current language) for Laravel/PHP combinations outside Laravel's support table, else null. */
function laravelPhpHint(laravelMajor, phpVersion) {
  if (laravelMajor === null || laravelMajor === undefined || laravelMajor === '') return null;
  const major = Number(laravelMajor);
  const v = semver.normalizeVersion(phpVersion);
  if (!Number.isInteger(major) || major < 1 || !v) return null;
  const ge = (a, b) => semver.compare(v, [a, b, 0]) >= 0;
  const lt = (a, b) => semver.compare(v, [a, b, 0]) < 0;
  const pv = `${v[0]}.${v[1]}`;
  if (major <= 7 && ge(8, 1)) return tr('hint.tooNew', { laravel: major, php: pv, max: '8.0' });
  if (major === 8 && ge(8, 2)) return tr('hint.deprecations', { laravel: 8, php: pv, max: '8.1' });
  if (major === 9 && ge(8, 3)) return tr('hint.notBuilt', { laravel: 9, php: pv, max: '8.2' });
  if (major === 10 && ge(8, 4)) return tr('hint.notBuilt', { laravel: 10, php: pv, max: '8.3' });
  if (major === 11 && lt(8, 2)) return tr('hint.needsMin', { laravel: 11, min: '8.2' });
  if (major === 12 && lt(8, 2)) return tr('hint.needsMin', { laravel: 12, min: '8.2' });
  if (major === 13 && lt(8, 3)) return tr('hint.needsMin', { laravel: 13, min: '8.3' });
  return null;
}

/** Sorted PHP suggestions: satisfies true without hint first (newest first), then null, then false. */
function suggestPhp(info, phpRuntimes) {
  const major = info ? laravelMajorOf(info) : null;
  const out = [];
  for (const r of phpRuntimes || []) {
    if (!r || r.ok === false || !r.version) continue;
    const sat = info && info.composerPhp ? semver.satisfies(r.version, info.composerPhp) : null;
    const hint = laravelPhpHint(major, r.version);
    let group;
    if (sat === true && !hint) group = 5;
    else if (sat === true) group = 4;
    else if (sat === null && !hint) group = 3;
    else if (sat === null) group = 2;
    else group = 1;
    const v = semver.normalizeVersion(r.version) || [0, 0, 0];
    const score = group * 1000000 + Math.min(v[0], 99) * 10000 + Math.min(v[1], 99) * 100 + Math.min(v[2], 99);
    out.push({ version: r.version, path: r.path, satisfies: sat, hint, score });
  }
  out.sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)));
  return out;
}

/** DB server whose effective port equals the .env port (local host only), preferring running ones. */
function suggestDbServer(info, dbServers) {
  if (!info || !info.env || !info.env.exists) return null;
  const host = info.env.host || '127.0.0.1';
  if (!util.isLocalHost(host)) return null;
  const port = info.env.port || 3306;
  const list = (dbServers || []).filter((s) => Number(s.port != null ? s.port : s.effectivePort) === port);
  if (!list.length) return null;
  const running = list.find((s) => s.status === 'running');
  return (running || list[0]).id;
}

// ------------------------------------------------------------------------------------------ shims + terminal

function batPath(p) {
  return String(p).replace(/%/g, '%%');
}

function echoSafe(s) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '-').replace(/[%^&|<>"!()]/g, '').trim();
}

function phpCmdPrefix(php) {
  const ini = php.iniRelocated && php.iniFile ? ` -c "${batPath(php.iniFile)}"` : '';
  return `"${batPath(php.path)}"${ini}`;
}

/** terminal.cmd content for a project and action. */
function buildTerminalScript({ project, php, composer, db, action = 'shell' }) {
  const lines = [];
  const name = echoSafe(project.name) || 'project';
  lines.push('@echo off');
  lines.push(`title PHP Station - ${name} - PHP ${echoSafe(php && php.version)}`);
  lines.push(`cd /d "${batPath(project.path)}"`);
  lines.push('echo.');
  lines.push(`echo   PHP Station terminal: ${name}`);
  lines.push(`echo   PHP       : ${echoSafe(php && php.version)}  (${echoSafe(php && php.path)})`);
  lines.push(`echo   Composer  : ${composer ? echoSafe(composer.version) : trConsole('term.noComposer')}`);
  lines.push(`echo   DB server : ${db ? `${echoSafe(db.label)} - port ${echoSafe(db.port)}` : trConsole('term.noDb')}`);
  lines.push(`echo   Folder    : ${echoSafe(project.path)}`);
  lines.push(`echo   ${trConsole('term.phpHint')}`);
  if (db) lines.push(`echo   ${trConsole('term.tmHint')}`);
  lines.push('echo.');
  const cmd = Object.prototype.hasOwnProperty.call(TERMINAL_ACTIONS, action) ? TERMINAL_ACTIONS[action] : null;
  if (cmd) {
    lines.push(`echo ^> ${cmd.replace(/^call /, '')}`);
    lines.push(cmd);
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * php.bat of a project. With `hook` ({node, script, dataDir}) it first asks the panel for a DB restore
 * point when the command is `php artisan migrate*` or `php artisan db:*` (tools\restore-point.js never
 * blocks the command); otherwise it only runs the project's PHP. PURE.
 */
function buildPhpBat(php, project, hook) {
  const run = `${phpCmdPrefix(php)} %*`;
  if (!hook || !hook.node || !hook.script || !hook.dataDir || !util.isCmdSafePath(hook.node) || !util.isCmdSafePath(hook.script) || !util.isCmdSafePath(hook.dataDir)) {
    return `@${run}\r\n`;
  }
  return [
    '@echo off',
    'if /i not "%~1"=="artisan" goto ps_run',
    'set "PS_ARTISAN=%~2"',
    'if not defined PS_ARTISAN goto ps_run',
    'if /i "%PS_ARTISAN:~0,7%"=="migrate" goto ps_point',
    'if /i "%PS_ARTISAN:~0,3%"=="db:" goto ps_point',
    'goto ps_run',
    ':ps_point',
    `"${batPath(hook.node)}" "${batPath(hook.script)}" "${batPath(hook.dataDir)}" "${project.id}" "%PS_ARTISAN%"`,
    ':ps_run',
    'set "PS_ARTISAN="',
    run,
  ].join('\r\n') + '\r\n';
}

/** Writes php.bat, composer.bat (if a composer is chosen) and terminal.cmd into <data>\shims\<id>. */
function writeShims({ dataDir, project, php, composer = null, db = null, action = 'shell', hook = null }) {
  if (!project || !project.id || !php || !php.path) throw new AppError('BAD_INPUT', tr('err.shimInput'));
  const dir = util.ensureDir(path.join(dataDir, 'shims', project.id));
  const phpBat = path.join(dir, 'php.bat');
  fs.writeFileSync(phpBat, buildPhpBat(php, project, hook && Object.assign({ dataDir }, hook)));
  const composerBat = path.join(dir, 'composer.bat');
  let composerOut = null;
  if (composer && composer.path) {
    fs.writeFileSync(composerBat, `@${phpCmdPrefix(php)} "${batPath(composer.path)}" %*\r\n`);
    composerOut = composerBat;
  } else {
    try { fs.unlinkSync(composerBat); } catch { /* not there */ }
  }
  const terminalCmd = path.join(dir, 'terminal.cmd');
  fs.writeFileSync(terminalCmd, buildTerminalScript({ project, php, composer, db, action }));
  return { dir, phpBat, composerBat: composerOut, terminalCmd };
}

// ------------------------------------------------------------------------------------------ records

function projectsList(ctx) {
  return ctx.store.data.projects;
}

function getProject(ctx, id) {
  const p = projectsList(ctx).find((x) => x.id === id);
  if (!p) throw new AppError('PROJECT_NOT_FOUND', tr('err.projectNotFound'), 404);
  return p;
}

function phpMissingError(v) {
  return new AppError('PHP_MISSING', tr('err.phpMissing', { version: v || '?' }), 409);
}

function resolveProjectPhp(ctx, project) {
  return runtimes.resolvePhp(ctx, project.phpVersion, project.phpPath);
}

function dbEntryFor(ctx, project) {
  if (!project.dbServerId) return null;
  return dbservers.buildEntries(ctx).find((e) => e.id === project.dbServerId) || null;
}

function validatePhpChoice(ctx, version, phpPath) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) throw new AppError('BAD_INPUT', tr('err.choosePhp'));
  const r = runtimes.resolvePhp(ctx, version, phpPath || null);
  if (!r) throw phpMissingError(version);
  return r;
}

function validateComposer(ctx, id) {
  if (id === null || id === undefined || id === '') return null;
  if (!runtimes.findComposer(ctx, id)) throw new AppError('BAD_INPUT', tr('err.composerNotInList'));
  return id;
}

function validateDbServer(ctx, id) {
  if (id === null || id === undefined || id === '') return null;
  if (!dbservers.buildEntries(ctx).some((e) => e.id === id)) throw new AppError('BAD_INPUT', tr('err.dbNotInList'));
  return id;
}

async function assignPort(ctx, excludeId, preferred) {
  const s = ctx.store.data.settings;
  const reserved = projectsList(ctx).filter((p) => p.id !== excludeId).map((p) => p.port);
  let busy = [];
  try { busy = (await procs.listListeners({ maxAgeMs: 0 })).map((l) => l.port); } catch { /* best effort */ }
  const p = ports.pickPort({ from: s.webPortRange[0], to: s.webPortRange[1], preferred, reserved, busy });
  if (!p) throw new AppError('NO_PORT', tr('err.noWebPort'), 409);
  return p;
}

async function addProject(ctx, body) {
  const dir = util.checkUserPath(body.path, { kind: 'dir', label: tr('label.projectFolder') });
  if (projectsList(ctx).some((p) => util.samePath(p.path, dir))) throw new AppError('ALREADY_ADDED', tr('err.alreadyAdded'), 409);
  const php = validatePhpChoice(ctx, body.phpVersion, body.phpPath);
  const name = util.cleanText(body.name || '', 80) || win.basename(dir);
  const wanted = Number.isInteger(body.port) ? body.port : null;
  const port = await assignPort(ctx, null, wanted);
  const project = {
    id: `${util.slugify(name)}-${util.randomHex(2)}`,
    name,
    path: dir,
    phpVersion: php.version,
    phpPath: php.path,
    composerId: validateComposer(ctx, body.composerId),
    dbServerId: validateDbServer(ctx, body.dbServerId),
    port,
    // asked once before the first run, unless the port was chosen explicitly here
    portConfirmed: wanted !== null && wanted === port,
    createdAt: util.nowIso(),
    lastStartedAt: null,
  };
  projectsList(ctx).push(project);
  ctx.store.save();
  return project;
}

async function updateProject(ctx, id, body) {
  const p = getProject(ctx, id);
  const running = await isRunningNow(ctx, p);
  const touchesRuntime = ['phpVersion', 'phpPath', 'composerId', 'dbServerId', 'port'].some((k) => k in body && body[k] !== p[k]);
  if (running && touchesRuntime) throw new AppError('RUNNING', tr('err.stopToChange'), 409);
  if ('name' in body) {
    const n = util.cleanText(String(body.name || ''), 80);
    if (!n) throw new AppError('BAD_INPUT', tr('err.nameEmpty'));
    p.name = n;
  }
  if ('phpVersion' in body || 'phpPath' in body) {
    const r = validatePhpChoice(ctx, body.phpVersion || p.phpVersion, body.phpPath || (body.phpVersion ? null : p.phpPath));
    p.phpVersion = r.version;
    p.phpPath = r.path;
  }
  if ('composerId' in body) p.composerId = validateComposer(ctx, body.composerId);
  if ('dbServerId' in body) p.dbServerId = validateDbServer(ctx, body.dbServerId);
  if ('port' in body) {
    const n = Number(body.port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new AppError('BAD_PORT', tr('err.portRange'));
    if (projectsList(ctx).some((x) => x.id !== p.id && x.port === n)) throw new AppError('PORT_USED', tr('err.portUsedProject', { port: n }), 409);
    p.port = n;
    p.portConfirmed = true;
  }
  ctx.store.save();
  return p;
}

async function removeProject(ctx, id) {
  const p = getProject(ctx, id);
  if (await isRunningNow(ctx, p)) await stopProject(ctx, id);
  ctx.store.data.projects = projectsList(ctx).filter((x) => x.id !== id);
  delete ctx.store.data.runs[id];
  ctx.store.save();
}

// ------------------------------------------------------------------------------------------ status

function serverArgMatches(proc, port) {
  if (!proc || !proc.cmd) return false;
  const argv = procs.splitCommandLine(proc.cmd);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = a === '-S' ? argv[i + 1] : (a.startsWith('-S') ? a.slice(2) : null);
    if (val && (val === `127.0.0.1:${port}` || val.toLowerCase() === `localhost:${port}`)) return true;
  }
  return false;
}

/** PHP workers per project (settings.phpWorkers, 1-16, default 4). PURE. */
function phpWorkersOf(settings) {
  const n = settings && Number(settings.phpWorkers);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 4;
}

/** Command line of tools\fastserve.js (php args travel as base64 JSON: no quoting issues). PURE. */
function fastServeArgs({ script, port, docroot, php, router, workers, pre }) {
  const a = [script, '--port', String(port), '--docroot', docroot, '--php', php, '--workers', String(workers)];
  if (router) a.push('--router', router);
  if (pre && pre.length) a.push('--pre', Buffer.from(JSON.stringify(pre)).toString('base64'));
  return a;
}

/** The project's own server process: plain `php -S 127.0.0.1:<port>` or the fast server (tools\fastserve.js --port <port>). */
function ownServerMatches(proc, port) {
  if (!proc || !proc.cmd) return false;
  if (proc.name === 'php.exe') return serverArgMatches(proc, port);
  if (proc.name !== 'node.exe') return false;
  const argv = procs.splitCommandLine(proc.cmd);
  if (!argv.some((x) => /[\\/]fastserve\.js$/i.test(x))) return false;
  const i = argv.indexOf('--port');
  return i > 0 && argv[i + 1] === String(port);
}

/**
 * Status of a project from a snapshot: {status, run, external|null}. Updates ctx runs
 * (marks ctx.dirty when it changed).
 */
function reconcileOne(ctx, project, snap) {
  const runs = ctx.store.data.runs;
  const starting = ctx.projStarting && ctx.projStarting.has(project.id);
  const run = runs[project.id];
  if (run && !run.external) {
    const proc = snap.procs.find((x) => x.pid === Number(run.pid));
    if (proc && ownServerMatches(proc, run.port)) return { status: 'running', run, ext: null };
  }
  const ext = snap.externals.find((e) => e.projectPath && util.samePath(e.projectPath, project.path)
    && !isTrackedPid(ctx, e.pid, project.id));
  if (ext) {
    const r = { pid: ext.topPid, serverPid: ext.pid, port: ext.port, phpPath: ext.phpPath, startedAt: (run && run.external && run.pid === ext.topPid && run.startedAt) || util.nowIso(), external: true };
    if (!run || run.pid !== r.pid || !run.external || run.port !== r.port) {
      runs[project.id] = r;
      ctx.dirty = true;
    }
    return { status: 'running', run: runs[project.id], ext };
  }
  if (starting) return { status: 'starting', run: run || null, ext: null };
  if (run && snap.ok) {
    delete runs[project.id];
    ctx.dirty = true;
  }
  return { status: 'stopped', run: null, ext: null };
}

function isTrackedPid(ctx, pid, exceptId) {
  for (const [id, r] of Object.entries(ctx.store.data.runs)) {
    if (id !== exceptId && r && !r.external && Number(r.pid) === Number(pid)) return true;
  }
  return false;
}

async function isRunningNow(ctx, project) {
  const snap = await procs.getSnapshot({ fresh: true });
  return reconcileOne(ctx, project, snap).status !== 'stopped';
}

function projectWarnings(ctx, project, info, php, dbView) {
  const w = [];
  if (!info.exists) w.push({ code: 'NOT_FOUND', level: 'bad', text: tr('warn.folderMissing', { path: project.path }), params: { path: project.path } });
  if (!php) w.push({ code: 'PHP_MISSING', level: 'bad', text: phpMissingError(project.phpVersion).message, params: { version: project.phpVersion || null } });
  if (info.composerPhp && project.phpVersion) {
    const sat = semver.satisfies(project.phpVersion, info.composerPhp);
    if (sat === false) {
      w.push({
        code: 'PHP_CONSTRAINT', level: 'warn', text: tr('warn.phpConstraint', { constraint: info.composerPhp, version: project.phpVersion }),
        params: { constraint: info.composerPhp, version: project.phpVersion },
      });
    }
  }
  const major = laravelMajorOf(info);
  const hint = laravelPhpHint(major, project.phpVersion);
  if (info.isLaravel && hint) w.push({ code: 'LARAVEL_PHP', level: 'warn', text: hint, params: { laravel: major, php: project.phpVersion } });
  if (dbView && info.env.exists) {
    const envPort = info.env.port || 3306;
    if (envPort !== dbView.port) {
      w.push({
        code: 'ENV_DB_PORT_MISMATCH', level: 'warn',
        text: tr('warn.envPortMismatch', { envPort: info.env.port == null ? tr('warn.envPortUnset') : info.env.port, serverPort: dbView.port }),
        envPort: info.env.port, serverPort: dbView.port, params: { envPort: info.env.port, serverPort: dbView.port },
      });
    }
  }
  if (info.isLaravel && info.configCached) w.push({ code: 'CONFIG_CACHED', level: 'warn', text: tr('warn.configCached'), params: {} });
  if (info.isLaravel && !info.vendor) w.push({ code: 'NO_VENDOR', level: 'bad', text: tr('warn.noVendor'), params: {} });
  return w;
}

/** ProjectView list (spec 6) + updated externals info. */
function views(ctx, snap, dbViews) {
  const cache = runtimes.getCache(ctx);
  const out = [];
  for (const p of projectsList(ctx)) {
    const info = inspectCached(p.path);
    const php = resolveProjectPhp(ctx, p);
    const comp = runtimes.findComposer(ctx, p.composerId);
    const dbView = p.dbServerId ? dbViews.find((d) => d.id === p.dbServerId) || null : null;
    const st = reconcileOne(ctx, p, snap);
    const port = st.run ? st.run.port : p.port;
    out.push({
      id: p.id,
      name: p.name,
      path: p.path,
      phpVersion: p.phpVersion,
      phpPath: p.phpPath,
      php: { ok: !!php, resolvedPath: php ? php.path : null, label: php ? php.label : null, iniFile: php ? php.iniFile || null : null },
      composerId: p.composerId,
      composer: comp ? { version: comp.version, path: comp.path } : null,
      dbServerId: p.dbServerId,
      db: dbView ? { label: dbView.label, port: dbView.port, status: dbView.status } : null,
      port: p.port,
      portConfirmed: p.portConfirmed !== false,
      url: st.status === 'running' ? `http://127.0.0.1:${port}` : null,
      status: st.status,
      run: st.run ? { pid: st.run.pid, startedAt: st.run.startedAt, external: !!st.run.external, port: st.run.port } : null,
      lastStartedAt: p.lastStartedAt || null,
      share: share.viewFor(ctx, p.id, st.status === 'running' && st.run ? st.run.port : null),
      sharePrepend: !!(st.run && st.run.sharePrepend),
      info: {
        isLaravel: info.isLaravel,
        laravel: laravelVersionOf(info),
        laravelConstraint: info.laravelConstraint,
        composerPhp: info.composerPhp,
        vendor: info.vendor,
        router: info.router,
        configCached: info.configCached,
        exists: info.exists,
        env: info.env,
      },
      warnings: projectWarnings(ctx, p, info, php, dbView),
      suggestions: { php: suggestPhp(info, cache.php).map(({ version, path: pp, satisfies, hint }) => ({ version, path: pp, satisfies, hint })) },
    });
  }
  return out;
}

/** External php -S servers for the state (tracked panel servers excluded). */
function externalViews(ctx, snap) {
  const projects = projectsList(ctx);
  const pmaRoot = path.join(runtimes.toolRuntimesDir(ctx), 'phpmyadmin');
  return snap.externals
    .filter((e) => !isTrackedPid(ctx, e.pid, null))
    // PHP Station's own phpMyAdmin server is not an "external" server
    .filter((e) => !(e.docroot && (util.isInside(e.docroot, pmaRoot) || util.samePath(e.docroot, pmaRoot))))
    .map((e) => {
      const rt = e.phpPath ? runtimes.findPhpByPath(ctx, e.phpPath) : null;
      const match = e.projectPath ? projects.find((p) => util.samePath(p.path, e.projectPath)) : null;
      return {
        pid: e.pid, topPid: e.topPid, host: e.host, port: e.port, phpPath: e.phpPath, phpVersion: rt ? rt.version : null,
        projectPath: e.projectPath, router: e.router, docroot: e.docroot, via: e.via, matchesProjectId: match ? match.id : null,
      };
    });
}

// ------------------------------------------------------------------------------------------ start / stop

function projectEnv(ctx, project, php, dbEntry, set = null) {
  const pre = [path.join(ctx.dataDir, 'shims', project.id), php.dir];
  if (dbEntry && dbEntry.binDir) pre.push(dbEntry.binDir);
  return util.cleanEnv({ prependPath: pre, set: set || {} });
}

/**
 * {DB_PORT} to put into the PHP server's environment when the project's .env (local MySQL/MariaDB)
 * names another port than the server PHP Station really used; null when nothing needs overriding or
 * the setting is off. PURE.
 */
function dbEnvOverride(settings, env, dbUse) {
  if (!dbUse || !Number.isInteger(dbUse.port) || (settings && settings.dbEnvOverride === false)) return null;
  if (!env || !env.exists) return null;
  if (env.connection && !/^(mysql|mariadb)$/i.test(env.connection)) return null;
  if (env.host && !util.isLocalHost(env.host)) return null;
  if (env.port === dbUse.port) return null;
  return { DB_PORT: String(dbUse.port) };
}

function regenShims(ctx, project, php, action = 'shell') {
  const comp = runtimes.findComposer(ctx, project.composerId);
  const dbEntry = dbEntryFor(ctx, project);
  return writeShims({
    dataDir: ctx.dataDir,
    project,
    php,
    composer: comp,
    db: dbEntry ? { label: dbEntry.label, port: dbEntry.effectivePort, binDir: dbEntry.binDir } : null,
    action,
    // DB Time Machine: restore point before `php artisan migrate*` / `db:*` (only with a DB server)
    hook: dbEntry ? { node: process.execPath, script: path.join(ctx.toolDir || path.resolve(__dirname, '..'), 'tools', 'restore-point.js') } : null,
  });
}

function projectLogFile(ctx, id) {
  return path.join(ctx.dataDir, 'logs', 'projects', `${id}.log`);
}

/** Port offered in the PORT_CONFIRM question: the sticky port when free, else a free one. */
async function suggestStartPort(ctx, p, snap) {
  const takenByOther = projectsList(ctx).some((x) => x.id !== p.id && x.port === p.port);
  const listening = snap.listeners.some((l) => l.port === p.port);
  if (Number.isInteger(p.port) && !takenByOther && !listening) return p.port;
  try { return await assignPort(ctx, p.id, null); } catch { return null; }
}

/** A port given with start: integer 1024-65535, not another project's, not listening. */
function applyStartPort(ctx, p, raw, snap) {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new AppError('BAD_INPUT', tr('err.portRange'), 400);
  const other = projectsList(ctx).find((x) => x.id !== p.id && x.port === n);
  if (other) throw new AppError('PORT_TAKEN', tr('err.portTakenBy', { port: n, name: other.name }), 409);
  const l = snap.listeners.find((x) => x.port === n);
  if (l) throw new AppError('PORT_BUSY', tr('err.portBusyPid', { port: n, pid: l.pid, detail: '' }), 409);
  p.port = n;
  p.portConfirmed = true;
  ctx.store.save();
  ctx.log(`project ${p.id} port confirmed ${n}`);
}

/**
 * DB_MISSING check: the .env database (local MySQL/MariaDB only) must exist on the project's
 * DB server. Returns null (fine / could not check -> never blocks) or
 * {database, dbServerId, foundOn:[{serverId, label, port, sizeMB}], warning?}.
 * Credentials: project .env first, then root / empty (never logged).
 */
async function findMissingDatabase(ctx, p, entry) {
  const env = inspectProject(p.path).env;
  if (!env.exists || !env.database) return null;
  if (env.connection && !/^(mysql|mariadb)$/i.test(env.connection)) return null;
  if (env.host && !util.isLocalHost(env.host)) return null;
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(env.database)) return null;
  const candidates = dbservers.credCandidates(ctx, p.id);
  const check = async (e) => {
    for (const c of candidates) {
      try {
        return { size: await dbservers.databaseSize(ctx, e, env.database, c, { timeoutMs: 15000 }) };
      } catch (err) {
        if (err.code !== 'NEED_CREDENTIALS') return { error: err };
      }
    }
    return { error: new AppError('NEED_CREDENTIALS', tr('err.needCreds'), 409) };
  };
  const own = await check(entry);
  if (own.error) {
    ctx.log(`project ${p.id}: database check skipped (${own.error.code || 'error'})`);
    return { skipped: true, warning: tr('warn.dbCheckSkipped', { message: own.error.message }) };
  }
  if (own.size !== null) return null;
  const snap = await procs.getSnapshot({ fresh: true });
  const others = dbservers.buildEntries(ctx).filter((e) => e.id !== entry.id && dbservers.entryStatus(ctx, e, snap).status === 'running');
  const foundOn = [];
  for (const e of others) {
    const r = await check(e);
    if (!r.error && r.size !== null) foundOn.push({ serverId: e.id, label: e.label, port: e.effectivePort, sizeMB: r.size });
  }
  return { database: env.database, dbServerId: entry.id, foundOn };
}

async function startProject(ctx, id, { startDb = false, port: wantPort = undefined, skipDbCheck = false, sharePrepend = false } = {}) {
  const p = getProject(ctx, id);
  if (!ctx.projStarting) ctx.projStarting = new Set();
  if (ctx.projStarting.has(id)) throw new AppError('ALREADY_STARTING', tr('err.projectAlreadyStarting'), 409);
  ctx.projStarting.add(id);
  try {
    let snap = await procs.getSnapshot({ fresh: true });
    const cur = reconcileOne(ctx, p, snap);
    if (cur.status === 'running') return { ok: true, url: `http://127.0.0.1:${cur.run.port}`, alreadyRunning: true };
    if (!util.existsDir(p.path)) throw new AppError('NOT_FOUND', tr('err.projectFolderMissing', { path: p.path }), 404);
    const php = resolveProjectPhp(ctx, p);
    if (!php) throw phpMissingError(p.phpVersion);

    // the port is asked once, before the first run
    if (wantPort !== undefined && wantPort !== null) applyStartPort(ctx, p, wantPort, snap);
    else if (p.portConfirmed === false) {
      return { ok: false, code: 'PORT_CONFIRM', suggestedPort: await suggestStartPort(ctx, p, snap), port: p.port, error: tr('err.portConfirm') };
    }

    const dbEntry = dbEntryFor(ctx, p);
    const settings = ctx.store.data.settings;
    let dbCheckWarning = null;
    // dbUse: the server the project really talks to (its own entry, or one already serving the same datadir)
    let dbUse = null;
    let dbNote = null;
    if (p.dbServerId && dbEntry) {
      const st = dbservers.entryStatus(ctx, dbEntry, snap);
      if (st.status === 'running') {
        dbUse = { entry: dbEntry, port: dbEntry.effectivePort, label: dbEntry.label, via: 'own' };
      } else {
        if (!startDb && settings.autoStartDb === false) {
          return { ok: false, code: 'DB_STOPPED', dbServerId: dbEntry.id, error: tr('err.dbStopped', { label: dbEntry.label }) };
        }
        // Same data already served by another server (Laragon/XAMPP, maybe as admin)? Use it.
        const other = await dbservers.findDatadirServer(ctx, dbEntry, snap, { projectId: p.id });
        if (other) {
          dbUse = other;
          dbNote = tr('note.dbUsingRunning', { label: other.label, port: other.port });
          ctx.log(`project ${p.id}: DB ${dbEntry.id} stopped, using ${other.via} server on port ${other.port} (same datadir)`);
        } else {
          await dbservers.startServer(ctx, dbEntry.id, {});
          dbUse = { entry: dbEntry, port: dbEntry.effectivePort, label: dbEntry.label, via: 'started' };
          dbNote = tr('note.dbAutoStarted', { label: dbEntry.label, port: dbEntry.effectivePort });
        }
        snap = await procs.getSnapshot({ fresh: true });
      }
      if (!skipDbCheck) {
        const miss = await findMissingDatabase(ctx, p, dbUse.entry);
        if (miss && miss.skipped) dbCheckWarning = miss.warning;
        else if (miss) {
          return {
            ok: false, code: 'DB_MISSING', database: miss.database, dbServerId: miss.dbServerId, foundOn: miss.foundOn,
            error: tr('err.dbMissing', { db: miss.database, label: dbEntry.label }),
          };
        }
        snap = await procs.getSnapshot({ fresh: true });
      }
    }

    let port = p.port;
    let portChanged = false;
    if (snap.listeners.some((l) => l.port === port)) {
      port = await assignPort(ctx, p.id, null);
      p.port = port;
      portChanged = true;
      ctx.store.save();
    }

    const info = inspectProject(p.path);
    regenShims(ctx, p, php);
    const inv = runtimes.phpInvocation(php);
    // live share: requests through the tunnel are HTTPS for the app (lib/share.js)
    const prepend = sharePrepend ? ['-d', `auto_prepend_file=${share.prependFile(ctx)}`] : [];
    const args = [...inv.preArgs, ...prepend, '-S', `127.0.0.1:${port}`, '-t', info.docroot];
    if (info.router === 'root') args.push(win.join(p.path, 'server.php'));
    else if (info.router === 'vendor') args.push(win.join(p.path, VENDOR_ROUTER));
    const logFile = projectLogFile(ctx, p.id);
    util.ensureDir(path.dirname(logFile));
    util.rotateIfLarge(logFile);
    fs.appendFileSync(logFile, `===== ${util.nowIso()} start PHP ${php.version} port ${port} =====\r\n`);
    // .env points to another port than the server really used: override DB_PORT for this run only
    // (the process environment wins over .env in Laravel's dotenv; the .env file is not touched).
    const dbOverride = dbEnvOverride(settings, info.env, dbUse);
    if (dbOverride) {
      fs.appendFileSync(logFile, `PHP Station: DB_PORT=${dbOverride.DB_PORT} (env override, .env says ${info.env.port == null ? 'nothing' : info.env.port})\r\n`);
      ctx.log(`project ${p.id}: env override DB_PORT=${dbOverride.DB_PORT}`);
    }
    // Fast server (default): php -S handles one request at a time on Windows, so N workers behind a
    // small Node server (static files served directly). phpWorkers = 1 keeps the plain php -S.
    const workers = phpWorkersOf(settings);
    const router = info.router === 'root' ? win.join(p.path, 'server.php') : info.router === 'vendor' ? win.join(p.path, VENDOR_ROUTER) : null;
    const spawnFile = workers > 1 ? process.execPath : inv.file;
    const spawnArgs = workers > 1 ? fastServeArgs({
      script: path.join(ctx.toolDir || path.resolve(__dirname, '..'), 'tools', 'fastserve.js'),
      port, docroot: info.docroot, php: inv.file, router, workers, pre: [...inv.preArgs, ...prepend],
    }) : args;
    if (workers > 1) fs.appendFileSync(logFile, `PHP Station: fast server, ${workers} PHP workers\r\n`);
    const pid = procs.spawnDetached(spawnFile, spawnArgs, { cwd: info.docroot, env: projectEnv(ctx, p, php, dbEntry, dbOverride), logFile });
    if (!pid) throw new AppError('START_FAILED', tr('err.phpSpawnFailed'), 500, { logTail: util.tailFile(logFile, 30).text });
    ctx.log(`spawn project ${p.id} pid ${pid} PHP ${php.version} port ${port}`);
    const ok = await ports.waitForPort(port, { timeoutMs: 15000, intervalMs: 200, isAlive: () => procs.pidExists(pid) });
    procs.invalidateCaches();
    if (!ok) {
      if (procs.pidExists(pid)) {
        const k = await procs.killTree(pid);
        ctx.log(`kill project ${p.id} pid ${pid} after failed start: ${k.ok}`);
      }
      return { ok: false, code: 'START_FAILED', error: tr('err.projectStartFailed', { port }), logTail: util.tailFile(logFile, 30).text };
    }
    ctx.store.data.runs[p.id] = { pid, port, phpPath: php.path, startedAt: util.nowIso(), external: false };
    if (sharePrepend) ctx.store.data.runs[p.id].sharePrepend = true;
    p.lastStartedAt = util.nowIso();
    ctx.store.save();
    const res = { ok: true, url: `http://127.0.0.1:${port}`, pid, port };
    if (portChanged) res.portChanged = true;
    if (dbCheckWarning) res.dbCheckWarning = dbCheckWarning;
    if (dbNote) res.dbNote = dbNote;
    if (dbOverride) res.dbEnvPort = Number(dbOverride.DB_PORT);
    if (dbOverride) res.dbEnvOverride = tr('note.dbEnvOverride', { port: dbOverride.DB_PORT, envPort: info.env.port == null ? '-' : info.env.port });
    return res;
  } finally {
    ctx.projStarting.delete(id);
  }
}

async function stopProject(ctx, id) {
  const p = getProject(ctx, id);
  const snap = await procs.getSnapshot({ fresh: true });
  const st = reconcileOne(ctx, p, snap);
  if (st.status !== 'running' || !st.run) {
    delete ctx.store.data.runs[id];
    ctx.store.save();
    return { ok: true, wasRunning: false };
  }
  const pid = Number(st.run.pid);
  // Re-verify: our own php -S, or the top of a verified external chain.
  let verified = false;
  if (st.run.external) verified = !!(st.ext && st.ext.topPid === pid);
  else verified = !!snap.procs.find((x) => x.pid === pid && ownServerMatches(x, st.run.port));
  if (!verified) throw new AppError('NOT_VERIFIED', tr('err.notVerified'), 409);
  const k = await procs.killTree(pid);
  ctx.log(`kill project ${id} pid ${pid}${st.run.external ? ' (external)' : ''}: ${k.ok}`);
  await ports.waitForPortClosed(st.run.port, { timeoutMs: 5000 });
  delete ctx.store.data.runs[id];
  ctx.store.save();
  procs.invalidateCaches();
  return { ok: true, wasRunning: true };
}

async function restartProject(ctx, id, opts) {
  await stopProject(ctx, id);
  return startProject(ctx, id, opts || {});
}

// ------------------------------------------------------------------------------------------ externals

async function findExternal(ctx, pid) {
  const n = Number(pid);
  if (!Number.isInteger(n)) throw new AppError('BAD_INPUT', tr('err.badPid'));
  const snap = await procs.getSnapshot({ fresh: true });
  const list = externalViews(ctx, snap);
  const ext = list.find((e) => e.pid === n || e.topPid === n);
  if (!ext) throw new AppError('NOT_EXTERNAL', tr('err.notExternal'), 404);
  return ext;
}

async function adoptExternal(ctx, pid) {
  const ext = await findExternal(ctx, pid);
  if (!ext.projectPath || !util.existsDir(ext.projectPath)) throw new AppError('NO_PROJECT_PATH', tr('err.noProjectPath'), 409);
  const existing = projectsList(ctx).find((p) => util.samePath(p.path, ext.projectPath));
  if (existing) return existing;
  let rt = ext.phpPath ? runtimes.findPhpByPath(ctx, ext.phpPath) : null;
  if (!rt || !rt.ok) {
    const info = inspectProject(ext.projectPath);
    const s = suggestPhp(info, runtimes.getCache(ctx).php)[0];
    rt = s ? runtimes.resolvePhp(ctx, s.version, s.path) : null;
  }
  if (!rt) throw new AppError('PHP_MISSING', tr('err.noPhpRuntime'), 409);
  const name = win.basename(util.cleanPath(ext.projectPath));
  const project = {
    id: `${util.slugify(name)}-${util.randomHex(2)}`,
    name,
    path: util.cleanPath(ext.projectPath),
    phpVersion: rt.version,
    phpPath: rt.path,
    composerId: null,
    dbServerId: null,
    port: ext.port,
    portConfirmed: true,
    createdAt: util.nowIso(),
    lastStartedAt: null,
  };
  const info = inspectProject(project.path);
  const dbv = dbservers.buildEntries(ctx).map((e) => ({ id: e.id, port: e.effectivePort, status: 'stopped' }));
  project.dbServerId = suggestDbServer(info, dbv);
  projectsList(ctx).push(project);
  ctx.store.save();
  ctx.log(`adopt external pid ${ext.pid} -> project ${project.id}`);
  return project;
}

async function stopExternal(ctx, pid) {
  const ext = await findExternal(ctx, pid);
  const k = await procs.killTree(ext.topPid);
  ctx.log(`kill external php server topPid ${ext.topPid} (server ${ext.pid}, port ${ext.port}): ${k.ok}`);
  await ports.waitForPortClosed(ext.port, { timeoutMs: 5000 });
  procs.invalidateCaches();
  if (!k.ok && procs.pidExists(ext.topPid)) throw new AppError('STOP_FAILED', tr('err.stopFailed', { output: k.output }), 500);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------ terminal / folder / logs

function openTerminal(ctx, id, action) {
  if (!Object.prototype.hasOwnProperty.call(TERMINAL_ACTIONS, action)) throw new AppError('BAD_INPUT', tr('err.badTerminalAction'));
  const p = getProject(ctx, id);
  const php = resolveProjectPhp(ctx, p);
  if (!php) throw phpMissingError(p.phpVersion);
  if (!util.existsDir(p.path)) throw new AppError('NOT_FOUND', tr('err.projectFolderMissing', { path: p.path }), 404);
  if (/^composer/.test(action) || action === 'check-platform') {
    if (!p.composerId || !runtimes.findComposer(ctx, p.composerId)) throw new AppError('NO_COMPOSER', tr('err.noComposer'));
  }
  const shims = regenShims(ctx, p, php, action);
  if (!util.isCmdSafePath(shims.terminalCmd)) throw new AppError('BAD_PATH', tr('err.dataDirUnsafe'));
  const env = projectEnv(ctx, p, php, dbEntryFor(ctx, p));
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "PHP Station" cmd.exe /d /k "${shims.terminalCmd}"`], {
    windowsVerbatimArguments: true, detached: true, stdio: 'ignore', env, cwd: p.path, shell: false,
  });
  child.on('error', () => { /* reported via log only */ });
  child.unref();
  ctx.log(`terminal ${p.id} action ${action} pid ${child.pid}`);
  return { ok: true };
}

function openFolder(ctx, id) {
  const p = getProject(ctx, id);
  if (!util.existsDir(p.path)) throw new AppError('NOT_FOUND', tr('err.projectFolderMissing', { path: p.path }), 404);
  const child = spawn('explorer.exe', [p.path], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
  return { ok: true };
}

function getLog(ctx, id, lines) {
  getProject(ctx, id);
  const t = util.tailFile(projectLogFile(ctx, id), lines);
  return { ok: true, text: t.text, size: t.size };
}

function clearLog(ctx, id) {
  getProject(ctx, id);
  const f = projectLogFile(ctx, id);
  if (util.existsFile(f)) fs.writeFileSync(f, '');
  return { ok: true };
}

// ------------------------------------------------------------------------------------------ .env writer

async function writeEnvDb(ctx, id, body) {
  const p = getProject(ctx, id);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('BAD_PORT', tr('err.badPort'));
  const updates = { DB_PORT: String(port) };
  if (body.host !== undefined && body.host !== null && body.host !== '') {
    if (typeof body.host !== 'string' || !/^[A-Za-z0-9.\-:]{1,100}$/.test(body.host)) throw new AppError('BAD_INPUT', tr('err.badHost'));
    updates.DB_HOST = body.host;
  }
  if (body.database !== undefined && body.database !== null && body.database !== '') {
    if (typeof body.database !== 'string' || !/^[A-Za-z0-9_$-]{1,64}$/.test(body.database)) throw new AppError('BAD_INPUT', tr('err.badDbName'));
    updates.DB_DATABASE = body.database;
  }
  const envPath = win.join(p.path, '.env');
  const text = util.readText(envPath, null);
  if (text == null) throw new AppError('NO_ENV', tr('err.noEnv'), 404);
  const raw = fs.readFileSync(envPath);
  const cur = envfile.parseEnv(text);
  const changed = Object.keys(updates).filter((k) => cur[k] !== updates[k]);
  const backupDir = util.ensureDir(path.join(ctx.dataDir, 'env-backups', p.id));
  const backup = path.join(backupDir, `.env.${util.stamp()}`);
  fs.writeFileSync(backup, raw);
  if (changed.length) {
    const sub = {};
    for (const k of changed) sub[k] = updates[k];
    const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? '﻿' : '';
    fs.writeFileSync(envPath, bom + envfile.setEnvValues(text, sub));
  }
  ctx.log(`write-env-db ${p.id} keys ${changed.join(',') || '(none)'} backup ${backup}`);
  const res = { ok: true, backup, changed };
  if (changed.length && util.existsFile(win.join(p.path, 'bootstrap', 'cache', 'config.php'))) {
    const php = resolveProjectPhp(ctx, p);
    if (php) {
      const inv = runtimes.phpInvocation(php);
      const r = await util.run(inv.file, [...inv.preArgs, 'artisan', 'config:clear', '--no-ansi'], { cwd: p.path, env: projectEnv(ctx, p, php, dbEntryFor(ctx, p)), timeoutMs: 60000 });
      res.configCleared = r.code === 0;
      if (r.code !== 0) res.warning = tr('msg.configClearFailed', { line: util.firstLine(r.stderr) || util.firstLine(r.stdout) });
    } else {
      res.configCleared = false;
      res.warning = tr('msg.configClearNoPhp');
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------------ jobs: check / lint / clear-cache

async function checkJob(ctx, id, log) {
  const p = getProject(ctx, id);
  const next = [];
  const counts = { ok: 0, warn: 0, bad: 0 };
  const step = (level, text) => { counts[level] = (counts[level] || 0) + 1; log(level, text); };
  const info = inspectProject(p.path);
  if (!info.exists) throw new AppError('NOT_FOUND', tr('err.projectFolderMissing', { path: p.path }), 404);
  const php = resolveProjectPhp(ctx, p);
  if (!php) {
    step('bad', phpMissingError(p.phpVersion).message);
    next.push(tr('next.choosePhpOnCard'));
    return { ok: false, summary: counts, next };
  }
  step('ok', tr(php.iniRelocated ? 'check.phpFoundRelocated' : 'check.phpFound', { version: php.version, path: php.path }));

  if (info.composerPhp) {
    const sat = semver.satisfies(php.version, info.composerPhp);
    if (sat === true) step('ok', tr('check.constraintOk', { constraint: info.composerPhp, version: php.version }));
    else if (sat === false) { step('bad', tr('check.constraintBad', { constraint: info.composerPhp, version: php.version })); next.push(tr('next.chooseMatchingPhp')); }
    else step('warn', tr('check.constraintUnknown', { constraint: info.composerPhp }));
  } else {
    step('info', tr('check.noConstraint'));
  }
  const major = laravelMajorOf(info);
  if (info.isLaravel) {
    const hint = laravelPhpHint(major, php.version);
    if (hint) { step('warn', hint); next.push(tr('next.chooseLaravelPhp')); } else if (major) step('ok', tr('check.laravelOk', { laravel: major, version: php.version }));
  }

  if (info.isLaravel || info.hasComposerJson) {
    if (!info.vendor) { step('bad', tr('check.noVendor')); next.push(tr('next.composerInstall')); } else if (info.laravelInstalled && info.laravelLocked) {
      if (semver.majorOf(info.laravelInstalled) !== semver.majorOf(info.laravelLocked)) {
        step('bad', tr('check.vendorLockMismatch', { installed: info.laravelInstalled, locked: info.laravelLocked }));
        next.push(tr('next.composerInstallAgain'));
      } else step('ok', tr('check.vendorLockOk', { installed: info.laravelInstalled }));
    } else if (info.laravelInstalled && info.laravelConstraint && semver.satisfies(info.laravelInstalled, info.laravelConstraint) === false) {
      step('bad', tr('check.vendorConstraintBad', { installed: info.laravelInstalled, constraint: info.laravelConstraint }));
    } else if (info.vendor) step('ok', tr('check.vendorOk'));
  }

  // composer check-platform-reqs
  const comp = runtimes.findComposer(ctx, p.composerId)
    || runtimes.getCache(ctx).composer.filter((c) => c.ok).sort((a, b) => semver.compare(b.version, a.version))[0] || null;
  if (info.hasComposerJson && (info.vendor || util.existsFile(win.join(p.path, 'composer.lock')))) {
    if (!comp) step('warn', tr('check.noComposer'));
    else {
      if (!p.composerId) step('info', tr('check.composerFallback', { version: comp.version }));
      const inv = runtimes.phpInvocation(php);
      const r = await util.run(inv.file, [...inv.preArgs, comp.path, 'check-platform-reqs', '--no-ansi', '--no-interaction'], {
        cwd: p.path, env: projectEnv(ctx, p, php, dbEntryFor(ctx, p)), timeoutMs: 90000,
      });
      const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const badLines = lines.filter((l) => /failed|missing/i.test(l));
      if (badLines.length) {
        for (const l of badLines.slice(0, 20)) step('bad', `platform: ${l}`);
        next.push(tr('next.enableExtOrPhp'));
      } else if (r.code === 0 || lines.length) step('ok', tr('check.platformOk', { count: lines.length }));
      else step('warn', tr('check.platformFailed', { reason: util.describeExit(r, inv.file) }));
    }
  }

  if (info.requiredExt.length) {
    const loaded = new Set(php.extensions.map((e) => e.toLowerCase()));
    const missing = info.requiredExt.map((e) => e.slice(4)).filter((e) => !loaded.has(e) && !loaded.has(e.replace(/-/g, '_')));
    if (missing.length) {
      step('bad', tr('check.extMissing', { version: php.version, list: missing.join(', ') }));
      next.push(tr('next.enableExt', { list: missing.join(', ') }));
    } else step('ok', tr('check.extOk', { list: info.requiredExt.join(', ') }));
  }

  // .env DB checks
  if (info.env.exists) {
    const host = info.env.host || '127.0.0.1';
    if (!util.isLocalHost(host)) step('warn', tr('check.envHostNotLocal', { host }));
    else step('ok', `.env DB: ${host}:${info.env.port || 3306}${info.env.database ? ` / ${info.env.database}` : ''}`);
    const entry = dbEntryFor(ctx, p);
    if (entry) {
      const envPort = info.env.port || 3306;
      if (envPort !== entry.effectivePort) {
        step('warn', tr('warn.envPortMismatch', { envPort, serverPort: entry.effectivePort }));
        next.push(tr('next.writeEnvPort', { port: entry.effectivePort }));
      } else step('ok', tr('check.envPortOk', { label: entry.label }));
      const snap = await procs.getSnapshot({ fresh: true });
      const st = dbservers.entryStatus(ctx, entry, snap);
      if (st.status !== 'running') { step('warn', tr('check.dbStopped', { label: entry.label })); next.push(tr('next.startDbServer')); } else {
        step('ok', tr('check.dbRunning', { pid: st.pid }));
        if (info.env.database) {
          try {
            const creds = dbservers.resolveCreds(ctx, null, p.id);
            const exists = await dbservers.databaseExists(ctx, entry, info.env.database, creds);
            if (exists) step('ok', tr('check.dbExists', { db: info.env.database }));
            else { step('bad', tr('check.dbMissing', { db: info.env.database })); next.push(tr('next.moveOrMigrate')); }
          } catch (e) {
            step('warn', tr('check.dbCheckFailed', { message: e.message }));
          }
        }
      }
    } else if (info.isLaravel) {
      step('info', tr('check.noDbServer'));
    }
  } else if (info.isLaravel) {
    step('warn', tr('check.noEnv'));
    next.push(tr('next.makeEnv'));
  }
  if (info.isLaravel && info.configCached) {
    step('warn', tr('check.configCached'));
    next.push(tr('next.optimizeClear'));
  }
  if (!next.length) next.push(tr('next.allGood'));
  log('info', tr('check.nextSteps', { list: next.join(' | ') }));
  return { ok: counts.bad === 0, summary: counts, next };
}

function collectPhpFiles(dir, out, max = 20000) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= max) return;
    const full = win.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(vendor|node_modules|\.git)$/i.test(e.name)) continue;
      collectPhpFiles(full, out, max);
    } else if (e.isFile() && /\.php$/i.test(e.name)) out.push(full);
  }
}

async function lintJob(ctx, id, log) {
  const p = getProject(ctx, id);
  const php = resolveProjectPhp(ctx, p);
  if (!php) throw phpMissingError(p.phpVersion);
  const files = [];
  for (const sub of ['app', 'bootstrap', 'config', 'database', 'routes', 'tests']) {
    const d = win.join(p.path, sub);
    if (!util.existsDir(d)) continue;
    const list = [];
    collectPhpFiles(d, list);
    for (const f of list) {
      if (sub === 'bootstrap' && util.isInside(f, win.join(p.path, 'bootstrap', 'cache'))) continue;
      files.push(f);
    }
  }
  if (!files.length) {
    // Plain PHP projects: lint the top-level folder (without vendor).
    collectPhpFiles(p.path, files, 5000);
  }
  log('info', tr('lint.start', { count: files.length, version: php.version }));
  const inv = runtimes.phpInvocation(php);
  const env = util.cleanEnv();
  const errors = [];
  let done = 0;
  await util.mapLimit(files, 4, async (f) => {
    const r = await util.run(inv.file, [...inv.preArgs, '-l', f], { env, cwd: p.path, timeoutMs: 30000 });
    done++;
    if (r.code !== 0) {
      const text = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Errors parsing/i.test(l));
      const msgLine = text.find((l) => /error/i.test(l)) || text[0] || util.describeExit(r, inv.file);
      const lm = /on line (\d+)/i.exec(msgLine);
      errors.push({ file: win.relative(p.path, f), line: lm ? Number(lm[1]) : null, message: msgLine.replace(/\s+in\s+.+?\s+on line \d+\s*$/i, '') });
    }
    if (done % 50 === 0) log('info', tr('lint.progress', { done, total: files.length }));
  });
  if (errors.length) for (const e of errors.slice(0, 50)) log('bad', `${e.file}${e.line ? ` : line ${e.line}` : ''} — ${e.message}`);
  else log('ok', tr('lint.noErrors'));
  return { count: files.length, errors };
}

async function clearCacheJob(ctx, id, log) {
  const p = getProject(ctx, id);
  if (!util.existsFile(win.join(p.path, 'artisan'))) throw new AppError('NOT_LARAVEL', tr('err.notLaravel'));
  const php = resolveProjectPhp(ctx, p);
  if (!php) throw phpMissingError(p.phpVersion);
  regenShims(ctx, p, php);
  const inv = runtimes.phpInvocation(php);
  log('info', `php artisan optimize:clear (PHP ${php.version})`);
  const r = await util.run(inv.file, [...inv.preArgs, 'artisan', 'optimize:clear', '--no-ansi'], {
    cwd: p.path, env: projectEnv(ctx, p, php, dbEntryFor(ctx, p)), timeoutMs: 120000,
  });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code !== 0) throw new AppError('COMMAND_FAILED', tr('err.optimizeClearFailed', { line: util.firstLine(r.stderr) || util.firstLine(r.stdout) || util.describeExit(r, inv.file) }), 500, { output });
  log('ok', tr('clear.done'));
  return { output };
}

// ------------------------------------------------------------------------------------------ folder scan

function scanProjects(ctx, dbViews) {
  const roots = ctx.store.data.settings.projectRoots || [];
  const cache = runtimes.getCache(ctx);
  const items = [];
  for (const root of roots) {
    for (const name of util.listDirNames(root)) {
      if (items.length >= 300) break;
      if (name.startsWith('.')) continue;
      const dir = win.join(util.cleanPath(root), name);
      const hasAny = ['artisan', 'composer.json', 'index.php'].some((f) => util.existsFile(win.join(dir, f)));
      if (!hasAny) continue;
      const info = inspectCached(dir);
      const already = projectsList(ctx).find((p) => util.samePath(p.path, dir));
      items.push({
        path: dir,
        name,
        alreadyAdded: already ? already.id : null,
        info: {
          isLaravel: info.isLaravel, laravel: laravelVersionOf(info), laravelConstraint: info.laravelConstraint,
          composerPhp: info.composerPhp, vendor: info.vendor, router: info.router, env: info.env,
        },
        suggestions: {
          php: suggestPhp(info, cache.php).slice(0, 8).map(({ version, path: pp, satisfies, hint }) => ({ version, path: pp, satisfies, hint })),
          dbServerId: suggestDbServer(info, dbViews),
        },
      });
    }
  }
  return items;
}

module.exports = {
  // pure-ish
  inspectProject,
  laravelPhpHint,
  dbEnvOverride,
  suggestPhp,
  suggestDbServer,
  writeShims,
  buildPhpBat,
  phpWorkersOf,
  fastServeArgs,
  ownServerMatches,
  buildTerminalScript,
  laravelMajorOf,
  laravelVersionOf,
  TERMINAL_ACTIONS,
  // manager
  getProject,
  addProject,
  updateProject,
  removeProject,
  views,
  externalViews,
  startProject,
  stopProject,
  restartProject,
  adoptExternal,
  stopExternal,
  openTerminal,
  openFolder,
  getLog,
  clearLog,
  writeEnvDb,
  checkJob,
  lintJob,
  clearCacheJob,
  scanProjects,
  inspectCached,
  // shared with setup / db-provision
  projectEnv,
  dbEntryFor,
  resolveProjectPhp,
  regenShims,
  phpMissingError,
  findMissingDatabase,
  suggestStartPort,
  VENDOR_ROUTER,
};
