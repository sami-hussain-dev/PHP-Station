'use strict';
/*
 * Crash diagnosis and repair for MariaDB/MySQL servers (the XAMPP "MySQL shutdown unexpectedly"
 * family). Every repair first takes a full snapshot of the datadir (backups.snapshot), so the
 * state before the repair can always be restored.
 *  - diagnose: reads the server's error log and names the known problems.
 *  - repairJob: aria log files moved away (kept), crashed Aria/MyISAM tables repaired offline
 *    (aria_chk / myisamchk), then the server is started and mariadb-check --auto-repair runs.
 *  - rescueJob (InnoDB damage): works on a COPY of the datadir, starts it with
 *    innodb_force_recovery 1..6 on a temporary port, dumps every database, and (optionally)
 *    imports the dumps into a brand-new DB server. The original datadir is never written.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const procs = require('./procs');
const ports = require('./ports');
const dbservers = require('./dbservers');
const backups = require('./backups');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const DB_RE = /^[A-Za-z0-9_$-]{1,64}$/;

// ------------------------------------------------------------------------------------------ diagnose (PURE)

/** Known problems in error log text -> [{code, tables?, line}]. PURE. */
function analyzeLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  const issues = new Map();
  const add = (code, line, extra) => {
    const cur = issues.get(code) || Object.assign({ code, line: line.trim().slice(0, 300) }, extra || {});
    if (extra && extra.tables) cur.tables = [...new Set([...(cur.tables || []), ...extra.tables])];
    issues.set(code, cur);
  };
  for (const line of lines) {
    let m = /Table '(?:\.[\\/])?([^'\\/.]+)[\\/.]([^'\\/]+?)' is marked as crashed/i.exec(line)
      || /Incorrect key file for table '(?:\.[\\/])?([^'\\/.]+)[\\/.]([^'\\/]+?)(?:\.MAI|\.MYI)?'/i.exec(line);
    if (m) { add('CRASHED_TABLES', line, { tables: [`${m[1]}/${m[2]}`] }); continue; }
    if (/Can't open and lock privilege tables|Fatal error: Can't open privilege tables/i.test(line)) { add('PRIV_TABLES', line); continue; }
    if (/aria_log|Aria engine is not initialized|Aria recovery failed|Plugin 'Aria' (?:init|registration)/i.test(line)) { add('ARIA', line); continue; }
    if (/Unable to lock \.?[\\/]?ibdata1|Check that you do not already have another mysqld process/i.test(line)) { add('LOCKED', line); continue; }
    if (/Bind on TCP\/IP port|Do you already have another (?:mysqld|server) running on port/i.test(line)) { add('PORT', line); continue; }
    // table files (.ibd) newer than the system tablespace / redo log: copied in from another datadir
    m = /InnoDB: Page \[page id: space=(\d+), page number=\d+\] log sequence number \d+ is in the future/i.exec(line);
    if (m) { add('LSN_FUTURE', line, { spaces: [Number(m[1])] }); const cur = issues.get('LSN_FUTURE'); cur.spaces = [...new Set([...(cur.spaces || []), Number(m[1])])]; continue; }
    if (/Your database may be corrupt or you may have copied the InnoDB tablespace/i.test(line) && issues.has('LSN_FUTURE')) continue;
    m = /Table '?`?([^`'.]+)`?\.`?([^`' ]+)`?'? doesn't exist in engine/i.exec(line);
    if (m) { add('MISSING_IN_ENGINE', line, { tables: [`${m[1]}/${m[2]}`] }); continue; }
    if (/InnoDB: (?:Database page corruption|Your database may be corrupt|Plugin initialization aborted|Assertion failure|Missing MLOG_CHECKPOINT|Corrupted page|Page \[page id:.*\] log sequence number .* is in the future|.*is in the future!|Failed to read .* log|Set innodb_force_recovery)/i.test(line)
      || /\[ERROR\] InnoDB:.*(corrupt|crash recovery|redo log|tablespace)/i.test(line)) { add('INNODB', line); continue; }
  }
  return [...issues.values()];
}

function logText(entry) {
  const f = dbservers.errorLogPath(entry);
  if (!f || !util.existsFile(f)) return { file: f || null, text: '' };
  const size = fs.statSync(f).size;
  return { file: f, text: dbservers.readNewText(f, Math.max(0, size - 96 * 1024), 96 * 1024) };
}

/** Only the part after the last start attempt counts. */
function lastStartPart(text) {
  const t = String(text || '');
  const idx = Math.max(t.lastIndexOf('Starting MariaDB'), t.lastIndexOf('mysqld (server'), t.lastIndexOf('mariadbd (server'), t.lastIndexOf('Starting crash recovery'));
  const cut = t.lastIndexOf('\n', idx > 0 ? idx : 0);
  return idx > 0 ? t.slice(Math.max(0, cut)) : t.slice(-24 * 1024);
}

