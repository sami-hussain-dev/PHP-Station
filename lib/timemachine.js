'use strict';
/*
 * DB Time Machine: restore points of ONE project's database (its .env DB_DATABASE on the project's
 * DB server) and a one-click "undo" back to any of them.
 *
 *  - Restore point: mariadb-dump of that database while the server runs (single transaction, so it
 *    is consistent even while the app writes), stored in
 *    <dumpDir>\devpanel-backups\points\<project>\<stamp>_<reason>\<db>.sql + meta.json.
 *    Made by hand, automatically before `php artisan migrate*` / `db:*` (the project's php.bat shim
 *    calls tools\restore-point.js) and before every undo.
 *  - Undo: nothing is lost on the way.
 *      1. a "pre-undo" restore point of the CURRENT state is taken first (undo can be undone);
 *      2. the chosen point is imported into a scratch database to prove it imports cleanly
 *         (on failure the real database is never touched);
 *      3. only then the real database is emptied and the point imported into it; if that fails,
 *         the pre-undo point is imported back.
 *  - Old automatic points beyond settings.pointKeep are removed; manual / pre-undo ones are kept.
 *
 * Instant restore points (MariaDB servers that write the DB History binlog):
 *  - Every full dump also records the binlog position it was taken at (--master-data=2 on a
 *    consistent snapshot, no table lock): it is a "base".
 *  - Before an artisan command only a MARKER is saved: the current binlog position (meta.json, no
 *    .sql), in well under a second whatever the database size, when a base of the same server run
 *    exists. Undo to a marker = the base imported + the binlog replayed from the base up to the
 *    marker (point-in-time restore), so TRUNCATE, DROP and ALTER are covered too.
 *  - Bases are made in the background (job 'tm-base': project start, the panel's 10-minute tick,
 *    after an undo / import) so the terminal never waits for one; without a base the old blocking
 *    dump runs, and becomes the base for the next command.
 *  - A base is only used for a marker of the same server run (a restart may have run unlogged),
 *    and not across an unlogged write (Time Machine undo, Import database): those are recorded in
 *    <points>\unlogged.json.
 */
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const util = require('./util');
const procs = require('./procs');
const dbservers = require('./dbservers');
const projects = require('./projects');
const { tr } = require('./i18n');

const { AppError } = util;
const REASONS = Object.freeze(['manual', 'artisan', 'pre-undo', 'auto', 'pre-import']);
const UNLOGGED_FILE = 'unlogged.json';
const BASE_MAX_AGE_MS = 24 * 3600 * 1000;
const NAME_RE = /^\d{8}-\d{6}(?:-\d{1,2})?_(manual|artisan|pre-undo|auto|pre-import)$/;
const DB_RE = /^[A-Za-z0-9_$-]{1,64}$/;
// artisan commands that change the database (the shim only calls us for migrate* / db:*)
const READ_ONLY_COMMANDS = new Set(['migrate:status', 'db:show', 'db:table', 'db:monitor', 'db']);

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}
function rootDir(ctx) {
  return path.join(ctx.store.data.settings.dumpDir, 'devpanel-backups', 'points');
}
function pointsDir(ctx, projectId) {
  return path.join(rootDir(ctx), safeId(projectId));
}
function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/** "20261112-174832_manual" -> "2026-11-12 17:48:32" (local time, as the folder name). PURE. */
function whenOf(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(name || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(name || '');
}

function settingsOf(ctx) {
  const s = ctx.store.data.settings;
  return {
    keep: Number.isInteger(s.pointKeep) ? s.pointKeep : 20,
    beforeArtisan: s.pointBeforeArtisan !== false,
  };
}
function qid(s) {
  return `\`${String(s).replace(/`/g, '``')}\``;
}

/** Does `php artisan <command>` change the database? (PURE) */
function isWritingCommand(command) {
  const c = String(command || '').trim().toLowerCase();
  if (!/^(migrate|db:)/.test(c) && c !== 'db') return false;
  return !READ_ONLY_COMMANDS.has(c);
}

// ------------------------------------------------------------------------------------------ target

/**
 * The project's database and a RUNNING server that serves it:
 * {project, entry, port, database, creds, via}. Throws when the project has no local MySQL/MariaDB
 * database in .env or its server is not running.
 */
async function target(ctx, projectId, { fast = false } = {}) {
  const p = projects.getProject(ctx, projectId);
  const env = projects.inspectProject(p.path).env;
  if (!env.exists) throw new AppError('NO_ENV', tr('tm.noEnv'), 409);
  if (env.connection && !/^(mysql|mariadb)$/i.test(env.connection)) throw new AppError('NOT_MYSQL', tr('tm.notMysql', { conn: env.connection }), 409);
  if (env.host && !util.isLocalHost(env.host)) throw new AppError('NOT_LOCAL', tr('tm.notLocal', { host: env.host }), 409);
  if (!env.database || !DB_RE.test(env.database)) throw new AppError('NO_DATABASE', tr('tm.noDatabase'), 409);
  const own = projects.dbEntryFor(ctx, p);
  if (!own) throw new AppError('NO_DB_SERVER', tr('tm.noDbServer'), 409);
  // fast (before an artisan command): a process list up to 1.5 s old is good enough
  const snap = await procs.getSnapshot({ fresh: !fast });
  let entry = own;
  let via = 'own';
  if (dbservers.entryStatus(ctx, own, snap).status !== 'running') {
    const other = await dbservers.findDatadirServer(ctx, own, snap, { projectId: p.id });
    if (!other) throw new AppError('DB_NOT_RUNNING', tr('tm.dbStopped', { label: own.label }), 409);
    entry = other.entry;
    via = other.via;
  }
  const key = `${entry.id}|${p.id}`;
  if (fast && credCache.has(key)) {
    // checked by the first query (probeWithLogin falls back to the normal login search)
    return { project: p, entry, port: entry.effectivePort, database: env.database, creds: credCache.get(key), via, credsChecked: false };
  }
  const creds = await dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, p.id), { timeoutMs: 15000 });
  credCache.set(key, creds);
  return { project: p, entry, port: entry.effectivePort, database: env.database, creds, via, credsChecked: true };
}

async function schemaInfo(ctx, t, db) {
  const rows = await dbservers.query(ctx, t.entry,
    `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.schemata WHERE schema_name = '${db.replace(/'/g, "''")}';\n`
    + `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${db.replace(/'/g, "''")}';\n`, t.creds);
  if (!rows.length || rows.length < 2) return { exists: false, charset: null, collation: null, tables: 0 };
  return { exists: true, charset: rows[0][0] || null, collation: rows[0][1] || null, tables: Number(rows[1][0]) || 0 };
}

function clientArgs(ctx, t, tool) {
  const c = dbservers.clientInstallFor(ctx, t.entry);
  return ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(t.port), '-u', t.creds.user, ...dbservers.sslArgs(tool || c.client, c.kind)];
}

