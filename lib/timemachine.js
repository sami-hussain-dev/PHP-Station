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
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const procs = require('./procs');
const dbservers = require('./dbservers');
const projects = require('./projects');
const { tr } = require('./i18n');

const { AppError } = util;
const REASONS = Object.freeze(['manual', 'artisan', 'pre-undo', 'auto']);
const NAME_RE = /^\d{8}-\d{6}(?:-\d{1,2})?_(manual|artisan|pre-undo|auto)$/;
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
async function target(ctx, projectId) {
  const p = projects.getProject(ctx, projectId);
  const env = projects.inspectProject(p.path).env;
  if (!env.exists) throw new AppError('NO_ENV', tr('tm.noEnv'), 409);
  if (env.connection && !/^(mysql|mariadb)$/i.test(env.connection)) throw new AppError('NOT_MYSQL', tr('tm.notMysql', { conn: env.connection }), 409);
  if (env.host && !util.isLocalHost(env.host)) throw new AppError('NOT_LOCAL', tr('tm.notLocal', { host: env.host }), 409);
  if (!env.database || !DB_RE.test(env.database)) throw new AppError('NO_DATABASE', tr('tm.noDatabase'), 409);
  const own = projects.dbEntryFor(ctx, p);
  if (!own) throw new AppError('NO_DB_SERVER', tr('tm.noDbServer'), 409);
  const snap = await procs.getSnapshot({ fresh: true });
  let entry = own;
  let via = 'own';
  if (dbservers.entryStatus(ctx, own, snap).status !== 'running') {
    const other = await dbservers.findDatadirServer(ctx, own, snap, { projectId: p.id });
    if (!other) throw new AppError('DB_NOT_RUNNING', tr('tm.dbStopped', { label: own.label }), 409);
    entry = other.entry;
    via = other.via;
  }
  const creds = await dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, p.id), { timeoutMs: 15000 });
  return { project: p, entry, port: entry.effectivePort, database: env.database, creds, via };
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
  const auto = util.listDirNames(dir).filter((n) => NAME_RE.test(n) && /_(artisan|auto)$/.test(n)).sort().reverse();
  for (const n of auto.slice(Math.max(1, keep))) {
    const p = path.join(dir, n);
    if (!util.isInside(p, rootDir(ctx))) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); log('info', tr('tm.pruned', { name: n })); } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------------------------------ create

/** mariadb-dump of t.database into a new restore point folder. -> point (readPoint shape). */
async function dumpTo(ctx, t, { reason, command = null, log = () => {}, job = null }) {
  if (!REASONS.includes(reason)) throw new AppError('BAD_INPUT', tr('tm.badReason'), 400);
  const tools = dbservers.clientInstallFor(ctx, t.entry);
  const tool = t.entry.dump || tools.dump;
  if (!tool) throw new AppError('NO_DUMP_TOOL', tr('move.noDumpTool'));
  const info = await schemaInfo(ctx, t, t.database);
  if (!info.exists) throw new AppError('DB_MISSING', tr('tm.dbMissing', { db: t.database }), 409);
  let migrations = null;
  try {
    const r = await dbservers.query(ctx, t.entry, `SELECT COUNT(*) FROM ${qid(t.database)}.\`migrations\`;\n`, Object.assign({}, t.creds, { timeoutMs: 15000 }));
    migrations = r.length ? Number(r[0][0]) : null;
  } catch { migrations = null; }

  const dir = util.ensureDir(pointsDir(ctx, t.project.id));
  let name = `${stampNow()}_${reason}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)) && i < 60; i++) name = `${stampNow()}-${i}_${reason}`;
  const final = path.join(dir, name);
  const tmp = `${final}.partial`;
  util.ensureDir(tmp);
  const file = path.join(tmp, `${t.database}.sql`);
  log('info', tr('tm.dumping', { db: t.database, tables: info.tables, label: t.entry.label }));
  if (job) job.progress = { stage: 'dump' };
  const args = [...clientArgs(ctx, t, tool), '--single-transaction', '--quick', '--routines', '--triggers', '--events',
    '--add-drop-table', '--default-character-set=utf8mb4', t.database];
  const r = await util.run(tool, args, { outputFile: file, env: dbservers.credEnv(t.creds.password), timeoutMs: 0 });
  const completed = /Dump completed/.test(util.tailFile(file, 2).text || '');
  if (!completed) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new AppError('DUMP_FAILED', tr('tm.dumpFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, tool) }), 500);
  }
  util.writeJsonAtomic(path.join(tmp, 'meta.json'), {
    project: t.project.id, projectName: t.project.name, database: t.database, server: t.entry.id, serverLabel: t.entry.label,
    reason, command: command ? String(command).slice(0, 120) : null, tables: info.tables, migrations,
    charset: info.charset, collation: info.collation, createdAt: util.nowIso(),
  });
  fs.renameSync(tmp, final);
  const point = readPoint(dir, name);
  log('ok', tr('tm.pointDone', { name, size: util.fmtMB(point.sizeBytes || 0), tables: info.tables }));
  ctx.log(`restore point ${t.project.id}/${name} (${reason}${command ? ` ${command}` : ''})`);
  if (reason === 'artisan' || reason === 'auto') prune(ctx, t.project.id, settingsOf(ctx).keep, log);
  return point;
}

/** A restore point of the project's database now. -> {point} or {skipped, reason}. */
async function createPoint(ctx, projectId, { reason = 'manual', command = null, log = () => {}, job = null } = {}) {
  if (reason === 'artisan') {
    if (!settingsOf(ctx).beforeArtisan) { log('info', tr('tm.artisanOff')); return { skipped: true, why: 'off' }; }
    if (!isWritingCommand(command)) return { skipped: true, why: 'read-only' };
  }
  const t = await target(ctx, projectId);
  if (reason === 'artisan') {
    // nothing to protect yet (first migrate of a fresh database): stay quiet
    const info = await schemaInfo(ctx, t, t.database);
    if (!info.exists || info.tables === 0) { log('info', tr('tm.nothingYet', { db: t.database })); return { skipped: true, why: 'empty' }; }
  }
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

/** Puts the project's database back to restore point `name` (see the header for the safety steps). */
async function undoTo(ctx, projectId, name, log = () => {}, job = null) {
  if (!NAME_RE.test(String(name || ''))) throw new AppError('BAD_INPUT', tr('tm.badName'), 400);
  const dir = pointsDir(ctx, projectId);
  const point = readPoint(dir, name);
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
  fs.rmSync(p, { recursive: true, force: true });
  ctx.log(`restore point deleted ${projectId}/${name}`);
  return { ok: true };
}

module.exports = {
  NAME_RE, REASONS, isWritingCommand, rootDir, pointsDir, settingsOf,
  listPoints, summary, overview, createPoint, undoTo, deletePoint, target,
};