async function diagnose(ctx, id) {
  const entry = dbservers.getEntry(ctx, id);
  const snap = await procs.getSnapshot({ fresh: true });
  const status = dbservers.entryStatus(ctx, entry, snap).status;
  const { file, text } = logText(entry);
  const recent = lastStartPart(text);
  const issues = analyzeLog(recent);
  // running: name the tables behind the tablespace ids ("space=1302" -> shop/items)
  const lsn = issues.find((x) => x.code === 'LSN_FUTURE');
  if (lsn && status === 'running' && Array.isArray(lsn.spaces) && lsn.spaces.length) {
    try {
      const creds = await dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, null), { timeoutMs: 10000 });
      const ids = lsn.spaces.filter((n) => Number.isInteger(n)).slice(0, 200).join(',');
      const rows = await dbservers.query(ctx, entry, `SELECT NAME FROM information_schema.INNODB_SYS_TABLESPACES WHERE SPACE IN (${ids});\n`, creds);
      lsn.tables = rows.map((r) => r[0]).filter(Boolean).sort();
    } catch { /* names are a bonus */ }
  }
  return {
    id, label: entry.label, status, errorLog: file, issues,
    logTail: recent.split(/\r?\n/).slice(-40).join('\n'),
    tools: { ariaChk: !!toolPath(entry, 'aria_chk'), myisamChk: !!toolPath(entry, 'myisamchk'), check: !!toolPath(entry, 'check') },
  };
}

// ------------------------------------------------------------------------------------------ tools

function toolPath(entry, kind) {
  const names = {
    aria_chk: ['aria_chk.exe'],
    myisamchk: ['myisamchk.exe'],
    check: ['mariadb-check.exe', 'mysqlcheck.exe'],
  }[kind];
  for (const n of names || []) {
    const f = entry.binDir ? win.join(entry.binDir, n) : null;
    if (f && util.existsFile(f)) return f;
  }
  return null;
}

function repairDir(ctx, id, stamp) {
  return util.ensureDir(path.join(backups.rootDir(ctx), 'repairs', String(id).replace(/[^A-Za-z0-9._-]/g, '_'), stamp));
}

// ------------------------------------------------------------------------------------------ repair

/** Moves aria_log.* and aria_log_control out of the datadir (into the repair folder). */
function moveAriaLogs(entry, dest, log) {
  const moved = [];
  for (const f of fs.readdirSync(entry.datadir)) {
    if (!/^aria_log(\.\d+|_control)$/i.test(f)) continue;
    util.ensureDir(dest);
    fs.renameSync(win.join(entry.datadir, f), win.join(dest, f));
    moved.push(f);
  }
  log(moved.length ? 'ok' : 'info', moved.length ? tr('rep.ariaMoved', { list: moved.join(', '), to: dest }) : tr('rep.ariaNone'));
  return moved;
}

