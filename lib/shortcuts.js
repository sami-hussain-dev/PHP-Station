'use strict';
/**
 * Windows shortcuts for PHP Station: Desktop + Start Menu ("PHP Station.lnk" -> PHP-Station.bat).
 *  - Created automatically once per install folder on the first start of the panel (state.shortcuts.for
 *    remembers the folder, so a shortcut the user deleted on purpose is not brought back; moving the
 *    folder creates fresh ones).
 *  - Only for the real install (data folder = <tool>\data): test runs and temporary panels never touch
 *    the desktop. DEVPANEL_NO_SHORTCUTS=1 turns the automatic part off.
 *  - Old "DevPanel.lnk" shortcuts are removed, but ONLY when they point into this same folder.
 */
const path = require('path');
const procs = require('./procs');
const util = require('./util');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell
$made = @()
$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($d in $dirs) {
  if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
  $old = Join-Path $d 'DevPanel.lnk'
  if (Test-Path -LiteralPath $old) {
    try {
      $o = $sh.CreateShortcut($old)
      if ([string]$o.TargetPath -and ([string]$o.TargetPath).ToLower().StartsWith(([string]$env:DP_WORKDIR).ToLower())) { Remove-Item -LiteralPath $old -Force }
    } catch { }
  }
  $lnk = Join-Path $d 'PHP Station.lnk'
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $env:DP_TARGET
  $s.WorkingDirectory = $env:DP_WORKDIR
  $s.WindowStyle = 7
  $s.Description = [string]$env:DP_DESC
  $s.IconLocation = [string]$env:DP_ICON
  $s.Save()
  $made += [string]$lnk
}
[Console]::Out.WriteLine((DP-Ascii (ConvertTo-Json -InputObject @{ ok = $true; paths = @($made) } -Compress)))
`;

function iconFor(toolDir) {
  const ico = path.join(toolDir, 'public', 'php-station.ico');
  return util.existsFile(ico) ? `${ico},0` : `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\shell32.dll,12`;
}

/** Creates / refreshes both shortcuts. Returns {paths}. Throws NO_LAUNCHER / SHORTCUT_FAILED (AppError from caller). */
async function create({ toolDir, description }) {
  const target = path.join(toolDir, 'PHP-Station.bat');
  if (!util.existsFile(target)) {
    const e = new Error('launcher missing');
    e.code = 'NO_LAUNCHER';
    e.target = target;
    throw e;
  }
  const env = util.cleanEnv({ remove: [], set: { DP_TARGET: target, DP_WORKDIR: toolDir, DP_DESC: description || 'PHP Station', DP_ICON: iconFor(toolDir) } });
  const r = await procs.psOneShot(SCRIPT, { env, timeoutMs: 30000 });
  if (!r.json || !r.json.ok) {
    const e = new Error('shortcut failed');
    e.code = 'SHORTCUT_FAILED';
    throw e;
  }
  return { paths: Array.isArray(r.json.paths) ? r.json.paths : [r.json.paths].filter(Boolean) };
}

/** True when this panel should create the shortcuts by itself now. */
function shouldAuto(ctx, toolDir, env = process.env) {
  if (env.DEVPANEL_NO_SHORTCUTS === '1') return false;
  if (process.platform !== 'win32') return false;
  if (path.resolve(ctx.dataDir).toLowerCase() !== path.resolve(toolDir, 'data').toLowerCase()) return false;
  const s = ctx.store.data.shortcuts;
  return !(s && typeof s.for === 'string' && s.for.toLowerCase() === path.resolve(toolDir).toLowerCase());
}

/** First start of an install: make the shortcuts once. Never throws. */
async function ensureAuto(ctx, { toolDir, description }) {
  if (!shouldAuto(ctx, toolDir)) return { skipped: true };
  try {
    const r = await create({ toolDir, description });
    ctx.store.data.shortcuts = { for: path.resolve(toolDir), at: new Date().toISOString(), paths: r.paths };
    ctx.store.save();
    return r;
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { create, ensureAuto, shouldAuto, iconFor };
