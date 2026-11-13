'use strict';
/*
 * Errors: a project's Laravel log (storage\logs\*.log) and PHP Station's own server log for it,
 * parsed into entries (level, message, exception class, file:line, stack frames) and grouped by
 * fingerprint so a loop that throws 500 times is one row "x 500".
 *
 *  - Read only: the log files are never changed. "Mark as seen" stores a byte position per file
 *    in the panel state; newer entries count as new.
 *  - Only the tail of each file is read (TAIL_BYTES), so a 2 GB laravel.log stays fast.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const projects = require('./projects');

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 1500;
const HEAD_RE = /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)\] ([\w-]+)\.([A-Z]+): ?/;
const PHP_RE = /PHP (Fatal error|Parse error|Warning|Notice|Deprecated|Recoverable fatal error|Strict Standards|Catchable fatal error):\s+(.*?)(?: in (.+?)(?::(\d+)| on line (\d+)))?\s*$/;
const BAD_LEVELS = new Set(['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR']);

/** Log time text -> ms (Laravel "2026-11-13 10:00:00", php -S "Fri Nov 13 10:00:00 2026"), null when unknown. PURE. */
function timeOf(t) {
  const s = String(t || '').trim();
  const n = Date.parse(/^d{4}-d{2}-d{2} /.test(s) ? s.replace(' ', 'T') : s);
  return Number.isFinite(n) ? n : null;
}

function phpLogFile(ctx, id) {
  return path.join(ctx.dataDir, 'logs', 'projects', `${id}.log`);
}

