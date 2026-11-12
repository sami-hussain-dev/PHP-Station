'use strict';
/*
 * Backups of DB servers. Nothing is ever overwritten or deleted except PHP Station's own OLD
 * automatic copies beyond the "keep" count.
 *  - Snapshot: a full copy of the datadir, taken only while the server is STOPPED (so it is
 *    consistent): <dumpDir>\devpanel-backups\snapshots\<server>\<stamp>_<reason>\ (+ meta.json).
 *    Automatic: before PHP Station starts a server (default once a day).
 *  - Dump: mariadb-dump of every user database while the server RUNS:
 *    <dumpDir>\devpanel-backups\dumps\<server>\<stamp>_<reason>\<db>.sql. Automatic: once a day.
 *  - Restore snapshot: the current datadir is RENAMED to "<datadir>_before_restore_<stamp>"
 *    (kept next to it), then the snapshot is copied in.
 *  - Restore dump: into a database that does not exist yet (never over an existing one).
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const procs = require('./procs');
const dbservers = require('./dbservers');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const NAME_RE = /^\d{8}-\d{6}_(auto|manual|pre-repair|pre-rescue|pre-restore)$/;
const DB_RE = /^[A-Za-z0-9_$-]{1,64}$/;

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}
function rootDir(ctx) {
  return path.join(ctx.store.data.settings.dumpDir, 'devpanel-backups');
}
function snapDir(ctx, id) {
  return path.join(rootDir(ctx), 'snapshots', safeId(id));
}
function dumpDirOf(ctx, id) {
  return path.join(rootDir(ctx), 'dumps', safeId(id));
}
/** 20261112-143005 (sorts by time, safe in folder names). */
function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { total += fs.statSync(f).size; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return total;
}

