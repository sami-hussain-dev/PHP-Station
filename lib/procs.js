'use strict';
/*
 * Process table, listening ports, killing, detached spawning and the persistent PowerShell
 * helper. parseNetstat, splitCommandLine and deriveExternalPhpServers are PURE.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const util = require('./util');
const { tr } = require('./i18n');

// ------------------------------------------------------------------------------------------ PowerShell helper

// Shared PowerShell code. Output is forced to ASCII (\uXXXX escapes) so the pipe encoding can
// never corrupt the JSON. cmd.exe is listed because "artisan serve" starts "php -S" through a
// "cmd.exe /V:ON /E:ON /D /C (...)" wrapper (Symfony Process) and the parent chain must be walked.
const PS_COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
function DP-Ascii([string]$s) {
  return [regex]::Replace($s, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}
function DP-Procs {
  $f = "Name='php.exe' OR Name='php-cgi.exe' OR Name='mysqld.exe' OR Name='mariadbd.exe' OR Name='node.exe' OR Name='cmd.exe'"
  $list = @(Get-CimInstance -ClassName Win32_Process -Filter $f | ForEach-Object {
    [pscustomobject]@{
      ProcessId = [int]$_.ProcessId
      ParentProcessId = [int]$_.ParentProcessId
      Name = [string]$_.Name
      CommandLine = $_.CommandLine
      ExecutablePath = $_.ExecutablePath
    }
  })
  return (ConvertTo-Json -InputObject $list -Compress -Depth 3)
}
function DP-Event([string]$id) {
  try {
    $ev = [System.Threading.EventWaitHandle]::OpenExisting('MySQLShutdown' + $id)
    try { [void]$ev.Set() } finally { $ev.Dispose() }
    return '{"ok":true}'
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    return (ConvertTo-Json -InputObject @{ ok = $false; error = [string]$e.Message } -Compress)
  }
}
function DP-Run([string]$line) {
  try {
    if ($line -eq 'procs') { return (DP-Procs) }
    if ($line -match '^event (\d{1,10})$') { return (DP-Event $Matches[1]) }
    if ($line -eq 'ping') { return '{"ok":true,"pong":true}' }
    return '{"ok":false,"error":"unknown command"}'
  } catch {
    return (ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message } -Compress)
  }
}
`;

const PS_LOOP = String.raw`
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'exit') { break }
  $out = DP-Run $line
  [Console]::Out.WriteLine((DP-Ascii $out))
  [Console]::Out.Flush()
}
`;

function encodedArgs(script, { sta = false } = {}) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (sta) args.push('-STA');
  args.push('-EncodedCommand', enc);
  return args;
}

const helper = {
  proc: null,
  buf: '',
  queue: [],
  current: null,
  failures: 0,
  fallbackSince: 0,
  freshStart: false,
  stopped: false,
};

function validHelperCommand(cmd) {
  return cmd === 'procs' || cmd === 'ping' || /^event \d{1,10}$/.test(cmd);
}

function startHelper() {
  helper.buf = '';
  helper.freshStart = true;
  let p;
  try {
    p = spawn('powershell.exe', encodedArgs(PS_COMMON + PS_LOOP), {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: util.cleanEnv({ remove: [] }),
    });
  } catch (e) {
    helper.proc = null;
    return false;
  }
  helper.proc = p;
  p.stdout.on('data', (d) => {
    if (helper.proc !== p) return;
    helper.buf += d.toString('utf8');
    let i;
    while ((i = helper.buf.indexOf('\n')) >= 0) {
      const line = helper.buf.slice(0, i).trim();
      helper.buf = helper.buf.slice(i + 1);
      if (line) onHelperLine(line);
    }
  });
  p.stderr.on('data', () => { /* progress/CLIXML noise is ignored */ });
  p.stdin.on('error', () => { /* helper died; handled by exit */ });
  p.on('error', () => {
    if (helper.proc === p) helperFailed(new Error(tr('ps.helperStartFailed')));
  });
  p.on('exit', () => {
    if (helper.proc === p) helperFailed(new Error(tr('ps.helperExited')));
  });
  return true;
}

function killHelperProc() {
  const p = helper.proc;
  helper.proc = null;
  if (p) {
    try { p.stdin.end(); } catch { /* ignore */ }
    try { p.kill(); } catch { /* ignore */ }
  }
}

