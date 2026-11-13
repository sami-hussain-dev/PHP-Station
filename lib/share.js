'use strict';
/*
 * Live share link: a Cloudflare "quick tunnel" (cloudflared, no account) that makes a RUNNING
 * project reachable at https://<random>.trycloudflare.com, e.g. on a client's phone.
 *
 *  - cloudflared.exe is installed by the installer (official GitHub release, SHA-256 checked) into
 *    <tool>\runtimes\cloudflared\<version>\.
 *  - The project's own php -S keeps listening on 127.0.0.1 only; cloudflared connects to it.
 *  - HTTPS awareness: a tiny auto_prepend_file (<data>\share\https.php) marks requests that came
 *    through the tunnel (X-Forwarded-Proto: https from 127.0.0.1) as HTTPS, so Laravel builds
 *    https:// links and assets. Projects are restarted with it once when sharing starts.
 *  - Shares never outlive the panel: they are stopped on panel shutdown and when the project stops.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('./util');
const procs = require('./procs');
const semver = require('./semver');
const runtimes = require('./runtimes');
const { tr } = require('./i18n');

const { AppError } = util;
// a tunnel link; api.trycloudflare.com (the API cloudflared talks to, also printed in its errors) is NOT one
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])/i;
const START_TIMEOUT_MS = 40000;
const MAX_ATTEMPTS = 3;

const PREPEND_PHP = `<?php
// PHP Station live share: requests that came through the Cloudflare tunnel are HTTPS for the app.
// Only used while a project is shared; it changes nothing for normal local requests.
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https'
    && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) {
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = 443;
    $_SERVER['REQUEST_SCHEME'] = 'https';
}
// PHP Station dev tools (Inbox: mail + dump() catching), see lib/devtools.js
$phpstationDevtools = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'devtools' . DIRECTORY_SEPARATOR . 'prepend.php';
if (is_file($phpstationDevtools)) require $phpstationDevtools;
unset($phpstationDevtools);
`;

function shares(ctx) {
  if (!ctx.store.data.shares || typeof ctx.store.data.shares !== 'object') ctx.store.data.shares = {};
  return ctx.store.data.shares;
}

/** <data>\share\https.php (rewritten when its content differs). */
function prependFile(ctx) {
  const f = path.join(ctx.dataDir, 'share', 'https.php');
  if (util.readText(f, null) !== PREPEND_PHP) {
    util.ensureDir(path.dirname(f));
    fs.writeFileSync(f, PREPEND_PHP);
  }
  return f;
}

/** Newest installed cloudflared.exe: {path, version} or null. */
function findCloudflared(ctx) {
  const dir = path.join(runtimes.toolRuntimesDir(ctx), 'cloudflared');
  const list = util.listDirNames(dir)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && util.existsFile(path.join(dir, v, 'cloudflared.exe')))
    .sort((a, b) => semver.compare(b, a));
  return list.length ? { version: list[0], path: path.join(dir, list[0], 'cloudflared.exe') } : null;
}

/** First trycloudflare.com URL in a cloudflared log text, or null. PURE. */
function parseTunnelUrl(text) {
  const m = URL_RE.exec(String(text || ''));
  return m ? m[0].toLowerCase() : null;
}

