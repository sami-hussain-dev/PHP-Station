'use strict';
/*
 * "Import database": a .sql / .sql.gz / .zip dump into a project's database, checked first, with
 * one-click fixes for what usually breaks an import.
 *
 *  inspect()  reads the dump (the first SCAN_LIMIT bytes) and asks the server what it supports, and
 *             returns the problems it will hit, each with the fix that is switched on for it.
 *  importJob()
 *    1. a Time Machine restore point of the target database when it has tables ("pre-import"),
 *       so any import can be undone from the project card;
 *    2. replace: the database is emptied (DROP + CREATE); merge: the dump goes over what is there;
 *    3. the dump is streamed through the fixes into the server's client, in one session with
 *       FOREIGN_KEY_CHECKS / UNIQUE_CHECKS / AUTOCOMMIT off (an XAMPP server commits ~20x faster);
 *    4. on an error the job stops at once and returns the server's error code, the line of the
 *       dump it came from (a few lines of it) and the fix that solves it: the panel shows that and
 *       "Fix and import again" runs the same import with the fix added.
 *
 * Fixes (all work on a line at a time; INSERT lines longer than LONG_LINE pass through untouched,
 * so huge dumps stream in constant memory):
 *   stripdb    USE / CREATE DATABASE / DROP DATABASE lines are dropped: everything goes into the
 *              chosen database (always on: otherwise a dump's own USE line sends the tables elsewhere)
 *   collation  collations the server does not know (MySQL 8 utf8mb4_0900_ai_ci ...) -> its nearest one
 *   charset    utf8mb3 -> utf8 (servers older than MariaDB 10.6 / MySQL 8.0.30)
 *   definer    DEFINER=`user`@`host` removed (views, triggers, routines then belong to the importer)
 *   gtid       GTID_PURGED / SQL_LOG_BIN lines dropped (they need SUPER and fail on MariaDB)
 *   mysql8     /*!80xxx ... *\/ version comments dropped (MariaDB runs them and fails on them)
 *   sqlmode    zero dates and strict mode: the session and the dump's own sql_mode go non-strict
 *   packet     max_allowed_packet raised to 1 GB for the import (needs SUPER), and for the client
 *   strict     innodb_strict_mode off ("Row size too large")
 *   latin1     the file is not UTF-8: it is read as latin1 / Windows-1252
 * UTF-16 files are turned into UTF-8 by themselves.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const util = require('./util');
const dbservers = require('./dbservers');
const dbmove = require('./dbmove');
const projects = require('./projects');
const timemachine = require('./timemachine');
const { tr } = require('./i18n');

const { AppError } = util;
const FIXES = Object.freeze(['stripdb', 'collation', 'charset', 'definer', 'gtid', 'mysql8', 'sqlmode', 'packet', 'strict', 'latin1']);
const MODES = Object.freeze(['replace', 'merge']);
const DB_RE = /^[A-Za-z0-9_$-]{1,64}$/;
const SCAN_LIMIT = 200 * 1024 * 1024;
const LONG_LINE = 256 * 1024;
const ONE_GB = 1024 * 1024 * 1024;

/** Server error -> the fix that solves it (codes from the mysql client's "ERROR nnnn (xxxxx) at line N: ..."). */
const ERROR_FIXES = Object.freeze({
  1273: ['collation'], // Unknown collation
  1115: ['charset'], // Unknown character set
  1449: ['definer'], // The user specified as a definer does not exist
  1227: ['definer', 'gtid'], // Access denied; you need SUPER
  1153: ['packet'], // Got a packet bigger than max_allowed_packet
  2006: ['packet'], // server has gone away
  2013: ['packet'], // Lost connection
  1301: ['packet'], // Result of ... was larger than max_allowed_packet
  1067: ['sqlmode'], // Invalid default value
  1292: ['sqlmode'], // Incorrect datetime value
  1264: ['sqlmode'], // Out of range value
  1265: ['sqlmode'], // Data truncated
  1406: ['sqlmode'], // Data too long
  1118: ['strict'], // Row size too large
  1300: ['latin1'], // Invalid utf8 character string
  1050: ['replace'], // Table already exists
  1062: ['replace'], // Duplicate entry
  1007: ['stripdb'], // Can't create database; database exists
  1008: ['stripdb'], // Can't drop database
  1049: ['stripdb'], // Unknown database
  1840: ['gtid'], 1839: ['gtid'], 3546: ['gtid'],
});

// ------------------------------------------------------------------------------------------ pure parts

