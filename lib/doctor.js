'use strict';
/*
 * Doctor: one check of the whole setup, each finding with its fix, and a report to paste into a
 * GitHub issue.
 *
 *   update     a newer PHP Station release on GitHub (link to it)
 *   php        PHP folders that do not run
 *   projects   project folders / PHP versions that are gone
 *   db         DB server warnings; running MariaDB / MySQL servers still on the tiny XAMPP defaults
 *              (16 MB buffer pool, 1 MB max_allowed_packet) -> fix "dbtune": set live (SET GLOBAL,
 *              no restart) and written to my.ini (a copy of the old one is kept first)
 *   defender   Windows Defender scans every file a DB server writes -> fix "defender": exclusions for
 *              the datadirs, through a Windows administrator prompt (the user sees the folders first)
 *   disk       free space where backups and restore points are kept
 *
 * The report has no user name, PC name or private paths: they are replaced by <user>, <pc>, <path>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const util = require('./util');
const semver = require('./semver');
const dbservers = require('./dbservers');
const { tr, trIn } = require('./i18n');

const { AppError } = util;
const REPO = 'sami-hussain-dev/PHP-Station';
const MB = 1024 * 1024;
const GOOD_POOL = 128 * MB;
const GOOD_PACKET = 64 * MB;
const TUNED_PACKET = 256 * MB;

/** Buffer pool for a dev box: 1/8 of the RAM, 256 MB .. 1 GB, in 128 MB steps. PURE. */
function tunedPool(totalMem = os.totalmem()) {
  const want = Math.min(1024 * MB, Math.max(256 * MB, Math.floor(totalMem / 8)));
  return Math.floor(want / (128 * MB)) * 128 * MB;
}

/**
 * my.ini with `key = value` set in its [mysqld] section (an existing line replaced, else added
 * right after the header; the section is created when missing). PURE.
 */
function setMyIni(text, values) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  let start = lines.findIndex((l) => /^\s*\[(mysqld|mariadb|server)\]\s*$/i.test(l));
  if (start < 0) {
    lines.push('', '[mysqld]');
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^\\s*${key.replace(/_/g, '[_-]')}\\s*=`, 'i');
    let hit = -1;
    for (let i = start + 1; i < end; i++) if (re.test(lines[i])) hit = i;
    if (hit >= 0) lines[hit] = `${key} = ${value}`;
    else { lines.splice(start + 1, 0, `${key} = ${value}`); end++; }
  }
  return lines.join(nl);
}

/** Text with the user name, PC name, home folder and the given private paths masked. PURE. */
function mask(text, { home = os.homedir(), user = os.userInfo().username, pc = os.hostname(), paths = [] } = {}) {
  let s = String(text);
  const swap = (from, to) => {
    if (!from || from.length < 3) return;
    const re = new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, to);
  };
  for (const p of paths.filter(Boolean).sort((a, b) => b.length - a.length)) swap(p, '<path>');
  swap(home, '%USERPROFILE%');
  swap(pc, '<pc>');
  swap(user, '<user>');
  return s;
}

/** The newest PHP Station: the latest GitHub release, else the version on the default branch. */
async function latestRelease() {
  const get = async (url, json) => {
    const res = await fetch(url, { headers: { 'User-Agent': 'PHP-Station', Accept: json ? 'application/vnd.github+json' : '*/*' }, signal: AbortSignal.timeout(6000) });
    return res.ok ? (json ? res.json() : res.text()) : null;
  };
  try {
    const j = await get(`https://api.github.com/repos/${REPO}/releases/latest`, true);
    if (j && j.tag_name) return { version: String(j.tag_name).replace(/^v/i, ''), url: j.html_url || `https://github.com/${REPO}/releases/latest` };
  } catch { /* try the branch */ }
  for (const branch of ['master', 'main']) {
    try {
      const text = await get(`https://raw.githubusercontent.com/${REPO}/${branch}/package.json`, false);
      const v = text && JSON.parse(text).version;
      if (v) return { version: String(v), url: `https://github.com/${REPO}` };
    } catch { /* next */ }
  }
  return null;
}

