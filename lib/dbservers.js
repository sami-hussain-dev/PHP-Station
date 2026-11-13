'use strict';
/*
 * DB server entries (one per scanned install with a server exe + my.ini, plus instances the
 * panel created), port-based status matching, start/stop, the datadir lock probe, client
 * queries (password only via MYSQL_PWD) and instance creation.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');
const ini = require('./ini');
const procs = require('./procs');
const ports = require('./ports');
const runtimes = require('./runtimes');
const envfile = require('./envfile');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const DB_NAMES = new Set(['mysqld.exe', 'mariadbd.exe']);
const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function rtState(ctx) {
  if (!ctx.db) ctx.db = { starting: new Set(), stopping: new Set() };
  return ctx.db;
}

// ------------------------------------------------------------------------------------------ entries

function entryFromInstall(inst, over) {
  const parsed = inst.defaultsFile ? ini.parseMyIni(util.readText(inst.defaultsFile, ''), inst.defaultsFile) : {};
  return {
    id: inst.id,
    autoLabel: inst.label,
    kind: inst.kind,
    version: inst.version,
    serverExe: inst.serverExe,
    binDir: inst.binDir,
    client: inst.client,
    dump: inst.dump,
    admin: inst.admin,
    installDb: inst.installDb,
    defaultsFile: inst.defaultsFile,
    datadir: parsed.datadir || inst.datadir || null,
    logError: parsed.logError || inst.logError || null,
    parsedPort: parsed.port != null ? parsed.port : inst.port,
    created: false,
    installId: inst.id,
    over: over || {},
  };
}

/** All DB server entries with their effective port. */
function buildEntries(ctx) {
  const cache = runtimes.getCache(ctx);
  const overrides = ctx.store.data.dbServers || {};
  const out = [];
  // A created instance may own the my.ini that the scan also finds next to an install (the
  // installer puts the datadir inside runtimes\mariadb\<v>\data): list that server only once.
  const ownedIni = new Set();
  for (const o of Object.values(overrides)) {
    if (!o || !o.created) continue;
    const df = o.defaultsFile || (o.datadir ? win.join(o.datadir, 'my.ini') : null);
    if (df) ownedIni.add(util.normPath(df));
  }
  for (const inst of cache.db) {
    if (!inst.serverExe || !inst.defaultsFile) continue;
    if (ownedIni.has(util.normPath(inst.defaultsFile))) continue;
    out.push(entryFromInstall(inst, overrides[inst.id]));
  }
  for (const [id, o] of Object.entries(overrides)) {
    if (!o || !o.created) continue;
    const inst = cache.db.find((d) => d.id === o.installId) || null;
    const defaultsFile = o.defaultsFile || (o.datadir ? win.join(o.datadir, 'my.ini') : null);
    const parsed = defaultsFile && util.existsFile(defaultsFile) ? ini.parseMyIni(util.readText(defaultsFile, ''), defaultsFile) : {};
    out.push({
      id,
      autoLabel: `${inst ? (inst.kind === 'mariadb' ? 'MariaDB' : 'MySQL') : 'DB'} ${inst ? inst.version : '?'} · ${o.name || id}`,
      kind: inst ? inst.kind : 'mariadb',
      version: inst ? inst.version : null,
      serverExe: inst ? inst.serverExe : null,
      binDir: inst ? inst.binDir : null,
      client: inst ? inst.client : null,
      dump: inst ? inst.dump : null,
      admin: inst ? inst.admin : null,
      installDb: inst ? inst.installDb : null,
      defaultsFile: defaultsFile && util.existsFile(defaultsFile) ? defaultsFile : null,
      datadir: o.datadir || parsed.datadir || null,
      logError: parsed.logError || null,
      parsedPort: parsed.port != null ? parsed.port : (o.port || null),
      created: true,
      installId: o.installId || null,
      name: o.name || null,
      missingInstall: !inst,
      over: o,
    });
  }
  for (const e of out) {
    e.portOverride = Number.isInteger(e.over.portOverride) ? e.over.portOverride : null;
    e.effectivePort = e.portOverride != null ? e.portOverride : (e.parsedPort != null ? e.parsedPort : 3306);
    e.label = typeof e.over.label === 'string' && e.over.label.trim() ? e.over.label.trim() : e.autoLabel;
  }
  return out;
}

function getEntry(ctx, id) {
  const e = buildEntries(ctx).find((x) => x.id === id);
  if (!e) throw new AppError('DB_NOT_FOUND', tr('err.dbNotFound'), 404);
  return e;
}

// ------------------------------------------------------------------------------------------ matching (PURE)

/**
 * PORT-BASED matching (spec 5.8): a mysqld/mariadbd process belongs to an entry only if it
 * listens on the entry's effective port AND (exe unknown OR exe inside entry.binDir) AND
 * (command line unknown OR no --defaults-file OR --defaults-file equals entry.defaultsFile).
 */
