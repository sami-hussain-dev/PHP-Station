'use strict';
/*
 * Shutdown guard: keeps tools\guard.cs (compiled once into <data>\bin\PHPStationGuard.exe with the
 * .NET Framework csc.exe that ships with Windows) running, and tells it which DB server pids to
 * stop cleanly when Windows shuts down / restarts / signs out (<data>\guard\dbs.txt).
 * The guard outlives the panel on purpose: DB servers keep running when the panel is closed.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const procs = require('./procs');
const { tr } = require('./i18n');

const { AppError } = util;
const TOOL_DIR = path.resolve(__dirname, '..');
const SOURCE = path.join(TOOL_DIR, 'tools', 'guard.cs');
const EXE_NAME = 'PHPStationGuard.exe';
// guards built by older versions (same mutex / quit event, so they are stopped and replaced)
const LEGACY_NAMES = ['DevPanelGuard.exe'];
const CSC_CANDIDATES = [
  path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

function exePath(ctx) {
  return path.join(ctx.dataDir, 'bin', EXE_NAME);
}
function listFile(ctx) {
  return path.join(ctx.dataDir, 'guard', 'dbs.txt');
}

function mtime(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

/** Compiles the guard when the exe is missing or older than its source. */
async function ensureBuilt(ctx) {
  const exe = exePath(ctx);
  if (util.existsFile(exe) && mtime(exe) >= mtime(SOURCE)) return exe;
  const csc = CSC_CANDIDATES.find((f) => util.existsFile(f));
  if (!csc) throw new AppError('NO_CSC', tr('guard.noCsc'), 500);
  util.ensureDir(path.dirname(exe));
  const tmp = `${exe}.${util.randomHex(3)}.tmp.exe`;
  const r = await util.run(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${tmp}`, '/r:System.Windows.Forms.dll', SOURCE],
    { timeoutMs: 120000, env: util.cleanEnv({ remove: [] }) });
  if (r.code !== 0 || !util.existsFile(tmp)) {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    throw new AppError('GUARD_BUILD_FAILED', tr('guard.buildFailed', { message: util.firstLine(r.stdout) || util.firstLine(r.stderr) || util.describeExit(r, csc) }), 500);
  }
  // an older guard may still run from the old exe: it is stopped first by the caller (ensure)
  try { fs.unlinkSync(exe); } catch { /* not there / in use */ }
  fs.renameSync(tmp, exe);
  ctx.log(`guard built ${exe}`);
  return exe;
}

/** Running guard processes [{pid}] (tasklist: PHP Station's process list only covers php / DB names). */
async function running() {
  const tl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
  const out = [];
  for (const name of [EXE_NAME, ...LEGACY_NAMES]) {
    const r = await util.run(tl, ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { timeoutMs: 15000, env: util.cleanEnv({ remove: [] }) });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m && m[1].toLowerCase() === name.toLowerCase()) out.push({ pid: Number(m[2]), legacy: name !== EXE_NAME });
    }
  }
  return out;
}

/** Ends a running guard through its named quit event (never killed). */
async function stop(ctx) {
  const r = await procs.psOneShot("try { $e = [System.Threading.EventWaitHandle]::OpenExisting('Local\\DevPanelShutdownGuardQuit'); [void]$e.Set(); [Console]::Out.WriteLine('{\"ok\":true}') } catch { [Console]::Out.WriteLine('{\"ok\":false}') }", { timeoutMs: 15000 });
  for (let i = 0; i < 20 && (await running(ctx)).length; i++) await util.sleep(150);
  ctx.log('guard stop requested');
  return { ok: !!(r.json && r.json.ok) };
}

/** Executable path of each pid ({pid: path|null}); null when Windows does not tell. */
async function exePaths(pids) {
  if (!pids.length) return {};
  const list = pids.filter((p) => Number.isInteger(p)).join(',');
  const r = await procs.psOneShot(`$o = @{}; foreach ($i in @(${list})) { try { $o["$i"] = [string](Get-Process -Id $i -ErrorAction Stop).Path } catch { $o["$i"] = $null } }; [Console]::Out.WriteLine((DP-Ascii (ConvertTo-Json -InputObject $o -Compress)))`, { timeoutMs: 15000 });
  return r.json && typeof r.json === 'object' ? r.json : {};
}

/** The real install (data folder = <tool>\data). Only it may replace a guard started by another data folder. */
function isPrimary(ctx) {
  return path.resolve(ctx.dataDir).toLowerCase() === path.join(TOOL_DIR, 'data').toLowerCase();
}

/**
 * Starts the guard when the setting is on (rebuilding it if the source changed); stops it when off.
 * Only one guard runs per Windows session (named mutex). A guard that belongs to another data folder
 * (a test run, a temporary panel) is replaced only by the real install; temporary panels never touch
 * a guard that is not their own.
 */
async function ensure(ctx) {
  const on = ctx.store.data.settings.shutdownGuard !== false;
  const cur = await running(ctx);
  const exe = exePath(ctx);
  const paths = await exePaths(cur.map((x) => x.pid));
  const ours = cur.filter((x) => !x.legacy && paths[x.pid] && path.resolve(paths[x.pid]).toLowerCase() === path.resolve(exe).toLowerCase());
  const foreign = cur.filter((x) => !ours.includes(x));
  const primary = isPrimary(ctx);
  if (!on) {
    if (ours.length || (foreign.length && primary)) await stop(ctx);
    return { running: false, enabled: false };
  }
  const stale = util.existsFile(exe) && mtime(exe) < mtime(SOURCE);
  if (ours.length && !stale) return { running: true, enabled: true, pid: ours[0].pid };
  if (!ours.length && foreign.length && !primary) return { running: true, enabled: true, pid: foreign[0].pid, foreign: true };
  if (cur.length) await stop(ctx);
  await ensureBuilt(ctx);
  const logFile = path.join(ctx.dataDir, 'logs', 'guard-console.log');
  util.ensureDir(path.dirname(logFile));
  const pid = procs.spawnDetached(exe, [ctx.dataDir], { cwd: path.dirname(exe), env: util.cleanEnv({ remove: [] }), logFile });
  ctx.log(`guard started pid ${pid}`);
  return { running: !!pid, enabled: true, pid };
}

/** Writes the pids the guard must stop (only when the list changed). PURE apart from the file. */
function writeList(ctx, dbViews) {
  const lines = (dbViews || [])
    .filter((d) => d && d.status === 'running' && Number.isInteger(d.pid))
    .map((d) => `${d.pid}\t${String(d.label || d.id).replace(/[\t\r\n]/g, ' ')}`)
    .sort();
  const text = lines.join('\r\n');
  if (ctx.guardList === text) return false;
  const f = listFile(ctx);
  util.ensureDir(path.dirname(f));
  fs.writeFileSync(f, text, 'utf8');
  ctx.guardList = text;
  return true;
}

async function status(ctx) {
  const cur = await running(ctx);
  const logFile = path.join(ctx.dataDir, 'logs', 'guard.log');
  return {
    enabled: ctx.store.data.settings.shutdownGuard !== false,
    running: cur.length > 0,
    pid: cur.length ? cur[0].pid : null,
    watching: (ctx.guardList || '').split(/\r?\n/).filter(Boolean).length,
    logTail: util.existsFile(logFile) ? util.tailFile(logFile, 20).text : '',
  };
}

module.exports = { ensure, stop, status, writeList, ensureBuilt, exePath, EXE_NAME };