/** "703 GB" / "512 MB". PURE. */
function size(bytes) {
  return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(bytes >= 100 * 1024 * MB ? 0 : 1)} GB` : `${Math.round(bytes / MB)} MB`;
}

async function defenderOn() {
  const procs = require('./procs');
  const r = await procs.psOneShot("try { $s = Get-MpComputerStatus -ErrorAction Stop; [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ ok = $true; rt = [bool]$s.RealTimeProtectionEnabled })) } catch { [Console]::Out.WriteLine('{\"ok\":false}') }", { timeoutMs: 15000 });
  return r.json && r.json.ok ? !!r.json.rt : null;
}

/** Live settings of a running MariaDB / MySQL server: {pool, packet, super} | null. */
async function serverVars(ctx, view) {
  try {
    const entry = dbservers.getEntry(ctx, view.id);
    const creds = await dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, null), { timeoutMs: 8000 });
    const rows = await dbservers.query(ctx, entry, "SELECT @@GLOBAL.innodb_buffer_pool_size, @@GLOBAL.max_allowed_packet;\n", Object.assign({}, creds, { timeoutMs: 10000 }));
    return rows.length ? { pool: Number(rows[0][0]) || 0, packet: Number(rows[0][1]) || 0 } : null;
  } catch { return null; }
}

/**
 * All checks. state: the panel state (server.js buildState). -> {checks: [{id, level, title, text,
 * fix?}], report, at}
 */
async function run(ctx, state) {
  const raw = [];
  // title / text: T(key, params) (translated) or a plain string (server output, lists)
  const T = (key, params = {}) => ({ key, params });
  const add = (id, level, title, text, fix = null) => raw.push({ id, level, title, text, fix });
  const [rel, defender] = await Promise.all([latestRelease(), defenderOn()]);

  // PHP Station itself
  const version = state.panel.version;
  if (rel && semver.compare(rel.version, version) > 0) add('update', 'warn', T('doc.updateTitle', { v: rel.version }), T('doc.updateText', { v: rel.version, cur: version }), { action: 'url', url: rel.url });
  else if (rel) add('update', 'ok', T('doc.upToDate', { v: version }), '');
  else add('update', 'info', T('doc.updateUnknown', { v: version }), T('doc.updateUnknownText'));

  // PHP
  const php = (state.runtimes && state.runtimes.php) || [];
  const brokenPhp = php.filter((p) => !p.ok);
  if (!php.length) add('php', 'bad', T('doc.noPhp'), T('doc.noPhpText'));
  else if (brokenPhp.length) add('php', 'warn', T('doc.phpBroken', { n: brokenPhp.length }), brokenPhp.slice(0, 5).map((p) => `${p.label}: ${p.error || '?'}`).join('\n'));
  else add('php', 'ok', T('doc.phpOk', { n: php.length, list: php.map((p) => p.version).filter(Boolean).join(', ') }), '');

  // projects
  const bad = [];
  for (const p of state.projects || []) for (const w of p.warnings || []) if (w.level === 'bad') bad.push(`${p.name}: ${w.text}`);
  if (bad.length) add('projects', 'bad', T('doc.projectsBad', { n: bad.length }), bad.slice(0, 8).join('\n'));
  else add('projects', 'ok', T('doc.projectsOk', { n: (state.projects || []).length }), '');

  // DB servers
  const dbs = state.dbServers || [];
  const dbBad = [];
  for (const d of dbs) for (const w of d.warnings || []) if (w.level === 'bad') dbBad.push(`${d.label}: ${w.text}`);
  if (dbBad.length) add('db', 'bad', T('doc.dbBad', { n: dbBad.length }), dbBad.slice(0, 8).join('\n'));
  for (const d of dbs.filter((x) => x.status === 'running')) {
    const v = await serverVars(ctx, d);
    if (!v) continue;
    if (v.pool < GOOD_POOL || v.packet < GOOD_PACKET) {
      add(`dbtune:${d.id}`, 'warn', T('doc.dbSlowTitle', { label: d.label }),
        T('doc.dbSlowText', { pool: size(v.pool), packet: size(v.packet), newPool: size(tunedPool()), newPacket: size(TUNED_PACKET) }),
        { action: 'dbtune', serverId: d.id, myIni: d.defaultsFile || null });
    } else {
      add(`dbtune:${d.id}`, 'ok', T('doc.dbFast', { label: d.label, pool: size(v.pool) }), '');
    }
  }
  if (!dbs.length) add('db', 'info', T('doc.noDb'), '');

  // Windows Defender
  const datadirs = [...new Set(dbs.map((d) => d.datadir).filter((x) => x && util.existsDir(x)))];
  if (defender === true && datadirs.length) {
    add('defender', 'info', T('doc.defenderTitle'), T('doc.defenderText', { list: datadirs.join('\n') }), { action: 'defender', paths: datadirs });
  }

  // disk
  const dumpDir = ctx.store.data.settings.dumpDir;
  let free = null;
  try { util.ensureDir(dumpDir); const s = fs.statfsSync(dumpDir); free = Number(s.bavail) * Number(s.bsize); } catch { free = null; }
  if (free !== null) {
    const level = free < 512 * MB ? 'bad' : free < 2048 * MB ? 'warn' : 'ok';
    add('disk', level, T(level === 'ok' ? 'doc.diskOk' : 'doc.diskLow', { free: size(free) }), level === 'ok' ? '' : T('doc.diskText'));
  }

  const render = (x, lang) => (x == null || x === '' ? '' : typeof x === 'string' ? x : lang ? trIn(lang, x.key, x.params) : tr(x.key, x.params));
  const checks = raw.map((c) => ({ id: c.id, level: c.level, title: render(c.title), text: render(c.text), fix: c.fix }));
  const english = raw.map((c) => ({ id: c.id, level: c.level, title: render(c.title, 'en'), text: render(c.text, 'en') }));
  const at = util.nowIso();
  return { at, checks, report: report(ctx, state, english, at) };
}

/** Markdown for a GitHub issue, with personal details masked. */
function report(ctx, state, checks, at) {
  const icon = { ok: 'OK  ', info: 'INFO', warn: 'WARN', bad: 'BAD ' };
  const php = ((state.runtimes && state.runtimes.php) || []).map((p) => `${p.version || '?'}${p.ok ? '' : ' (broken)'}`).join(', ') || '-';
  const db = (state.dbServers || []).map((d) => `${d.kind || '?'} ${d.version || '?'} (${d.status})`).join(', ') || '-';
  const lines = [
    '### PHP Station report',
    '',
    `- PHP Station ${state.panel.version}, Node ${process.version}, Windows ${os.release()} ${os.arch()}`,
    `- PHP: ${php}`,
    `- Database servers: ${db}`,
    `- Projects: ${(state.projects || []).length} (${(state.projects || []).filter((p) => p.info && p.info.isLaravel).length} Laravel)`,
    `- Checked: ${at}`,
    '',
    '```',
    ...checks.map((c) => `${icon[c.level] || c.level} ${c.title}${c.text ? `\n     ${String(c.text).split('\n').join('\n     ')}` : ''}`),
    '```',
  ];
  // known folders first (they may contain spaces), then any other Windows path
  const dbs = state.dbServers || [];
  const paths = [ctx.dataDir, ctx.store.data.settings.dumpDir, ...(state.projects || []).map((p) => p.path),
    ...dbs.map((d) => d.datadir), ...dbs.map((d) => d.binDir), ...dbs.map((d) => d.defaultsFile),
    ...dbs.map((d) => String(d.label || '').split(' · ')[1]), ...((state.runtimes && state.runtimes.php) || []).map((x) => x.dir)];
  return mask(lines.join('\n'), { paths }).replace(/\b[A-Za-z]:\\[^\s:·,;)'"]*/g, '<path>');
}