function helperFailed(err) {
  helper.failures++;
  killHelperProc();
  const item = helper.current;
  helper.current = null;
  if (item) {
    clearTimeout(item.timer);
    item.reject(err);
  }
  setImmediate(pump);
}

function onHelperLine(line) {
  const item = helper.current;
  if (!item) return;
  clearTimeout(item.timer);
  helper.current = null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    helper.failures++;
    killHelperProc();
    item.reject(new Error(tr('ps.helperBadReply')));
    setImmediate(pump);
    return;
  }
  helper.failures = 0;
  helper.freshStart = false;
  item.resolve(parsed);
  setImmediate(pump);
}

/** One-shot PowerShell run of an arbitrary script; parses the last JSON line of stdout. */
function psOneShot(script, { sta = false, env = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', encodedArgs(PS_COMMON + script, { sta }), {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env || util.cleanEnv({ remove: [] }),
      });
    } catch (e) {
      resolve({ ok: false, error: e.message, json: null });
      return;
    }
    const out = [];
    const err = [];
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, json: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let json = null;
      for (let i = lines.length - 1; i >= 0 && json === null; i--) {
        try { json = JSON.parse(lines[i]); } catch { /* keep looking */ }
      }
      resolve({ ok: json !== null, code, json, stdout: text, stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

function oneShotCommand(cmd) {
  return psOneShot(`[Console]::Out.WriteLine((DP-Ascii (DP-Run '${cmd}')))`, { timeoutMs: 25000 }).then((r) => {
    if (r.json === null) throw new Error(tr('ps.noReply'));
    return r.json;
  });
}

function pump() {
  if (helper.current || !helper.queue.length || helper.stopped) return;
  const item = helper.queue.shift();
  // Two consecutive failures -> one-shot PowerShell for a minute, then try the helper again.
  if (helper.failures >= 2) {
    if (!helper.fallbackSince) helper.fallbackSince = Date.now();
    if (Date.now() - helper.fallbackSince < 60000) {
      helper.current = item;
      oneShotCommand(item.cmd).then(
        (r) => { helper.current = null; item.resolve(r); setImmediate(pump); },
        (e) => { helper.current = null; item.reject(e); setImmediate(pump); },
      );
      return;
    }
    helper.failures = 0;
    helper.fallbackSince = 0;
  }
  if (!helper.proc && !startHelper()) {
    helper.failures++;
    item.reject(new Error(tr('ps.startFailed')));
    setImmediate(pump);
    return;
  }
  helper.current = item;
  const timeoutMs = item.timeoutMs + (helper.freshStart ? 15000 : 0);
  item.timer = setTimeout(() => {
    if (helper.current === item) helperFailed(new Error(tr('ps.helperTimeout')));
  }, timeoutMs);
  try {
    helper.proc.stdin.write(`${item.cmd}\n`);
  } catch (e) {
    helperFailed(e);
  }
}

function psRequest(cmd, timeoutMs = 10000) {
  if (!validHelperCommand(cmd)) return Promise.reject(new Error('invalid helper command'));
  helper.stopped = false;
  return new Promise((resolve, reject) => {
    helper.queue.push({ cmd, timeoutMs, resolve, reject, timer: null });
    pump();
  });
}

/** Ends the helper (panel shutdown). */
function stopHelper() {
  helper.stopped = true;
  const p = helper.proc;
  helper.proc = null;
  for (const item of helper.queue.splice(0)) item.reject(new Error(tr('ps.panelStopping')));
  if (helper.current) {
    clearTimeout(helper.current.timer);
    helper.current.reject(new Error(tr('ps.panelStopping')));
    helper.current = null;
  }
  if (p) {
    try { p.stdin.write('exit\n'); p.stdin.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 1500);
    if (t.unref) t.unref();
  }
}

// ------------------------------------------------------------------------------------------ process table

let procCache = { at: 0, list: null, pending: null };

/** Cached [{pid, ppid, name (lower case), cmd|null, exe|null}] for php/mysqld/mariadbd/node/cmd. */
function listProcesses({ maxAgeMs = 1500 } = {}) {
  if (procCache.list && Date.now() - procCache.at <= maxAgeMs) return Promise.resolve(procCache.list);
  if (procCache.pending) return procCache.pending;
  const pending = (async () => {
    try {
      const raw = await psRequest('procs', 10000);
      let arr;
      if (Array.isArray(raw)) arr = raw;
      else if (raw && raw.ok === false) throw new Error(raw.error || tr('ps.noProcessList'));
      else arr = raw ? [raw] : [];
      const list = arr.map((p) => ({
        pid: Number(p.ProcessId),
        ppid: Number(p.ParentProcessId),
        name: String(p.Name || '').toLowerCase(),
        cmd: p.CommandLine || null,
        exe: p.ExecutablePath || null,
      }));
      procCache = { at: Date.now(), list, pending: null };
      return list;
    } catch (e) {
      procCache.pending = null;
      if (procCache.list) return procCache.list;
      throw e;
    }
  })();
  procCache.pending = pending;
  return pending;
}

// ------------------------------------------------------------------------------------------ netstat

/** LISTENING TCP sockets from `netstat -ano` text: [{proto, address, port, pid}] (IPv4 and IPv6). */
function parseNetstat(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const proto = parts[0];
    if (!/^tcp(v6)?$/i.test(proto)) continue;
    const local = parts[1];
    const foreign = parts[2];
    const state = parts[3];
    const pid = Number(parts[parts.length - 1]);
    const listening = /^listen/i.test(state) || /^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(foreign);
    if (!listening || !Number.isInteger(pid)) continue;
    const idx = local.lastIndexOf(':');
    if (idx <= 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    let address = local.slice(0, idx);
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    const pctIdx = address.indexOf('%');
    if (pctIdx > 0) address = address.slice(0, pctIdx);
    out.push({ proto: proto.toUpperCase(), address, port, pid });
  }
  return out;
}

let listenCache = { at: 0, list: null, pending: null };

/** Cached parseNetstat(netstat.exe -ano). */
function listListeners({ maxAgeMs = 1500 } = {}) {
  if (listenCache.list && Date.now() - listenCache.at <= maxAgeMs) return Promise.resolve(listenCache.list);
  if (listenCache.pending) return listenCache.pending;
  const pending = new Promise((resolve, reject) => {
    execFile('netstat.exe', ['-ano'], { windowsHide: true, timeout: 15000, maxBuffer: 32 * util.MB }, (err, stdout) => {
      if (err && !stdout) {
        listenCache.pending = null;
        if (listenCache.list) resolve(listenCache.list);
        else reject(new Error(tr('ps.netstatFailed', { message: err.message })));
        return;
      }
      const list = parseNetstat(stdout);
      listenCache = { at: Date.now(), list, pending: null };
      resolve(list);
    });
  });
  listenCache.pending = pending;
  return pending;
}

// ------------------------------------------------------------------------------------------ command lines

/** argv from a Windows command line using the MSVCRT rules (quotes, backslashes before quotes). */
function splitCommandLine(cmd) {
  const s = String(cmd == null ? '' : cmd);
  const args = [];
  let i = 0;
  const n = s.length;
  while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i >= n) return args;

  // argv[0]: quotes toggle, backslashes are literal (program names never contain quotes).
  let a0 = '';
  if (s[i] === '"') {
    i++;
    while (i < n && s[i] !== '"') a0 += s[i++];
    if (i < n) i++;
  }
  while (i < n && s[i] !== ' ' && s[i] !== '\t') {
    if (s[i] === '"') { i++; continue; }
    a0 += s[i++];
  }
  args.push(a0);

  for (;;) {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) break;
    let arg = '';
    let inQuotes = false;
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        let bs = 0;
        while (i < n && s[i] === '\\') { bs++; i++; }
        if (i < n && s[i] === '"') {
          arg += '\\'.repeat(Math.floor(bs / 2));
          if (bs % 2 === 1) { arg += '"'; i++; }
        } else {
          arg += '\\'.repeat(bs);
        }
        continue;
      }
      if (c === '"') {
        if (inQuotes && s[i + 1] === '"') { arg += '"'; i += 2; continue; }
        inQuotes = !inQuotes;
        i++;
        continue;
      }
      if (!inQuotes && (c === ' ' || c === '\t')) break;
      arg += c;
      i++;
    }
    args.push(arg);
  }
  return args;
}

