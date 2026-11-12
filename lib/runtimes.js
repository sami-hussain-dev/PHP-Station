'use strict';
/*
 * Runtime discovery: PHP (with php.ini relocation for copied PHP folders), Composer phars and
 * MariaDB/MySQL installs. Results are cached in <data>\runtimes.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');
const ini = require('./ini');
const semver = require('./semver');
const { tr } = require('./i18n');

const win = path.win32;
const DEFAULT_TOOL_DIR = path.resolve(__dirname, '..');

/** <tool>\runtimes: where the installer puts PHP / MariaDB / Composer (always a scan root). */
function toolRuntimesDir(ctx) {
  return path.join(ctx && ctx.toolDir ? ctx.toolDir : DEFAULT_TOOL_DIR, 'runtimes');
}

// ------------------------------------------------------------------------------------------ cache

function cacheFile(ctx) {
  return path.join(ctx.dataDir, 'runtimes.json');
}

function rt(ctx) {
  if (!ctx.runtimes) {
    const c = util.readJson(cacheFile(ctx), null);
    ctx.runtimes = {
      scanning: false,
      jobId: null,
      cache: c && typeof c === 'object' && Array.isArray(c.php)
        ? { scannedAt: c.scannedAt || null, php: c.php, composer: c.composer || [], db: c.db || [] }
        : null,
    };
  }
  return ctx.runtimes;
}

function hasCache(ctx) {
  return !!rt(ctx).cache;
}

function getCache(ctx) {
  const r = rt(ctx);
  const c = r.cache || { scannedAt: null, php: [], composer: [], db: [] };
  return { scannedAt: c.scannedAt, scanning: r.scanning, php: c.php, composer: c.composer, db: c.db };
}

/** How PHP must be invoked everywhere (servers, artisan, composer, lint, probes). */
function phpInvocation(r) {
  return { file: r.path, preArgs: r.iniRelocated && r.iniFile ? ['-c', r.iniFile] : [] };
}

// ------------------------------------------------------------------------------------------ candidates

function sourceOf(root, manual) {
  if (manual) return 'manual';
  if (/xampp/i.test(root)) return 'xampp';
  if (/laragon/i.test(root)) return 'laragon';
  if (/wamp/i.test(root)) return 'other';
  return 'path';
}

/**
 * Candidate files under the scan roots. opts.runtimesDir (the tool's own runtimes folder) is
 * scanned with the installer layout: php\<v>\php.exe, composer\<v>\*.phar, mariadb\<v>\bin.
 */