/** Offline repair of Aria (.MAI) / MyISAM (.MYI) tables. tables: ["db/table"]; "mysql/*" = all of mysql. */
async function repairTablesOffline(entry, tables, log) {
  const aria = toolPath(entry, 'aria_chk');
  const myi = toolPath(entry, 'myisamchk');
  const list = [];
  for (const t of tables) {
    const [db, tb] = t.split('/');
    if (!DB_RE.test(db)) continue;
    const dir = win.join(entry.datadir, db);
    if (tb === '*') {
      for (const f of util.existsDir(dir) ? fs.readdirSync(dir) : []) {
        const m = /^(.+)\.(MAI|MYI)$/i.exec(f);
        if (m) list.push({ base: win.join(dir, m[1]), ext: m[2].toUpperCase(), name: `${db}.${m[1]}` });
      }
    } else if (/^[A-Za-z0-9_$#@-]{1,64}$/.test(tb)) {
      for (const ext of ['MAI', 'MYI']) if (util.existsFile(win.join(dir, `${tb}.${ext}`))) list.push({ base: win.join(dir, tb), ext, name: `${db}.${tb}` });
    }
  }
  const results = [];
  for (const t of list) {
    const tool = t.ext === 'MAI' ? aria : myi;
    if (!tool) { log('warn', tr('rep.noTool', { tool: t.ext === 'MAI' ? 'aria_chk' : 'myisamchk', table: t.name })); continue; }
    const run = (args) => util.run(tool, args, { cwd: entry.datadir, timeoutMs: 15 * 60 * 1000, env: util.cleanEnv({ remove: ['MYSQL_PWD'] }) });
    let r = await run(t.ext === 'MAI' ? [`--datadir=${entry.datadir}`, '-r', t.base] : ['-r', t.base]);
    // a damaged / missing aria_log_control: repair without it (the server writes a new one on start)
    if (r.code !== 0 && t.ext === 'MAI' && /control file/i.test(`${r.stdout}\n${r.stderr}`)) {
      r = await run([`--datadir=${entry.datadir}`, '--ignore-control-file', '-r', t.base]);
    }
    const ok = r.code === 0;
    results.push({ table: t.name, ok, db: t.name.split('.')[0], name: t.name.split('.').slice(1).join('.') });
    log(ok ? 'ok' : 'warn', `${win.basename(tool)} -r ${t.name}: ${ok ? 'OK' : (util.firstLine(r.stderr) || util.firstLine(r.stdout) || util.describeExit(r, tool))}`);
  }
  return results;
}

/**
 * Last resort for SYSTEM tables (mysql.*) that aria_chk / myisamchk cannot repair (e.g. the index
 * header is gone): a fresh copy of just those tables from MariaDB's own install-db template.
 * The broken files are moved to the repair folder (kept). Never used for user databases.
 */
async function rebuildSystemTables(entry, names, work, log) {
  if (!names.length) return [];
  if (!entry.installDb || entry.kind !== 'mariadb') { log('warn', tr('rep.noTemplate')); return []; }
  const tpl = path.join(work, 'template-data');
  if (!util.existsDir(path.join(tpl, 'mysql'))) {
    const r = await util.run(entry.installDb, [`--datadir=${tpl}`, '--silent'], { cwd: entry.binDir, timeoutMs: 300000, env: util.cleanEnv({ remove: ['PHPRC', 'PHP_INI_SCAN_DIR', 'MYSQL_PWD'] }) });
    if (r.code !== 0 || !util.existsDir(path.join(tpl, 'mysql'))) { log('warn', tr('rep.templateFailed', { message: util.firstLine(r.stderr) || util.describeExit(r, entry.installDb) })); return []; }
  }
  const broken = util.ensureDir(path.join(work, 'broken-system-tables'));
  const done = [];
  for (const n of names) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(n)) continue;
    const files = fs.readdirSync(path.join(tpl, 'mysql')).filter((f) => f.slice(0, f.lastIndexOf('.')) === n);
    if (!files.length) continue;
    for (const f of fs.readdirSync(path.join(entry.datadir, 'mysql'))) {
      if (f.slice(0, f.lastIndexOf('.')) === n) fs.renameSync(path.join(entry.datadir, 'mysql', f), path.join(broken, f));
    }
    for (const f of files) fs.copyFileSync(path.join(tpl, 'mysql', f), path.join(entry.datadir, 'mysql', f));
    done.push(n);
    log('warn', tr('rep.rebuilt', { table: `mysql.${n}`, to: broken }));
  }
  return done;
}

/**
 * Repair job (server must be stopped): snapshot -> aria logs moved -> offline table repair ->
 * start -> mariadb-check --auto-repair. actions = codes from diagnose (others are ignored).
 */
