'use strict';
/*
 * Fixes for DB_MISSING (the project's .env database is not on its DB server):
 *   move   - bring it from another running server (the DB move job, same name),
 *   import - create it and import a .sql file with the target server's client,
 *   empty  - create it empty.
 * The target is always the project's own DB server and the .env DB_DATABASE name. Nothing is
 * ever overwritten or dropped; credentials (project .env first, then root / empty) are never
 * logged.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const util = require('./util');
const envfile = require('./envfile');
const dbservers = require('./dbservers');
const dbmove = require('./dbmove');
const projects = require('./projects');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const MODES = Object.freeze(['move', 'import', 'empty']);

/** Validates the request before the job is created; returns the job input. */
function prepare(ctx, id, body) {
  const b = body || {};
  const p = projects.getProject(ctx, id);
  const mode = String(b.mode || '');
  if (!MODES.includes(mode)) throw new AppError('BAD_INPUT', tr('prov.badMode'), 400);
  if (!p.dbServerId) throw new AppError('NO_DB_SERVER', tr('prov.noServer'), 409);
  const entry = dbservers.getEntry(ctx, p.dbServerId);
  const env = envfile.parseEnv(util.readText(win.join(p.path, '.env'), '') || '');
  const database = env.DB_DATABASE || '';
  if (!database) throw new AppError('NO_DATABASE_NAME', tr('prov.noDbName'), 409);
  if (!dbmove.NAME_RE.test(database)) throw new AppError('BAD_NAME', tr('err.badDbName'), 400);
  const input = { projectId: p.id, mode, database, serverId: entry.id, label: entry.label };
  if (mode === 'move') {
    if (typeof b.fromServerId !== 'string' || !b.fromServerId) throw new AppError('BAD_INPUT', tr('prov.chooseFrom'), 400);
    if (b.fromServerId === entry.id) throw new AppError('BAD_INPUT', tr('prov.sameServer'), 400);
    dbservers.getEntry(ctx, b.fromServerId);
    input.fromServerId = b.fromServerId;
  } else if (mode === 'import') {
    const f = util.checkUserPath(b.file, { kind: 'file', label: tr('label.sqlFile') });
    if (!/\.sql$/i.test(f)) throw new AppError('BAD_PATH', tr('prov.notSql'), 400);
    input.file = f;
  }
  return input;
}

/**
 * Database names a .sql file switches to, creates or drops at the start of a line
 * (USE x; CREATE DATABASE x; DROP DATABASE x). Streams the file, so large dumps are fine.
 */
function sqlDatabaseRefs(file) {
  const res = [
    /^\s*USE\s+`?([^`;\s]+)`?\s*;?/i,
    /^\s*(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\s+(?:\/\*!\d+\s*)?(?:IF\s+(?:NOT\s+)?EXISTS\s*)?(?:\*\/\s*)?`?([^`;\s/]+)`?/i,
  ];
  return new Promise((resolve, reject) => {
    const names = new Set();
    const rs = fs.createReadStream(file, { encoding: 'utf8' });
    rs.on('error', reject);
    const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const head = line.length > 400 ? line.slice(0, 400) : line;
      if (!/^\s*(USE|CREATE|DROP)\b/i.test(head)) return;
      for (const re of res) {
        const m = re.exec(head);
        if (m) names.add(m[1]);
      }
    });
    rl.on('close', () => resolve([...names]));
  });
}

async function runningEntry(ctx, id, key) {
  const { entry, status } = await dbservers.isEntryRunning(ctx, id);
  if (status.status !== 'running') throw new AppError('DB_NOT_RUNNING', tr(key, { label: entry.label }), 409);
  return entry;
}