/** "ERROR 1273 (HY000) at line 25: Unknown collation: 'x'" -> {code, line, message} | null. PURE. */
function parseClientError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  for (const l of lines) {
    const m = /ERROR\s+(\d{4})(?:\s*\([0-9A-Z]{5}\))?(?:\s+at line\s+(\d+))?\s*:?\s*(.*)$/.exec(l);
    if (m) return { code: Number(m[1]), line: m[2] ? Number(m[2]) : null, message: m[3].trim() };
  }
  return null;
}

/** The fixes that solve an error, minus the ones already on. `scan` adds what the check saw. PURE. */
function fixesFor(err, applied = [], scan = {}) {
  if (!err) return [];
  let out = (ERROR_FIXES[err.code] || []).slice();
  const msg = String(err.message || '');
  if (err.code === 1366) out = [scan.invalidUtf8 ? 'latin1' : 'sqlmode'];
  if (err.code === 1064 && (/\/\*!80|ENCRYPTION|VISIBLE|SRID/i.test(msg) || scan.mysql8)) out = ['mysql8'];
  if (err.code === 1064 && /GTID|SQL_LOG_BIN/i.test(msg)) out = ['gtid'];
  if (err.code === 1227 && /GTID|SQL_LOG_BIN|BINLOG/i.test(msg)) out = ['gtid'];
  if (err.code === 1193) out = /GTID|LOG_BIN/i.test(msg) ? ['gtid'] : /sql_mode|innodb_strict/i.test(msg) ? [] : ['mysql8'];
  if (err.code === 1231 && /sql_mode/i.test(msg)) out = ['sqlmode']; // Variable 'sql_mode' can't be set to ...
  if (err.code === 1115 && !/utf8mb3/i.test(msg)) out = ['collation'];
  return out.filter((f, i) => out.indexOf(f) === i && !applied.includes(f));
}

/** The nearest collation the server has, for one it lacks. PURE. */
function nearestCollation(name, supported) {
  const has = (c) => supported.has(c);
  const n = String(name).toLowerCase();
  const charset = n.startsWith('utf8mb4_') ? 'utf8mb4' : n.startsWith('utf8mb3_') || n.startsWith('utf8_') ? 'utf8' : n.split('_')[0];
  const bin = /_bin$/.test(n);
  const order = charset === 'utf8mb4'
    ? (bin ? ['utf8mb4_bin', 'utf8mb4_unicode_ci'] : ['utf8mb4_unicode_ci', 'utf8mb4_general_ci'])
    : charset === 'utf8'
      ? (bin ? ['utf8_bin', 'utf8mb3_bin', 'utf8mb4_bin'] : ['utf8_unicode_ci', 'utf8mb3_unicode_ci', 'utf8_general_ci', 'utf8mb4_unicode_ci'])
      : [`${charset}_general_ci`, `${charset}_bin`, 'utf8mb4_unicode_ci'];
  return order.find(has) || 'utf8mb4_unicode_ci';
}

const RE_DB_LINE = /^\s*(?:\/\*!\d+\s*)?(?:USE\s|(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b)/i;
const RE_GTID = /GTID_PURGED|SQL_LOG_BIN|@MYSQLDUMP_TEMP_LOG_BIN/i;
const RE_DEFINER = /\s*DEFINER\s*=\s*(?:`[^`]*`|'[^']*'|"[^"]*"|[^\s@]+)\s*@\s*(?:`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z0-9_.%-]+)/gi;
const RE_MYSQL8 = /\/\*!80\d{3}\s[\s\S]*?\*\//g;
const RE_STRICT_TOKENS = /(,?)\b(NO_ZERO_DATE|NO_ZERO_IN_DATE|STRICT_TRANS_TABLES|STRICT_ALL_TABLES|TRADITIONAL)\b(,?)/gi;

/**
 * The line fixer: (line without its own handling of long lines) -> line | null (dropped).
 * `state` keeps multi-line skips. PURE (apart from `state`).
 */
