'use strict';
/*
 * Shared helpers: errors, Windows path handling, user-path validation, files, logging,
 * child processes (always argument arrays, never a shell) and a tiny HTTP client for the CLI.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { tr } = require('./i18n');

const win = path.win32;

const MB = 1024 * 1024;

/** Error that maps to a JSON API response {ok:false, code, error} with an HTTP status. */
class AppError extends Error {
  constructor(code, message, status = 400, extra) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (extra !== undefined) this.extra = extra;
  }
}

// ------------------------------------------------------------------------------------------ paths

function toWinPath(p) {
  return String(p == null ? '' : p).replace(/\//g, '\\');
}

/** Display form of a path: backslashes, normalised, no trailing separator (except "C:\"). */
function cleanPath(p) {
  if (p == null || p === '') return '';
  let s = toWinPath(String(p).trim());
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  try { s = win.normalize(s); } catch { /* keep as is */ }
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

/** Comparison key for a path: cleanPath + lower case + no trailing separator at all. */
function normPath(p) {
  let s = cleanPath(p);
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s.toLowerCase();
}

function samePath(a, b) {
  const x = normPath(a);
  return x !== '' && x === normPath(b);
}

/** True when `child` is strictly inside folder `parent`. */
function isInside(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return c !== '' && p !== '' && c.startsWith(p + '\\');
}

function isAbsWin(p) {
  return /^[A-Za-z]:[\\/]/.test(String(p || '')) || /^\\\\[^\\]/.test(String(p || ''));
}

const FORBIDDEN_PATH_CHARS = /["%!^&|<>\r\n]/;

/**
 * Validates a path typed or picked in the UI (spec §4): absolute Windows path, no shell
 * meta characters, shorter than 240, and (by default) existing with the expected kind.
 */
function checkUserPath(input, { kind = 'any', mustExist = true, label = null } = {}) {
  if (!label) label = tr('label.path');
  if (typeof input !== 'string' || !input.trim()) {
    throw new AppError('BAD_PATH', tr('path.empty', { label }));
  }
  let p = input.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"') && p.indexOf('"', 1) === p.length - 1) p = p.slice(1, -1).trim();
  if (FORBIDDEN_PATH_CHARS.test(p)) {
    throw new AppError('BAD_PATH', tr('path.badChars', { label }));
  }
  p = toWinPath(p);
  if (!/^[A-Za-z]:\\/.test(p)) {
    throw new AppError('BAD_PATH', tr('path.notAbsolute', { label }));
  }
  p = cleanPath(p);
  if (p.length >= 240) throw new AppError('BAD_PATH', tr('path.tooLong', { label }));
  if (mustExist) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      throw new AppError('PATH_NOT_FOUND', tr('path.notFound', { label, path: p }), 404);
    }
    if (kind === 'dir' && !st.isDirectory()) throw new AppError('NOT_A_FOLDER', tr('path.notFolder', { path: p }));
    if (kind === 'file' && !st.isFile()) throw new AppError('NOT_A_FILE', tr('path.notFile', { path: p }));
  }
  return p;
}

/** True when a path we generated ourselves is safe to embed in .bat/.cmd text and cmd.exe lines. */
function isCmdSafePath(p) {
  return typeof p === 'string' && p.length > 0 && !/["%!^&|<>()\r\n]/.test(p);
}

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && existsDir(path.join(dir, e.name))))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFileNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------------------------------ misc

function hash6(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function slugify(s, fallback = 'project') {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return out || fallback;
}

/** YYYYMMDD-HHMMSS in local time (used in backup and dump file names). */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function firstLine(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[0] : '';
}

function isLocalHost(h) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(h || '').trim().toLowerCase());
}

function fmtMB(bytes) {
  return `${(Number(bytes || 0) / MB).toFixed(1)} MB`;
}

/** Strips control characters and trims; returns '' for non-strings. */
function cleanText(s, max = 200) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Runs fn over items with at most `limit` promises in flight; keeps result order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// ------------------------------------------------------------------------------------------ files