/** Image name of a pid via tasklist ('' when gone). */
function imageOf(pid) {
  const n = util.validPid(pid);
  if (!n) return '';
  const tl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
  const r = spawnSync(tl, ['/FI', `PID eq ${n}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const m = /^"([^"]+)","(\d+)"/.exec(String(r.stdout || '').trim());
  return m && Number(m[2]) === n ? m[1].toLowerCase() : '';
}

function isOurTunnel(rec) {
  return !!(rec && procs.pidExists(rec.pid) && imageOf(rec.pid) === 'cloudflared.exe');
}

/**
 * Share of a project for the state: {url, startedAt, port} or null. `runPort` is the port the project
 * runs on now (null when it is stopped): a tunnel whose project stopped or moved to another port
 * is ended, a tunnel that died is forgotten.
 */
function viewFor(ctx, projectId, runPort) {
  const rec = shares(ctx)[projectId];
  if (!rec) return null;
  const alive = procs.pidExists(rec.pid);
  if (alive && rec.port === runPort) return { url: rec.url, startedAt: rec.startedAt, port: rec.port, prepend: !!rec.prepend };
  if (alive) stopRecord(ctx, projectId, rec, runPort == null ? 'project stopped' : 'project port changed');
  delete shares(ctx)[projectId];
  ctx.dirty = true;
  return null;
}

function stopRecord(ctx, projectId, rec, why) {
  if (rec && isOurTunnel(rec)) {
    spawnSync('taskkill.exe', ['/PID', String(rec.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    ctx.log(`share ${projectId} stopped (${why}) pid ${rec.pid}`);
  }
}

/** Stops a project's share (no error when there is none). */
function stop(ctx, projectId, why = 'user') {
  const rec = shares(ctx)[projectId];
  if (!rec) return { ok: true, wasSharing: false };
  stopRecord(ctx, projectId, rec, why);
  delete shares(ctx)[projectId];
  ctx.store.save();
  return { ok: true, wasSharing: true };
}

/** Panel shutdown: every share ends with it. */
function stopAll(ctx) {
  for (const id of Object.keys(shares(ctx))) {
    try { stopRecord(ctx, id, shares(ctx)[id], 'panel shutdown'); } catch { /* best effort */ }
    delete shares(ctx)[id];
  }
}

/**
 * Starts the tunnel for a project that runs on 127.0.0.1:<port>. Returns {url, port, warnings[]}.
 * `restart(opts)` restarts the project's PHP server (done by the caller's projects module).
 */
async function start(ctx, project, run, { restart } = {}) {
  const cf = findCloudflared(ctx);
  if (!cf) throw new AppError('NO_CLOUDFLARED', tr('share.noCloudflared'), 409);
  if (!run || !Number.isInteger(run.port)) throw new AppError('NOT_RUNNING', tr('share.notRunning'), 409);
  const existing = shares(ctx)[project.id];
  if (existing && isOurTunnel(existing) && existing.port === run.port) return { url: existing.url, port: existing.port, warnings: [], already: true };
  if (existing) stop(ctx, project.id, 'replaced');

  const warnings = [];
  let port = run.port;
  let prepend = !!run.sharePrepend;
  if (!prepend && !run.external && typeof restart === 'function') {
    const r = await restart({ sharePrepend: true });
    if (!r || r.ok === false || !Number.isInteger(r.port)) {
      throw new AppError('SHARE_RESTART_FAILED', tr('share.restartFailed', { error: (r && r.error) || '?' }), 500, { logTail: r && r.logTail });
    }
    port = r.port;
    prepend = true;
  } else if (!prepend) warnings.push('NO_HTTPS_FIX');
  if (util.existsFile(path.join(project.path, 'public', 'hot'))) warnings.push('VITE_HOT');

  const logFile = path.join(ctx.dataDir, 'logs', 'share', `${project.id}.log`);
  util.ensureDir(path.dirname(logFile));
  try { fs.writeFileSync(logFile, ''); } catch { /* new run, new log */ }
  const kill = (pid) => { if (procs.pidExists(pid) && imageOf(pid) === 'cloudflared.exe') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); };

  // Cloudflare's quick-tunnel API is sometimes slow to answer (or a network drops the first try):
  // up to 3 attempts, and a link counts only once the tunnel has REALLY connected.
  let lastTail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const from = (() => { try { return fs.statSync(logFile).size; } catch { return 0; } })();
    fs.appendFileSync(logFile, `----- PHP Station: attempt ${attempt}/${MAX_ATTEMPTS} ${util.nowIso()} -----\r\n`);
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    const pid = procs.spawnDetached(cf.path, args, { cwd: path.dirname(cf.path), env: util.cleanEnv({ remove: [] }), logFile });
    if (!pid) throw new AppError('SHARE_FAILED', tr('share.spawnFailed'), 500);
    ctx.log(`share ${project.id}: cloudflared ${cf.version} pid ${pid} -> 127.0.0.1:${port} (attempt ${attempt})`);
    const st = await waitTunnel(logFile, from, pid);
    if (st.ok) {
      shares(ctx)[project.id] = { pid, url: st.url, port, startedAt: util.nowIso(), prepend, version: cf.version };
      ctx.store.save();
      return { url: st.url, port, warnings, attempts: attempt };
    }
    kill(pid);
    lastTail = util.tailFile(logFile, 25).text;
    ctx.log(`share ${project.id}: attempt ${attempt} failed (${st.why})`);
    if (attempt < MAX_ATTEMPTS) await util.sleep(2000);
  }
  throw new AppError('SHARE_FAILED', tr('share.noUrl'), 502, { logTail: lastTail });
}

/**
 * Reads the cloudflared log written since `from` until the quick tunnel is created AND one
 * connection to Cloudflare is registered -> {ok, url} | {ok:false, why}.
 */
async function waitTunnel(logFile, from, pid) {
  const end = Date.now() + START_TIMEOUT_MS;
  let url = null;
  let urlAt = 0;
  while (Date.now() < end) {
    await util.sleep(400);
    let text = '';
    try {
      const buf = fs.readFileSync(logFile);
      text = buf.subarray(Math.min(from, buf.length)).toString('utf8');
    } catch { text = ''; }
    const st = tunnelState(text);
    if (st.failed) return { ok: false, why: st.failed };
    if (st.url && !url) { url = st.url; urlAt = Date.now(); }
    if (url && st.registered) return { ok: true, url };
    // some cloudflared builds log the connection late: accept the link after 15 s without an error
    if (url && Date.now() - urlAt > 15000) return { ok: true, url };
    if (!procs.pidExists(pid)) return { ok: false, why: 'cloudflared exited' };
  }
  return { ok: false, why: url ? 'no connection to Cloudflare' : 'no link from Cloudflare' };
}

/** What a cloudflared log says: {url|null, registered, failed|null}. PURE. */
function tunnelState(text) {
  const t = String(text || '');
  const failed = /failed to request quick tunnel[^\r\n]*/i.exec(t) || /\bERR\b[^\r\n]*(quick tunnel|trycloudflare)[^\r\n]*/i.exec(t);
  return {
    url: parseTunnelUrl(t),
    registered: /Registered tunnel connection/i.test(t),
    failed: failed ? failed[0].slice(0, 200) : null,
  };
}

module.exports = { PREPEND_PHP, prependFile, findCloudflared, parseTunnelUrl, tunnelState, viewFor, start, stop, stopAll, URL_RE };