// ------------------------------------------------------------------------------------------ listing

function readPoint(dir, name) {
  const meta = util.readJson(path.join(dir, name, 'meta.json'), null) || {};
  const db = typeof meta.database === 'string' && DB_RE.test(meta.database) ? meta.database : null;
  let size = null;
  if (db) { try { size = fs.statSync(path.join(dir, name, `${db}.sql`)).size; } catch { size = null; } }
  if (meta.kind === 'marker') {
    const base = db ? baseForMarker(dir, meta) : null;
    return {
      name, reason: name.split('_').slice(1).join('_'), createdAt: meta.createdAt || null, database: db,
      command: typeof meta.command === 'string' ? meta.command.slice(0, 120) : null,
      tables: Number.isInteger(meta.tables) ? meta.tables : null, migrations: Number.isInteger(meta.migrations) ? meta.migrations : null,
      sizeBytes: null, server: meta.serverLabel || null, marker: true, base: base ? base.name : null, ok: !!base,
    };
  }
  return {
    name,
    reason: name.split('_').slice(1).join('_'),
    createdAt: meta.createdAt || null,
    database: db,
    command: typeof meta.command === 'string' ? meta.command.slice(0, 120) : null,
    tables: Number.isInteger(meta.tables) ? meta.tables : null,
    migrations: Number.isInteger(meta.migrations) ? meta.migrations : null,
    sizeBytes: size,
    server: meta.serverLabel || null,
    ok: !!(db && size !== null),
  };
}

function listPoints(ctx, projectId) {
  const dir = pointsDir(ctx, projectId);
  return util.listDirNames(dir).filter((n) => NAME_RE.test(n)).sort().reverse().map((n) => readPoint(dir, n));
}

/** Cheap summary for the project card (no meta reads except the newest). */
function summary(ctx, projectId) {
  const dir = pointsDir(ctx, projectId);
  const names = util.listDirNames(dir).filter((n) => NAME_RE.test(n)).sort();
  if (!names.length) return { count: 0, last: null };
  const last = readPoint(dir, names[names.length - 1]);
  return { count: names.length, last: { name: last.name, reason: last.reason, createdAt: last.createdAt, command: last.command } };
}

function overview(ctx, projectId) {
  const p = projects.getProject(ctx, projectId);
  const env = projects.inspectProject(p.path).env;
  return {
    root: pointsDir(ctx, projectId),
    database: env.database || null,
    points: listPoints(ctx, projectId),
    settings: settingsOf(ctx),
  };
}

/** Old automatic points beyond `keep` (manual and pre-undo points are never removed). */
function prune(ctx, projectId, keep, log) {
  const dir = pointsDir(ctx, projectId);
  const all = util.listDirNames(dir).filter((n) => NAME_RE.test(n));
  const auto = all.filter((n) => /_(artisan|auto)$/.test(n)).sort().reverse();
  const going = new Set(auto.slice(Math.max(1, keep)));
  // a base still needed by a marker that stays is kept as well
  const needed = new Set();
  for (const n of all) {
    if (going.has(n)) continue;
    const meta = util.readJson(path.join(dir, n, 'meta.json'), null);
    if (meta && meta.kind === 'marker') { const b = baseForMarker(dir, meta); if (b) needed.add(b.name); }
  }
  for (const n of auto.slice(Math.max(1, keep))) {
    if (needed.has(n)) continue;
    const p = path.join(dir, n);
    if (!util.isInside(p, rootDir(ctx))) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); log('info', tr('tm.pruned', { name: n })); } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------------------------------ binlog markers

/** "binlog.000012" -> 12. PURE. */
function binIndex(file) {
  const m = /\.(\d+)$/.exec(String(file || ''));
  return m ? Number(m[1]) : -1;
}
/** Order of two binlog positions {file, pos}. PURE. */
function cmpCoords(a, b) {
  return (binIndex(a.file) - binIndex(b.file)) || (Number(a.pos) - Number(b.pos));
}

function unloggedTimes(dir) {
  const list = util.readJson(path.join(dir, UNLOGGED_FILE), []);
  return Array.isArray(list) ? list.map(Number).filter((x) => x > 0) : [];
}

/** A write that is not in the binlog happened to this project's database now (undo, import). */
function markUnlogged(ctx, projectId) {
  const dir = util.ensureDir(pointsDir(ctx, projectId));
  util.writeJsonAtomic(path.join(dir, UNLOGGED_FILE), [...unloggedTimes(dir), Date.now()].slice(-50));
}

/**
 * The newest full point a marker can start from: same database and server run, taken at or before
 * the marker's binlog position, no unlogged write in between, its .sql and binlog file still there.
 * want: {database, server, boot, binlog: {file, pos, basename}, createdAt}
 */
function baseForMarker(dir, want) {
  if (!want || !want.binlog || !want.database) return null;
  const until = Date.parse(want.createdAt || '') || Date.now();
  const unlogged = unloggedTimes(dir);
  const names = util.listDirNames(dir).filter((n) => NAME_RE.test(n)).sort().reverse();
  for (const n of names) {
    const meta = util.readJson(path.join(dir, n, 'meta.json'), null);
    if (!meta || meta.kind === 'marker' || !meta.binlog || meta.database !== want.database || meta.server !== want.server) continue;
    if (!meta.fingerprint || Math.abs(Number(meta.fingerprint.boot) - Number(want.boot)) > BOOT_SLACK_S) continue;
    if (cmpCoords(meta.binlog, want.binlog) > 0) continue;
    // its snapshot was taken when the dump started (a base still being written for a marker is fine:
    // the binlog position decides what came first)
    const at = Date.parse(meta.snapshotAt || meta.createdAt || '') || 0;
    // no write outside the binlog between the base and the marker, whichever came first (an undo does
    // not move the binlog position, so a later copy can have the same position and other data)
    const lo = Math.min(at, until) - 1000;
    const hi = Math.max(at, until) + 1000;
    if (unlogged.some((u) => u > lo && u < hi)) continue;
    if (!util.existsFile(path.join(dir, n, `${meta.database}.sql`))) continue;
    const bdir = meta.binlog.basename ? path.dirname(meta.binlog.basename) : null;
    if (bdir && !util.existsFile(path.join(bdir, meta.binlog.file))) continue;
    return { name: n, meta };
  }
  return null;
}

/** The binlog state of a probe: {file, pos, basename} when the server writes a row-based binlog. */
function binlogOf(st) {
  const b = st && st.binlog;
  return b && b.on && b.row && b.file && Number.isFinite(b.pos) ? { file: b.file, pos: b.pos, basename: b.basename || null } : null;
}