function freeBytes(dir) {
  try {
    util.ensureDir(dir);
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

function settingsOf(ctx) {
  const s = ctx.store.data.settings;
  return {
    snapshotOnStart: ['daily', 'always', 'off'].includes(s.snapshotOnStart) ? s.snapshotOnStart : 'daily',
    snapshotKeep: Number.isInteger(s.snapshotKeep) ? s.snapshotKeep : 7,
    snapshotMaxMB: Number.isInteger(s.snapshotMaxMB) ? s.snapshotMaxMB : 4096,
    dailyDump: s.dailyDump !== false,
    dumpKeep: Number.isInteger(s.dumpKeep) ? s.dumpKeep : 7,
  };
}

// ------------------------------------------------------------------------------------------ listing

function listSnapshots(ctx, id) {
  const dir = snapDir(ctx, id);
  return util.listDirNames(dir)
    .filter((n) => NAME_RE.test(n))
    .map((n) => {
      const meta = util.readJson(path.join(dir, n, 'meta.json'), {}) || {};
      return { name: n, path: path.join(dir, n), reason: n.split('_')[1], createdAt: meta.createdAt || null, sizeBytes: meta.sizeBytes || null, version: meta.version || null, datadir: meta.datadir || null };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function listDumps(ctx, id) {
  const dir = dumpDirOf(ctx, id);
  return util.listDirNames(dir)
    .filter((n) => NAME_RE.test(n))
    .map((n) => {
      const meta = util.readJson(path.join(dir, n, 'meta.json'), {}) || {};
      let files = [];
      try {
        files = fs.readdirSync(path.join(dir, n)).filter((f) => /\.sql$/i.test(f))
          .map((f) => ({ db: f.replace(/\.sql$/i, ''), file: path.join(dir, n, f), size: fs.statSync(path.join(dir, n, f)).size }));
      } catch { files = []; }
      return { name: n, path: path.join(dir, n), reason: n.split('_')[1], createdAt: meta.createdAt || null, files, failed: meta.failed || [] };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Old AUTOMATIC copies beyond `keep` are removed (manual / pre-repair ones are never touched). */
function prune(ctx, dir, keep, log) {
  const auto = util.listDirNames(dir).filter((n) => NAME_RE.test(n) && n.endsWith('_auto')).sort().reverse();
  for (const n of auto.slice(Math.max(1, keep))) {
    const p = path.join(dir, n);
    if (!util.isInside(p, rootDir(ctx))) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); log('info', tr('bk.pruned', { name: n })); } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------------------------------ snapshots

async function requireStopped(ctx, entry) {
  const snap = await procs.getSnapshot({ fresh: true });
  const st = dbservers.entryStatus(ctx, entry, snap);
  if (st.status !== 'stopped') throw new AppError('DB_RUNNING', tr('bk.stopFirst', { label: entry.label }), 409);
  const lock = dbservers.lockProbe(entry.datadir);
  if (lock.inUse) throw new AppError('DATADIR_IN_USE', tr('err.datadirLockedHint', { code: lock.error }), 409);
}

/** Full copy of a STOPPED server's datadir. -> {name, path, sizeBytes}. */
async function snapshot(ctx, entryOrId, { reason = 'manual', log = () => {} } = {}) {
  const entry = typeof entryOrId === 'string' ? dbservers.getEntry(ctx, entryOrId) : entryOrId;
  if (!entry.datadir || !util.existsDir(entry.datadir)) throw new AppError('DATADIR_MISSING', tr('db.datadirMissing', { datadir: entry.datadir || '-' }), 409);
  await requireStopped(ctx, entry);
  const size = dirSize(entry.datadir);
  const dir = util.ensureDir(snapDir(ctx, entry.id));
  const free = freeBytes(dir);
  if (free != null && free < size * 1.1 + 200 * util.MB) {
    throw new AppError('NO_SPACE', tr('bk.noSpace', { need: util.fmtMB(size), free: util.fmtMB(free), dir }), 507);
  }
  const name = `${stampNow()}_${reason}`;
  const target = path.join(dir, name);
  const tmp = `${target}.partial`;
  log('info', tr('bk.snapCopying', { from: entry.datadir, size: util.fmtMB(size), to: target }));
  const t0 = Date.now();
  try {
    fs.cpSync(entry.datadir, tmp, { recursive: true, errorOnExist: true, force: false });
    util.writeJsonAtomic(path.join(tmp, 'meta.json'), {
      server: entry.id, label: entry.label, version: entry.version, kind: entry.kind, datadir: entry.datadir,
      reason, sizeBytes: size, createdAt: util.nowIso(),
    });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new AppError('SNAPSHOT_FAILED', tr('bk.snapFailed', { message: e.message }), 500);
  }
  log('ok', tr('bk.snapDone', { name, size: util.fmtMB(size), secs: Math.round((Date.now() - t0) / 1000) }));
  ctx.log(`snapshot ${entry.id} -> ${target} (${reason})`);
  if (reason === 'auto') prune(ctx, dir, settingsOf(ctx).snapshotKeep, log);
  return { name, path: target, sizeBytes: size };
}

/** Called by startServer before the spawn: the automatic snapshot. Never blocks the start. */
async function autoBeforeStart(ctx, entry, log = () => {}) {
  const s = settingsOf(ctx);
  if (s.snapshotOnStart === 'off' || !entry.datadir || !util.existsDir(entry.datadir)) return null;
  if (s.snapshotOnStart === 'daily') {
    const today = stampNow().slice(0, 8);
    const last = listSnapshots(ctx, entry.id)[0]; // any snapshot today (also a pre-repair one) is enough
    if (last && last.name.slice(0, 8) === today) return null;
  }
  try {
    const size = dirSize(entry.datadir);
    if (size > s.snapshotMaxMB * util.MB) {
      log('warn', tr('bk.snapSkipBig', { size: util.fmtMB(size), max: `${s.snapshotMaxMB} MB` }));
      return null;
    }
    return await snapshot(ctx, entry, { reason: 'auto', log });
  } catch (e) {
    log('warn', tr('bk.snapAutoFailed', { message: e.message }));
    ctx.log(`auto snapshot ${entry.id} failed: ${e.message}`);
    return null;
  }
}

/**
 * Restore: server must be stopped. The current datadir is renamed (kept next to it), the snapshot
 * copied into its place. -> {kept}.
 */
async function restoreSnapshot(ctx, id, name, log = () => {}) {
  const entry = dbservers.getEntry(ctx, id);
  if (!NAME_RE.test(String(name || ''))) throw new AppError('BAD_INPUT', tr('bk.badName'), 400);
  const src = path.join(snapDir(ctx, id), name);
  if (!util.existsDir(src)) throw new AppError('NOT_FOUND', tr('bk.notFound'), 404);
  if (!entry.datadir) throw new AppError('DATADIR_MISSING', tr('db.datadirMissing', { datadir: '-' }), 409);
  await requireStopped(ctx, entry);
  const kept = `${entry.datadir.replace(/[\\/]+$/, '')}_before_restore_${stampNow()}`;
  if (util.existsDir(entry.datadir)) {
    log('info', tr('bk.keepCurrent', { from: entry.datadir, to: kept }));
    fs.renameSync(entry.datadir, kept);
  }
  try {
    log('info', tr('bk.restoring', { name }));
    fs.cpSync(src, entry.datadir, { recursive: true, errorOnExist: true, force: false, filter: (p) => !util.samePath(p, path.join(src, 'meta.json')) });
  } catch (e) {
    // put the original back exactly as it was
    try { fs.rmSync(entry.datadir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (util.existsDir(kept)) fs.renameSync(kept, entry.datadir);
    throw new AppError('RESTORE_FAILED', tr('bk.restoreFailed', { message: e.message }), 500);
  }
  log('ok', tr('bk.restored', { name, kept }));
  ctx.log(`snapshot restore ${id} <- ${name}, old datadir kept at ${kept}`);
  return { kept, datadir: entry.datadir };
}

// ------------------------------------------------------------------------------------------ dumps

/** Credentials that work on a running server: a project's .env user first, then root / empty. */
async function credsFor(ctx, entry) {
  const p = (ctx.store.data.projects || []).find((x) => x.dbServerId === entry.id);
  return dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, p ? p.id : null), { timeoutMs: 15000 });
}

/** mariadb-dump of every user database of a RUNNING server. -> {name, files, failed}. */
async function dump(ctx, entryOrId, { reason = 'manual', log = () => {}, job = null } = {}) {
  const entry = typeof entryOrId === 'string' ? dbservers.getEntry(ctx, entryOrId) : entryOrId;
  const snap = await procs.getSnapshot({ fresh: true });
  if (dbservers.entryStatus(ctx, entry, snap).status !== 'running') throw new AppError('DB_NOT_RUNNING', tr('bk.startFirst', { label: entry.label }), 409);
  const creds = await credsFor(ctx, entry);
  const dbs = (await dbservers.query(ctx, entry, 'SHOW DATABASES;\n', creds)).map((r) => r[0])
    .filter((d) => d && !dbservers.SYSTEM_DBS.has(d.toLowerCase()) && DB_RE.test(d));
  const tools = dbservers.clientInstallFor(ctx, entry);
  const tool = entry.dump || tools.dump;
  if (!tool) throw new AppError('NO_DUMP_TOOL', tr('move.noDumpTool'));
  const dir = util.ensureDir(dumpDirOf(ctx, entry.id));
  const name = `${stampNow()}_${reason}`;
  const out = util.ensureDir(path.join(dir, name));
  log('info', tr('bk.dumpStart', { n: dbs.length, to: out }));
  const files = [];
  const failed = [];
  for (let i = 0; i < dbs.length; i++) {
    const db = dbs[i];
    if (job) job.progress = { stage: 'dump', percent: Math.floor((i / Math.max(1, dbs.length)) * 100) };
    const file = path.join(out, `${db}.sql`);
    const args = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(entry.effectivePort), '-u', creds.user,
      ...dbservers.sslArgs(tool, entry.kind), '--single-transaction', '--quick', '--routines', '--triggers', '--events',
      // --force: one broken table (e.g. "doesn't exist in engine") must not cost the rest of the database
      '--force', '--default-character-set=utf8mb4', '--databases', db];
    const r = await util.run(tool, args, { outputFile: file, env: dbservers.credEnv(creds.password), timeoutMs: 0 });
    const completed = /Dump completed/.test(util.tailFile(file, 2).text || '');
    const errLines = dbservers.cleanStderr(r.stderr).split(/\r?\n/).filter((l) => /error|couldn't/i.test(l));
    if (completed) {
      const size = fs.statSync(file).size;
      files.push({ db, file, size });
      if (errLines.length) {
        const broken = [...new Set(errLines.map((l) => (/`([^`]+)`/.exec(l) || [])[1]).filter(Boolean))];
        failed.push({ db, partial: true, tables: broken, error: errLines[0] });
        log('warn', tr('bk.dumpPartial', { db, size: util.fmtMB(size), tables: broken.join(', ') || errLines[0] }));
      } else {
        log('ok', `${db}: ${util.fmtMB(size)}`);
      }
    } else {
      failed.push({ db, error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, tool) });
      try { fs.renameSync(file, `${file}.incomplete`); } catch { /* none */ }
      log('warn', tr('bk.dumpDbFailed', { db, error: failed[failed.length - 1].error }));
    }
  }
  util.writeJsonAtomic(path.join(out, 'meta.json'), { server: entry.id, label: entry.label, reason, createdAt: util.nowIso(), databases: files.map((f) => f.db), failed });
  if (reason === 'auto') prune(ctx, dir, settingsOf(ctx).dumpKeep, log);
  const st = ctx.store.data.backupState || (ctx.store.data.backupState = {});
  st[entry.id] = Object.assign({}, st[entry.id], { lastDumpAt: util.nowIso(), lastDumpError: failed.length ? `${failed.length} failed` : null });
  ctx.store.save();
  log(failed.length ? 'warn' : 'ok', tr('bk.dumpDone', { ok: files.length, failed: failed.length }));
  return { name, path: out, files, failed };
}

/** Imports one dumped database into a NEW database `target` on the (running) server. */
async function restoreDump(ctx, id, name, db, target, log = () => {}, job = null) {
  const entry = dbservers.getEntry(ctx, id);
  if (!NAME_RE.test(String(name || '')) || !DB_RE.test(String(db || '')) || !DB_RE.test(String(target || ''))) throw new AppError('BAD_INPUT', tr('bk.badName'), 400);
  const file = path.join(dumpDirOf(ctx, id), name, `${db}.sql`);
  if (!util.existsFile(file)) throw new AppError('NOT_FOUND', tr('bk.notFound'), 404);
  const snap = await procs.getSnapshot({ fresh: true });
  if (dbservers.entryStatus(ctx, entry, snap).status !== 'running') throw new AppError('DB_NOT_RUNNING', tr('bk.startFirst', { label: entry.label }), 409);
  const creds = await credsFor(ctx, entry);
  if (await dbservers.databaseExists(ctx, entry, target, creds)) throw new AppError('TARGET_EXISTS', tr('move.targetExists', { db: target }), 409);
  // the dump names its database (--databases): import it into the target by rewriting only the
  // CREATE DATABASE / USE lines into a temp copy
  const tmp = path.join(util.ensureDir(path.join(rootDir(ctx), 'tmp')), `${target}_${util.randomHex(3)}.sql`);
  const q = (s) => `\`${s.replace(/`/g, '``')}\``;
  await new Promise((resolve, reject) => {
    const rl = require('readline').createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
    let header = true;
    rl.on('line', (line) => {
      let l = line;
      if (header && /^CREATE DATABASE /i.test(l)) l = `CREATE DATABASE ${q(target)} /*!40100 DEFAULT CHARACTER SET utf8mb4 */;`;
      else if (header && /^USE `/i.test(l)) { l = `USE ${q(target)};`; header = false; }
      ws.write(`${l}\n`);
    });
    rl.on('close', () => ws.end(resolve));
    rl.on('error', reject);
    ws.on('error', reject);
  });
  try {
    const c = dbservers.clientInstallFor(ctx, entry);
    log('info', tr('bk.dumpRestoring', { db, target }));
    if (job) job.progress = { stage: 'import' };
    const r = await util.run(c.client, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(entry.effectivePort), '-u', creds.user,
      ...dbservers.sslArgs(c.client, c.kind), '--default-character-set=utf8mb4'], { inputFile: tmp, env: dbservers.credEnv(creds.password), timeoutMs: 0 });
    if (r.code !== 0) throw new AppError('IMPORT_FAILED', tr('bk.dumpRestoreFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, c.client) }), 500);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
  log('ok', tr('bk.dumpRestored', { db, target }));
  return { database: target };
}

/** Once a day per running server (scheduler in server.js). -> list of server ids due. */
function dueForDailyDump(ctx, dbViews, now = Date.now()) {
  if (!settingsOf(ctx).dailyDump) return [];
  const st = ctx.store.data.backupState || {};
  return (dbViews || []).filter((d) => {
    if (!d || d.status !== 'running') return false;
    const s = st[d.id] || {};
    const last = Date.parse(s.lastDumpAt || s.lastTryAt || '') || 0;
    return now - last >= 24 * 3600 * 1000;
  }).map((d) => d.id);
}

function overview(ctx, id) {
  dbservers.getEntry(ctx, id);
  return {
    root: rootDir(ctx),
    snapshots: listSnapshots(ctx, id),
    dumps: listDumps(ctx, id),
    state: (ctx.store.data.backupState || {})[id] || {},
    settings: settingsOf(ctx),
  };
}

module.exports = {
  NAME_RE, stampNow, rootDir, snapDir, dumpDirOf, dirSize, settingsOf,
  listSnapshots, listDumps, snapshot, autoBeforeStart, restoreSnapshot, dump, restoreDump, dueForDailyDump, overview, requireStopped,
};