async function repairJob(ctx, id, log, job) {
  const entry = dbservers.getEntry(ctx, id);
  const d = await diagnose(ctx, id);
  if (d.status !== 'stopped') throw new AppError('DB_RUNNING', tr('rep.stopFirst'), 409);
  const codes = new Set(d.issues.map((x) => x.code));
  if (codes.has('LOCKED')) log('warn', tr('rep.lockedHint'));
  if (codes.has('PORT')) log('warn', tr('rep.portHint'));
  job.progress = { stage: 'snapshot' };
  log('info', tr('rep.snapFirst'));
  const snap = await backups.snapshot(ctx, entry, { reason: 'pre-repair', log });
  const work = repairDir(ctx, id, backups.stampNow());

  job.progress = { stage: 'repair' };
  // tables first (aria_chk uses aria_log_control when it can), then the aria logs are moved away
  const tables = [];
  for (const i of d.issues) if (i.code === 'CRASHED_TABLES') tables.push(...(i.tables || []));
  if (codes.has('PRIV_TABLES')) tables.push('mysql/*');
  if (tables.length) {
    const res = await repairTablesOffline(entry, tables, log);
    const sysFailed = res.filter((x) => !x.ok && x.db.toLowerCase() === 'mysql').map((x) => x.name);
    if (sysFailed.length) await rebuildSystemTables(entry, sysFailed, work, log);
  }
  if (codes.has('ARIA') || codes.has('PRIV_TABLES') || codes.has('CRASHED_TABLES')) moveAriaLogs(entry, path.join(work, 'aria-logs'), log);
  if (!codes.size) log('info', tr('rep.nothingKnown'));

  job.progress = { stage: 'start' };
  log('info', tr('rep.starting'));
  try {
    await dbservers.startServer(ctx, entry.id, { log });
  } catch (e) {
    const after = await diagnose(ctx, id);
    const innodb = after.issues.some((x) => x.code === 'INNODB');
    throw new AppError('REPAIR_NOT_ENOUGH', tr(innodb ? 'rep.needRescue' : 'rep.stillFails', { message: e.message }), 500,
      { snapshot: snap.name, needRescue: innodb, logTail: after.logTail });
  }
  const chk = toolPath(entry, 'check');
  let checked = null;
  if (chk) {
    job.progress = { stage: 'check' };
    try {
      const p = (ctx.store.data.projects || []).find((x) => x.dbServerId === entry.id);
      const creds = await dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, p ? p.id : null), { timeoutMs: 15000 });
      log('info', tr('rep.checking', { tool: win.basename(chk) }));
      const r = await util.run(chk, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(entry.effectivePort), '-u', creds.user,
        ...dbservers.sslArgs(chk, entry.kind), '--all-databases', '--auto-repair', '--check'], { env: dbservers.credEnv(creds.password), timeoutMs: 30 * 60 * 1000 });
      // cleanStderr drops the client's own SSL / password notices, which are not table problems
      const out = `${r.stdout}\n${dbservers.cleanStderr(r.stderr)}`;
      const bad = out.split(/\r?\n/).filter((l) => /error|corrupt|crashed|warning/i.test(l) && !/^\s*$/.test(l)).slice(0, 30);
      checked = { ok: r.code === 0, problems: bad };
      log(bad.length ? 'warn' : 'ok', bad.length ? tr('rep.checkProblems', { n: bad.length }) : tr('rep.checkOk'));
      for (const l of bad) log('warn', l);
    } catch (e) {
      log('warn', tr('rep.checkSkipped', { message: e.message }));
    }
  }
  log('ok', tr('rep.done', { snapshot: snap.name }));
  return { repaired: true, snapshot: snap.name, checked };
}

// ------------------------------------------------------------------------------------------ rescue (InnoDB)