/** An instant restore point: the binlog position before the command (see the header). */
function createMarker(ctx, t, st, { reason = 'artisan', command = null, log = () => {} } = {}) {
  const dir = util.ensureDir(pointsDir(ctx, t.project.id));
  let name = `${stampNow()}_${reason}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)) && i < 60; i++) name = `${stampNow()}-${i}_${reason}`;
  const tmp = util.ensureDir(path.join(dir, `${name}.partial`));
  util.writeJsonAtomic(path.join(tmp, 'meta.json'), {
    kind: 'marker', project: t.project.id, projectName: t.project.name, database: t.database, server: t.entry.id, serverLabel: t.entry.label,
    reason, command: command ? String(command).slice(0, 120) : null, tables: st.tableCount, migrations: st.migrations ? st.migrations.size : null,
    charset: st.charset, collation: st.collation, createdAt: util.nowIso(),
    fingerprint: st.fingerprint ? { sig: st.fingerprint.sig, boot: st.fingerprint.boot, port: t.port } : null,
    boot: st.fingerprint ? st.fingerprint.boot : null, binlog: binlogOf(st),
  });
  fs.renameSync(tmp, path.join(dir, name));
  const point = readPoint(dir, name);
  log('ok', tr('tm.markerDone', { name }));
  ctx.log(`restore point ${t.project.id}/${name} (marker ${point.base ? `on ${point.base}` : 'WITHOUT base'}${command ? `, ${command}` : ''})`);
  if (reason === 'artisan') prune(ctx, t.project.id, settingsOf(ctx).keep, log);
  return point;
}

/** Should a background base copy be made now? (no usable one for this server run, or an old one) */
async function baseNeeded(ctx, projectId) {
  const t = await target(ctx, projectId, { fast: true });
  if (t.entry.kind && t.entry.kind !== 'mariadb') return false;
  const st = await probeWithLogin(ctx, t);
  const bl = binlogOf(st);
  if (!bl || !st.exists || !st.tableCount || !st.fingerprint) return false;
  const base = baseForMarker(pointsDir(ctx, projectId), { database: t.database, server: t.entry.id, boot: st.fingerprint.boot, binlog: bl, createdAt: util.nowIso() });
  if (!base) return true;
  return Date.now() - (Date.parse(base.meta.createdAt) || 0) > BASE_MAX_AGE_MS || binIndex(bl.file) - binIndex(base.meta.binlog.file) > 3;
}

// ------------------------------------------------------------------------------------------ quick checks
//
// Before `php artisan migrate` / `db:*` the terminal waits for us, so the common cases are answered
// without a dump: nothing to migrate, or nothing written since the last restore point.

// Server write counters: none of them moves unless something is written (in any database, by any
// session, logged to the binlog or not). Dumping and these checks only read, so they never move them.
const WRITE_COUNTERS = Object.freeze([
  'COM_INSERT', 'COM_INSERT_SELECT', 'COM_UPDATE', 'COM_UPDATE_MULTI', 'COM_DELETE', 'COM_DELETE_MULTI',
  'COM_REPLACE', 'COM_REPLACE_SELECT', 'COM_LOAD', 'COM_CREATE_TABLE', 'COM_ALTER_TABLE', 'COM_DROP_TABLE',
  'COM_RENAME_TABLE', 'COM_TRUNCATE', 'COM_CREATE_INDEX', 'COM_DROP_INDEX', 'COM_CREATE_DB', 'COM_DROP_DB',
  'COM_ALTER_DB', 'COM_CREATE_VIEW', 'COM_DROP_VIEW', 'COM_CREATE_TRIGGER', 'COM_DROP_TRIGGER',
  'COM_CREATE_PROCEDURE', 'COM_ALTER_PROCEDURE', 'COM_DROP_PROCEDURE', 'COM_CREATE_FUNCTION', 'COM_ALTER_FUNCTION',
  'COM_DROP_FUNCTION', 'COM_CREATE_EVENT', 'COM_ALTER_EVENT', 'COM_DROP_EVENT', 'COM_CREATE_SEQUENCE',
  'COM_DROP_SEQUENCE', 'COM_ALTER_SEQUENCE', 'COM_XA_COMMIT', 'INNODB_ROWS_INSERTED', 'INNODB_ROWS_UPDATED',
  'INNODB_ROWS_DELETED', 'UPTIME',
]);
const BOOT_SLACK_S = 3;
const PARALLEL_FROM_BYTES = 64 * 1024 * 1024;
// `php artisan migrate <these>` still only runs the pending migrations of the default paths
const PLAIN_MIGRATE_FLAGS = new Set(['--force', '--step', '--graceful', '--isolated', '--no-interaction', '-n',
  '--ansi', '--no-ansi', '-q', '--quiet', '-v', '-vv', '-vvv', '--verbose']);

const credCache = new Map(); // `${entry.id}|${projectId}` -> login that worked last time (memory only)
const vendorCache = new Map(); // project path -> { stamp, dirs | null }

function sqlLit(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Runs a batch that tolerates errors (--force); rows are tab-split. Login / connect errors throw. */
async function batch(ctx, t, sql) {
  const c = dbservers.clientInstallFor(ctx, t.entry);
  const r = await util.run(c.client, [...clientArgs(ctx, t, c.client), '-N', '-B', '--force', '--default-character-set=utf8mb4'],
    { input: sql, env: dbservers.credEnv(t.creds.password), timeoutMs: 30000 });
  const err = dbservers.cleanStderr(r.stderr);
  if (/ERROR 1045/.test(err)) throw new AppError('NEED_CREDENTIALS', tr('err.needCreds'), 409);
  if (/ERROR 2002|ERROR 2003|Can't connect/i.test(err)) throw new AppError('DB_NOT_RUNNING', tr('err.dbConnect', { port: t.port, line: util.firstLine(err) }), 409);
  if (r.error || r.code === null) throw new AppError('QUERY_FAILED', tr('err.queryFailed', { line: util.firstLine(err) || util.describeExit(r, c.client) }), 500);
  return String(r.stdout || '').split(/\r?\n/).filter((l) => l !== '').map((l) => l.split('\t'));
}

/** Server write counters -> one signature, plus the server's start time (seconds). PURE. */
function fingerprintOf(stats, nowMs = Date.now()) {
  const m = new Map(stats.map(([k, v]) => [String(k).toUpperCase(), String(v)]));
  if (!m.has('UPTIME') || !m.has('COM_INSERT') || !m.has('COM_ALTER_TABLE')) return null;
  const sig = WRITE_COUNTERS.filter((k) => k !== 'UPTIME').map((k) => `${k}=${m.has(k) ? m.get(k) : '-'}`).join(',');
  return { sig, boot: Math.round(nowMs / 1000) - Number(m.get('UPTIME')) };
}

/**
 * Everything a restore point needs to know, in ONE client run: schema, tables (with sizes), routines,
 * events, the write counters and the migrations that ran.
 */
async function probe(ctx, t, { migrationsTable = 'migrations' } = {}) {
  const db = sqlLit(t.database);
  const mt = /^[A-Za-z0-9_]{1,64}$/.test(migrationsTable) ? migrationsTable : 'migrations';
  const counters = WRITE_COUNTERS.map(sqlLit).join(',');
  // inside a quoted string for PREPARE: quotes doubled
  const migSql = `SELECT ''mig'', migration FROM ${qid(t.database).replace(/'/g, "''")}.${qid(mt)}`;
  const sql = [
    `SELECT 'schema', DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.schemata WHERE schema_name = ${db};`,
    `SELECT 'tbl', TABLE_NAME, TABLE_TYPE, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) FROM information_schema.tables WHERE table_schema = ${db};`,
    `SELECT 'routines', COUNT(*) FROM information_schema.routines WHERE routine_schema = ${db};`,
    `SELECT 'events', COUNT(*) FROM information_schema.events WHERE event_schema = ${db};`,
    `SELECT 'triggers', COUNT(*) FROM information_schema.triggers WHERE trigger_schema = ${db};`,
    // MariaDB / MySQL 5.x; MySQL 8 keeps them in performance_schema (the one that fails is skipped by --force)
    `SELECT 'stat', VARIABLE_NAME, VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE UPPER(VARIABLE_NAME) IN (${counters});`,
    `SELECT 'stat', VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status WHERE UPPER(VARIABLE_NAME) IN (${counters});`,
    `SET @ps_q = IF((SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ${db} AND table_name = '${mt}') > 0, '${migSql}', 'DO 0');`,
    'PREPARE ps_s FROM @ps_q;', 'EXECUTE ps_s;', 'DEALLOCATE PREPARE ps_s;',
    "SELECT 'binlog', @@GLOBAL.log_bin, @@GLOBAL.binlog_format, @@GLOBAL.log_bin_basename;",
    "SELECT 'snap', VARIABLE_NAME, VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME IN ('BINLOG_SNAPSHOT_FILE', 'BINLOG_SNAPSHOT_POSITION');", '',
  ].join('\n');
  const rows = await batch(ctx, t, sql);
  const out = { exists: false, charset: null, collation: null, tables: [], tableCount: 0, routines: 0, events: 0, triggers: 0, migrations: null, fingerprint: null };
  const stats = [];
  const mig = new Set();
  for (const r of rows) {
    if (r[0] === 'schema') Object.assign(out, { exists: true, charset: r[1] || null, collation: r[2] || null });
    else if (r[0] === 'tbl') out.tables.push({ name: r[1], view: r[2] === 'VIEW', bytes: Number(r[3]) || 0 });
    else if (r[0] === 'routines') out.routines = Number(r[1]) || 0;
    else if (r[0] === 'events') out.events = Number(r[1]) || 0;
    else if (r[0] === 'triggers') out.triggers = Number(r[1]) || 0;
    else if (r[0] === 'stat') stats.push([r[1], r[2]]);
    else if (r[0] === 'mig') mig.add(r[1]);
    else if (r[0] === 'binlog') out.binlog = Object.assign(out.binlog || {}, { on: r[1] === '1', row: String(r[2] || '').toUpperCase() === 'ROW', basename: r[3] && r[3] !== 'NULL' ? r[3] : null });
    else if (r[0] === 'snap') {
      out.binlog = out.binlog || {};
      if (/FILE$/i.test(r[1])) out.binlog.file = r[2];
      else out.binlog.pos = Number(r[2]);
    }
  }
  out.tableCount = out.tables.length;
  if (out.tables.some((x) => x.name.toLowerCase() === mt.toLowerCase() && !x.view)) out.migrations = mig;
  out.fingerprint = fingerprintOf(stats);
  return out;
}

/** probe() with the login of last time, falling back to the normal login search once. */
async function probeWithLogin(ctx, t) {
  const mt = migrationsTableOf(t.project.path);
  try {
    return await probe(ctx, t, { migrationsTable: mt });
  } catch (e) {
    if (e.code !== 'NEED_CREDENTIALS' || t.credsChecked) throw e;
    credCache.delete(`${t.entry.id}|${t.project.id}`);
    t.creds = await dbservers.workingCreds(ctx, t.entry, dbservers.credCandidates(ctx, t.project.id), { timeoutMs: 15000 });
    t.credsChecked = true;
    credCache.set(`${t.entry.id}|${t.project.id}`, t.creds);
    return probe(ctx, t, { migrationsTable: mt });
  }
}

/** The migrations table name from config/database.php (Laravel's default "migrations"). */
function migrationsTableOf(projectPath) {
  let src = '';
  try { src = fs.readFileSync(path.join(projectPath, 'config', 'database.php'), 'utf8'); } catch { return 'migrations'; }
  const m = /'migrations'\s*=>\s*(?:'([A-Za-z0-9_]+)'|\[[^\]]*?'table'\s*=>\s*'([A-Za-z0-9_]+)')/.exec(src);
  return (m && (m[1] || m[2])) || 'migrations';
}

/** Laravel's migration name of a file: the base name without ".php" (every one, as Laravel does). PURE. */
function migrationName(file) {
  return path.basename(String(file)).split('.php').join('');
}

/** Is this `migrate` with nothing but output / safety flags? PURE. */
function isPlainMigrate(command, args) {
  if (String(command || '').toLowerCase() !== 'migrate') return false;
  return (Array.isArray(args) ? args : []).every((a) => PLAIN_MIGRATE_FLAGS.has(String(a).toLowerCase()));
}

function phpFilesIn(dir) {
  try { return fs.readdirSync(dir).filter((n) => /_.*\.php$/i.test(n)); } catch { return []; }
}

/**
 * Folders Laravel takes migrations from besides database/migrations: packages whose (auto-discovered)
 * service provider loads its own. null = can't tell (a provider loads them from somewhere else).
 * Cached per project until composer changes vendor.
 */
function packageMigrationDirs(projectPath) {
  const installed = path.join(projectPath, 'vendor', 'composer', 'installed.json');
  let stamp;
  try { stamp = fs.statSync(installed).mtimeMs; } catch { return []; }
  const hit = vendorCache.get(projectPath);
  if (hit && hit.stamp === stamp) return hit.dirs;
  let dirs = [];
  try {
    const data = JSON.parse(fs.readFileSync(installed, 'utf8'));
    const list = Array.isArray(data) ? data : (data.packages || []);
    for (const pkg of list) {
      const providers = (pkg.extra && pkg.extra.laravel && pkg.extra.laravel.providers) || [];
      if (!providers.length || !pkg.name) continue;
      const root = path.join(projectPath, 'vendor', ...String(pkg.name).split('/'));
      const psr4 = (pkg.autoload && pkg.autoload['psr-4']) || {};
      let loads = false;
      for (const cls of providers) {
        const ns = Object.keys(psr4).find((p) => String(cls).startsWith(p));
        if (!ns) continue;
        const base = [].concat(psr4[ns])[0] || '';
        const file = path.join(root, base, ...String(cls).slice(ns.length).split('\\')) + '.php';
        let src = '';
        try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
        if (/loadMigrationsFrom\s*\(|->\s*runsMigrations\s*\(/.test(src)) loads = true;
      }
      if (!loads) continue;
      const dir = path.join(root, 'database', 'migrations');
      if (!util.existsDir(dir)) { dirs = null; break; }
      dirs.push(dir);
    }
  } catch { dirs = null; }
  vendorCache.set(projectPath, { stamp, dirs });
  return dirs;
}

/** Does the app itself load migrations from more folders? (then what is pending can't be told) */
function appLoadsMoreMigrations(projectPath) {
  if (util.existsDir(path.join(projectPath, 'Modules'))) return true;
  const dir = path.join(projectPath, 'app', 'Providers');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.php$/i.test(n)); } catch { return false; }
  return names.some((n) => {
    try { return /loadMigrationsFrom\s*\(/.test(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return true; }
  });
}

/** How many migrations `php artisan migrate` would run, or null when that can't be told for sure. */
function pendingMigrations(projectPath, ran) {
  if (!(ran instanceof Set)) return null;
  if (appLoadsMoreMigrations(projectPath)) return null;
  const extra = packageMigrationDirs(projectPath);
  if (extra === null) return null;
  let pending = 0;
  for (const dir of [path.join(projectPath, 'database', 'migrations'), ...extra]) {
    for (const f of phpFilesIn(dir)) if (!ran.has(migrationName(f))) pending++;
  }
  return pending;
}

/** The newest restore point of this database, if it was taken with the same write counters (= same data). */
function samePoint(ctx, t, st) {
  if (!st.fingerprint) return null;
  const dir = pointsDir(ctx, t.project.id);
  const newest = util.listDirNames(dir).filter((n) => NAME_RE.test(n)).sort().pop();
  if (!newest) return null;
  const meta = util.readJson(path.join(dir, newest, 'meta.json'), null);
  const fp = meta && meta.fingerprint;
  if (!fp || meta.database !== t.database || meta.server !== t.entry.id || fp.port !== t.port) return null;
  if (fp.sig !== st.fingerprint.sig || Math.abs(Number(fp.boot) - st.fingerprint.boot) > BOOT_SLACK_S) return null;
  const p = readPoint(dir, newest);
  return p.ok ? p : null;
}

// ------------------------------------------------------------------------------------------ dump

/**
 * mariadb-dump of the database: views after the tables and routines / events last, joined into one
 * .sql that imports like a single dump. A big database is dumped in up to 4 parallel parts (biggest
 * tables spread first); for small ones the server's time per table decides, not the client, so
 * they stay in one part. Each part is its own consistent snapshot; the terminal waits until all are
 * done, so nothing the command changes can get in. Per-table trigger lookups are skipped when the
 * database has no triggers. -> number of parts.
 */
async function dumpParts(ctx, t, tool, file, st, job, { coords = false } = {}) {
  const base = [...clientArgs(ctx, t, tool), '--single-transaction', '--quick', '--add-drop-table', '--no-tablespaces',
    '--default-character-set=utf8mb4', ...(st.triggers ? [] : ['--skip-triggers'])];
  if (coords) {
    // one consistent snapshot with its binlog position (MariaDB: no table lock): a base for markers
    if (job) job.progress = { stage: 'dump', parts: 1 };
    const args = [...base, '--master-data=2', ...(st.routines || st.events ? ['--routines', '--events'] : []), t.database];
    const r = await util.run(tool, args, { outputFile: file, env: dbservers.credEnv(t.creds.password), timeoutMs: 0 });
    if (!/Dump completed/.test(util.tailFile(file, 2).text || '')) {
      throw new AppError('DUMP_FAILED', tr('tm.dumpFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, tool) }), 500);
    }
    return { parts: 1, binlog: binlogFromDump(file) };
  }
  const tables = st.tables.filter((x) => !x.view);
  const views = st.tables.filter((x) => x.view).map((x) => x.name);
  const bytes = tables.reduce((n, x) => n + x.bytes, 0);
  const lanes = bytes < PARALLEL_FROM_BYTES ? 1 : Math.max(1, Math.min(4, os.cpus().length || 1, Math.ceil(tables.length / 4)));
  const buckets = Array.from({ length: lanes }, () => ({ w: 0, names: [] }));
  for (const x of tables.slice().sort((a, b) => b.bytes - a.bytes)) {
    const b = buckets.reduce((m, c) => (c.w < m.w ? c : m));
    b.w += x.bytes + 256 * 1024;
    b.names.push(x.name);
  }
  // Windows command lines end at 32K characters: long table lists become more parts
  const chunk = (names) => {
    const out = [];
    let cur = [];
    let len = 0;
    for (const n of names) {
      if (cur.length && len + n.length + 3 > 20000) { out.push(cur); cur = []; len = 0; }
      cur.push(n);
      len += n.length + 3;
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const parts = [];
  for (const b of buckets) for (const names of chunk(b.names)) parts.push([...base, t.database, ...names]);
  for (const names of chunk(views)) parts.push([...base.filter((a) => a !== '--skip-triggers'), '--skip-triggers', t.database, ...names]);
  if (st.routines || st.events) parts.push([...base, '--no-create-info', '--no-data', '--skip-triggers', '--routines', '--events', t.database]);
  if (!parts.length) parts.push([...base, t.database]);

  if (job) job.progress = { stage: 'dump', parts: parts.length };
  const files = parts.map((_, i) => (i === 0 ? file : `${file}.part${i}`));
  const env = dbservers.credEnv(t.creds.password);
  const results = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      results[i] = await util.run(tool, parts[i], { outputFile: files[i], env, timeoutMs: 0 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker));
  try {
    for (let i = 0; i < parts.length; i++) {
      if (!/Dump completed/.test(util.tailFile(files[i], 2).text || '')) {
        const r = results[i];
        throw new AppError('DUMP_FAILED', tr('tm.dumpFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, tool) }), 500);
      }
    }
    for (let i = 1; i < files.length; i++) {
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(file, { flags: 'a' });
        w.on('error', reject).on('close', resolve);
        fs.createReadStream(files[i]).on('error', reject).pipe(w);
      });
    }
  } finally {
    for (let i = 1; i < files.length; i++) { try { fs.unlinkSync(files[i]); } catch { /* gone */ } }
  }
  return { parts: parts.length, binlog: null };
}

/** "-- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000003', MASTER_LOG_POS=1234;" from a dump's head. */
function binlogFromDump(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf8');
  } catch { return null; }
  const m = /CHANGE MASTER TO MASTER_LOG_FILE='([^']+)',\s*MASTER_LOG_POS=(\d+)/.exec(head);
  return m ? { file: m[1], pos: Number(m[2]) } : null;
}

// ------------------------------------------------------------------------------------------ create

/** mariadb-dump of t.database into a new restore point folder. -> point (readPoint shape). */
async function dumpTo(ctx, t, { reason, command = null, log = () => {}, job = null, st = null }) {
  if (!REASONS.includes(reason)) throw new AppError('BAD_INPUT', tr('tm.badReason'), 400);
  const started = Date.now();
  const tools = dbservers.clientInstallFor(ctx, t.entry);
  const tool = t.entry.dump || tools.dump;
  if (!tool) throw new AppError('NO_DUMP_TOOL', tr('move.noDumpTool'));
  const info = st || await probeWithLogin(ctx, t);
  if (!info.exists) throw new AppError('DB_MISSING', tr('tm.dbMissing', { db: t.database }), 409);
  const migrations = info.migrations ? info.migrations.size : null;

  const dir = util.ensureDir(pointsDir(ctx, t.project.id));
  let name = `${stampNow()}_${reason}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)) && i < 60; i++) name = `${stampNow()}-${i}_${reason}`;
  const final = path.join(dir, name);
  const tmp = `${final}.partial`;
  util.ensureDir(tmp);
  const file = path.join(tmp, `${t.database}.sql`);
  log('info', tr('tm.dumping', { db: t.database, tables: info.tableCount, label: t.entry.label }));
  // with the DB History binlog on (MariaDB), the dump records its binlog position: a base for markers
  const canBase = !!binlogOf(info) && (!t.entry.kind || t.entry.kind === 'mariadb');
  let dumped;
  try {
    try {
      dumped = await dumpParts(ctx, t, tool, file, info, job, { coords: canBase });
    } catch (e) {
      if (!canBase) throw e;
      // e.g. a login without RELOAD: a plain dump still protects
      dumped = await dumpParts(ctx, t, tool, file, info, job);
    }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
  const bl = binlogOf(info);
  util.writeJsonAtomic(path.join(tmp, 'meta.json'), {
    project: t.project.id, projectName: t.project.name, database: t.database, server: t.entry.id, serverLabel: t.entry.label,
    reason, command: command ? String(command).slice(0, 120) : null, tables: info.tableCount, migrations,
    charset: info.charset, collation: info.collation, createdAt: util.nowIso(),
    // the server's write counters when the dump started: the same counters later = the same data
    fingerprint: info.fingerprint ? { sig: info.fingerprint.sig, boot: info.fingerprint.boot, port: t.port } : null,
    binlog: dumped.binlog ? { file: dumped.binlog.file, pos: dumped.binlog.pos, basename: bl ? bl.basename : null } : null,
    snapshotAt: new Date(started).toISOString(),
    tookMs: Date.now() - started,
  });
  fs.renameSync(tmp, final);
  const point = readPoint(dir, name);
  point.tookMs = Date.now() - started;
  log('ok', tr('tm.pointDone', { name, size: util.fmtMB(point.sizeBytes || 0), tables: info.tableCount }));
  ctx.log(`restore point ${t.project.id}/${name} (${reason}${command ? ` ${command}` : ''}, ${point.tookMs} ms)`);
  if (reason === 'artisan' || reason === 'auto') prune(ctx, t.project.id, settingsOf(ctx).keep, log);
  return point;
}

/**
 * Before `php artisan <command> <args>`: is a new restore point needed at all? Answers in one query:
 *   {skipped, why: 'off' | 'read-only' | 'empty' | 'nothing-to-migrate'}  no point needed
 *   {reused: point}                       nothing was written since the newest point: it still fits
 *   {needed: true, t, st}                 a dump is needed (pass to createPoint as `pre`)
 */
async function precheck(ctx, projectId, { command = null, args = [], baseRunning = false } = {}) {
  if (!settingsOf(ctx).beforeArtisan) return { skipped: true, why: 'off' };
  if (!isWritingCommand(command)) return { skipped: true, why: 'read-only' };
  const t = await target(ctx, projectId, { fast: true });
  const st = await probeWithLogin(ctx, t);
  // nothing to protect yet (first migrate of a fresh database)
  if (!st.exists || st.tableCount === 0) return { skipped: true, why: 'empty', db: t.database };
  if (isPlainMigrate(command, args) && pendingMigrations(t.project.path, st.migrations) === 0) return { skipped: true, why: 'nothing-to-migrate' };
  const same = samePoint(ctx, t, st);
  if (same) return { reused: same };
  // instant: a binlog marker on a base of this server run
  const bl = binlogOf(st);
  if (bl && st.fingerprint && (!t.entry.kind || t.entry.kind === 'mariadb')) {
    const base = baseForMarker(pointsDir(ctx, projectId), { database: t.database, server: t.entry.id, boot: st.fingerprint.boot, binlog: bl, createdAt: util.nowIso() });
    if (base) {
      const marker = createMarker(ctx, t, st, { command: [command, ...(args || [])].join(' ').trim() });
      const old = Date.now() - (Date.parse(base.meta.createdAt) || 0) > BASE_MAX_AGE_MS || binIndex(bl.file) - binIndex(base.meta.binlog.file) > 3;
      return { marker, refreshBase: old };
    }
    // a base copy is being written right now: its snapshot is older than this marker, which becomes
    // usable the moment it is done (no second dump, no waiting)
    if (baseRunning) return { marker: createMarker(ctx, t, st, { command: [command, ...(args || [])].join(' ').trim() }), refreshBase: false };
  }
  return { needed: true, t, st };
}

/** A restore point of the project's database now. -> {point} | {reused: point} | {skipped, why}. */
async function createPoint(ctx, projectId, { reason = 'manual', command = null, args = [], log = () => {}, job = null, pre = null } = {}) {
  if (reason === 'artisan') {
    const chk = pre || await precheck(ctx, projectId, { command, args });
    if (chk.skipped) {
      if (chk.why === 'off') log('info', tr('tm.artisanOff'));
      else if (chk.why === 'empty') log('info', tr('tm.nothingYet', { db: chk.db }));
      return { skipped: true, why: chk.why };
    }
    if (chk.reused) { log('ok', tr('tm.reused', { name: chk.reused.name })); return { reused: chk.reused }; }
    if (chk.marker) return { point: chk.marker, marker: true };
    return { point: await dumpTo(ctx, chk.t, { reason, command, log, job, st: chk.st }) };
  }
  const t = await target(ctx, projectId);
  return { point: await dumpTo(ctx, t, { reason, command, log, job }) };
}

// ------------------------------------------------------------------------------------------ undo

async function importFile(ctx, t, db, file, job) {
  const c = dbservers.clientInstallFor(ctx, t.entry);
  if (job) job.progress = { stage: 'import' };
  const quiet = t.noLog ? ['--init-command=SET SESSION sql_log_bin=0'] : [];
  const r = await util.run(c.client, [...clientArgs(ctx, t, c.client), ...quiet, '--default-character-set=utf8mb4', '-D', db],
    { inputFile: file, env: dbservers.credEnv(t.creds.password), timeoutMs: 0 });
  if (r.code !== 0) throw new AppError('IMPORT_FAILED', tr('tm.importFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, c.client) }), 500);
}

/**
 * Time Machine's own restore work (scratch database, DROP / CREATE, re-import) must not show up as
 * hundreds of actions in "Every action": skip the binary log for these sessions when the login may.
 */
async function quietLog(ctx, t) {
  try { await dbservers.query(ctx, t.entry, 'SET SESSION sql_log_bin=0;\nSELECT 1;\n', t.creds); return true; } catch { return false; }
}
const nolog = (t) => (t.noLog ? 'SET SESSION sql_log_bin=0;\n' : '');

function createSql(db, charset, collation) {
  const cs = /^[A-Za-z0-9_]{1,32}$/.test(String(charset || '')) ? charset : 'utf8mb4';
  const co = /^[A-Za-z0-9_]{1,64}$/.test(String(collation || '')) ? ` COLLATE ${collation}` : '';
  return `CREATE DATABASE ${qid(db)} CHARACTER SET ${cs}${co};\n`;
}

/** Binlog files from `from` to `to` (both included) as the server lists them. */
async function binlogFiles(ctx, t, from, to) {
  const rows = await dbservers.query(ctx, t.entry, 'SHOW BINARY LOGS;\n', t.creds);
  const names = rows.map((r) => r[0]).filter((n) => binIndex(n) >= binIndex(from) && binIndex(n) <= binIndex(to)).sort((a, b) => binIndex(a) - binIndex(b));
  if (!names.length || names[0] !== from || names[names.length - 1] !== to || names.length !== binIndex(to) - binIndex(from) + 1) {
    throw new AppError('TM_BINLOG_GONE', tr('tm.binlogGone'), 409);
  }
  return names;
}

/** Replays the binlog of t.database from `from` to `to` into t.database (read through the server). */
async function replay(ctx, t, from, to, files, job) {
  const c = dbservers.clientInstallFor(ctx, t.entry);
  const tool = ['mariadb-binlog.exe', 'mysqlbinlog.exe'].map((f) => path.win32.join(path.win32.dirname(c.client), f)).find((f) => util.existsFile(f));
  if (!tool) throw new AppError('NO_BINLOG_TOOL', tr('hist.noTool'), 409);
  if (job) job.progress = { stage: 'replay' };
  const env = dbservers.credEnv(t.creds.password);
  const readArgs = ['-R', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(t.port), '-u', t.creds.user, ...dbservers.sslArgs(tool, c.kind),
    `--start-position=${from.pos}`, `--stop-position=${to.pos}`, `--database=${t.database}`, ...files];
  const quiet = t.noLog ? ['--init-command=SET SESSION sql_log_bin=0'] : [];
  const applyArgs = [...clientArgs(ctx, t, c.client), '--binary-mode', ...quiet, '--default-character-set=utf8mb4', '-D', t.database];
  const result = await new Promise((resolve) => {
    const reader = spawn(tool, readArgs, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const writer = spawn(c.client, applyArgs, { env, windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    let errR = '';
    let errW = '';
    let codeR = null;
    let codeW = null;
    const done = () => { if (codeR !== null && codeW !== null) resolve({ codeR, codeW, errR, errW }); };
    reader.stderr.on('data', (d) => { if (errR.length < 16384) errR += d; });
    writer.stderr.on('data', (d) => { if (errW.length < 16384) errW += d; });
    reader.on('error', (e) => { errR += e.message; codeR = -1; try { writer.stdin.end(); } catch { /* gone */ } done(); });
    writer.on('error', (e) => { errW += e.message; codeW = -1; done(); });
    writer.stdin.on('error', () => { /* the client stopped: its exit code tells */ });
    reader.stdout.pipe(writer.stdin);
    reader.on('close', (code) => { codeR = code; done(); });
    writer.on('close', (code) => { codeW = code; if (codeR === null) { try { reader.kill(); } catch { /* gone */ } } done(); });
  });
  if (result.codeR !== 0 || result.codeW !== 0) {
    const err = util.firstLine(dbservers.cleanStderr(result.errW)) || util.firstLine(dbservers.cleanStderr(result.errR)) || `${result.codeR}/${result.codeW}`;
    throw new AppError('TM_REPLAY_FAILED', tr('tm.replayFailed', { error: err }), 500);
  }
}

/** The database rebuilt as it was at a marker: its base imported, the binlog replayed up to the marker. */
async function rebuildAt(ctx, t, dir, markerMeta, charset, collation, log, job) {
  const base = baseForMarker(dir, markerMeta);
  if (!base) throw new AppError('TM_NO_BASE', tr('tm.noBase'), 409);
  const files = await binlogFiles(ctx, t, base.meta.binlog.file, markerMeta.binlog.file);
  log('info', tr('tm.rebuilding', { base: whenOf(base.name), files: files.length }));
  await dbservers.query(ctx, t.entry, nolog(t) + `DROP DATABASE IF EXISTS ${qid(t.database)};\n${createSql(t.database, charset, collation)}`, t.creds);
  await importFile(ctx, t, t.database, path.join(dir, base.name, `${base.meta.database}.sql`), job);
  await replay(ctx, t, base.meta.binlog, markerMeta.binlog, files, job);
}

/** Undo to a marker (point-in-time restore); the current state is saved first as well. */
async function undoToMarker(ctx, projectId, name, meta, log, job) {
  const dir = pointsDir(ctx, projectId);
  const t = await target(ctx, projectId);
  t.database = meta.database;
  if (t.entry.id !== meta.server) throw new AppError('TM_OTHER_SERVER', tr('tm.otherServer'), 409);
  t.noLog = await quietLog(ctx, t);
  const when = whenOf(name);
  log('info', tr('tm.undoStart', { db: t.database, when, label: t.entry.label }));
  // 1. the current state first (as a marker when possible: instant)
  const st = await probeWithLogin(ctx, t);
  let safety = null;
  if (st.exists && st.tableCount) {
    log('info', tr('tm.safetyFirst'));
    const bl = binlogOf(st);
    const base = bl && st.fingerprint ? baseForMarker(dir, { database: t.database, server: t.entry.id, boot: st.fingerprint.boot, binlog: bl, createdAt: util.nowIso() }) : null;
    safety = base ? createMarker(ctx, t, st, { reason: 'pre-undo', command: `undo -> ${name}`, log }) : await dumpTo(ctx, t, { reason: 'pre-undo', command: `undo -> ${name}`, log, job, st });
  }
  const charset = st.charset || meta.charset;
  const collation = st.collation || meta.collation;
  // 2. base + binlog up to the marker
  try {
    await rebuildAt(ctx, t, dir, meta, charset, collation, log, job);
  } catch (e) {
    log('bad', tr('tm.replaceFailed', { message: e.message }));
    if (safety) {
      const smeta = util.readJson(path.join(dir, safety.name, 'meta.json'), {}) || {};
      if (smeta.kind === 'marker') await rebuildAt(ctx, t, dir, smeta, charset, collation, log, job);
      else {
        await dbservers.query(ctx, t.entry, nolog(t) + `DROP DATABASE IF EXISTS ${qid(t.database)};\n${createSql(t.database, charset, collation)}`, t.creds);
        await importFile(ctx, t, t.database, path.join(dir, safety.name, `${t.database}.sql`), job);
      }
      log('ok', tr('tm.putBack'));
    }
    if (t.noLog) markUnlogged(ctx, projectId);
    throw new AppError('UNDO_FAILED', tr('tm.undoFailed', { message: e.message }), 500);
  }
  if (t.noLog) markUnlogged(ctx, projectId);
  const after = await schemaInfo(ctx, t, t.database);
  log('ok', tr('tm.undoDone', { db: t.database, tables: after.tables, when }));
  ctx.log(`undo ${projectId} -> ${name} (marker, safety ${safety ? safety.name : '-'})`);
  return { database: t.database, point: name, safety: safety ? safety.name : null, tables: after.tables };
}

/** Puts the project's database back to restore point `name` (see the header for the safety steps). */
async function undoTo(ctx, projectId, name, log = () => {}, job = null) {
  if (!NAME_RE.test(String(name || ''))) throw new AppError('BAD_INPUT', tr('tm.badName'), 400);
  const dir = pointsDir(ctx, projectId);
  const point = readPoint(dir, name);
  if (point.marker) {
    if (!point.ok) throw new AppError('TM_NO_BASE', tr('tm.noBase'), 409);
    return undoToMarker(ctx, projectId, name, util.readJson(path.join(dir, name, 'meta.json'), {}) || {}, log, job);
  }
  if (!point.ok) throw new AppError('NOT_FOUND', tr('tm.notFound'), 404);
  const meta = util.readJson(path.join(dir, name, 'meta.json'), {}) || {};
  const file = path.join(dir, name, `${point.database}.sql`);
  const t = await target(ctx, projectId);
  // the point belongs to the database it was taken from (the .env may name another one by now)
  t.database = point.database;
  const when = whenOf(name);
  t.noLog = await quietLog(ctx, t);
  log('info', tr('tm.undoStart', { db: t.database, when, label: t.entry.label }));

  // 1. the current state first, so this undo can be undone too
  const cur = await schemaInfo(ctx, t, t.database);
  let safety = null;
  if (cur.exists) {
    log('info', tr('tm.safetyFirst'));
    safety = await dumpTo(ctx, t, { reason: 'pre-undo', command: `undo -> ${name}`, log, job });
  } else {
    log('info', tr('tm.dbAbsentNow', { db: t.database }));
  }
  const charset = cur.charset || meta.charset;
  const collation = cur.collation || meta.collation;

  // 2. prove the point imports cleanly into a scratch database (the real one stays untouched)
  const scratch = `ps_undo_${util.randomHex(4)}`;
  log('info', tr('tm.verifying'));
  if (job) job.progress = { stage: 'verify' };
  await dbservers.query(ctx, t.entry, nolog(t) + createSql(scratch, charset, collation), t.creds);
  try {
    await importFile(ctx, t, scratch, file, job);
    log('ok', tr('tm.verified'));
  } catch (e) {
    try { await dbservers.query(ctx, t.entry, nolog(t) + `DROP DATABASE IF EXISTS ${qid(scratch)};\n`, t.creds); } catch { /* best effort */ }
    throw new AppError('UNDO_VERIFY_FAILED', tr('tm.verifyFailed', { message: e.message }), 500);
  }
  try { await dbservers.query(ctx, t.entry, nolog(t) + `DROP DATABASE IF EXISTS ${qid(scratch)};\n`, t.creds); } catch { /* best effort */ }

  // 3. the real database
  log('info', tr('tm.replacing', { db: t.database }));
  await dbservers.query(ctx, t.entry, nolog(t) + `DROP DATABASE IF EXISTS ${qid(t.database)};\n${createSql(t.database, charset, collation)}`, t.creds);
  try {
    await importFile(ctx, t, t.database, file, job);
  } catch (e) {
    log('bad', tr('tm.replaceFailed', { message: e.message }));
    if (safety) {
      const back = path.join(dir, safety.name, `${t.database}.sql`);
      await dbservers.query(ctx, t.entry, nolog(t) + `DROP DATABASE IF EXISTS ${qid(t.database)};\n${createSql(t.database, charset, collation)}`, t.creds);
      await importFile(ctx, t, t.database, back, job);
      log('ok', tr('tm.putBack'));
    }
    throw new AppError('UNDO_FAILED', tr('tm.undoFailed', { message: e.message }), 500);
  }
  if (t.noLog) markUnlogged(ctx, projectId);
  const after = await schemaInfo(ctx, t, t.database);
  log('ok', tr('tm.undoDone', { db: t.database, tables: after.tables, when }));
  ctx.log(`undo ${projectId} -> ${name} (safety ${safety ? safety.name : '-'})`);
  return { database: t.database, point: name, safety: safety ? safety.name : null, tables: after.tables };
}

/** Removes one restore point (only inside the points folder). */
function deletePoint(ctx, projectId, name) {
  projects.getProject(ctx, projectId);
  if (!NAME_RE.test(String(name || ''))) throw new AppError('BAD_INPUT', tr('tm.badName'), 400);
  const p = path.join(pointsDir(ctx, projectId), name);
  if (!util.isInside(p, rootDir(ctx)) || !util.existsDir(p)) throw new AppError('NOT_FOUND', tr('tm.notFound'), 404);
  const dir = pointsDir(ctx, projectId);
  for (const n of util.listDirNames(dir).filter((x) => NAME_RE.test(x) && x !== name)) {
    const meta = util.readJson(path.join(dir, n, 'meta.json'), null);
    if (meta && meta.kind === 'marker') {
      const b = baseForMarker(dir, meta);
      if (b && b.name === name) throw new AppError('TM_BASE_IN_USE', tr('tm.baseInUse', { marker: whenOf(n) }), 409);
    }
  }
  fs.rmSync(p, { recursive: true, force: true });
  ctx.log(`restore point deleted ${projectId}/${name}`);
  return { ok: true };
}

module.exports = {
  NAME_RE, REASONS, isWritingCommand, rootDir, pointsDir, settingsOf,
  listPoints, summary, overview, createPoint, precheck, undoTo, deletePoint, target,
  dumpPoint: dumpTo, baseNeeded, markUnlogged,
  // pure, for tests
  cmpCoords, binIndex, baseForMarker,
  // pure, for tests
  fingerprintOf, migrationName, isPlainMigrate, pendingMigrations,
};
