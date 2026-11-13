'use strict';
/*
 * DB Time Machine — every action.
 *
 * MariaDB servers that PHP Station starts write a row-based binary log (dbservers.historyArgs:
 * --log-bin into <dumpDir>\devpanel-backups\binlog\<server>, binlog_format=ROW, full row images).
 * This module reads it back for ONE project's database as a timeline of actions (one action =
 * one transaction: its INSERT / UPDATE / DELETE rows, the original SQL when MariaDB recorded it)
 * and undoes a single action with `mariadb-binlog --flashback` — only the rows of that action
 * change, everything else stays as it is. The undo is itself a new action, so it can be undone.
 * Table changes (CREATE / ALTER / DROP) are listed but cannot be undone this way; restore points
 * cover them.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const dbservers = require('./dbservers');
const projects = require('./projects');
const timemachine = require('./timemachine');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const FILE_RE = /^[A-Za-z0-9._-]{1,80}\.\d{6}$/;
const MAX_OUTPUT = 256 * 1024 * 1024;

// ------------------------------------------------------------------------------------------ parsing (PURE)

/** "@3='it's hot' /* BLOB/TEXT meta=2 nullable=1 is_null=0 * /" -> {col: 3, value: "it's hot", isNull: false} */
function parseColumnLine(line) {
  const m = /^###\s+@(\d+)=(.*)$/.exec(line);
  if (!m) return null;
  let raw = m[2];
  const c = raw.lastIndexOf(' /* ');
  let type = null;
  if (c >= 0) { type = raw.slice(c + 4).replace(/\s*\*\/\s*$/, ''); raw = raw.slice(0, c); }
  const isNull = raw === 'NULL' || /is_null=1/.test(type || '');
  let value = isNull ? null : raw;
  if (!isNull && value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  return { col: Number(m[1]), value, isNull, type: type ? type.split(' ')[0] : null };
}

/** "261113 13:53:52" (binlog header) -> "2026-11-13 13:53:52" */
function binlogTime(s) {
  const m = /^(\d{2})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? `20${m[1]}-${m[2]}-${m[3]} ${m[4].padStart(2, '0')}:${m[5]}:${m[6]}` : null;
}

/**
 * `mariadb-binlog --base64-output=decode-rows -vv` text of one file -> transactions:
 * [{file, start, end, time, gtid, ddl, query, statements[], rows:[{op, db, table, before[], after[]}]}]
 */
function parseBinlog(text, file) {
  const out = [];
  let pos = null;
  let tx = null;
  let row = null;
  let mode = null;
  let qLines = null;
  let ddlNext = false;
  const finishRow = () => { if (row && tx) tx.rows.push(row); row = null; mode = null; };
  const close = (end) => {
    finishRow();
    if (tx) { tx.end = end; out.push(tx); }
    tx = null;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = /^# at (\d+)$/.exec(line);
    if (at) { pos = Number(at[1]); continue; }
    const hd = /^#(\d{6}\s+\d{1,2}:\d{2}:\d{2})\s+server id \d+\s+end_log_pos (\d+)\s.*?\t(.*)$/.exec(line);
    if (hd) {
      finishRow();
      qLines = null;
      const time = binlogTime(hd[1]);
      const endPos = Number(hd[2]);
      const ev = hd[3];
      if (/^GTID\s/.test(ev)) {
        if (tx) close(pos);
        tx = { file, start: pos, end: null, time, gtid: (/^GTID\s+(\S+)/.exec(ev) || [])[1] || null, ddl: /\bddl\b/.test(ev), query: null, statements: [], rows: [] };
        ddlNext = tx.ddl;
      } else if (/^Xid\s*=/.test(ev)) {
        close(endPos);
      } else if (/^Annotate_rows/.test(ev)) {
        qLines = [];
      } else if (/^Query\b/.test(ev) && tx && ddlNext) {
        tx.ddlEndPos = endPos;
      }
      continue;
    }
    if (qLines && /^#Q> ?/.test(line)) {
      qLines.push(line.replace(/^#Q> ?/, ''));
      if (tx) {
        const q = qLines.join('\n').slice(0, 2000);
        if (!tx.statements.includes(q)) { if (qLines.length === 1) tx.statements.push(q); else tx.statements[tx.statements.length - 1] = q; }
      }
      continue;
    }
    const st = /^### (INSERT INTO|UPDATE|DELETE FROM) `([^`]+)`\.`([^`]+)`$/.exec(line);
    if (st) {
      finishRow();
      row = { op: st[1] === 'INSERT INTO' ? 'INSERT' : st[1] === 'UPDATE' ? 'UPDATE' : 'DELETE', db: st[2], table: st[3], before: [], after: [] };
      mode = row.op === 'INSERT' ? 'after' : 'before';
      continue;
    }
    if (row && /^### SET$/.test(line)) { mode = 'after'; continue; }
    if (row && /^### WHERE$/.test(line)) { mode = 'before'; continue; }
    if (row) {
      const c = parseColumnLine(line);
      if (c) { row[mode].push(c); continue; }
    }
    // a DDL statement (statement-based Query event inside a "ddl" GTID group)
    if (tx && ddlNext && line && !line.startsWith('#') && !/^(SET |use |\/\*|DELIMITER|BEGIN|COMMIT|ROLLBACK)/i.test(line)) {
      const q = line.replace(/\/\*!\*\/;?\s*$/, '').trim();
      if (q) {
        tx.statements.push(q.slice(0, 2000));
        tx.query = tx.query || q.slice(0, 2000);
        close(tx.ddlEndPos || null);
        ddlNext = false;
      }
    }
  }
  if (tx && tx.rows.length) close(null);
  for (const t of out) {
    t.query = t.query || t.statements[0] || null;
    // an undo made by PHP Station (mariadb-binlog --flashback output replayed as BINLOG statements)
    t.isUndo = !!(t.query && /^BINLOG '/.test(t.query));
    if (t.isUndo) t.query = null;
    delete t.ddlEndPos;
  }
  return out;
}

/**
 * Transactions that touched `db` (rows of other databases are dropped). Table changes (DDL) are
 * kept: the binlog reader already filters them by --database. PURE.
 */
function forDatabase(txs, db) {
  const out = [];
  for (const t of txs) {
    if (t.ddl) { if (t.query) out.push(t); continue; }
    const rows = t.rows.filter((r) => r.db === db);
    if (rows.length) out.push(Object.assign({}, t, { rows }));
  }
  return out;
}

/**
 * Later actions that touched the same rows (same table and same first column, usually the
 * primary key) — undoing the earlier one would then overwrite their change. PURE.
 */
function conflictsOf(target, later) {
  const keys = new Set();
  for (const r of target.rows) {
    const k = (r.after[0] || r.before[0] || {}).value;
    keys.add(`${r.table}\u0000${k}`);
  }
  const hits = [];
  for (const t of later) {
    for (const r of t.rows) {
      for (const side of [r.before, r.after]) {
        if (side[0] && keys.has(`${r.table}\u0000${side[0].value}`)) { hits.push({ time: t.time, op: r.op, table: r.table, key: side[0].value }); break; }
      }
    }
  }
  return hits;
}

// ------------------------------------------------------------------------------------------ server access

function binlogTool(ctx, t) {
  const c = dbservers.clientInstallFor(ctx, t.entry);
  const dir = win.dirname(c.client);
  const tool = ['mariadb-binlog.exe', 'mysqlbinlog.exe'].map((f) => win.join(dir, f)).find((f) => util.existsFile(f));
  if (!tool) throw new AppError('NO_BINLOG_TOOL', tr('hist.noTool'), 409);
  return { tool, client: c.client, kind: c.kind };
}

function remoteArgs(ctx, t, tool, kind) {
  return ['-R', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(t.port), '-u', t.creds.user, ...dbservers.sslArgs(tool, kind)];
}

/** {on, reason?, format, files:[{name, size}]} for the server the project uses. */
async function serverHistory(ctx, t) {
  if (!dbservers.historySupported(t.entry)) return { on: false, reason: 'UNSUPPORTED' };
  const rows = await dbservers.query(ctx, t.entry, 'SELECT @@log_bin, @@binlog_format;\n', t.creds);
  const on = rows.length && rows[0][0] === '1';
  if (!on) return { on: false, reason: 'NOT_ON' };
  if (String(rows[0][1]).toUpperCase() !== 'ROW') return { on: false, reason: 'NOT_ROW', format: rows[0][1] };
  const files = (await dbservers.query(ctx, t.entry, 'SHOW BINARY LOGS;\n', t.creds))
    .map((r) => ({ name: r[0], size: Number(r[1]) || 0 })).filter((f) => FILE_RE.test(f.name));
  return { on: true, format: 'ROW', files };
}

async function readFile(ctx, t, name, db) {
  const { tool, kind } = binlogTool(ctx, t);
  const args = [...remoteArgs(ctx, t, tool, kind), '--base64-output=decode-rows', '-vv', `--database=${db}`, name];
  const r = await util.run(tool, args, { env: dbservers.credEnv(t.creds.password), timeoutMs: 120000, maxCapture: MAX_OUTPUT });
  if (r.code !== 0 && !String(r.stdout || '').length) {
    throw new AppError('BINLOG_READ_FAILED', tr('hist.readFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, tool) }), 500);
  }
  return parseBinlog(r.stdout, name);
}

async function columnNames(ctx, t, db, tables) {
  if (!tables.length) return {};
  const list = tables.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
  const rows = await dbservers.query(ctx, t.entry,
    `SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME FROM information_schema.columns WHERE table_schema='${db.replace(/'/g, "''")}' AND TABLE_NAME IN (${list});\n`, t.creds);
  const map = {};
  for (const [tb, n, c] of rows) (map[tb] = map[tb] || {})[n] = c;
  return map;
}

// ------------------------------------------------------------------------------------------ API

/** GET /api/projects/:id/history -> {on, reason, database, server, actions[], more} */
/** Does a transaction pass the filters {table, op, q}? q is matched against SQL, table and values. PURE. */
function matches(x, { table = null, op = null, q = null } = {}) {
  if (table && !(x.rows.some((r) => r.table === table) || (x.ddl && x.query && x.query.includes(table)))) return false;
  if (op) {
    if (op === 'DDL') { if (!x.ddl) return false; } else if (x.ddl || !x.rows.some((r) => r.op === op)) return false;
  }
  if (q) {
    const needle = String(q).toLowerCase();
    const hay = [x.query || '', ...x.rows.map((r) => r.table)];
    for (const r of x.rows) for (const c of [...r.before, ...r.after]) if (c.value != null) hay.push(String(c.value));
    // "id=21" style: also match "<first column value>" alone
    const kv = /^\s*[\w$]+\s*=\s*(.+)$/.exec(String(q));
    const vals = kv ? [kv[1].trim().toLowerCase()] : [];
    const found = hay.some((h) => h.toLowerCase().includes(needle))
      || (vals.length && x.rows.some((r) => [...r.before, ...r.after].some((c) => c.value != null && String(c.value).toLowerCase() === vals[0])));
    if (!found) return false;
  }
  return true;
}

/** Counts of the scanned window: {total, INSERT, UPDATE, DELETE, DDL, from, to}. PURE. */
function statsOf(txs) {
  const st = { total: txs.length, INSERT: 0, UPDATE: 0, DELETE: 0, DDL: 0, from: null, to: null };
  for (const x of txs) {
    if (x.ddl) st.DDL++;
    else for (const o of new Set(x.rows.map((r) => r.op))) st[o]++;
    if (x.time && (!st.from || x.time < st.from)) st.from = x.time;
    if (x.time && (!st.to || x.time > st.to)) st.to = x.time;
  }
  return st;
}

/**
 * GET /api/projects/:id/history -> {on, reason, database, server, actions[], tables, stats, more}
 * Filters: table, op (INSERT | UPDATE | DELETE | DDL), q (search). The newest `limit` matches.
 */
async function list(ctx, projectId, { limit = 100, table = null, op = null, q = null } = {}) {
  const t = await timemachine.target(ctx, projectId);
  const own = projects.dbEntryFor(ctx, projects.getProject(ctx, projectId));
  const base = { database: t.database, server: { id: own ? own.id : null, label: t.entry.label, via: t.via }, enabled: ctx.store.data.settings.dbHistory !== false };
  const sh = await serverHistory(ctx, t);
  if (!sh.on) return Object.assign(base, { on: false, reason: sh.reason, actions: [] });
  const max = Math.min(2000, Math.max(10, Number(limit) || 100));
  const filters = {
    table: table || null,
    op: ['INSERT', 'UPDATE', 'DELETE', 'DDL'].includes(op) ? op : null,
    q: typeof q === 'string' && q.trim() ? q.trim().slice(0, 100) : null,
  };
  let txs = [];
  let matched = [];
  const files = sh.files.slice().reverse();
  let read = 0;
  for (const f of files) {
    const got = forDatabase(await readFile(ctx, t, f.name, t.database), t.database);
    txs = got.concat(txs);
    matched = got.filter((x) => matches(x, filters)).concat(matched);
    read++;
    // enough matches (one extra page to know there is "more"), or a bounded amount of reading
    if (matched.length > max || read >= 8) break;
  }
  const moreFiles = read < files.length;
  const tables = [...new Set(txs.flatMap((x) => x.rows.map((r) => r.table)))];
  const page = matched.slice(-max).reverse();
  const cols = await columnNames(ctx, t, t.database, [...new Set(page.flatMap((x) => x.rows.map((r) => r.table)))]);
  const actions = page.map((x) => ({
    id: `${x.file}:${x.start}:${x.end}`,
    file: x.file, start: x.start, end: x.end, time: x.time, gtid: x.gtid, ddl: x.ddl, isUndo: !!x.isUndo,
    query: x.query ? x.query.slice(0, 2000) : null,
    canUndo: !x.ddl && x.rows.length > 0 && Number.isInteger(x.start) && Number.isInteger(x.end),
    rowCount: x.rows.length,
    tables: [...new Set(x.rows.map((r) => r.table))],
    ops: [...new Set(x.rows.map((r) => r.op))],
    rows: x.rows.slice(0, 5).map((r) => ({
      op: r.op, table: r.table,
      columns: Object.assign({}, cols[r.table] || {}),
      before: r.before.slice(0, 40).map((c) => ({ col: c.col, value: c.value == null ? null : String(c.value).slice(0, 500), isNull: c.isNull })),
      after: r.after.slice(0, 40).map((c) => ({ col: c.col, value: c.value == null ? null : String(c.value).slice(0, 500), isNull: c.isNull })),
    })),
  }));
  return Object.assign(base, {
    on: true, actions, tables: tables.sort(), filters,
    stats: statsOf(txs), matchedCount: matched.length,
    more: matched.length > max || moreFiles,
  });
}

function parseActionId(id) {
  const m = /^([A-Za-z0-9._-]{1,80}\.\d{6}):(\d{1,15}):(\d{1,15})$/.exec(String(id || ''));
  if (!m) throw new AppError('BAD_INPUT', tr('hist.badAction'), 400);
  const a = { file: m[1], start: Number(m[2]), end: Number(m[3]) };
  if (!(a.end > a.start)) throw new AppError('BAD_INPUT', tr('hist.badAction'), 400);
  return a;
}

/** Later actions that touch the same rows as action `id` (shown before an undo). */
async function check(ctx, projectId, id) {
  const a = parseActionId(id);
  const t = await timemachine.target(ctx, projectId);
  const sh = await serverHistory(ctx, t);
  if (!sh.on) throw new AppError('HISTORY_OFF', tr('hist.off'), 409);
  const idx = sh.files.findIndex((f) => f.name === a.file);
  if (idx < 0) throw new AppError('NOT_FOUND', tr('hist.gone'), 404);
  let all = [];
  for (const f of sh.files.slice(idx)) all = all.concat(forDatabase(await readFile(ctx, t, f.name, t.database), t.database));
  const target = all.find((x) => x.file === a.file && x.start === a.start && x.end === a.end);
  if (!target) throw new AppError('NOT_FOUND', tr('hist.gone'), 404);
  const later = all.filter((x) => (x.file > a.file) || (x.file === a.file && x.start > a.start));
  return { conflicts: conflictsOf(target, later).slice(0, 20) };
}

/** Undoes ONE action (job). The inverse rows come from mariadb-binlog --flashback. */
async function undoAction(ctx, projectId, id, log = () => {}) {
  const a = parseActionId(id);
  const t = await timemachine.target(ctx, projectId);
  const sh = await serverHistory(ctx, t);
  if (!sh.on) throw new AppError('HISTORY_OFF', tr('hist.off'), 409);
  if (!sh.files.some((f) => f.name === a.file)) throw new AppError('NOT_FOUND', tr('hist.gone'), 404);
  const target = (await readFile(ctx, t, a.file, t.database)).find((x) => x.start === a.start && x.end === a.end);
  if (!target || !forDatabase([target], t.database).length) throw new AppError('NOT_FOUND', tr('hist.gone'), 404);
  if (target.ddl) throw new AppError('DDL_NO_UNDO', tr('hist.ddl'), 409);
  const rows = forDatabase([target], t.database)[0].rows;
  log('info', tr('hist.undoing', { n: rows.length, time: target.time, db: t.database }));
  const { tool, client, kind } = binlogTool(ctx, t);
  const tmp = path.join(util.ensureDir(path.join(timemachine.rootDir(ctx), '..', 'tmp')), `flashback_${util.randomHex(4)}.sql`);
  try {
    const fb = await util.run(tool, [...remoteArgs(ctx, t, tool, kind), '--flashback', `--database=${t.database}`,
      `--start-position=${a.start}`, `--stop-position=${a.end}`, a.file], { outputFile: tmp, env: dbservers.credEnv(t.creds.password), timeoutMs: 120000 });
    if (fb.code !== 0 || !util.existsFile(tmp) || fs.statSync(tmp).size < 20) {
      throw new AppError('FLASHBACK_FAILED', tr('hist.flashbackFailed', { error: util.firstLine(dbservers.cleanStderr(fb.stderr)) || util.describeExit(fb, tool) }), 500);
    }
    const r = await util.run(client, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(t.port), '-u', t.creds.user, ...dbservers.sslArgs(client, kind), '--default-character-set=utf8mb4'],
      { inputFile: tmp, env: dbservers.credEnv(t.creds.password), timeoutMs: 300000 });
    if (r.code !== 0) throw new AppError('UNDO_FAILED', tr('hist.applyFailed', { error: util.firstLine(dbservers.cleanStderr(r.stderr)) || util.describeExit(r, client) }), 500);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
  log('ok', tr('hist.undone', { n: rows.length }));
  ctx.log(`history undo ${projectId} ${id} (${rows.length} rows)`);
  return { rows: rows.length, time: target.time };
}

module.exports = { parseColumnLine, binlogTime, parseBinlog, forDatabase, conflictsOf, matches, statsOf, parseActionId, list, check, undoAction, serverHistory };