const VENDOR_ROUTER_RE = /[\\/]vendor[\\/]laravel[\\/]framework[\\/]src[\\/]Illuminate[\\/]Foundation[\\/]resources[\\/]server\.php$/i;
const PHP_VALUE_OPTIONS = new Set(['-t', '-c', '-d', '-z']);

function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function dirName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : s;
}

function parseHostPort(v) {
  const s = String(v || '').trim();
  const m = /^\[?([^\]]*?)\]?:(\d{1,5})$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[1] || '127.0.0.1', port };
}

/** Parses the php CLI arguments of a "php -S" server; null when there is no -S. */
function parsePhpServerArgs(argv) {
  let sIdx = -1;
  let addr = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-S') { sIdx = i; addr = argv[i + 1] || null; break; }
    if (a.startsWith('-S') && a.length > 2 && !a.startsWith('-S=')) { sIdx = i; addr = a.slice(2); break; }
  }
  if (sIdx < 0) return null;
  let docroot = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-t' && i + 1 < argv.length) { docroot = argv[i + 1]; i++; continue; }
    if (a.startsWith('-t') && a.length > 2 && a !== '-t') docroot = a.slice(2);
  }
  let router = null;
  const start = argv[sIdx] === '-S' ? sIdx + 2 : sIdx + 1;
  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (PHP_VALUE_OPTIONS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (/\.php$/i.test(a)) { router = a; break; }
  }
  return { addr, router, docroot };
}