function matchDbProcess(entry, processes, listeners) {
  if (!entry) return null;
  const port = Number(entry.effectivePort != null ? entry.effectivePort : entry.port);
  if (!Number.isInteger(port)) return null;
  const listening = new Set();
  for (const l of listeners || []) if (Number(l.port) === port) listening.add(Number(l.pid));
  if (!listening.size) return null;
  for (const p of processes || []) {
    if (!DB_NAMES.has(String(p.name || '').toLowerCase())) continue;
    if (!listening.has(Number(p.pid))) continue;
    if (p.exe) {
      if (!entry.binDir || !util.samePath(win.dirname(util.cleanPath(p.exe)), entry.binDir)) continue;
    }
    if (p.cmd) {
      const df = procs.defaultsFileFromCmd(p.cmd);
      if (df && !(entry.defaultsFile && util.samePath(df, entry.defaultsFile))) continue;
    }
    return p;
  }
  return null;
}

function portsOf(pid, listeners) {
  const s = new Set();
  for (const l of listeners || []) if (Number(l.pid) === Number(pid)) s.add(l.port);
  return [...s].sort((a, b) => a - b);
}

// ------------------------------------------------------------------------------------------ status / views

/** Status of one entry: {status, pid, ports, proc, controllable, external, startedByPanel}. */
function entryStatus(ctx, entry, snap) {
  const st = rtState(ctx);
  const dbRuns = ctx.store.data.dbRuns;
  const run = dbRuns[entry.id];
  const proc = matchDbProcess(entry, snap.procs, snap.listeners);
  if (proc) {
    const startedByPanel = !!(run && Number(run.pid) === proc.pid);
    return {
      status: st.stopping.has(entry.id) ? 'stopping' : 'running',
      pid: proc.pid,
      ports: portsOf(proc.pid, snap.listeners),
      proc,
      controllable: !!(proc.exe && proc.cmd),
      external: !startedByPanel,
      startedByPanel,
    };
  }
  if (run && st.starting.has(entry.id)) {
    const p = snap.procs.find((x) => x.pid === Number(run.pid));
    if (p && DB_NAMES.has(p.name) && (!p.exe || util.samePath(win.dirname(p.exe), entry.binDir))) {
      return { status: 'starting', pid: p.pid, ports: portsOf(p.pid, snap.listeners), proc: p, controllable: !!(p.exe && p.cmd), external: false, startedByPanel: true };
    }
  }
  if (run && snap.ok && !st.starting.has(entry.id) && !snap.procs.some((x) => x.pid === Number(run.pid))) {
    delete dbRuns[entry.id];
    ctx.dirty = true;
  }
  return { status: st.stopping.has(entry.id) ? 'stopping' : 'stopped', pid: null, ports: [], proc: null, controllable: false, external: false, startedByPanel: false };
}

function entryWarnings(entry, all) {
  const w = [];
  if (entry.datadir) {
    const same = all.filter((o) => o.id !== entry.id && o.datadir && util.samePath(o.datadir, entry.datadir));
    if (same.length) {
      const labels = same.map((o) => o.label);
      w.push({
        code: 'SHARED_DATADIR', level: 'bad', text: tr('warn.sharedDatadir', { servers: labels.join(', ') }),
        others: same.map((o) => o.id), params: { others: labels, datadir: entry.datadir },
      });
    }
    if (!util.existsDir(entry.datadir)) w.push({ code: 'DATADIR_MISSING', level: 'bad', text: tr('db.datadirMissing', { datadir: entry.datadir }), params: { datadir: entry.datadir } });
  } else {
    w.push({ code: 'DATADIR_MISSING', level: 'bad', text: tr('warn.datadirNotSet'), params: { datadir: null } });
  }
  const clash = all.filter((o) => o.id !== entry.id && o.effectivePort === entry.effectivePort);
  if (clash.length) {
    const labels = clash.map((o) => o.label);
    w.push({
      code: 'PORT_CLASH', level: 'warn', text: tr('warn.portClash', { port: entry.effectivePort, servers: labels.join(', ') }),
      others: clash.map((o) => o.id), params: { others: labels, port: entry.effectivePort },
    });
  }
  if (!entry.defaultsFile) w.push({ code: 'NO_CONFIG', level: 'bad', text: tr('warn.noConfig'), params: {} });
  if (entry.missingInstall) w.push({ code: 'NO_INSTALL', level: 'bad', text: tr('warn.noInstall'), params: {} });
  return w;
}

/** {list: DbServerView[], unknown: [{pid, ports, exe}], entries, statuses}. */
function views(ctx, snap) {
  const entries = buildEntries(ctx);
  const projects = ctx.store.data.projects;
  const matchedPids = new Set();
  const statuses = new Map();
  const list = entries.map((e) => {
    const s = entryStatus(ctx, e, snap);
    statuses.set(e.id, s);
    if (s.pid) matchedPids.add(s.pid);
    return {
      id: e.id,
      label: e.label,
      kind: e.kind,
      version: e.version,
      port: e.effectivePort,
      portOverride: e.portOverride,
      datadir: e.datadir,
      defaultsFile: e.defaultsFile,
      binDir: e.binDir,
      serverExe: e.serverExe,
      created: e.created,
      status: s.status,
      pid: s.pid,
      ports: s.ports,
      controllable: s.status === 'stopped' ? !!e.serverExe : s.controllable,
      external: s.external,
      startedByPanel: s.startedByPanel,
      warnings: entryWarnings(e, entries),
      usedBy: projects.filter((p) => p.dbServerId === e.id).map((p) => p.id),
    };
  });
  const unknown = snap.procs
    .filter((p) => DB_NAMES.has(p.name) && !matchedPids.has(p.pid))
    .map((p) => ({ pid: p.pid, ports: portsOf(p.pid, snap.listeners), exe: p.exe || null }))
    .filter((p) => p.ports.length);
  return { list, unknown, entries, statuses };
}