function unescapeJsonPath(p) {
  return String(p || '').replace(/\\\\/g, '\\').replace(/\\\//g, '/');
}

function isVendor(file) {
  return /[\\/]vendor[\\/]/i.test(String(file || ''));
}

/** "#3 D:\\app\\X.php(12): Foo->bar()" -> {file, line, call, vendor}. PURE. */
function parseFrame(line) {
  const m = /^#(\d+)\s+(?:(.+?)\((\d+)\)|\[internal function\]|\{main\}):?\s*(.*)$/.exec(String(line).trim());
  if (!m) return null;
  const file = m[2] ? unescapeJsonPath(m[2]) : null;
  return { n: Number(m[1]), file, line: m[3] ? Number(m[3]) : null, call: unescapeJsonPath(m[4] || '').slice(0, 300), vendor: file ? isVendor(file) : true };
}

/** Body of one Laravel log entry -> {message, exception, frames}. PURE. */
function parseEntryBody(text) {
  const lines = String(text).split(/\r?\n/);
  let message = lines[0] || '';
  // the context JSON / [] [] tail of the first line is not part of the message
  const ctxAt = message.search(/ \{"|\s\[\]\s*\[\]\s*$|\s\{\}\s*\[\]\s*$/);
  if (ctxAt > 0) message = message.slice(0, ctxAt);
  let exception = null;
  const ex = /\[object\] \(([\w\\]+)\(code: ([^)]*)\): ([\s\S]*?) at (.+?):(\d+)\)/.exec(text);
  if (ex) {
    exception = { class: ex[1].replace(/\\\\/g, '\\'), code: ex[2], message: unescapeJsonPath(ex[3]).replace(/\\"/g, '"').slice(0, 2000), file: unescapeJsonPath(ex[4]), line: Number(ex[5]) };
  }
  const frames = [];
  let inFirstTrace = false;
  for (const l of lines.slice(1)) {
    if (/^\[stacktrace\]/.test(l)) { if (frames.length) break; inFirstTrace = true; continue; }
    if (/^\[previous exception\]/.test(l)) break;
    if (!inFirstTrace) continue;
    const f = parseFrame(l);
    if (f) frames.push(f);
    if (frames.length >= 80) break;
  }
  return { message: unescapeJsonPath(message).trim().slice(0, 2000), exception, frames };
}

/** Laravel log text -> entries [{offset, time, env, level, message, exception, frames, where}]. PURE. */
function parseLaravelLog(text, baseOffset = 0) {
  const out = [];
  const s = String(text || '');
  const re = /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*\] [\w-]+\.[A-Z]+:/gm;
  const starts = [];
  let m;
  while ((m = re.exec(s))) starts.push(m.index);
  let bytes = 0;
  let prev = 0;
  for (let i = 0; i < starts.length; i++) {
    bytes += Buffer.byteLength(s.slice(prev, starts[i]), 'utf8');
    prev = starts[i];
    const chunk = s.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : s.length).replace(/\s+$/, '');
    const h = HEAD_RE.exec(chunk);
    if (!h) continue;
    const body = parseEntryBody(chunk.slice(h[0].length));
    const appFrame = body.frames.find((f) => f.file && !f.vendor);
    const where = body.exception && !isVendor(body.exception.file) ? { file: body.exception.file, line: body.exception.line }
      : appFrame ? { file: appFrame.file, line: appFrame.line } : body.exception ? { file: body.exception.file, line: body.exception.line } : null;
    out.push({
      source: 'laravel', offset: baseOffset + bytes, ts: timeOf(h[1]),
      time: h[1], env: h[2], level: h[3], message: body.message, exception: body.exception, frames: body.frames, where,
      raw: chunk.length > 20000 ? `${chunk.slice(0, 20000)}\n…` : chunk,
    });
  }
  return out;
}

/** PHP server log text (php -S stderr) -> entries for PHP errors. PURE. */
function parsePhpLog(text, baseOffset = 0) {
  const out = [];
  const s = String(text || '');
  let pos = 0;
  for (const line of s.split('\n')) {
    const len = Buffer.byteLength(line, 'utf8') + 1;
    const m = PHP_RE.exec(line.replace(/\r$/, ''));
    if (m) {
      const lvl = /fatal|parse/i.test(m[1]) ? 'ERROR' : /warning/i.test(m[1]) ? 'WARNING' : /deprecated|strict/i.test(m[1]) ? 'DEPRECATED' : 'NOTICE';
      const tm = /^\[([^\]]+)\]/.exec(line);
      const file = m[3] || null;
      const ln = Number(m[4] || m[5]) || null;
      out.push({
        source: 'php', offset: baseOffset + pos, time: tm ? tm[1] : null, ts: tm ? timeOf(tm[1]) : null, env: null, level: lvl,
        message: `PHP ${m[1]}: ${m[2]}`.slice(0, 2000), exception: null, frames: [], where: file ? { file, line: ln } : null, raw: line.slice(0, 4000),
      });
    }
    pos += len;
  }
  return out;
}

/** Fingerprint used for grouping (numbers and quoted values are ignored). PURE. */
function fingerprint(e) {
  const msg = String(e.exception ? e.exception.message : e.message).replace(/\d+/g, '#').replace(/'[^']*'|"[^"]*"/g, '?').slice(0, 300);
  return [e.source, e.level, e.exception ? e.exception.class : '', e.where ? `${e.where.file}:${e.where.line}` : '', msg].join('|');
}

/** Entries (newest first) -> groups [{key, count, first, last(entry), newCount}]. PURE. */
function groupEntries(entries, isNew = () => false) {
  const map = new Map();
  for (const e of entries) {
    const k = fingerprint(e);
    let g = map.get(k);
    if (!g) { g = { key: k, count: 0, newCount: 0, last: e, firstTime: e.time, lastTime: e.time }; map.set(k, g); }
    g.count++;
    if (isNew(e)) g.newCount++;
    g.firstTime = e.time;
  }
  return [...map.values()];
}

function readTail(file, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    let base = start;
    if (start > 0) {
      // skip the (probably partial) first line
      const nl = text.indexOf('\n');
      base += Buffer.byteLength(text.slice(0, nl + 1), 'utf8');
      text = text.slice(nl + 1);
    }
    return { text, base, size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** storage\logs\*.log of a project, newest first (at most 3). */
function laravelLogFiles(dir) {
  const logs = path.join(dir, 'storage', 'logs');
  return util.listFileNames(logs).filter((n) => /\.log$/i.test(n))
    .map((n) => { const f = path.join(logs, n); try { return { file: f, mtime: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 3).map((x) => x.file);
}

function seenOf(ctx, projectId) {
  const all = ctx.store.data.logSeen && typeof ctx.store.data.logSeen === 'object' ? ctx.store.data.logSeen : {};
  return all[projectId] && typeof all[projectId] === 'object' ? all[projectId] : {};
}

/** All entries of a project (newest first) with `isNew`. Cached per file by size + mtime. */
function entriesOf(ctx, p) {
  const cache = ctx.logCache || (ctx.logCache = new Map());
  const files = [...laravelLogFiles(p.path).map((f) => ({ f, kind: 'laravel' })), { f: phpLogFile(ctx, p.id), kind: 'php' }];
  const seen = seenOf(ctx, p.id);
  const all = [];
  for (const { f, kind } of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const key = `${f}|${st.size}|${st.mtimeMs}`;
    let entries = cache.get(f);
    if (!entries || entries.key !== key) {
      const t = readTail(f);
      if (!t) continue;
      entries = { key, list: kind === 'laravel' ? parseLaravelLog(t.text, t.base) : parsePhpLog(t.text, t.base) };
      cache.set(f, entries);
    }
    const mark = seen[f];
    for (const e of entries.list) {
      all.push(Object.assign({ file: f, isNew: !(mark && typeof mark.pos === 'number' && mark.size <= st.size && e.offset < mark.pos) }, e));
    }
  }
  // newest first: by time when both have one, else by position in the same file
  all.sort((a, b) => (a.ts != null && b.ts != null && a.ts !== b.ts ? b.ts - a.ts : a.file === b.file ? b.offset - a.offset : 0));
  return all.slice(0, MAX_ENTRIES);
}

const LEVEL_FILTERS = { errors: (e) => BAD_LEVELS.has(e.level), warnings: (e) => e.level === 'WARNING', all: () => true };

/** GET /api/projects/:id/errors -> {groups, counts, files, isLaravel}. */
function list(ctx, projectId, { level = 'errors', q = null } = {}) {
  const p = projects.getProject(ctx, projectId);
  const all = entriesOf(ctx, p);
  const filter = LEVEL_FILTERS[level] || LEVEL_FILTERS.errors;
  const needle = q ? String(q).toLowerCase().slice(0, 100) : null;
  const shown = all.filter((e) => filter(e) && (!needle || `${e.message} ${e.exception ? `${e.exception.class} ${e.exception.message}` : ''} ${e.where ? e.where.file : ''}`.toLowerCase().includes(needle)));
  const groups = groupEntries(shown, (e) => e.isNew).slice(0, 300).map((g) => ({
    key: g.key, count: g.count, newCount: g.newCount, firstTime: g.firstTime, lastTime: g.lastTime,
    entry: Object.assign({}, g.last, { raw: undefined, rawSize: g.last.raw ? g.last.raw.length : 0 }),
    raw: g.last.raw,
  }));
  return {
    groups,
    counts: { errors: all.filter(LEVEL_FILTERS.errors).length, warnings: all.filter(LEVEL_FILTERS.warnings).length, all: all.length, newErrors: all.filter((e) => e.isNew && BAD_LEVELS.has(e.level)).length },
    files: [...new Set(all.map((e) => e.file))],
    logDir: path.join(p.path, 'storage', 'logs'),
  };
}

/** New error count of a project (for badges). */
function newErrorCount(ctx, p) {
  try { return entriesOf(ctx, p).filter((e) => e.isNew && BAD_LEVELS.has(e.level)).length; } catch { return 0; }
}

/** Everything up to now counts as seen (log files are not changed). */
function markSeen(ctx, projectId) {
  const p = projects.getProject(ctx, projectId);
  const marks = {};
  const files = [...laravelLogFiles(p.path), phpLogFile(ctx, p.id)];
  for (const f of files) {
    try { const st = fs.statSync(f); marks[f] = { pos: st.size, size: st.size }; } catch { /* missing */ }
  }
  if (!ctx.store.data.logSeen || typeof ctx.store.data.logSeen !== 'object') ctx.store.data.logSeen = {};
  ctx.store.data.logSeen[p.id] = marks;
  ctx.store.save();
  return {};
}

module.exports = { timeOf, parseFrame, parseEntryBody, parseLaravelLog, parsePhpLog, fingerprint, groupEntries, list, newErrorCount, markSeen, laravelLogFiles, BAD_LEVELS };