// ------------------------------------------------------------------------------------------ fixes

/** Faster DB server for development: live (SET GLOBAL) and in my.ini (old copy kept). */
async function tuneDb(ctx, serverId) {
  const entry = dbservers.getEntry(ctx, serverId);
  const creds = await dbservers.workingCreds(ctx, entry, dbservers.credCandidates(ctx, null), { timeoutMs: 8000 });
  const pool = tunedPool();
  const done = { live: false, myIni: null, backup: null, pool, packet: TUNED_PACKET };
  await dbservers.query(ctx, entry, `SET GLOBAL max_allowed_packet = ${TUNED_PACKET};\nSET GLOBAL innodb_buffer_pool_size = ${pool};\n`, creds);
  done.live = true;
  if (entry.defaultsFile && util.existsFile(entry.defaultsFile)) {
    const text = fs.readFileSync(entry.defaultsFile, 'utf8');
    const dir = util.ensureDir(path.join(ctx.dataDir, 'config-backups'));
    const backup = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${path.basename(entry.defaultsFile)}`);
    fs.copyFileSync(entry.defaultsFile, backup);
    util.writeFileAtomic(entry.defaultsFile, setMyIni(text, { innodb_buffer_pool_size: `${pool / MB}M`, max_allowed_packet: `${TUNED_PACKET / MB}M` }));
    done.myIni = entry.defaultsFile;
    done.backup = backup;
  }
  ctx.log(`doctor: tuned ${entry.id} (pool ${pool / MB}M, packet ${TUNED_PACKET / MB}M, my.ini ${done.myIni ? 'written' : 'not written'})`);
  return done;
}

/** Defender exclusions for the datadirs, through a Windows administrator prompt. -> {ok, code} */
function addDefenderExclusions(ctx, paths) {
  const views = dbservers.buildEntries(ctx).map((e) => e.datadir).filter(Boolean);
  const list = (Array.isArray(paths) ? paths : []).filter((p) => views.some((v) => util.samePath(v, p)) && util.existsDir(p));
  if (!list.length) throw new AppError('BAD_INPUT', tr('doc.noPaths'), 400);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const inner = `Add-MpPreference -ExclusionPath ${list.map(q).join(',')}`;
  const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-Command',${q(inner)}; exit $p.ExitCode`;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { windowsHide: true, shell: false, stdio: 'ignore' });
    child.on('error', () => resolve({ ok: false, code: -1 }));
    child.on('close', (code) => {
      ctx.log(`doctor: defender exclusions ${code === 0 ? 'added' : `not added (${code})`} for ${list.length} folder(s)`);
      resolve({ ok: code === 0, code, paths: list });
    });
  });
}

module.exports = { run, tuneDb, addDefenderExclusions, tunedPool, setMyIni, mask, size };