function hasArg(argv, pred) {
  for (let i = 1; i < argv.length; i++) if (pred(argv[i])) return true;
  return false;
}

/** 'artisan serve' | 'kit serve' | null for a php.exe wrapper process. */
function wrapperKind(proc) {
  if (!proc || proc.name !== 'php.exe' || !proc.cmd) return null;
  const argv = splitCommandLine(proc.cmd);
  const serve = hasArg(argv, (a) => a.toLowerCase() === 'serve');
  if (!serve) return null;
  if (hasArg(argv, (a) => baseName(a).toLowerCase() === 'kit.php')) return 'kit serve';
  if (hasArg(argv, (a) => baseName(a).toLowerCase() === 'artisan')) return 'artisan serve';
  return null;
}

/**
 * php.exe "-S" dev servers from the process table:
 * [{pid, topPid, host, port, phpPath, router|null, docroot|null, projectPath|null, via, listening}]
 * topPid is the top-most artisan/kit "serve" ancestor (through the cmd.exe wrapper that
 * Symfony Process puts in between), via says which one it is.
 */
function deriveExternalPhpServers(processes, listeners) {
  const procs = Array.isArray(processes) ? processes : [];
  const byPid = new Map(procs.map((p) => [Number(p.pid), p]));
  const portsByPid = new Map();
  for (const l of Array.isArray(listeners) ? listeners : []) {
    if (!portsByPid.has(l.pid)) portsByPid.set(l.pid, new Set());
    portsByPid.get(l.pid).add(l.port);
  }
  const out = [];
  for (const proc of procs) {
    const name = String(proc.name || '').toLowerCase();
    if (name !== 'php.exe' || !proc.cmd) continue;
    const argv = splitCommandLine(proc.cmd);
    const parsed = parsePhpServerArgs(argv);
    if (!parsed) continue;
    let hp = parseHostPort(parsed.addr);
    const pidPorts = portsByPid.get(Number(proc.pid));
    if (!hp && pidPorts && pidPorts.size) hp = { host: '127.0.0.1', port: [...pidPorts][0] };
    if (!hp) continue;

    const router = parsed.router;
    const docroot = parsed.docroot;
    let projectPath = null;
    if (router && VENDOR_ROUTER_RE.test(router)) {
      projectPath = router.replace(VENDOR_ROUTER_RE, '');
    } else if (router && baseName(router).toLowerCase() === 'server.php') {
      projectPath = dirName(router);
    } else if (docroot) {
      projectPath = baseName(docroot).toLowerCase() === 'public' ? dirName(docroot) : docroot.replace(/[\\/]+$/, '');
    }

    // Walk up: php -S <- [cmd.exe wrapper] <- php artisan serve <- [cmd.exe] <- php kit.php serve
    let topPid = Number(proc.pid);
    let via = 'php -S';
    let cur = proc;
    const seen = new Set([topPid]);
    for (let depth = 0; depth < 12; depth++) {
      let parent = byPid.get(Number(cur.ppid));
      if (!parent || seen.has(Number(parent.pid))) break;
      if (String(parent.name || '').toLowerCase() === 'cmd.exe') {
        const grand = byPid.get(Number(parent.ppid));
        if (!grand || seen.has(Number(grand.pid)) || !wrapperKind(grand)) break;
        seen.add(Number(parent.pid));
        parent = grand;
      }
      const kind = wrapperKind(parent);
      if (!kind) break;
      seen.add(Number(parent.pid));
      topPid = Number(parent.pid);
      via = kind;
      cur = parent;
    }

    out.push({
      pid: Number(proc.pid),
      topPid,
      host: hp.host,
      port: hp.port,
      phpPath: proc.exe || argv[0] || null,
      router: router || null,
      docroot: docroot || null,
      projectPath: projectPath || null,
      via,
      listening: !!(pidPorts && pidPorts.has(hp.port)),
    });
  }
  out.sort((a, b) => a.port - b.port || a.pid - b.pid);
  return out;
}