// ------------------------------------------------------------------------------------------ helpers

function errorLogPath(entry) {
  if (entry.logError && util.existsFile(entry.logError)) return entry.logError;
  if (entry.datadir) {
    const comp = win.join(entry.datadir, `${os.hostname()}.err`);
    if (util.existsFile(comp)) return comp;
    const alt = process.env.COMPUTERNAME ? win.join(entry.datadir, `${process.env.COMPUTERNAME}.err`) : null;
    if (alt && util.existsFile(alt)) return alt;
    const x = win.join(entry.datadir, 'mysql_error.log');
    if (util.existsFile(x)) return x;
  }
  return entry.logError || null;
}

function panelLogFor(ctx, id) {
  return path.join(ctx.dataDir, 'logs', 'db', `${id}.log`);
}

/** EBUSY/EPERM/EACCES on ibdata1 -> in use. Never writes. */
function lockProbe(datadir) {
  const f = win.join(datadir, 'ibdata1');
  let fd = null;
  try {
    fd = fs.openSync(f, 'r+');
    return { inUse: false };
  } catch (e) {
    if (e.code === 'ENOENT') return { inUse: false, skipped: true };
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return { inUse: true, error: e.code };
    return { inUse: false, error: e.code };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function sslArgs(clientPath, kind) {
  const base = win.basename(clientPath || '').toLowerCase();
  if (kind === 'mysql' && !base.startsWith('mariadb')) return ['--ssl-mode=DISABLED'];
  return ['--skip-ssl'];
}

/** Which client install to use for an entry: its own bin, else the newest MariaDB client. */
function clientInstallFor(ctx, entry) {
  if (entry.client) return { client: entry.client, dump: entry.dump, admin: entry.admin, kind: entry.kind, version: entry.version };
  const n = runtimes.newestClient(ctx, 'mariadb') || runtimes.newestClient(ctx, null);
  if (!n) throw new AppError('NO_CLIENT', tr('err.noClient'));
  return { client: n.client, dump: n.dump, admin: n.admin, kind: n.kind, version: n.version };
}

function credEnv(password) {
  const set = {};
  if (typeof password === 'string' && password !== '') set.MYSQL_PWD = password;
  return util.cleanEnv({ remove: ['PHPRC', 'PHP_INI_SCAN_DIR', 'MYSQL_PWD', 'MYSQL_HOST', 'MYSQL_TCP_PORT'], set });
}

function cleanStderr(s) {
  return String(s || '').split(/\r?\n/)
    .filter((l) => l.trim() && !/ssl-verify-server-cert|insecure|passwordless|Deprecated program name/i.test(l))
    .join('\n');
}

function validUser(u) {
  return typeof u === 'string' && u.length > 0 && u.length <= 80 && !/[\r\n\0]/.test(u);
}

/** Credentials: request -> project .env (local host) -> root / empty. Never logged. */
function resolveCreds(ctx, creds, projectId) {
  if (creds && validUser(creds.user)) {
    return { user: creds.user, password: typeof creds.password === 'string' ? creds.password : '', source: 'request' };
  }
  if (projectId) {
    const p = ctx.store.data.projects.find((x) => x.id === projectId);
    if (p) {
      const env = envfile.parseEnv(util.readText(win.join(p.path, '.env'), '') || '');
      if (env.DB_USERNAME && util.isLocalHost(env.DB_HOST || '127.0.0.1')) {
        return { user: env.DB_USERNAME, password: env.DB_PASSWORD || '', source: 'env' };
      }
    }
  }
  return { user: 'root', password: '', source: 'default' };
}

/** Credentials to try in order: the project's .env (local host), then root / empty. Never logged. */
function credCandidates(ctx, projectId) {
  const first = resolveCreds(ctx, null, projectId);
  const out = [first];
  if (!(first.user === 'root' && first.password === '')) out.push({ user: 'root', password: '', source: 'default' });
  return out;
}

/**
 * The first candidate that can log in (SELECT 1). Throws NEED_CREDENTIALS when none can,
 * other errors (server down, ...) as they are.
 */
async function workingCreds(ctx, entry, candidates, { timeoutMs = 20000 } = {}) {
  let denied = null;
  for (const c of candidates) {
    try {
      await query(ctx, entry, 'SELECT 1;\n', { user: c.user, password: c.password, timeoutMs });
      return c;
    } catch (e) {
      if (e.code !== 'NEED_CREDENTIALS') throw e;
      denied = e;
    }
  }
  throw denied || new AppError('NEED_CREDENTIALS', tr('err.needCreds'), 409);
}

/**
 * Runs SQL through the entry's client (stdin), returns rows (TSV split).
 * Throws NEED_CREDENTIALS on ERROR 1045.
 */
async function query(ctx, entryOrId, sql, { user, password, database, timeoutMs = 120000 } = {}) {
  const entry = typeof entryOrId === 'string' ? getEntry(ctx, entryOrId) : entryOrId;
  const c = clientInstallFor(ctx, entry);
  const args = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(entry.effectivePort), '-u', user || 'root',
    ...sslArgs(c.client, c.kind), '-N', '-B', '--default-character-set=utf8mb4'];
  if (database) args.push('-D', database);
  const r = await util.run(c.client, args, { input: sql, env: credEnv(password), timeoutMs });
  const err = cleanStderr(r.stderr);
  if (/ERROR 1045/.test(err)) throw new AppError('NEED_CREDENTIALS', tr('err.needCreds'), 409);
  if (r.code !== 0 || r.error) {
    const line = err.split('\n').find((l) => /ERROR/.test(l)) || err.split('\n')[0] || util.describeExit(r, c.client);
    if (/ERROR 2002|ERROR 2003|Can't connect/i.test(line)) throw new AppError('DB_NOT_RUNNING', tr('err.dbConnect', { port: entry.effectivePort, line }), 409);
    throw new AppError('QUERY_FAILED', tr('err.queryFailed', { line }), 500);
  }
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l !== '');
  return lines.map((l) => l.split('\t'));
}

function sqlStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function listDatabases(ctx, id, creds) {
  const entry = getEntry(ctx, id);
  const snap = await procs.getSnapshot({ fresh: true });
  const s = entryStatus(ctx, entry, snap);
  if (s.status !== 'running') throw new AppError('DB_NOT_RUNNING', tr('err.dbNotRunning'), 409);
  const rows = await query(ctx, entry,
    'SELECT s.schema_name, ROUND(COALESCE(SUM(t.data_length + t.index_length), 0) / 1048576, 2) '
    + 'FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name '
    + 'GROUP BY s.schema_name ORDER BY s.schema_name;\n', creds);
  return rows
    .filter((r) => r[0] && !SYSTEM_DBS.has(r[0].toLowerCase()))
    .map((r) => ({ name: r[0], sizeMB: Number(r[1]) || 0 }));
}

async function databaseExists(ctx, entry, name, creds, { timeoutMs } = {}) {
  const opts = Object.assign({}, creds, timeoutMs ? { timeoutMs } : {});
  const rows = await query(ctx, entry, `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ${sqlStr(name)};\n`, opts);
  return rows.length > 0 && Number(rows[0][0]) > 0;
}

/** Size in MB of one database, or null when it does not exist on that server. */
async function databaseSize(ctx, entry, name, creds, { timeoutMs } = {}) {
  const opts = Object.assign({}, creds, timeoutMs ? { timeoutMs } : {});
  const rows = await query(ctx, entry,
    'SELECT s.schema_name, ROUND(COALESCE(SUM(t.data_length + t.index_length), 0) / 1048576, 2) '
    + 'FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name '
    + `WHERE s.schema_name = ${sqlStr(name)} GROUP BY s.schema_name;\n`, opts);
  if (!rows.length || rows[0][0] !== name) return null;
  return Number(rows[0][1]) || 0;
}

async function isEntryRunning(ctx, id) {
  const entry = getEntry(ctx, id);
  const snap = await procs.getSnapshot({ fresh: true });
  return { entry, status: entryStatus(ctx, entry, snap) };
}

/** Normalised datadir as the server reports it (@@datadir uses / or \ and a trailing slash). */
function normDatadir(p) {
  return util.normPath(String(p || '').replace(/\//g, '\\'));
}

/** @@datadir of the server on `port` (logged in with the candidates), or null when it cannot be read. */
async function serverDatadir(ctx, entry, port, candidates) {
  const probe = Object.assign({}, entry, { effectivePort: port });
  for (const c of candidates) {
    try {
      const rows = await query(ctx, probe, 'SELECT @@datadir;\n', { user: c.user, password: c.password, timeoutMs: 8000 });
      return rows.length && rows[0][0] ? rows[0][0] : null;
    } catch (e) {
      if (e.code !== 'NEED_CREDENTIALS') return null;
    }
  }
  return null;
}

/**
 * A server that is ALREADY serving entry's datadir, so the project can use it instead of starting
 * a second server on the same data (which MariaDB refuses / would corrupt):
 *  - 'sibling': another entry with the same datadir is running (e.g. Laragon has MariaDB 12.3.2
 *    and 12.3.3 on one datadir); when its exe is not readable (admin process) @@datadir confirms it;
 *  - 'external': an unmatched mysqld/mariadbd (started by Laragon/XAMPP as admin, other port)
 *    whose @@datadir is this datadir.
 * Returns {entry, port, label, via, pid} or null. Never starts or stops anything.
 */
async function findDatadirServer(ctx, entry, snap, { projectId = null } = {}) {
  if (!entry || !entry.datadir) return null;
  const want = normDatadir(entry.datadir);
  const candidates = credCandidates(ctx, projectId);
  const all = buildEntries(ctx);
  const matched = new Set();
  for (const o of all) {
    const s = entryStatus(ctx, o, snap);
    if (s.pid) matched.add(s.pid);
    if (o.id === entry.id || s.status !== 'running' || !o.datadir || normDatadir(o.datadir) !== want) continue;
    if (!(s.proc && s.proc.exe)) {
      // exe unknown -> the port match alone is weak: confirm when the server tells us its datadir
      const dd = await serverDatadir(ctx, o, o.effectivePort, candidates);
      if (dd && normDatadir(dd) !== want) continue;
    }
    return { entry: o, port: o.effectivePort, label: o.label, via: 'sibling', pid: s.pid };
  }
  for (const p of snap.procs || []) {
    if (!DB_NAMES.has(String(p.name || '').toLowerCase()) || matched.has(p.pid)) continue;
    for (const port of portsOf(p.pid, snap.listeners)) {
      const dd = await serverDatadir(ctx, entry, port, candidates);
      if (dd && normDatadir(dd) === want) {
        const probe = Object.assign({}, entry, { effectivePort: port, label: `${entry.label} (pid ${p.pid})` });
        return { entry: probe, port, label: probe.label, via: 'external', pid: p.pid };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------ action history (binlog)

/** <dumpDir>\devpanel-backups\binlog\<server id> */
function historyDir(ctx, entry) {
  return path.join(ctx.store.data.settings.dumpDir, 'devpanel-backups', 'binlog', String(entry.id).replace(/[^A-Za-z0-9._-]/g, '_'));
}

/** MariaDB 10.2+ can record every row change (and undo one with mariadb-binlog --flashback). */
function historySupported(entry) {
  if (!entry || entry.kind !== 'mariadb' || !entry.version) return false;
  const [a, b] = String(entry.version).split('.').map(Number);
  return a > 10 || (a === 10 && b >= 2);
}

/**
 * Extra mysqld arguments that switch the row-based binary log on (nothing in my.ini changes; the
 * files live in PHP Station's backup folder and expire after settings.historyDays).
 */
function historyArgs(ctx, entry) {
  const s = ctx.store.data.settings;
  if (s.dbHistory === false || !historySupported(entry)) return [];
  const days = Number.isInteger(s.historyDays) && s.historyDays >= 1 && s.historyDays <= 90 ? s.historyDays : 7;
  const dir = util.ensureDir(historyDir(ctx, entry));
  const base = path.join(dir, 'binlog').replace(/\\/g, '/');
  return [`--log-bin=${base}`, '--binlog-format=ROW', '--binlog-row-image=FULL', `--expire-logs-days=${days}`,
    '--max-binlog-size=67108864', '--server-id=1'];
}

// ------------------------------------------------------------------------------------------ start

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Text appended to file after byte offset (at most the last maxBytes of it); '' when unreadable. */
function readNewText(file, offset, maxBytes = 64 * 1024) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const from = size < offset ? 0 : offset; // truncated/rotated -> read it from the start
    const len = Math.min(size - from, maxBytes);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Called once the port opened. A broken server (e.g. XAMPP MariaDB with a crashed mysql.db
 * privilege table) opens its port for a moment and aborts in the same second, so "port open" is
 * not "started". Confirmed by a "ready for connections" line written after the spawn, or by the
 * process staying alive for settleMs with the port still open at the end. An "Aborting" line
 * cancels both. Returns {ok:true, via} or {ok:false, alive, aborting}.
 * isAlive/isPortOpen may be sync or async; readLog returns the log text written since the spawn.
 */
async function confirmStarted({ isAlive, isPortOpen, readLog = () => '', settleMs = 2500, timeoutMs = 15000, intervalMs = 250 }) {
  const start = Date.now();
  let aborting = false;
  for (;;) {
    if (!(await isAlive())) return { ok: false, alive: false, aborting };
    const text = String(readLog() || '');
    if (/\bAborting\b/.test(text)) aborting = true;
    const elapsed = Date.now() - start;
    if (!aborting && /ready for connections/i.test(text) && (await isPortOpen())) return { ok: true, via: 'log' };
    if (!aborting && elapsed >= settleMs && (await isAlive()) && (await isPortOpen())) return { ok: true, via: 'settle' };
    if (elapsed >= timeoutMs) return { ok: false, alive: !!(await isAlive()), aborting };
    await util.sleep(intervalMs);
  }
}

/** Starts a DB server (awaitable; used by the start job and by project start with startDb). */
async function startServer(ctx, id, { log = () => {} } = {}) {
  const st = rtState(ctx);
  const entry = getEntry(ctx, id);
  if (!entry.serverExe) throw new AppError('NO_SERVER_EXE', tr('err.noServerExe'));
  if (!entry.defaultsFile) throw new AppError('NO_CONFIG', tr('err.noConfigStart'));
  if (st.starting.has(id)) throw new AppError('ALREADY_STARTING', tr('err.dbAlreadyStarting'), 409);
  const snap = await procs.getSnapshot({ fresh: true });
  const cur = entryStatus(ctx, entry, snap);
  if (cur.status === 'running') {
    log('ok', tr('db.alreadyRunning', { label: entry.label, pid: cur.pid }));
    return { alreadyRunning: true, pid: cur.pid, port: entry.effectivePort };
  }
  const busy = snap.listeners.find((l) => l.port === entry.effectivePort);
  if (busy) {
    const p = snap.procs.find((x) => x.pid === busy.pid);
    const detail = p && p.exe ? `, ${p.exe}` : p ? `, ${p.name}` : '';
    throw new AppError('PORT_BUSY', tr('err.portBusyPid', { port: entry.effectivePort, pid: busy.pid, detail }), 409);
  }
  if (!entry.datadir || !util.existsDir(entry.datadir)) throw new AppError('DATADIR_MISSING', tr('db.datadirMissing', { datadir: entry.datadir || tr('db.datadirNotInIni') }), 409);
  const all = buildEntries(ctx);
  for (const o of all) {
    if (o.id === entry.id || !o.datadir || !util.samePath(o.datadir, entry.datadir)) continue;
    const os2 = entryStatus(ctx, o, snap);
    if (os2.status !== 'stopped') {
      // A port-only match (exe not readable) of another program on the sibling's port is not a
      // reason to refuse: when that server reports a different datadir, it is not the sibling.
      if (os2.status === 'running' && !(os2.proc && os2.proc.exe)) {
        const dd = await serverDatadir(ctx, o, o.effectivePort, credCandidates(ctx, null));
        if (dd && normDatadir(dd) !== normDatadir(entry.datadir)) continue;
      }
      throw new AppError('DATADIR_IN_USE', tr('err.datadirInUseBy', { label: o.label }), 409);
    }
  }
  const lock = lockProbe(entry.datadir);
  if (lock.inUse) throw new AppError('DATADIR_IN_USE', tr('err.datadirLockedHint', { code: lock.error }), 409);
  log('ok', tr('db.precheckOk', { port: entry.effectivePort, datadir: entry.datadir }));
  // automatic snapshot of the (stopped, consistent) datadir before it starts — never blocks the start
  if (!st.starting.has(id)) await require('./backups').autoBeforeStart(ctx, entry, log);

  const args = [`--defaults-file=${entry.defaultsFile}`];
  if (entry.portOverride != null) args.push(`--port=${entry.portOverride}`);
  if (ctx.store.data.settings.dbBindLocal) args.push('--bind-address=127.0.0.1');
  // DB Time Machine "every action": the server's own row-based binary log, in PHP Station's backup folder
  const hist = historyArgs(ctx, entry);
  if (hist.length) { args.push(...hist); log('info', tr('hist.serverOn')); }
  const logFile = panelLogFor(ctx, id);
  util.ensureDir(path.dirname(logFile));
  util.rotateIfLarge(logFile);
  fs.appendFileSync(logFile, `===== ${util.nowIso()} start ${entry.label} port ${entry.effectivePort} =====\r\n`);
  // Log offsets before the spawn: only lines written by this start count for the confirmation.
  const logOffsets = new Map();
  for (const f of [errorLogPath(entry), logFile]) if (f) logOffsets.set(f, fileSize(f));
  const readStartLog = () => {
    const now = errorLogPath(entry);
    if (now && !logOffsets.has(now)) logOffsets.set(now, 0); // created by this start
    let text = '';
    for (const [f, off] of logOffsets) text += `${readNewText(f, off)}\n`;
    return text;
  };
  st.starting.add(id);
  let pid;
  try {
    pid = procs.spawnDetached(entry.serverExe, args, {
      cwd: win.dirname(entry.binDir),
      env: util.cleanEnv({ remove: ['PHPRC', 'PHP_INI_SCAN_DIR', 'MYSQL_PWD'] }),
      logFile,
    });
    if (!pid) throw new AppError('START_FAILED', tr('err.dbSpawnFailed'));
    ctx.log(`spawn db ${id} pid ${pid} port ${entry.effectivePort}`);
    ctx.store.data.dbRuns[id] = { pid, port: entry.effectivePort, startedAt: util.nowIso() };
    ctx.store.save();
    log('info', tr('db.waitingPort', { pid, port: entry.effectivePort }));
    let ok = await ports.waitForPort(entry.effectivePort, { timeoutMs: 60000, intervalMs: 500, isAlive: () => procs.pidExists(pid) });
    let unstable = false;
    if (ok) {
      log('info', tr('db.confirming', { port: entry.effectivePort }));
      const c = await confirmStarted({
        isAlive: () => procs.pidExists(pid),
        isPortOpen: () => ports.isPortOpen(entry.effectivePort, '127.0.0.1', 800),
        readLog: readStartLog,
      });
      if (!c.ok) {
        ok = false;
        unstable = true;
        ctx.log(`db ${id} pid ${pid} opened port ${entry.effectivePort} but did not stay up (alive ${c.alive}, aborting ${c.aborting})`);
      }
    }
    procs.invalidateCaches();
    if (!ok) {
      const alive = procs.pidExists(pid);
      if (!alive) {
        delete ctx.store.data.dbRuns[id];
        ctx.store.save();
      }
      const elog = errorLogPath(entry);
      const tail = elog ? util.tailFile(elog, 40).text : '';
      const ours = util.tailFile(logFile, 40).text;
      let msg = tr('err.dbExitedEarly');
      if (alive) msg = unstable ? tr('err.dbNotStable', { port: entry.effectivePort, pid }) : tr('err.dbNotReady', { port: entry.effectivePort, pid });
      throw new AppError('START_FAILED', msg, 500, { errorLog: tail, errorLogPath: elog, logTail: ours });
    }
    log('ok', tr('db.started', { label: entry.label, port: entry.effectivePort, pid }));
    return { pid, port: entry.effectivePort };
  } finally {
    st.starting.delete(id);
  }
}

// ------------------------------------------------------------------------------------------ stop

async function waitPidGone(pid, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!procs.pidExists(pid)) return true;
    await util.sleep(500);
  }
  return !procs.pidExists(pid);
}

/** Re-verifies the entry <-> process match right before signalling. */
async function verifyMatch(ctx, entry, pid) {
  const snap = await procs.getSnapshot({ fresh: true });
  const p = matchDbProcess(entry, snap.procs, snap.listeners);
  return p && p.pid === pid ? p : null;
}

async function stopServer(ctx, id, { user, password, force = false } = {}, log = () => {}) {
  const st = rtState(ctx);
  const entry = getEntry(ctx, id);
  const snap = await procs.getSnapshot({ fresh: true });
  const proc = matchDbProcess(entry, snap.procs, snap.listeners);
  if (!proc) throw new AppError('NOT_RUNNING', tr('err.notRunning'), 409);
  if (!proc.exe || !proc.cmd) {
    throw new AppError('NOT_CONTROLLABLE', tr('err.notControllable'), 403);
  }
  const pid = proc.pid;
  const elog = errorLogPath(entry);
  const finish = (method) => {
    delete ctx.store.data.dbRuns[id];
    ctx.store.save();
    procs.invalidateCaches();
    const tail = elog ? util.tailFile(elog, 40).text : '';
    log('ok', tr('db.stopped', { method }));
    ctx.log(`db ${id} pid ${pid} stopped via ${method}`);
    return { method, pid, errorLogTail: tail, shutdownComplete: /Shutdown complete/i.test(tail), errorLogPath: elog };
  };
  st.stopping.add(id);
  try {
    // (1) named event MySQLShutdown<pid>
    log('info', tr('db.eventSetting', { pid }));
    const ev = await procs.signalShutdownEvent(pid);
    if (ev.ok) {
      log('info', tr('db.eventSet'));
      if (await waitPidGone(pid, 90000)) return finish('event');
      log('warn', tr('db.eventTimeout'));
    } else {
      log('warn', tr('db.eventFailed', { error: ev.error }));
    }
    // (2) admin shutdown
    if (!(await verifyMatch(ctx, entry, pid))) {
      if (!procs.pidExists(pid)) return finish('event');
      throw new AppError('MATCH_LOST', tr('err.matchLost'), 409);
    }
    const inst = clientInstallFor(ctx, entry);
    const admin = entry.admin || inst.admin;
    let needCreds = false;
    if (admin) {
      const cr = resolveCreds(ctx, { user, password }, null);
      log('info', `${win.basename(admin)} shutdown (user ${cr.user})`);
      const r = await util.run(admin, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(entry.effectivePort), '-u', cr.user,
        ...sslArgs(admin, entry.kind), 'shutdown'], { env: credEnv(cr.password), timeoutMs: 30000 });
      const err = cleanStderr(r.stderr);
      if (/ERROR 1045|Access denied/i.test(err)) {
        needCreds = true;
        log('warn', tr('db.adminDenied'));
      } else if (r.code === 0) {
        if (await waitPidGone(pid, 90000)) return finish('admin');
        log('warn', tr('db.adminTimeout'));
      } else {
        log('warn', tr('db.adminFailed', { error: err.split('\n')[0] || util.describeExit(r, admin) }));
      }
    }
    // (3) force
    if (force === true) {
      if (!(await verifyMatch(ctx, entry, pid))) {
        if (!procs.pidExists(pid)) return finish('admin');
        throw new AppError('MATCH_LOST', tr('err.matchLost'), 409);
      }
      log('warn', tr('db.forcing', { pid }));
      const k = await procs.killTree(pid);
      ctx.log(`kill db ${id} pid ${pid}: ${k.ok}`);
      if (await waitPidGone(pid, 15000)) return finish('force');
      throw new AppError('STOP_FAILED', tr('err.forceFailed', { output: k.output }), 500);
    }
    if (needCreds) throw new AppError('NEED_CREDENTIALS', tr('err.needCredsStop'), 409);
    throw new AppError('STOP_FAILED', tr('err.gracefulFailed'), 500);
  } finally {
    st.stopping.delete(id);
  }
}

// ------------------------------------------------------------------------------------------ create / update / remove / log

/**
 * New, empty server instance. opts.datadir (internal callers only, e.g. the installer) puts the
 * datadir somewhere else than <data>\db\<name>\data; it must not exist either.
 */
async function createInstance(ctx, { installId, name, port }, log = () => {}, opts = {}) {
  const inst = runtimes.findDbInstall(ctx, installId);
  if (!inst || !inst.serverExe) throw new AppError('BAD_INSTALL', tr('err.installNotFound'), 404);
  if (inst.kind !== 'mariadb') throw new AppError('BAD_INSTALL', tr('err.installNotMariadb'));
  if (!inst.installDb) throw new AppError('BAD_INSTALL', tr('err.noInstallDb'));
  if (typeof name !== 'string' || !/^[a-z0-9-]{2,30}$/.test(name)) {
    throw new AppError('BAD_NAME', tr('err.badInstanceName'));
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new AppError('BAD_PORT', tr('err.portRange'));
  const id = `dbi-${name}`;
  if (ctx.store.data.dbServers[id]) throw new AppError('EXISTS', tr('err.instanceExists'));
  if (buildEntries(ctx).some((e) => e.effectivePort === p)) throw new AppError('PORT_USED', tr('err.portUsedDb', { port: p }), 409);
  const listeners = await procs.listListeners({ maxAgeMs: 0 });
  if (listeners.some((l) => l.port === p)) throw new AppError('PORT_BUSY', tr('err.portBusy', { port: p }), 409);
  const datadir = opts && typeof opts.datadir === 'string' && opts.datadir ? util.cleanPath(opts.datadir) : path.join(ctx.dataDir, 'db', name, 'data');
  if (fs.existsSync(datadir)) throw new AppError('DATADIR_EXISTS', tr('err.datadirExists', { datadir }), 409);
  util.ensureDir(path.dirname(datadir));
  log('info', tr('db.installDbRunning', { tool: win.basename(inst.installDb), datadir, port: p }));
  const r = await util.run(inst.installDb, [`--datadir=${datadir}`, `--port=${p}`, '--silent'], {
    cwd: inst.binDir, env: util.cleanEnv({ remove: ['PHPRC', 'PHP_INI_SCAN_DIR', 'MYSQL_PWD'] }), timeoutMs: 300000,
  });
  const myIni = path.join(datadir, 'my.ini');
  if (r.code !== 0 || !util.existsFile(myIni)) {
    const msg = util.firstLine(r.stderr) || util.firstLine(r.stdout) || util.describeExit(r, inst.installDb);
    throw new AppError('CREATE_FAILED', tr('err.createFailed', { message: msg }), 500, { output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) });
  }
  let text = fs.readFileSync(myIni, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (!/^\s*bind[-_]address\s*=/im.test(text)) {
    if (/^\s*\[mysqld\]\s*$/im.test(text)) text = text.replace(/^(\s*\[mysqld\]\s*)$/im, `$1${eol}bind-address=127.0.0.1`);
    else text += `${eol}[mysqld]${eol}bind-address=127.0.0.1${eol}`;
    fs.writeFileSync(myIni, text);
  }
  ctx.store.data.dbServers[id] = { created: true, installId, datadir, defaultsFile: myIni, name, port: p };
  ctx.store.save();
  log('ok', tr('db.created', { name, port: p }));
  return { id, datadir, defaultsFile: myIni, port: p };
}

function update(ctx, id, body) {
  getEntry(ctx, id);
  const over = Object.assign({}, ctx.store.data.dbServers[id] || {});
  if ('label' in body) {
    if (body.label === null || body.label === '') delete over.label;
    else if (typeof body.label === 'string') over.label = util.cleanText(body.label, 80);
    else throw new AppError('BAD_INPUT', tr('err.labelText'));
  }
  if ('portOverride' in body) {
    if (body.portOverride === null) delete over.portOverride;
    else {
      const n = Number(body.portOverride);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new AppError('BAD_PORT', tr('err.portRange'));
      over.portOverride = n;
    }
  }
  ctx.store.data.dbServers[id] = over;
  ctx.store.save();
}

async function remove(ctx, id) {
  const o = ctx.store.data.dbServers[id];
  if (!o || !o.created) throw new AppError('NOT_REMOVABLE', tr('err.notRemovable'), 400);
  const { status } = await isEntryRunning(ctx, id);
  if (status.status !== 'stopped') throw new AppError('RUNNING', tr('err.stopServerFirst'), 409);
  delete ctx.store.data.dbServers[id];
  delete ctx.store.data.dbRuns[id];
  for (const p of ctx.store.data.projects) if (p.dbServerId === id) p.dbServerId = null;
  ctx.store.save();
  return { datadir: o.datadir || null };
}

function getLog(ctx, id, lines) {
  const entry = getEntry(ctx, id);
  const elog = errorLogPath(entry);
  const ours = util.tailFile(panelLogFor(ctx, id), lines);
  const theirs = elog ? util.tailFile(elog, lines) : { exists: false, text: '' };
  let text = '';
  if (theirs.exists) text += `----- ${elog} -----\n${theirs.text}\n`;
  if (ours.exists) text += `----- PHP Station log -----\n${ours.text}\n`;
  if (!text) text = tr('log.empty');
  return { text, errorLogPath: elog };
}

module.exports = {
  buildEntries,
  getEntry,
  matchDbProcess,
  entryStatus,
  views,
  lockProbe,
  errorLogPath,
  confirmStarted,
  readNewText,
  resolveCreds,
  credCandidates,
  workingCreds,
  databaseSize,
  clientInstallFor,
  sslArgs,
  credEnv,
  cleanStderr,
  query,
  sqlStr,
  listDatabases,
  databaseExists,
  isEntryRunning,
  normDatadir,
  findDatadirServer,
  startServer,
  stopServer,
  historyDir,
  historySupported,
  historyArgs,
  createInstance,
  update,
  remove,
  getLog,
  SYSTEM_DBS,
};