/** Rescue job: force-recovery start of a COPY, dump everything, optionally import into a new server. */
async function rescueJob(ctx, id, { createServer = true } = {}, log, job) {
  const entry = dbservers.getEntry(ctx, id);
  if (!entry.serverExe) throw new AppError('NO_SERVER_EXE', tr('err.noServerExe'));
  job.progress = { stage: 'snapshot' };
  const snap = await backups.snapshot(ctx, entry, { reason: 'pre-rescue', log });
  const stamp = backups.stampNow();
  const work = repairDir(ctx, id, stamp);
  const copy = path.join(work, 'work-data');
  log('info', tr('rep.copyForRescue', { to: copy }));
  fs.cpSync(snap.path, copy, { recursive: true, filter: (p) => !util.samePath(p, path.join(snap.path, 'meta.json')) });
  const dumpOut = util.ensureDir(path.join(work, 'rescue-dumps'));

  const s = ctx.store.data.settings;
  let busy = [];
  try { busy = (await procs.listListeners({ maxAgeMs: 0 })).map((l) => l.port); } catch { /* best effort */ }
  const port = ports.pickPort({ from: s.dbPortRange[0], to: s.dbPortRange[1], reserved: dbservers.buildEntries(ctx).map((e) => e.effectivePort), busy });
  if (!port) throw new AppError('NO_PORT', tr('inst.noDbPort'), 409);

  let pid = null;
  let level = 0;
  job.progress = { stage: 'start' };
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const errLog = path.join(work, `rescue-${n}.err`);
    const args = [];
    if (entry.defaultsFile) args.push(`--defaults-file=${entry.defaultsFile}`);
    args.push(`--datadir=${copy}`, `--innodb-data-home-dir=${copy}`, `--innodb-log-group-home-dir=${copy}`, `--aria-log-dir-path=${copy}`,
      `--port=${port}`, '--bind-address=127.0.0.1', `--log-error=${errLog}`, `--pid-file=${path.join(work, 'rescue.pid')}`,
      '--skip-grant-tables', `--innodb-force-recovery=${n}`);
    log('info', tr('rep.tryLevel', { n, port }));
    const p = procs.spawnDetached(entry.serverExe, args, { cwd: win.dirname(entry.binDir), env: util.cleanEnv({ remove: ['PHPRC', 'PHP_INI_SCAN_DIR', 'MYSQL_PWD'] }), logFile: path.join(work, 'rescue-console.log') });
    const up = p && await ports.waitForPort(port, { timeoutMs: 60000, intervalMs: 500, isAlive: () => procs.pidExists(p) });
    if (up) {
      const c = await dbservers.confirmStarted({ isAlive: () => procs.pidExists(p), isPortOpen: () => ports.isPortOpen(port, '127.0.0.1', 800), readLog: () => util.readText(errLog, '') });
      if (c.ok) { pid = p; level = n; break; }
    }
    if (p && procs.pidExists(p)) await procs.killTree(p);
    log('warn', tr('rep.levelFailed', { n, line: util.firstLine((util.tailFile(errLog, 5).text || '').split('\n').reverse().join('\n')) }));
    if (n >= 4) log('warn', tr('rep.highLevel'));
  }
  if (!pid) throw new AppError('RESCUE_FAILED', tr('rep.rescueFailed'), 500, { snapshot: snap.name, folder: work });
  log('ok', tr('rep.rescueUp', { n: level }));

  const tmpEntry = Object.assign({}, entry, { effectivePort: port });
  const creds = { user: 'root', password: '' };
  const dumped = [];
  const failed = [];
  try {
    job.progress = { stage: 'dump' };
    const dbs = (await dbservers.query(ctx, tmpEntry, 'SHOW DATABASES;\n', creds)).map((r) => r[0])
      .filter((x) => x && !dbservers.SYSTEM_DBS.has(x.toLowerCase()) && DB_RE.test(x));
    const tools = dbservers.clientInstallFor(ctx, entry);
    const tool = entry.dump || tools.dump;
    if (!tool) throw new AppError('NO_DUMP_TOOL', tr('move.noDumpTool'));
    for (const db of dbs) {
      const file = path.join(dumpOut, `${db}.sql`);
      const r = await util.run(tool, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root',
        ...dbservers.sslArgs(tool, entry.kind), '--skip-lock-tables', '--quick', '--routines', '--triggers', '--events',
        '--default-character-set=utf8mb4', '--force', '--databases', db], { outputFile: file, env: dbservers.credEnv(''), timeoutMs: 0 });
      const complete = /Dump completed/.test(util.tailFile(file, 2).text || '');
      if (complete && r.code === 0) { dumped.push({ db, file, size: fs.statSync(file).size }); log('ok', `${db}: ${util.fmtMB(fs.statSync(file).size)}`); } else {
        failed.push({ db, partial: complete ? null : file, error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, tool) });
        log('warn', tr('rep.dumpPartial', { db, error: failed[failed.length - 1].error }));
      }
    }
  } finally {
    const ev = await procs.signalShutdownEvent(pid);
    let gone = false;
    for (let i = 0; i < 120 && ev.ok && !gone; i++) { await util.sleep(500); gone = !procs.pidExists(pid); }
    if (!gone && procs.pidExists(pid)) await procs.killTree(pid); // our own temporary server on a copy
    procs.invalidateCaches();
  }

  let server = null;
  if (createServer && dumped.length && entry.kind === 'mariadb' && entry.installDb) {
    job.progress = { stage: 'import' };
    const name = `rescue-${stamp.replace(/-/g, '').slice(2, 12)}`.toLowerCase();
    const r = await dbservers.createInstance(ctx, { installId: entry.installId, name, port }, log);
    await dbservers.startServer(ctx, r.id, { log });
    const ne = dbservers.getEntry(ctx, r.id);
    const c = dbservers.clientInstallFor(ctx, ne);
    for (const d of dumped) {
      const ir = await util.run(c.client, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(ne.effectivePort), '-u', 'root',
        ...dbservers.sslArgs(c.client, c.kind), '--default-character-set=utf8mb4'], { inputFile: d.file, env: dbservers.credEnv(''), timeoutMs: 0 });
      log(ir.code === 0 ? 'ok' : 'warn', `${d.db} -> ${ne.label}: ${ir.code === 0 ? 'OK' : util.firstLine(dbservers.cleanStderr(ir.stderr))}`);
    }
    server = { id: r.id, port: ne.effectivePort, label: ne.label };
    log('ok', tr('rep.newServer', { label: ne.label, port: ne.effectivePort }));
  }
  try { fs.rmSync(copy, { recursive: true, force: true }); } catch { /* the work copy only */ }
  return { rescued: true, level, snapshot: snap.name, folder: work, dumps: dumped, failed, server };
}

module.exports = { analyzeLog, lastStartPart, diagnose, repairJob, rescueJob, moveAriaLogs, repairTablesOffline, rebuildSystemTables };