async function countTables(ctx, entry, db, creds) {
  const rows = await dbservers.query(ctx, entry,
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ${dbservers.sqlStr(db)} AND table_type = 'BASE TABLE';\n`, creds);
  return rows.length ? Number(rows[0][0]) || 0 : 0;
}

async function importFile(ctx, entry, input, creds, log, job) {
  const { database, file } = input;
  const c = dbservers.clientInstallFor(ctx, entry);
  const args = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(entry.effectivePort), '-u', creds.user,
    ...dbservers.sslArgs(c.client, c.kind), '--default-character-set=utf8mb4'];
  if (dbmove.needsCollationCompat(entry, 'utf8mb4_unicode_ci')) {
    args.push(dbmove.COLLATION_COMPAT_ARG);
    log('info', tr('move.collationCompat'));
  }
  args.push('-D', database);
  const total = fs.statSync(file).size;
  let sent = 0;
  let lastLog = Date.now();
  job.progress = { stage: 'import', bytes: 0, total, percent: 0 };
  log('info', tr('prov.importing', { file, size: util.fmtMB(total), tool: path.basename(c.client) }));
  const r = await util.run(c.client, args, {
    inputFile: file,
    env: dbservers.credEnv(creds.password),
    timeoutMs: 0,
    onInputBytes: (n) => {
      sent += n;
      job.progress = { stage: 'import', bytes: sent, total, percent: total ? Math.floor((sent / total) * 100) : null };
      if (Date.now() - lastLog >= 2000) {
        lastLog = Date.now();
        log('info', `Import: ${util.fmtMB(sent)} / ${util.fmtMB(total)} (${total ? Math.floor((sent / total) * 100) : 0}%)`);
      }
    },
  });
  const err = dbservers.cleanStderr(r.stderr);
  if (r.code !== 0 || r.error) {
    const dropSql = `DROP DATABASE ${dbmove.ident(database)};`;
    throw new AppError('IMPORT_FAILED', tr('prov.importFailed', {
      error: err.split('\n').find((l) => /ERROR/.test(l)) || err.split('\n')[0] || r.error || util.describeExit(r, c.client),
      db: database,
      dropSql,
    }), 500, { dropSql });
  }
  return total;
}

/** The db-provision job. */
async function provisionJob(ctx, input, log, job) {
  const { projectId, mode, database, serverId } = input;
  const candidates = dbservers.credCandidates(ctx, projectId);
  job.progress = { stage: 'check' };

  if (mode === 'move') {
    const src = await runningEntry(ctx, input.fromServerId, 'move.srcNotRunning');
    const dst = await runningEntry(ctx, serverId, 'move.dstNotRunning');
    const from = await dbservers.workingCreds(ctx, src, candidates);
    const to = await dbservers.workingCreds(ctx, dst, candidates);
    const body = { fromServerId: src.id, fromDb: database, toServerId: dst.id, toDb: database, projectId };
    dbmove.validate(ctx, body);
    const res = await dbmove.moveJob(ctx, Object.assign({}, body, { from, to }), log, job);
    return Object.assign({ mode, database, serverId }, res);
  }

  const entry = await runningEntry(ctx, serverId, 'prov.serverNotRunning');
  const creds = await dbservers.workingCreds(ctx, entry, candidates);
  if (await dbservers.databaseExists(ctx, entry, database, creds)) {
    throw new AppError('TARGET_EXISTS', tr('prov.exists', { db: database, label: entry.label }), 409);
  }
  if (mode === 'import') {
    const foreign = (await sqlDatabaseRefs(input.file)).filter((n) => n !== database);
    if (foreign.length) {
      throw new AppError('SQL_SWITCHES_DB', tr('prov.sqlSwitchesDb', { names: foreign.slice(0, 5).join(', '), db: database }), 409, { databases: foreign });
    }
    log('ok', tr('prov.sqlChecked'));
  }
  await dbservers.query(ctx, entry, `CREATE DATABASE ${dbmove.ident(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`, creds);
  log('ok', tr('prov.created', { db: database, label: entry.label }));
  if (mode === 'empty') {
    job.progress = { stage: 'done' };
    return { mode, database, serverId, tables: 0 };
  }
  const bytes = await importFile(ctx, entry, input, creds, log, job);
  const tables = await countTables(ctx, entry, database, creds);
  log('ok', tr('prov.importDone', { tables, size: util.fmtMB(bytes) }));
  job.progress = { stage: 'done', bytes, total: bytes, percent: 100 };
  return { mode, database, serverId, tables, bytes, file: input.file };
}

module.exports = { MODES, prepare, provisionJob, sqlDatabaseRefs };
