'use strict';
/*
 * "Move database from old server to new server" job: checks, dump (stdout to a file), create,
 * import, count comparison. Never overwrites, never auto-drops, never logs passwords.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const semver = require('./semver');
const procs = require('./procs');
const dbservers = require('./dbservers');
const { tr } = require('./i18n');

const { AppError } = util;
const NAME_RE = /^[A-Za-z0-9_$-]{1,64}$/;
const COLLATION_COMPAT_ARG = "--init-command=SET SESSION character_set_collations='utf8mb4=utf8mb4_general_ci,utf8mb3=utf8mb3_general_ci'";

/** MariaDB >= 11.2 targets get the session setting that keeps pre-11.2 collations (unless uca1400). */
function needsCollationCompat(entry, collation) {
  const v = semver.normalizeVersion(entry && entry.version);
  return !!(entry && entry.kind === 'mariadb' && v && semver.compare(v, [11, 2, 0]) >= 0 && !/uca1400/i.test(collation || ''));
}

function ident(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/** side: 'src' (old server) or 'dst' (new server). */
async function requireRunning(ctx, id, side) {
  const { entry, status } = await dbservers.isEntryRunning(ctx, id);
  if (status.status !== 'running') throw new AppError('DB_NOT_RUNNING', tr(side === 'src' ? 'move.srcNotRunning' : 'move.dstNotRunning', { label: entry.label }), 409);
  return entry;
}

/** {tables:[{name, rows}], views, routines, triggers, events}. */
async function counts(ctx, entry, db, creds) {
  const lit = dbservers.sqlStr(db);
  const tables = (await dbservers.query(ctx, entry,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ${lit} AND table_type = 'BASE TABLE' ORDER BY table_name;\n`, creds))
    .map((r) => r[0]);
  const out = { tables: [], views: 0, routines: 0, triggers: 0, events: 0 };
  if (tables.length) {
    const sql = tables.map((t, i) => `SELECT ${i}, COUNT(*) FROM ${ident(db)}.${ident(t)};`).join('\n') + '\n';
    const rows = await dbservers.query(ctx, entry, sql, Object.assign({ timeoutMs: 0 }, creds));
    const byIdx = new Map(rows.map((r) => [Number(r[0]), Number(r[1])]));
    out.tables = tables.map((t, i) => ({ name: t, rows: byIdx.has(i) ? byIdx.get(i) : null }));
  }
  const o = (await dbservers.query(ctx, entry,
    `SELECT (SELECT COUNT(*) FROM information_schema.views WHERE table_schema = ${lit}), `
    + `(SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = ${lit}), `
    + `(SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = ${lit}), `
    + `(SELECT COUNT(*) FROM information_schema.events WHERE event_schema = ${lit});\n`, creds))[0] || [];
  out.views = Number(o[0]) || 0;
  out.routines = Number(o[1]) || 0;
  out.triggers = Number(o[2]) || 0;
  out.events = Number(o[3]) || 0;
  return out;
}

function fileEndsWith(file, needle) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 4096);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8').includes(needle);
  } catch {
    return false;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Validates the request synchronously (before the job is created). */
function validate(ctx, body) {
  const b = body || {};
  for (const k of ['fromServerId', 'toServerId']) if (typeof b[k] !== 'string' || !b[k]) throw new AppError('BAD_INPUT', tr('move.chooseServers'));
  if (!NAME_RE.test(String(b.fromDb || ''))) throw new AppError('BAD_NAME', tr('move.badFromName'));
  if (!NAME_RE.test(String(b.toDb || ''))) throw new AppError('BAD_NAME', tr('move.badToName'));
  if (b.fromServerId === b.toServerId && b.fromDb === b.toDb) throw new AppError('SAME_TARGET', tr('move.sameTarget'));
  dbservers.getEntry(ctx, b.fromServerId);
  dbservers.getEntry(ctx, b.toServerId);
  if (b.projectId && !ctx.store.data.projects.some((p) => p.id === b.projectId)) throw new AppError('PROJECT_NOT_FOUND', tr('move.projectNotFound'), 404);
}

async function moveJob(ctx, body, log, job) {
  const { fromServerId, fromDb, toServerId, toDb, projectId } = body;
  const fromCreds = dbservers.resolveCreds(ctx, body.from, projectId);
  const toCreds = dbservers.resolveCreds(ctx, body.to, projectId);
  job.progress = { stage: 'check', dumpBytes: null };

  // 1. both running
  const src = await requireRunning(ctx, fromServerId, 'src');
  const dst = await requireRunning(ctx, toServerId, 'dst');
  log('ok', tr('move.servers', { from: src.label, fromPort: src.effectivePort, to: dst.label, toPort: dst.effectivePort }));

  // 2. source exists, target must not
  if (!(await dbservers.databaseExists(ctx, src, fromDb, fromCreds))) throw new AppError('SOURCE_MISSING', tr('move.sourceMissing', { db: fromDb }), 404);
  if (await dbservers.databaseExists(ctx, dst, toDb, toCreds)) {
    throw new AppError('TARGET_EXISTS', tr('move.targetExists', { db: toDb }), 409);
  }
  log('ok', tr('move.checkOk', { from: fromDb, to: toDb }));

  // 3. charset / collation
  const cs = (await dbservers.query(ctx, src,
    `SELECT default_character_set_name, default_collation_name FROM information_schema.schemata WHERE schema_name = ${dbservers.sqlStr(fromDb)};\n`, fromCreds))[0] || [];
  const charset = /^[A-Za-z0-9_]+$/.test(cs[0] || '') ? cs[0] : 'utf8mb4';
  const collation = /^[A-Za-z0-9_]+$/.test(cs[1] || '') ? cs[1] : null;
  log('info', `Charset ${charset}${collation ? `, collation ${collation}` : ''}`);

  // 4. source counts
  const before = await counts(ctx, src, fromDb, fromCreds);
  const totalRows = before.tables.reduce((a, t) => a + (t.rows || 0), 0);
  log('ok', tr('move.sourceCounts', { tables: before.tables.length, rows: totalRows, views: before.views, routines: before.routines, triggers: before.triggers }));

  // 5. dump
  job.progress.stage = 'dump';
  const srcTools = dbservers.clientInstallFor(ctx, src);
  const dstTools = dbservers.clientInstallFor(ctx, dst);
  const sameVendor = srcTools.kind === dstTools.kind && src.kind === dst.kind;
  let dumpTool = sameVendor ? (dst.dump || dstTools.dump) : (src.dump || srcTools.dump);
  const dumpKind = sameVendor ? dst.kind : src.kind;
  if (!dumpTool) dumpTool = src.dump || srcTools.dump || dst.dump || dstTools.dump;
  if (!dumpTool) throw new AppError('NO_DUMP_TOOL', tr('move.noDumpTool'));
  if (!sameVendor) log('warn', tr('move.crossVendor'));
  const dumpDir = util.ensureDir(path.join(ctx.store.data.settings.dumpDir, 'devpanel'));
  const dumpFile = path.join(dumpDir, `${fromDb}_${src.effectivePort}_${util.stamp()}.sql`);
  log('warn', tr('move.dumpWarn', { file: dumpFile }));
  const dumpArgs = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(src.effectivePort), '-u', fromCreds.user,
    ...dbservers.sslArgs(dumpTool, dumpKind), '--single-transaction', '--quick', '--routines', '--triggers', '--events',
    '--default-character-set=utf8mb4', fromDb];
  log('info', tr('move.dumpRunning', { tool: path.basename(dumpTool) }));
  let lastLogged = 0;
  const timer = setInterval(() => {
    try {
      const size = fs.statSync(dumpFile).size;
      job.progress.dumpBytes = size;
      if (Date.now() - lastLogged > 10000) { lastLogged = Date.now(); log('info', `Dump: ${util.fmtMB(size)}`); }
    } catch { /* not created yet */ }
  }, 2000);
  let dr;
  try {
    dr = await util.run(dumpTool, dumpArgs, { outputFile: dumpFile, env: dbservers.credEnv(fromCreds.password), timeoutMs: 0 });
  } finally {
    clearInterval(timer);
  }
  const dumpErr = dbservers.cleanStderr(dr.stderr);
  if (/ERROR 1045|Access denied/i.test(dumpErr)) throw new AppError('NEED_CREDENTIALS', tr('move.needSrcCreds'), 409);
  let dumpBytes = 0;
  try { dumpBytes = fs.statSync(dumpFile).size; } catch { /* missing */ }
  job.progress.dumpBytes = dumpBytes;
  if (dr.code !== 0 || !fileEndsWith(dumpFile, 'Dump completed')) {
    throw new AppError('DUMP_FAILED', tr('move.dumpFailed', { error: dumpErr.split('\n')[0] || util.describeExit(dr, dumpTool) }), 500, { dumpFile });
  }
  log('ok', tr('move.dumpDone', { size: util.fmtMB(dumpBytes), file: dumpFile }));

  // 6. create target database
  job.progress.stage = 'import';
  const createSql = `CREATE DATABASE ${ident(toDb)} CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ''};\n`;
  try {
    await dbservers.query(ctx, dst, createSql, toCreds);
  } catch (e) {
    if (e.code === 'QUERY_FAILED' && collation && /collation/i.test(e.message)) {
      log('warn', tr('move.collationFallback', { collation }));
      await dbservers.query(ctx, dst, `CREATE DATABASE ${ident(toDb)} CHARACTER SET ${charset};\n`, toCreds);
    } else throw e;
  }
  log('ok', tr('move.created', { db: toDb }));

  // 7. import
  const importArgs = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(dst.effectivePort), '-u', toCreds.user,
    ...dbservers.sslArgs(dstTools.client, dstTools.kind), '--default-character-set=utf8mb4'];
  if (needsCollationCompat(dst, collation)) {
    importArgs.push(COLLATION_COMPAT_ARG);
    log('info', tr('move.collationCompat'));
  }
  importArgs.push('-D', toDb);
  log('info', tr('move.importing', { tool: path.basename(dstTools.client) }));
  const ir = await util.run(dstTools.client, importArgs, { inputFile: dumpFile, env: dbservers.credEnv(toCreds.password), timeoutMs: 0 });
  const impErr = dbservers.cleanStderr(ir.stderr);
  if (ir.code !== 0 || ir.error) {
    const dropSql = `DROP DATABASE ${ident(toDb)};`;
    throw new AppError('IMPORT_FAILED',
      tr('move.importFailed', {
        error: impErr.split('\n').find((l) => /ERROR/.test(l)) || impErr.split('\n')[0] || util.describeExit(ir, dstTools.client),
        db: toDb,
        dropSql,
      }),
      500, { dumpFile, dropSql });
  }
  log('ok', tr('move.importDone'));

  // 8. compare
  job.progress.stage = 'verify';
  const after = await counts(ctx, dst, toDb, toCreds);
  const diff = [];
  const afterMap = new Map(after.tables.map((t) => [t.name, t.rows]));
  const perTable = before.tables.map((t) => ({ name: t.name, source: t.rows, target: afterMap.has(t.name) ? afterMap.get(t.name) : null }));
  for (const t of perTable) if (t.source !== t.target) diff.push({ table: t.name, source: t.source, target: t.target });
  for (const t of after.tables) if (!before.tables.some((b) => b.name === t.name)) diff.push({ table: t.name, source: null, target: t.rows });
  if (before.tables.length !== after.tables.length) diff.push({ what: 'tables', source: before.tables.length, target: after.tables.length });
  for (const k of ['views', 'routines', 'triggers', 'events']) if (before[k] !== after[k]) diff.push({ what: k, source: before[k], target: after[k] });
  const rows = perTable.reduce((a, t) => a + (t.target || 0), 0);
  if (diff.length) {
    for (const d of diff.slice(0, 50)) log('bad', tr('move.diff', { what: d.table || d.what, source: d.source, target: d.target }));
    throw new AppError('COUNT_MISMATCH', tr('move.countMismatch', { count: diff.length }), 500,
      { diff, perTable, tables: perTable.length, rows, dumpFile, dumpBytes });
  }
  log('ok', tr('move.verifyOk', { tables: perTable.length, rows, views: after.views, routines: after.routines, triggers: after.triggers }));

  // 9. project link
  let projectUpdated = false;
  if (projectId) {
    const p = ctx.store.data.projects.find((x) => x.id === projectId);
    if (p) {
      p.dbServerId = toServerId;
      ctx.store.save();
      projectUpdated = true;
      log('ok', tr('move.projectLinked', { name: p.name, label: dst.label }));
    }
  }
  job.progress.stage = 'done';
  procs.invalidateCaches();
  return {
    tables: perTable.length, rows, perTable, views: after.views, routines: after.routines, triggers: after.triggers,
    dumpFile, dumpBytes, diff: [], projectUpdated, toServerId, toDb, toPort: dst.effectivePort,
  };
}

module.exports = { validate, moveJob, counts, NAME_RE, COLLATION_COMPAT_ARG, needsCollationCompat, ident };