function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return fallback;
  }
}

function readJson(file, fallback = null) {
  const t = readText(file, null);
  if (t == null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

/** Writes via a temp file + rename so readers never see a half-written file. */
function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomHex(3)}.tmp`;
  fs.writeFileSync(tmp, data);
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      sleepSync(25 + i * 10);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw lastErr;
}

function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

/** Last `lines` lines of a text file (reads at most maxBytes from the end). */
function tailFile(file, lines = 200, maxBytes = 512 * 1024) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const size = st.size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    if (len > 0) fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.replace(/^[^\n]*\n/, '');
    const arr = text.replace(/\r\n/g, '\n').split('\n');
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    const n = Math.max(1, Math.min(Number(lines) || 200, 5000));
    return { exists: true, size, text: arr.slice(-n).join('\n') };
  } catch {
    return { exists: false, size: 0, text: '' };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Renames file to file.1 when it is larger than maxBytes (the old .1 is replaced). */
function rotateIfLarge(file, maxBytes = 5 * MB) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return false;
    try { fs.unlinkSync(`${file}.1`); } catch { /* ignore */ }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** Panel logger: appends timestamped lines, rotates at 5 MB. Never pass secrets to it. */
function createLogger(file) {
  let count = 0;
  ensureDir(path.dirname(file));
  const log = (...parts) => {
    const text = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    try {
      if (count++ % 50 === 0) rotateIfLarge(file, 5 * MB);
      fs.appendFileSync(file, `${nowIso()} [${process.pid}] ${text}\r\n`);
    } catch { /* logging must never crash the panel */ }
  };
  log.file = file;
  return log;
}

// ------------------------------------------------------------------------------------------ child processes

/**
 * Copy of process.env for child processes: removes keys case-insensitively, prepends PATH
 * entries (keeping the original spelling of the PATH key) and sets extra values.
 */
function cleanEnv({ prependPath = [], remove = ['PHPRC', 'PHP_INI_SCAN_DIR'], set = {} } = {}) {
  const env = {};
  const removeSet = new Set(remove.map((k) => k.toUpperCase()));
  const setKeys = new Set(Object.keys(set).map((k) => k.toUpperCase()));
  let pathKey = 'Path';
  let pathVal = '';
  for (const [k, v] of Object.entries(process.env)) {
    const up = k.toUpperCase();
    if (up === 'PATH') { pathKey = k; pathVal = v || ''; continue; }
    if (removeSet.has(up) || setKeys.has(up)) continue;
    env[k] = v;
  }
  const pre = prependPath.filter((p) => typeof p === 'string' && p.trim()).map((p) => cleanPath(p));
  env[pathKey] = pre.length ? `${pre.join(';')};${pathVal}` : pathVal;
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || v === null) continue;
    env[k] = String(v);
  }
  return env;
}

function validPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 4 && n !== process.pid ? n : null;
}

/** taskkill /PID <pid> /T /F — only ever called for PIDs the caller verified. */
function taskkillTree(pid) {
  const n = validPid(pid);
  if (!n) return Promise.resolve({ ok: false, output: 'invalid pid' });
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(n), '/T', '/F'], { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

/** Human text for a failed child (missing program, missing DLL, crash code). */
function describeExit(r, file) {
  if (r.error) return r.error;
  if (r.timedOut) return tr('exit.timeout', { file: path.basename(file || '') });
  const code = r.code;
  if (code === 3221225781 || code === -1073741515) return tr('exit.dll', { file });
  if (code === 3221225477 || code === -1073741819) return tr('exit.crash', { file });
  if (code === 3221225595 || code === -1073741701) return tr('exit.bitness', { file });
  if (typeof code === 'number' && code > 0xffff) return tr('exit.failCode', { hex: (code >>> 0).toString(16).toUpperCase(), file });
  return `exit code ${code}`;
}

/**
 * Runs a program (no shell) and collects its output.
 * opts: cwd, env, input (string|Buffer for stdin), inputFile (stream into stdin), outputFile
 * (stdout streamed to this file), timeoutMs (0 = none), maxCapture, onStdout(chunk),
 * onStderr(chunk), onInputBytes(n) (bytes of inputFile handed to the child so far, per chunk).
 * Never rejects: returns {code, signal, stdout, stderr, timedOut, error, pid}.
 */
function run(file, args, opts = {}) {
  const { cwd, env, input, inputFile, outputFile, timeoutMs = 60000, maxCapture = 8 * MB, onStdout, onStderr, onInputBytes } = opts;
  return new Promise((resolve) => {
    const res = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: null, pid: null };
    let child;
    try {
      child = spawn(file, args, { cwd, env: env || process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      res.error = e.message;
      res.code = -1;
      resolve(res);
      return;
    }
    res.pid = child.pid || null;
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let outStream = null;
    let outDone = Promise.resolve();
    let timer = null;
    let settled = false;

    child.on('error', (e) => {
      res.error = e.code === 'ENOENT' ? tr('run.notFound', { file }) : e.message;
    });

    if (outputFile) {
      outStream = fs.createWriteStream(outputFile);
      outDone = new Promise((r) => {
        outStream.on('close', r);
        outStream.on('error', (e) => { res.error = res.error || tr('run.writeFail', { message: e.message }); r(); });
      });
      child.stdout.pipe(outStream);
    } else {
      child.stdout.on('data', (d) => {
        if (onStdout) { try { onStdout(d); } catch { /* ignore */ } }
        if (outLen < maxCapture) { outChunks.push(d); outLen += d.length; }
      });
    }
    child.stderr.on('data', (d) => {
      if (onStderr) { try { onStderr(d); } catch { /* ignore */ } }
      if (errLen < maxCapture) { errChunks.push(d); errLen += d.length; }
    });

    child.stdin.on('error', () => { /* EPIPE when the child exits early */ });
    if (inputFile) {
      const rs = fs.createReadStream(inputFile);
      if (onInputBytes) rs.on('data', (d) => { try { onInputBytes(d.length); } catch { /* ignore */ } });
      rs.on('error', (e) => { res.error = res.error || tr('run.readFail', { message: e.message }); try { child.stdin.end(); } catch { /* ignore */ } });
      rs.pipe(child.stdin);
    } else if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        res.timedOut = true;
        if (child.pid) taskkillTree(child.pid);
        else try { child.kill(); } catch { /* ignore */ }
      }, timeoutMs);
    }

    child.on('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      await outDone;
      res.code = code;
      res.signal = signal;
      res.stdout = Buffer.concat(outChunks).toString('utf8');
      res.stderr = Buffer.concat(errChunks).toString('utf8');
      if (res.code === null && res.error) res.code = -1;
      resolve(res);
    });
  });
}

// ------------------------------------------------------------------------------------------ http client (CLI)

/** Small JSON HTTP client against 127.0.0.1 (used by --launch/--stop and the single-instance check). */
function httpJson({ port, method = 'GET', urlPath = '/', token = null, body = undefined, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Host: `127.0.0.1:${port}`, Accept: 'application/json' };
    if (token) headers['X-DevPanel-Token'] = token;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(data.length);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  AppError,
  MB,
  win,
  toWinPath,
  cleanPath,
  normPath,
  samePath,
  isInside,
  isAbsWin,
  checkUserPath,
  isCmdSafePath,
  existsFile,
  existsDir,
  listDirNames,
  listFileNames,
  ensureDir,
  hash6,
  randomHex,
  slugify,
  stamp,
  nowIso,
  sleep,
  sleepSync,
  firstLine,
  isLocalHost,
  fmtMB,
  cleanText,
  mapLimit,
  readText,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  tailFile,
  rotateIfLarge,
  createLogger,
  cleanEnv,
  validPid,
  taskkillTree,
  describeExit,
  run,
  httpJson,
};