/** The --defaults-file value from a mysqld command line, or null. */
function defaultsFileFromCmd(cmd) {
  if (!cmd) return null;
  for (const a of splitCommandLine(cmd).slice(1)) {
    const m = /^--defaults-file=(.+)$/i.exec(a);
    if (m) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

// ------------------------------------------------------------------------------------------ actions

/** taskkill /PID <pid> /T /F -> {ok, output}. Callers must verify the pid first. */
function killTree(pid) {
  return util.taskkillTree(pid);
}

/**
 * Starts a program that keeps running after the panel exits. stdout/stderr are appended to
 * logFile. Returns the pid (undefined when Windows could not start it).
 */
function spawnDetached(file, args, { cwd, env, logFile } = {}) {
  util.ensureDir(path.dirname(logFile));
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(file, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: env || process.env,
      cwd,
      shell: false,
    });
    child.once('error', (e) => {
      try { fs.appendFileSync(logFile, `${tr('ps.spawnFailedLog', { message: e.message })}\r\n`); } catch { /* ignore */ }
    });
    child.unref();
    return child.pid;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Existence check for a pid the panel started itself (no process table round trip). */
function pidExists(pid) {
  const n = util.validPid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** pid present in the (fresh) process table and, if given, expect(proc) is true. */
async function isAlive(pid, expect, { maxAgeMs = 500 } = {}) {
  const list = await listProcesses({ maxAgeMs });
  const proc = list.find((p) => p.pid === Number(pid));
  if (!proc) return false;
  return expect ? !!expect(proc) : true;
}

/** Sets the MariaDB named event MySQLShutdown<pid> (clean shutdown) -> {ok, error?}. */
async function signalShutdownEvent(pid) {
  const s = String(pid);
  if (!/^\d{1,10}$/.test(s) || !util.validPid(pid)) return { ok: false, error: 'invalid pid' };
  try {
    const r = await psRequest(`event ${s}`, 10000);
    if (r && r.ok === true) return { ok: true };
    return { ok: false, error: (r && r.error) || tr('ps.eventNotSet') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** {ok, procs, listeners, externals} using the caches (fresh: force new tables). */
async function getSnapshot({ fresh = false } = {}) {
  const maxAgeMs = fresh ? 0 : 1500;
  try {
    const [procs, listeners] = await Promise.all([listProcesses({ maxAgeMs }), listListeners({ maxAgeMs })]);
    return { ok: true, procs, listeners, externals: deriveExternalPhpServers(procs, listeners) };
  } catch (e) {
    let listeners = [];
    try { listeners = await listListeners({ maxAgeMs }); } catch { /* ignore */ }
    return { ok: false, error: e.message, procs: [], listeners, externals: [] };
  }
}

/** Forgets cached tables (after starting/stopping something). */
function invalidateCaches() {
  procCache = { at: 0, list: procCache.list, pending: procCache.pending };
  listenCache = { at: 0, list: listenCache.list, pending: listenCache.pending };
}

module.exports = {
  // pure
  parseNetstat,
  splitCommandLine,
  deriveExternalPhpServers,
  defaultsFileFromCmd,
  parseHostPort,
  wrapperKind,
  // impure
  listProcesses,
  listListeners,
  killTree,
  spawnDetached,
  isAlive,
  pidExists,
  signalShutdownEvent,
  stopHelper,
  psRequest,
  psOneShot,
  getSnapshot,
  invalidateCaches,
};