function makeLineFixer(fixes, { collations = {}, latin1 = false } = {}) {
  const on = new Set(fixes);
  const collRe = Object.keys(collations).length
    ? new RegExp(`\\b(${Object.keys(collations).map((c) => c.replace(/[^A-Za-z0-9_]/g, '')).join('|')})\\b`, 'gi')
    : null;
  const state = { skipToSemicolon: false };
  return function fix(line) {
    if (state.skipToSemicolon) {
      if (/;\s*$/.test(line)) state.skipToSemicolon = false;
      return null;
    }
    if (on.has('stripdb') && RE_DB_LINE.test(line)) return null;
    if (on.has('gtid') && RE_GTID.test(line)) {
      if (!/;\s*$/.test(line)) state.skipToSemicolon = true;
      return null;
    }
    let s = line;
    if (on.has('definer') && /DEFINER/i.test(s)) s = s.replace(RE_DEFINER, '');
    if (on.has('mysql8') && s.includes('/*!80')) s = s.replace(RE_MYSQL8, '');
    if (on.has('collation') && collRe) s = s.replace(collRe, (m) => collations[m.toLowerCase()] || m);
    if (on.has('charset') && /utf8mb3/i.test(s)) s = s.replace(/utf8mb3/gi, 'utf8');
    if (on.has('sqlmode') && /sql_mode/i.test(s)) {
      s = s.replace(RE_STRICT_TOKENS, (m, a, tok, b) => (a && b ? ',' : '')).replace(/=\s*'\s*,/g, "='").replace(/,\s*'/g, "'");
    }
    if (latin1 && /SET\s+NAMES\s+utf8/i.test(s)) s = s.replace(/SET\s+NAMES\s+utf8(?:mb4)?/gi, 'SET NAMES latin1');
    return s;
  };
}

/** Original dump line of a line the client reported (prelude and dropped lines taken out). PURE. */
function originalLine(reported, preludeLines, dropped) {
  if (!Number.isInteger(reported)) return null;
  let orig = reported - preludeLines;
  if (orig < 1) return null;
  for (const d of dropped) {
    if (d <= orig) orig++;
    else break;
  }
  return orig;
}

// ------------------------------------------------------------------------------------------ the file

function fileKind(file, head) {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gz';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  return 'sql';
}

function encodingOf(head) {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf16be';
  // no BOM but every other byte zero: UTF-16 without BOM
  let zeros = 0;
  const n = Math.min(head.length, 512);
  for (let i = 1; i < n; i += 2) if (head[i] === 0) zeros++;
  if (n > 16 && zeros > n / 4) return 'utf16le';
  return 'utf8';
}

function readHead(file, bytes = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

function tmpRoot(ctx) {
  return path.join(ctx.store.data.settings.dumpDir, 'devpanel-backups', 'import-tmp');
}

/** A .zip: its biggest .sql / .sql.gz, extracted (once per zip version) with Windows' tar. */
async function fromZip(ctx, file) {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`${util.normPath(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12);
  const dir = path.join(tmpRoot(ctx), key);
  const pick = () => {
    const all = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.sql(\.gz)?$/i.test(e.name)) all.push({ p, size: fs.statSync(p).size });
      }
    };
    walk(dir, 0);
    all.sort((a, b) => b.size - a.size);
    return all.length ? all[0].p : null;
  };
  if (util.existsDir(dir)) {
    const hit = pick();
    if (hit) return { file: hit, tmpDir: dir };
  }
  util.ensureDir(dir);
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = await util.run(util.existsFile(tar) ? tar : 'tar', ['-xf', file, '-C', dir], { timeoutMs: 0 });
  const inner = pick();
  if (r.code !== 0 || !inner) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new AppError('ZIP_NO_SQL', tr('di.zipNoSql'), 400);
  }
  return { file: inner, tmpDir: dir };
}

/** The readable dump: {file, kind: 'sql' | 'gz', encoding, size, inner, tmpDir}. */
async function openDump(ctx, file) {
  let f = file;
  let inner = null;
  let tmpDir = null;
  let head = readHead(f);
  if (fileKind(f, head) === 'zip') {
    const z = await fromZip(ctx, f);
    f = z.file;
    inner = path.basename(z.file);
    tmpDir = z.tmpDir;
    head = readHead(f);
  }
  const kind = fileKind(f, head) === 'gz' ? 'gz' : 'sql';
  let encHead = head;
  if (kind === 'gz') {
    try { encHead = zlib.gunzipSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { encHead = Buffer.alloc(0); }
  }
  return { file: f, kind, encoding: encodingOf(encHead), size: fs.statSync(f).size, inner, tmpDir };
}

/** Raw dump stream: bytes as UTF-8 (UTF-16 converted), decompressed. onBytes(n) counts file bytes. */
function dumpStream(d, onBytes) {
  const src = fs.createReadStream(d.file, { highWaterMark: 1024 * 1024 });
  if (onBytes) src.on('data', (c) => onBytes(c.length));
  let s = d.kind === 'gz' ? src.pipe(zlib.createGunzip()) : src;
  if (d.encoding !== 'utf8') {
    const dec = new TextDecoder(d.encoding === 'utf16be' ? 'utf-16be' : 'utf-16le');
    s = s.pipe(new Transform({
      transform(chunk, enc, cb) { cb(null, Buffer.from(dec.decode(chunk, { stream: true }), 'utf8')); },
      flush(cb) { cb(null, Buffer.from(dec.decode(), 'utf8')); },
    }));
    src.on('error', (e) => s.destroy(e));
  }
  return { stream: s, source: src };
}

/** Walks the dump line by line (long lines only measured). visit(line, lineNo) may return true to stop; long(len, lineNo). */
function scanDump(d, limit, visit, long) {
  return new Promise((resolve, reject) => {
    const { stream, source } = dumpStream(d);
    let carry = '';
    let inLong = false;
    let longLen = 0;
    let seen = 0;
    let lineNo = 0;
    let stopped = false;
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    let invalidUtf8 = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { source.destroy(); } catch { /* ignore */ }
      try { stream.destroy(); } catch { /* ignore */ }
      resolve({ invalidUtf8, partial: true, lines: lineNo });
    };
    stream.on('data', (chunk) => {
      if (stopped) return;
      seen += chunk.length;
      if (!invalidUtf8) {
        try { utf8.decode(chunk, { stream: true }); } catch { invalidUtf8 = true; }
      }
      const text = chunk.toString('latin1');
      let pos = 0;
      while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        if (inLong) {
          if (nl < 0) { longLen += text.length - pos; pos = text.length; break; }
          longLen += nl - pos;
          lineNo++;
          long(longLen, lineNo);
          inLong = false;
          longLen = 0;
          pos = nl + 1;
          continue;
        }
        if (nl < 0) {
          carry += text.slice(pos);
          pos = text.length;
          if (carry.length > LONG_LINE) { inLong = true; longLen = carry.length; carry = ''; }
          break;
        }
        const line = carry + text.slice(pos, nl);
        carry = '';
        pos = nl + 1;
        lineNo++;
        if (line.length > LONG_LINE) long(line.length, lineNo);
        else if (visit(line, lineNo) === true) { stop(); return; }
      }
      if (seen >= limit) stop();
    });
    stream.on('end', () => {
      if (stopped) return;
      if (carry) { lineNo++; visit(carry, lineNo); }
      if (inLong) { lineNo++; long(longLen, lineNo); }
      stopped = true;
      resolve({ invalidUtf8, partial: false, lines: lineNo });
    });
    stream.on('error', (e) => { if (!stopped) { stopped = true; reject(new AppError('READ_FAILED', tr('di.readFailed', { message: e.message }), 400)); } });
  });
}

// ------------------------------------------------------------------------------------------ the server

function q(s) { return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

/** One client run (errors skipped with --force); rows tab-split. */
async function batch(ctx, t, sql) {
  const c = dbservers.clientInstallFor(ctx, t.entry);
  const r = await util.run(c.client, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(t.port), '-u', t.creds.user,
    ...dbservers.sslArgs(c.client, c.kind), '-N', '-B', '--force', '--default-character-set=utf8mb4'],
  { input: sql, env: dbservers.credEnv(t.creds.password), timeoutMs: 60000 });
  const err = dbservers.cleanStderr(r.stderr);
  if (/ERROR 1045/.test(err)) throw new AppError('NEED_CREDENTIALS', tr('err.needCreds'), 409);
  if (/ERROR 2002|ERROR 2003|Can't connect/i.test(err)) throw new AppError('DB_NOT_RUNNING', tr('err.dbConnect', { port: t.port, line: util.firstLine(err) }), 409);
  return String(r.stdout || '').split(/\r?\n/).filter((l) => l !== '').map((l) => l.split('\t'));
}

/** What the server supports and how the target database looks. */
async function serverFacts(ctx, t, database) {
  const db = q(database);
  const rows = await batch(ctx, t, [
    "SELECT 'ver', VERSION();",
    "SELECT 'packet', @@GLOBAL.max_allowed_packet;",
    "SELECT 'mode', @@GLOBAL.sql_mode;",
    "SELECT 'coll', COLLATION_NAME FROM information_schema.COLLATIONS;",
    "SELECT 'cs', CHARACTER_SET_NAME FROM information_schema.CHARACTER_SETS;",
    `SELECT 'db', COUNT(*) FROM information_schema.schemata WHERE schema_name = ${db};`,
    `SELECT 'tables', COUNT(*) FROM information_schema.tables WHERE table_schema = ${db};`,
    "SELECT 'super', COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE = 'SUPER' AND GRANTEE = CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''');",
    "SELECT 'user', LOWER(CONCAT(User, '@', Host)) FROM mysql.user;",
    '',
  ].join('\n'));
  const f = { version: '', mariadb: false, packet: 0, sqlMode: '', collations: new Set(), charsets: new Set(), exists: false, tables: 0, super: false, users: null };
  for (const r of rows) {
    if (r[0] === 'ver') { f.version = r[1]; f.mariadb = /mariadb/i.test(r[1]); }
    else if (r[0] === 'packet') f.packet = Number(r[1]) || 0;
    else if (r[0] === 'mode') f.sqlMode = r[1] || '';
    else if (r[0] === 'coll') f.collations.add(String(r[1]).toLowerCase());
    else if (r[0] === 'cs') f.charsets.add(String(r[1]).toLowerCase());
    else if (r[0] === 'db') f.exists = Number(r[1]) > 0;
    else if (r[0] === 'tables') f.tables = Number(r[1]) || 0;
    else if (r[0] === 'super') f.super = Number(r[1]) > 0;
    else if (r[0] === 'user') (f.users || (f.users = new Set())).add(String(r[1]));
  }
  if (!f.mariadb && t.entry.kind === 'mariadb') f.mariadb = true;
  return f;
}

async function targetFor(ctx, projectId, database) {
  const t = await timemachine.target(ctx, projectId);
  if (database) {
    if (!DB_RE.test(database)) throw new AppError('BAD_NAME', tr('err.badDbName'), 400);
    t.database = database;
  }
  return t;
}

function checkFile(file) {
  const f = util.checkUserPath(file, { kind: 'file', label: tr('label.sqlFile') });
  if (!/\.(sql|gz|zip)$/i.test(f)) throw new AppError('BAD_PATH', tr('di.notDump'), 400);
  return f;
}

// ------------------------------------------------------------------------------------------ inspect

/**
 * Reads the dump and the server: {file, size, kind, inner, encoding, producer, tables, inserts,
 * databases, partial, target: {database, exists, tables, server}, issues: [{code, level, fix, params}],
 * fixes: [default on], mode}.
 */
async function inspect(ctx, projectId, { file, database = null } = {}) {
  const f = checkFile(file);
  const t = await targetFor(ctx, projectId, database);
  const d = await openDump(ctx, f);
  const facts = await serverFacts(ctx, t, t.database);
  const found = { producer: null, dbs: new Set(), colls: new Set(), charsets: new Set(), definers: new Set(), gtid: false, mysql8: false, zeroDates: false, tables: 0, inserts: 0, maxLine: 0 };
  const scan = await scanDump(d, SCAN_LIMIT, (line, n) => {
    if (line.length > found.maxLine) found.maxLine = line.length;
    if (n <= 40 && !found.producer) {
      const m = /--\s*(MySQL dump|MariaDB dump|phpMyAdmin SQL Dump|HeidiSQL|Adminer|Navicat|Sequel|TablePlus|DBeaver)[^\r\n]*/i.exec(line);
      if (m) found.producer = m[0].replace(/^--\s*/, '').trim().slice(0, 100);
    }
    if (n <= 40 && /Server version:?\s*(8\.\d+)/i.test(line)) found.mysql8 = found.mysql8 || !/mariadb/i.test(line);
    const head = line.length > 300 ? line.slice(0, 300) : line;
    if (/^\s*CREATE\s+TABLE/i.test(head)) found.tables++;
    else if (/^\s*INSERT\s/i.test(head)) found.inserts++;
    if (RE_DB_LINE.test(head)) {
      const m = /(?:USE|DATABASE|SCHEMA)\s+(?:\/\*!\d+\s*)?(?:IF\s+(?:NOT\s+)?EXISTS\s*)?(?:\*\/\s*)?`?([^`;\s/]+)`?/i.exec(head);
      if (m) found.dbs.add(m[1]);
    }
    if (/COLLATE|CHARSET|CHARACTER SET/i.test(line)) {
      for (const m of line.matchAll(/COLLATE\s*=?\s*['`"]?([A-Za-z0-9_]+)/gi)) found.colls.add(m[1].toLowerCase());
      for (const m of line.matchAll(/(?:CHARSET|CHARACTER SET)\s*=?\s*['`"]?([A-Za-z0-9_]+)/gi)) found.charsets.add(m[1].toLowerCase());
    }
    if (/DEFINER/i.test(line)) {
      for (const m of line.matchAll(/DEFINER\s*=\s*(`[^`]*`|'[^']*'|[^\s@]+)\s*@\s*(`[^`]*`|'[^']*'|[A-Za-z0-9_.%-]+)/gi)) {
        found.definers.add(`${m[1].replace(/[`'"]/g, '')}@${m[2].replace(/[`'"]/g, '')}`.toLowerCase());
      }
    }
    if (RE_GTID.test(line)) found.gtid = true;
    if (line.includes('/*!80')) found.mysql8 = true;
    if (/'0000-00-00/.test(line)) found.zeroDates = true;
  }, (len) => { if (len > found.maxLine) found.maxLine = len; });

  const issues = [];
  const fixes = new Set();
  const add = (code, level, fix, params = {}) => { issues.push({ code, level, fix, params }); if (fix) fixes.add(fix); };
  if (d.encoding !== 'utf8') add('utf16', 'info', null, { encoding: d.encoding });
  const others = [...found.dbs].filter((n) => n !== t.database);
  if (found.dbs.size) add(others.length ? 'otherDb' : 'ownDb', others.length ? 'warn' : 'info', 'stripdb', { names: [...found.dbs].slice(0, 5).join(', '), db: t.database });
  const badColls = [...found.colls].filter((c) => !facts.collations.has(c));
  if (badColls.length) add('collation', 'bad', 'collation', { names: badColls.slice(0, 5).join(', '), to: nearestCollation(badColls[0], facts.collations) });
  if ([...found.charsets].includes('utf8mb3') && !facts.charsets.has('utf8mb3')) add('charset', 'bad', 'charset', {});
  if (found.definers.size) {
    const missing = facts.users ? [...found.definers].filter((u) => !facts.users.has(u)) : [...found.definers];
    if (missing.length || !facts.super) add('definer', 'warn', 'definer', { names: [...found.definers].slice(0, 3).join(', ') });
  }
  if (found.gtid) add('gtid', facts.mariadb || !facts.super ? 'bad' : 'warn', 'gtid', {});
  if (found.mysql8 && facts.mariadb) add('mysql8', 'warn', 'mysql8', { server: facts.version });
  if (found.zeroDates && /NO_ZERO_DATE|NO_ZERO_IN_DATE|STRICT|TRADITIONAL/i.test(facts.sqlMode)) add('zeroDates', 'warn', 'sqlmode', {});
  if (found.maxLine + 1024 > facts.packet && facts.packet) {
    add('packet', facts.super ? 'warn' : 'bad', 'packet', { line: util.fmtMB(found.maxLine), packet: util.fmtMB(facts.packet), super: facts.super });
  }
  if (scan.invalidUtf8 && d.encoding === 'utf8') add('notUtf8', 'warn', 'latin1', {});
  if (scan.partial) add('partial', 'info', null, { size: util.fmtMB(SCAN_LIMIT) });
  if (facts.exists && facts.tables > 0) add('hasTables', 'info', null, { db: t.database, tables: facts.tables });
  return {
    file: f, size: d.size, kind: d.kind, inner: d.inner, encoding: d.encoding, producer: found.producer,
    tables: found.tables, inserts: found.inserts, databases: [...found.dbs].slice(0, 10), partial: scan.partial, lines: scan.lines,
    target: { database: t.database, exists: facts.exists, tables: facts.tables, server: t.entry.label, version: facts.version },
    issues, fixes: FIXES.filter((x) => fixes.has(x)), mode: facts.exists && facts.tables > 0 ? 'replace' : 'merge',
    invalidUtf8: scan.invalidUtf8, mysql8: found.mysql8,
  };
}

// ------------------------------------------------------------------------------------------ import

/** Validates the request before the job is created. */
function prepare(ctx, projectId, body) {
  const b = body || {};
  const p = projects.getProject(ctx, projectId);
  const file = checkFile(b.file);
  const mode = MODES.includes(b.mode) ? b.mode : 'replace';
  const fixes = Array.isArray(b.fixes) ? b.fixes.filter((x) => FIXES.includes(x)) : [];
  const database = typeof b.database === 'string' && b.database.trim() ? b.database.trim() : null;
  if (database && !DB_RE.test(database)) throw new AppError('BAD_NAME', tr('err.badDbName'), 400);
  if (!p.dbServerId) throw new AppError('NO_DB_SERVER', tr('prov.noServer'), 409);
  return { projectId: p.id, file, mode, fixes, database, invalidUtf8: !!b.invalidUtf8, mysql8: !!b.mysql8 };
}

/** The import job (see the header). */
async function importJob(ctx, input, log, job) {
  const started = Date.now();
  job.progress = { stage: 'check' };
  const t = await targetFor(ctx, input.projectId, input.database);
  const db = t.database;
  const d = await openDump(ctx, input.file);
  const facts = await serverFacts(ctx, t, db);
  // USE / CREATE DATABASE lines would send the tables into another database: always taken out
  const fixes = input.fixes.includes('stripdb') ? input.fixes.slice() : ['stripdb', ...input.fixes];
  const on = new Set(fixes);
  log('info', tr('di.start', { file: path.basename(input.file) + (d.inner ? ` → ${d.inner}` : ''), size: util.fmtMB(d.size), db, label: t.entry.label }));
  if (fixes.length) log('info', tr('di.fixesOn', { list: fixes.join(', ') }));

  // 1. a restore point first, so the import can be undone
  let point = null;
  if (facts.exists && facts.tables > 0) {
    job.progress = { stage: 'dump' };
    log('info', tr('di.pointFirst', { db, tables: facts.tables }));
    point = await timemachine.dumpPoint(ctx, t, { reason: 'pre-import', command: `import ${path.basename(input.file)}`.slice(0, 120), log, job });
  }

  // 2. the database
  const ident = dbmove.ident(db);
  const create = `CREATE DATABASE ${input.mode === 'replace' ? '' : 'IF NOT EXISTS '}${ident} CHARACTER SET utf8mb4 COLLATE ${nearestCollation('utf8mb4_unicode_ci', facts.collations)};\n`;
  if (input.mode === 'replace' && facts.exists) {
    await dbservers.query(ctx, t.entry, `DROP DATABASE IF EXISTS ${ident};\n${create}`, t.creds);
    log('info', tr(point ? 'di.emptied' : 'di.emptiedNoPoint', { db }));
  } else {
    await dbservers.query(ctx, t.entry, create, t.creds);
  }

  // 3. max_allowed_packet for this import
  let packetBack = null;
  if (on.has('packet') && facts.super && facts.packet < ONE_GB) {
    await dbservers.query(ctx, t.entry, `SET GLOBAL max_allowed_packet = ${ONE_GB};\n`, t.creds);
    packetBack = facts.packet;
    log('info', tr('di.packetUp'));
  }

  // 4. stream it in
  const collations = {};
  if (on.has('collation')) {
    // every collation the server lacks that a dump may name
    for (const c of ['utf8mb4_0900_ai_ci', 'utf8mb4_0900_as_ci', 'utf8mb4_0900_as_cs', 'utf8mb4_0900_bin', 'utf8mb4_unicode_520_ci',
      'utf8mb4_uca1400_ai_ci', 'utf8mb4_uca1400_as_cs', 'utf8mb3_general_ci', 'utf8mb3_unicode_ci', 'utf8mb3_bin']) {
      if (!facts.collations.has(c)) collations[c] = nearestCollation(c, facts.collations);
    }
  }
  const latin1 = on.has('latin1');
  const quiet = facts.super;
  const prelude = [
    `SET NAMES ${latin1 ? 'latin1' : 'utf8mb4'};`,
    'SET FOREIGN_KEY_CHECKS=0;',
    'SET UNIQUE_CHECKS=0;',
    'SET AUTOCOMMIT=0;',
    // an import of thousands of rows must not flood the "Every action" history
    quiet ? 'SET SESSION sql_log_bin=0;' : null,
    on.has('sqlmode') ? "SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION';" : null,
    on.has('strict') ? 'SET SESSION innodb_strict_mode=0;' : null,
  ].filter(Boolean);
  const postlude = ['COMMIT;', 'SET FOREIGN_KEY_CHECKS=1;', 'SET UNIQUE_CHECKS=1;'];
  const fixLine = makeLineFixer(fixes, { collations, latin1 });
  const dropped = [];
  let origLine = 0;
  const c = dbservers.clientInstallFor(ctx, t.entry);
  const args = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(t.port), '-u', t.creds.user, ...dbservers.sslArgs(c.client, c.kind),
    `--default-character-set=${latin1 ? 'latin1' : 'utf8mb4'}`, `--max-allowed-packet=${ONE_GB}`];
  if (dbmove.needsCollationCompat(t.entry, 'utf8mb4_unicode_ci')) args.push(dbmove.COLLATION_COMPAT_ARG);
  args.push('-D', db);

  let sent = 0;
  let lastLog = Date.now();
  job.progress = { stage: 'import', bytes: 0, total: d.size, percent: 0 };
  const result = await new Promise((resolve) => {
    const child = spawn(c.client, args, { env: dbservers.credEnv(t.creds.password), windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    child.stderr.on('data', (b) => { if (stderr.length < 64 * 1024) stderr += b.toString('utf8'); });
    child.on('error', (e) => finish({ code: -1, stderr: e.message }));
    child.on('close', (code) => finish({ code, stderr }));
    child.stdin.on('error', () => { /* the client stopped at an error: its exit code tells */ });

    const { stream, source } = dumpStream(d, (n) => {
      sent += n;
      job.progress = { stage: 'import', bytes: sent, total: d.size, percent: d.size ? Math.floor((sent / d.size) * 100) : null };
      if (Date.now() - lastLog >= 3000) {
        lastLog = Date.now();
        log('info', `Import: ${util.fmtMB(sent)} / ${util.fmtMB(d.size)} (${d.size ? Math.floor((sent / d.size) * 100) : 0}%)`);
      }
    });
    let carry = '';
    let inLong = false;
    const fixer = new Transform({
      transform(chunk, enc, cb) {
        const text = chunk.toString('latin1');
        const out = [];
        let pos = 0;
        while (pos < text.length) {
          const nl = text.indexOf('\n', pos);
          if (inLong) {
            if (nl < 0) { out.push(text.slice(pos)); pos = text.length; break; }
            out.push(text.slice(pos, nl + 1));
            origLine++;
            inLong = false;
            pos = nl + 1;
            continue;
          }
          if (nl < 0) {
            carry += text.slice(pos);
            pos = text.length;
            if (carry.length > LONG_LINE) { out.push(carry); carry = ''; inLong = true; }
            break;
          }
          const line = carry + text.slice(pos, nl + 1);
          carry = '';
          pos = nl + 1;
          origLine++;
          const fixed = fixLine(line);
          if (fixed === null) { if (dropped.length < 200000) dropped.push(origLine); } else out.push(fixed);
        }
        cb(null, out.length ? Buffer.from(out.join(''), 'latin1') : null);
      },
      flush(cb) {
        const tail = [];
        if (carry) {
          origLine++;
          const fixed = inLong ? carry : fixLine(carry);
          if (fixed === null) dropped.push(origLine); else tail.push(fixed);
        }
        tail.push(`\n${postlude.join('\n')}\n`);
        cb(null, Buffer.from(tail.join(''), 'latin1'));
      },
    });
    child.stdin.write(`${prelude.join('\n')}\n`);
    stream.on('error', (e) => { finish({ code: -2, stderr: e.message }); try { child.kill(); } catch { /* gone */ } });
    stream.pipe(fixer).pipe(child.stdin);
    child.on('close', () => { try { source.destroy(); } catch { /* done */ } });
  });

  if (packetBack !== null) {
    try { await dbservers.query(ctx, t.entry, `SET GLOBAL max_allowed_packet = ${packetBack};\n`, t.creds); } catch { /* the server keeps 1 GB until it restarts */ }
  }
  if (d.tmpDir && result.code === 0) { try { fs.rmSync(d.tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }

  if (result.code !== 0) {
    const err = parseClientError(result.stderr) || { code: null, line: null, message: util.firstLine(dbservers.cleanStderr(result.stderr)) || String(result.code) };
    const line = originalLine(err.line, prelude.length, dropped);
    const suggest = fixesFor(err, fixes.concat(input.mode === 'replace' ? ['replace'] : []), { invalidUtf8: input.invalidUtf8, mysql8: input.mysql8 });
    const snippet = line ? await snippetAt(d, line) : null;
    log('bad', tr('di.failedAt', { code: err.code || '?', line: line || '?', message: err.message }));
    if (suggest.length) log('info', tr('di.suggest', { list: suggest.join(', ') }));
    throw new AppError('IMPORT_ERROR', tr('di.failed', { code: err.code || '?', message: err.message }), 500, {
      mysqlCode: err.code, line, message: err.message, suggest, snippet, file: d.inner ? null : d.file,
      fixes, mode: input.mode, database: db, point: point ? point.name : null,
    });
  }
  const after = await serverFacts(ctx, t, db);
  const tookMs = Date.now() - started;
  log('ok', tr('di.done', { db, tables: after.tables, secs: Math.round(tookMs / 1000) }));
  ctx.log(`db import ${input.projectId} ${db} <- ${input.file} (${after.tables} tables, ${tookMs} ms, fixes ${fixes.join(',') || '-'})`);
  job.progress = { stage: 'done', bytes: d.size, total: d.size, percent: 100 };
  return { database: db, tables: after.tables, bytes: d.size, tookMs, point: point ? point.name : null, fixes, mode: input.mode };
}

/** A few lines of the dump around `line` (each cut to 300 characters). */
async function snippetAt(d, line) {
  const lines = [];
  try {
    await scanDump(d, Number.MAX_SAFE_INTEGER, (text, n) => {
      if (n >= line - 2 && n <= line + 2) lines.push({ n, text: text.slice(0, 300) });
      return n >= line + 2;
    }, (len, n) => {
      if (n >= line - 2 && n <= line + 2) lines.push({ n, text: `… (${util.fmtMB(len)})`, long: true });
    });
  } catch { return null; }
  return lines.filter((x) => x.n >= line - 2 && x.n <= line + 2).slice(0, 5);
}

module.exports = {
  FIXES, MODES, inspect, prepare, importJob,
  // pure, for tests
  parseClientError, fixesFor, nearestCollation, makeLineFixer, originalLine, encodingOf,
};