function findCandidates(roots, extraPaths, opts = {}) {
  const php = [];
  const composer = [];
  const db = [];
  const addPhp = (p, root, manual, source) => { if (util.existsFile(p)) php.push({ path: util.cleanPath(p), root, source: source || sourceOf(root, manual) }); };
  const addPhar = (p, root) => { if (util.existsFile(p) && /\.phar$/i.test(p)) composer.push({ path: util.cleanPath(p), root }); };
  const addDbBin = (bin, root) => { if (util.existsDir(bin)) db.push({ binDir: util.cleanPath(bin), root }); };

  for (const rawRoot of roots || []) {
    const R = util.cleanPath(rawRoot);
    if (!util.existsDir(R)) continue;
    for (const d of util.listDirNames(R)) {
      if (/^php/i.test(d)) addPhp(win.join(R, d, 'php.exe'), R);
    }
    for (const d of util.listDirNames(win.join(R, 'bin', 'php'))) addPhp(win.join(R, 'bin', 'php', d, 'php.exe'), R);
    addPhp(win.join(R, 'php.exe'), R);

    for (const f of util.listFileNames(win.join(R, 'composer'))) if (/\.phar$/i.test(f)) addPhar(win.join(R, 'composer', f), R);
    for (const f of util.listFileNames(win.join(R, 'bin', 'composer'))) if (/\.phar$/i.test(f)) addPhar(win.join(R, 'bin', 'composer', f), R);
    for (const f of util.listFileNames(R)) if (/^composer.*\.phar$/i.test(f)) addPhar(win.join(R, f), R);

    addDbBin(win.join(R, 'mysql', 'bin'), R);
    for (const sub of ['mysql', 'mariadb']) {
      for (const d of util.listDirNames(win.join(R, 'bin', sub))) addDbBin(win.join(R, 'bin', sub, d, 'bin'), R);
    }
  }
  if (opts.runtimesDir && util.existsDir(opts.runtimesDir)) {
    const R = util.cleanPath(opts.runtimesDir);
    for (const d of util.listDirNames(win.join(R, 'php'))) addPhp(win.join(R, 'php', d, 'php.exe'), R, false, 'devpanel');
    for (const d of util.listDirNames(win.join(R, 'composer'))) {
      for (const f of util.listFileNames(win.join(R, 'composer', d))) if (/\.phar$/i.test(f)) addPhar(win.join(R, 'composer', d, f), R);
    }
    for (const sub of ['mariadb', 'mysql']) {
      for (const d of util.listDirNames(win.join(R, sub))) addDbBin(win.join(R, sub, d, 'bin'), R);
    }
  }
  for (const p of extraPaths || []) {
    const base = win.basename(p).toLowerCase();
    const dir = win.dirname(util.cleanPath(p));
    if (base === 'php.exe') addPhp(p, dir, true);
    else if (base.endsWith('.phar')) addPhar(p, dir);
    else if (['mysqld.exe', 'mariadbd.exe', 'mysql.exe', 'mariadb.exe'].includes(base)) addDbBin(dir, win.dirname(win.dirname(dir)));
  }
  const dedupe = (list, key) => {
    const seen = new Set();
    return list.filter((x) => {
      const k = util.normPath(x[key]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return { php: dedupe(php, 'path'), composer: dedupe(composer, 'path'), db: dedupe(db, 'binDir') };
}

// ------------------------------------------------------------------------------------------ PHP probe

const PROBE_CODE = "echo 'DPJSON', json_encode(['v'=>PHP_VERSION,'zts'=>PHP_ZTS,'bits'=>PHP_INT_SIZE*8,'ini'=>php_ini_loaded_file(),'ext'=>get_loaded_extensions()]);";

function phpId(version, dir) {
  return `php-${version || 'unknown'}-${util.hash6(util.normPath(dir))}`;
}

/** Writes (or reuses) the relocated php.ini copy; returns its path. */
function ensureRelocatedIni(dataDir, id, srcIni, fromHome, toDir) {
  const outDir = util.ensureDir(path.join(dataDir, 'php-ini'));
  const outFile = path.join(outDir, `${id}.ini`);
  const metaFile = path.join(outDir, `${id}.json`);
  const st = fs.statSync(srcIni);
  const meta = util.readJson(metaFile, null);
  if (meta && util.existsFile(outFile) && meta.size === st.size && meta.mtimeMs === st.mtimeMs
      && meta.fromHome === fromHome && meta.toDir === toDir && util.samePath(meta.source, srcIni)) {
    return outFile;
  }
  const text = fs.readFileSync(srcIni, 'utf8');
  util.writeFileAtomic(outFile, ini.relocatePhpIni(text, fromHome, toDir, srcIni));
  util.writeJsonAtomic(metaFile, { source: srcIni, size: st.size, mtimeMs: st.mtimeMs, fromHome, toDir });
  return outFile;
}

function splitOutput(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function probePhp(ctx, cand) {
  const exe = cand.path;
  const dir = win.dirname(exe);
  const env = util.cleanEnv();
  const base = {
    id: phpId(null, dir), version: null, path: exe, dir, zts: null, bits: null, iniFile: null, iniRelocated: false,
    ok: false, error: null, warnings: [], extensions: [], label: `PHP ? · ${dir}`, source: cand.source,
  };
  let preArgs = [];
  const srcIni = win.join(dir, 'php.ini');
  const iniText = util.readText(srcIni, null);
  const home = iniText != null ? ini.detectIniHome(iniText, dir) : null;
  if (home && util.normPath(home) !== util.normPath(dir)) {
    // The ini was written for another folder: learn the version without any ini, then relocate.
    const pre = await util.run(exe, ['-n', '-r', 'echo PHP_VERSION;'], { env, timeoutMs: 15000 });
    const ver = /^(\d+\.\d+\.\d+)/.exec(String(pre.stdout || '').trim());
    if (!ver) {
      base.error = util.firstLine(pre.stderr) || util.firstLine(pre.stdout) || util.describeExit(pre, exe);
      return base;
    }
    base.version = ver[1];
    base.id = phpId(ver[1], dir);
    try {
      base.iniFile = ensureRelocatedIni(ctx.dataDir, base.id, srcIni, home, dir);
      base.iniRelocated = true;
      preArgs = ['-c', base.iniFile];
    } catch (e) {
      base.error = tr('rt.iniCopyFailed', { message: e.message });
      return base;
    }
  }
  const r = await util.run(exe, [...preArgs, '-r', PROBE_CODE], { env, timeoutMs: 15000 });
  const out = String(r.stdout || '');
  const idx = out.indexOf('DPJSON');
  let data = null;
  let rest = out;
  if (idx >= 0) {
    const after = out.slice(idx + 6);
    const nl = after.search(/\r?\n/);
    const jsonText = nl >= 0 ? after.slice(0, nl) : after;
    try { data = JSON.parse(jsonText.trim()); } catch { data = null; }
    rest = out.slice(0, idx) + (nl >= 0 ? after.slice(nl) : '');
  }
  const noise = [...splitOutput(rest), ...splitOutput(r.stderr)];
  const fatal = noise.find((l) => /fatal/i.test(l));
  if (!data || fatal || r.timedOut) {
    base.error = fatal || noise[0] || util.describeExit(r, exe) || tr('rt.phpNoAnswer');
    if (data && data.v) { base.version = data.v; base.id = phpId(data.v, dir); }
    base.label = `PHP ${base.version || '?'} · ${dir}`;
    return base;
  }
  base.version = String(data.v);
  base.id = phpId(base.version, dir);
  base.zts = !!data.zts;
  base.bits = Number(data.bits) || null;
  if (!base.iniRelocated) base.iniFile = data.ini || null;
  base.extensions = Array.isArray(data.ext) ? data.ext.map((e) => String(e).toLowerCase()).sort() : [];
  base.warnings = noise.slice(0, 5);
  base.ok = true;
  base.label = `PHP ${base.version} · ${dir}`;
  return base;
}

// ------------------------------------------------------------------------------------------ Composer probe

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

async function probeComposer(cand, phpRt) {
  const sha = sha256File(cand.path);
  const res = {
    id: `composer-unknown-${util.hash6(util.normPath(cand.path))}`, version: null, path: cand.path, sha256: sha,
    sameAs: null, ok: false, error: null, label: `Composer ? · ${cand.path}`,
  };
  if (!phpRt) {
    res.error = tr('rt.noPhpForComposer');
    return res;
  }
  const inv = phpInvocation(phpRt);
  const r = await util.run(inv.file, [...inv.preArgs, cand.path, '--version', '--no-ansi', '--no-interaction'], {
    env: util.cleanEnv({ set: { COMPOSER_NO_INTERACTION: '1', COMPOSER_DISABLE_NETWORK: '1' } }),
    cwd: win.dirname(cand.path),
    timeoutMs: 30000,
  });
  const m = /Composer version (\S+)/i.exec(`${r.stdout}\n${r.stderr}`);
  if (!m) {
    res.error = util.firstLine(r.stderr) || util.firstLine(r.stdout) || util.describeExit(r, inv.file);
    return res;
  }
  res.version = m[1];
  res.id = `composer-${m[1]}-${util.hash6(util.normPath(cand.path))}`;
  res.ok = true;
  res.label = `Composer ${m[1]} · ${cand.path}`;
  return res;
}

// ------------------------------------------------------------------------------------------ DB probe

function firstExisting(dir, names) {
  for (const n of names) {
    const p = win.join(dir, n);
    if (util.existsFile(p)) return p;
  }
  return null;
}

function parseDbVersion(text) {
  const t = String(text || '');
  const m = /Distrib\s+(\d+\.\d+\.\d+)/i.exec(t) || /\bfrom\s+(\d+\.\d+\.\d+)/i.exec(t) || /Ver\s+(\d+\.\d+\.\d+)/i.exec(t);
  return m ? m[1] : null;
}

async function probeDb(cand) {
  const bin = cand.binDir;
  const serverExe = firstExisting(bin, ['mariadbd.exe', 'mysqld.exe']);
  const client = firstExisting(bin, ['mariadb.exe', 'mysql.exe']);
  if (!serverExe && !client) return null;
  const tools = {
    client,
    dump: firstExisting(bin, ['mariadb-dump.exe', 'mysqldump.exe']),
    admin: firstExisting(bin, ['mariadb-admin.exe', 'mysqladmin.exe']),
    installDb: firstExisting(bin, ['mariadb-install-db.exe', 'mysql_install_db.exe']),
  };
  const probeExe = serverExe || client;
  const r = await util.run(probeExe, ['--version'], { env: util.cleanEnv({ remove: ['MYSQL_PWD'] }), cwd: bin, timeoutMs: 15000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const folder = win.basename(win.dirname(bin));
  const probed = parseDbVersion(text);
  // When the exe can't run (e.g. missing DLL) fall back to the version in the folder name.
  const fromFolder = /(\d+\.\d+\.\d+)/.exec(folder);
  const version = probed || (fromFolder ? fromFolder[1] : null);
  const kind = /mariadb/i.test(text) || (!probed && (/mariadb/i.test(folder) || /[\\/]mariadb[\\/]/i.test(bin))) ? 'mariadb' : 'mysql';
  let defaultsFile = null;
  for (const c of [win.join(bin, 'my.ini'), win.join(bin, '..', 'my.ini'), win.join(bin, '..', 'data', 'my.ini')]) {
    if (util.existsFile(c)) { defaultsFile = util.cleanPath(c); break; }
  }
  let parsed = { port: null, datadir: null, logError: null, basedir: null, bindAddress: null };
  if (defaultsFile) parsed = ini.parseMyIni(util.readText(defaultsFile, ''), defaultsFile);
  const nice = kind === 'mariadb' ? 'MariaDB' : 'MySQL';
  return {
    id: `db-${kind}-${version || 'unknown'}-${util.hash6(util.normPath(bin))}`,
    kind,
    version,
    serverExe,
    binDir: bin,
    client: tools.client,
    dump: tools.dump,
    admin: tools.admin,
    installDb: tools.installDb,
    defaultsFile,
    port: parsed.port,
    datadir: parsed.datadir,
    logError: parsed.logError,
    label: `${nice} ${version || '?'} · ${cand.root || bin}`,
    ok: !!probed,
    error: probed ? null : (util.firstLine(r.stderr) || util.describeExit(r, probeExe)),
  };
}

// ------------------------------------------------------------------------------------------ scan

/** Full scan; the job function (log, job). Updates ctx cache and runtimes.json. */
async function scan(ctx, log) {
  const r = rt(ctx);
  r.scanning = true;
  try {
    const settings = ctx.store.data.settings;
    const cands = findCandidates(settings.runtimeRoots, settings.extraPaths, { runtimesDir: toolRuntimesDir(ctx) });
    log('info', tr('rt.scanStart', { php: cands.php.length, composer: cands.composer.length, db: cands.db.length }));

    const php = (await util.mapLimit(cands.php, 4, (c) => probePhp(ctx, c).catch((e) => ({
      id: phpId(null, win.dirname(c.path)), version: null, path: c.path, dir: win.dirname(c.path), zts: null, bits: null,
      iniFile: null, iniRelocated: false, ok: false, error: e.message, warnings: [], extensions: [], label: `PHP ? · ${c.path}`, source: c.source,
    })))).sort((a, b) => semver.compare(b.version, a.version) || a.path.localeCompare(b.path));
    for (const p of php) {
      if (p.ok) log('ok', p.iniRelocated ? tr('rt.phpOkRelocated', { version: p.version, dir: p.dir }) : `PHP ${p.version} · ${p.dir}`);
      else log('warn', `PHP ${p.version || '?'} · ${p.dir}: ${p.error}`);
    }

    const bestPhp = php.find((p) => p.ok) || null;
    const composer = (await util.mapLimit(cands.composer, 3, (c) => probeComposer(c, bestPhp)))
      .sort((a, b) => semver.compare(b.version, a.version) || a.path.localeCompare(b.path));
    const firstBySha = new Map();
    for (const c of composer) {
      if (!c.sha256) continue;
      if (firstBySha.has(c.sha256)) c.sameAs = firstBySha.get(c.sha256);
      else firstBySha.set(c.sha256, c.id);
    }
    for (const c of composer) {
      if (c.ok) log('ok', c.sameAs ? tr('rt.composerSame', { version: c.version, path: c.path }) : `Composer ${c.version} · ${c.path}`);
      else log('warn', `Composer · ${c.path}: ${c.error}`);
    }

    const db = (await util.mapLimit(cands.db, 4, (c) => probeDb(c).catch(() => null)))
      .filter(Boolean)
      .sort((a, b) => semver.compare(b.version, a.version) || a.binDir.localeCompare(b.binDir));
    for (const d of db) {
      const what = d.serverExe ? `port ${d.port || '?'} · ${d.datadir || tr('rt.datadirUnknown')}` : tr('rt.clientOnly');
      log(d.ok ? 'ok' : 'warn', `${d.label} — ${what}`);
    }
    const cache = { scannedAt: util.nowIso(), php, composer, db };
    util.writeJsonAtomic(cacheFile(ctx), cache);
    r.cache = cache;
    return {
      php: php.length, phpOk: php.filter((p) => p.ok).length, composer: composer.length, db: db.length,
    };
  } finally {
    r.scanning = false;
  }
}

/** Starts the scan job (or returns the running one). */
function startScan(ctx, jobs) {
  const r = rt(ctx);
  const running = r.jobId ? jobs.getJob(r.jobId) : null;
  if (running && running.status === 'running') return r.jobId;
  r.scanning = true;
  r.jobId = jobs.createJob('runtimes-scan', tr('job.runtimesScan'), (log) => scan(ctx, log));
  return r.jobId;
}

/** Validates and classifies a manually added path. */
function classifyExtraPath(p) {
  const base = win.basename(p).toLowerCase();
  if (base === 'php.exe') return 'php';
  if (base.endsWith('.phar')) return 'composer';
  if (['mysqld.exe', 'mariadbd.exe', 'mysql.exe', 'mariadb.exe'].includes(base)) return 'db';
  return null;
}

// ------------------------------------------------------------------------------------------ lookups

function findPhpByPath(ctx, p) {
  return getCache(ctx).php.find((x) => util.samePath(x.path, p)) || null;
}

/** The runtime for a project: same version + path, else same version (prefer same dir), else null. */
function resolvePhp(ctx, version, phpPath) {
  const list = getCache(ctx).php.filter((x) => x.ok);
  if (phpPath) {
    const exact = list.find((x) => x.version === version && util.samePath(x.path, phpPath));
    if (exact) return exact;
  }
  const same = list.filter((x) => x.version === version);
  if (!same.length) return null;
  if (phpPath) {
    const sameDir = same.find((x) => util.samePath(x.dir, win.dirname(util.cleanPath(phpPath))));
    if (sameDir) return sameDir;
  }
  return same[0];
}

function findComposer(ctx, id) {
  if (!id) return null;
  return getCache(ctx).composer.find((c) => c.id === id) || null;
}

function findDbInstall(ctx, id) {
  return getCache(ctx).db.find((d) => d.id === id) || null;
}

/** Newest MariaDB client (for servers whose own bin we can't use). */
function newestClient(ctx, kind = 'mariadb') {
  const list = getCache(ctx).db.filter((d) => d.ok && d.client && (!kind || d.kind === kind));
  list.sort((a, b) => semver.compare(b.version, a.version));
  return list[0] || null;
}

module.exports = {
  toolRuntimesDir,
  getCache,
  hasCache,
  phpInvocation,
  findCandidates,
  probePhp,
  probeComposer,
  probeDb,
  parseDbVersion,
  scan,
  startScan,
  classifyExtraPath,
  findPhpByPath,
  resolvePhp,
  findComposer,
  findDbInstall,
  newestClient,
};
