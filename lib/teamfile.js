'use strict';
/*
 * phpstation.json — a small file in a project's repository that says what the project needs:
 *
 *   {
 *     "name": "Shop",
 *     "php": "8.2",
 *     "extensions": ["intl", "gd"],
 *     "database": { "engine": "mariadb", "version": "10.11", "name": "shop_db" },
 *     "setup": ["env", "composer-install", "key", "database", "migrate", "storage-link"]
 *   }
 *
 * A teammate who opens the folder in PHP Station gets a plan (what is already here, what will be
 * installed from the official sources) and ONE job that installs the missing PHP / MariaDB /
 * Composer, enables the listed extensions (only in PHP Station's own PHP builds), registers the
 * project, starts its DB server and runs the setup steps. Every .env change makes a backup first
 * (lib/setup.js); an existing database is never dropped.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const semver = require('./semver');
const envfile = require('./envfile');
const runtimes = require('./runtimes');
const dbservers = require('./dbservers');
const installer = require('./installer');
const projects = require('./projects');
const setup = require('./setup');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const FILE = 'phpstation.json';
const SCHEMA_URL = 'https://sami-hussain-dev.github.io/PHP-Station/phpstation.schema.json';
const STEPS = Object.freeze(['env', 'composer-install', 'key', 'database', 'migrate', 'seed', 'storage-link']);
const LARAVEL_DEFAULT_STEPS = Object.freeze(['env', 'composer-install', 'key', 'database', 'migrate', 'storage-link']);
const DB_RE = /^[A-Za-z0-9_$-]{1,64}$/;
const BRANCH_RE = /^\d+\.\d+$/;

function branchOf(v) {
  const n = semver.normalizeVersion(v);
  return n ? `${n[0]}.${n[1]}` : null;
}

// ------------------------------------------------------------------------------------------ validation (PURE)

/** Raw JSON object -> {file, errors[]}. Unknown keys are ignored; bad values are reported. */
function validate(raw) {
  const errors = [];
  const file = { name: null, php: null, extensions: [], database: null, setup: null, port: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file, errors: ['root'] };
  if (raw.name != null) {
    const n = util.cleanText(String(raw.name), 80);
    if (n) file.name = n; else errors.push('name');
  }
  if (raw.php != null) {
    const pv = typeof raw.php === 'number' && Number.isFinite(raw.php) ? String(raw.php) : raw.php;
    const b = typeof pv === 'string' ? (BRANCH_RE.test(pv.trim()) ? pv.trim() : branchOf(pv)) : null;
    if (b) file.php = b; else errors.push('php');
  }
  if (raw.extensions != null) {
    if (!Array.isArray(raw.extensions) || raw.extensions.length > 40) errors.push('extensions');
    else {
      for (const e of raw.extensions) {
        const x = String(e || '').trim().toLowerCase().replace(/^ext-/, '');
        if (/^[a-z0-9_]{1,30}$/.test(x)) { if (!file.extensions.includes(x)) file.extensions.push(x); } else errors.push(`extensions:${String(e).slice(0, 20)}`);
      }
    }
  }
  if (raw.database != null) {
    const d = raw.database;
    if (!d || typeof d !== 'object' || Array.isArray(d)) errors.push('database');
    else {
      const engine = String(d.engine || 'mariadb').toLowerCase();
      const version = d.version == null ? null : (BRANCH_RE.test(String(d.version)) ? String(d.version) : branchOf(d.version));
      const name = d.name == null ? null : String(d.name);
      if (!['mariadb', 'mysql'].includes(engine)) errors.push('database.engine');
      if (d.version != null && !version) errors.push('database.version');
      if (name != null && !DB_RE.test(name)) errors.push('database.name');
      file.database = { engine: ['mariadb', 'mysql'].includes(engine) ? engine : 'mariadb', version, name: name && DB_RE.test(name) ? name : null };
    }
  }
  if (raw.setup != null) {
    if (!Array.isArray(raw.setup)) errors.push('setup');
    else {
      file.setup = [];
      for (const s of raw.setup) {
        const x = String(s || '').trim().toLowerCase();
        if (STEPS.includes(x)) { if (!file.setup.includes(x)) file.setup.push(x); } else errors.push(`setup:${String(s).slice(0, 20)}`);
      }
    }
  }
  if (raw.port != null) {
    const n = Number(raw.port);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) file.port = n; else errors.push('port');
  }
  return { file, errors };
}

/** Reads <dir>\phpstation.json -> {exists, file, errors, raw} (never throws on a bad file). */
function read(dir) {
  const f = win.join(dir, FILE);
  const text = util.readText(f, null);
  if (text == null) return { exists: false, file: null, errors: [] };
  let raw;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch { return { exists: true, file: null, errors: ['json'] }; }
  return Object.assign({ exists: true }, validate(raw));
}

function exists(dir) {
  return util.existsFile(win.join(dir, FILE));
}

// ------------------------------------------------------------------------------------------ export

/** The phpstation.json content for a registered project (from its PHP, DB server and .env). */
function fromProject(ctx, id) {
  const p = projects.getProject(ctx, id);
  const info = projects.inspectProject(p.path);
  const out = { $schema: SCHEMA_URL, name: p.name };
  const b = branchOf(p.phpVersion);
  if (b) out.php = b;
  const ext = info.requiredExt.map((e) => e.replace(/^ext-/, ''));
  if (ext.length) out.extensions = ext;
  const entry = projects.dbEntryFor(ctx, p);
  if (entry || info.env.database) {
    out.database = { engine: entry && entry.kind === 'mysql' ? 'mysql' : 'mariadb' };
    if (entry && entry.version) out.database.version = branchOf(entry.version);
    if (info.env.database && DB_RE.test(info.env.database)) out.database.name = info.env.database;
  }
  out.setup = info.isLaravel ? [...LARAVEL_DEFAULT_STEPS] : (info.hasComposerJson ? ['composer-install'] : []);
  return out;
}

/** Writes phpstation.json into the project (an existing one only with overwrite, after a backup). */
function writeFile(ctx, id, { overwrite = false } = {}) {
  const p = projects.getProject(ctx, id);
  const target = win.join(p.path, FILE);
  let backup = null;
  if (util.existsFile(target)) {
    if (!overwrite) throw new AppError('EXISTS', tr('team.exists'), 409);
    const dir = util.ensureDir(path.join(ctx.dataDir, 'env-backups', p.id));
    backup = path.join(dir, `${FILE}.${util.stamp()}`);
    fs.copyFileSync(target, backup);
  }
  const content = `${JSON.stringify(fromProject(ctx, id), null, 2)}\n`;
  fs.writeFileSync(target, content);
  ctx.log(`teamfile written ${target}${backup ? ` (backup ${backup})` : ''}`);
  return { path: target, backup, content };
}

// ------------------------------------------------------------------------------------------ plan

function newestOf(list) {
  return list.slice().sort((a, b) => semver.compare(b.version, a.version))[0] || null;
}

async function catalogItems(ctx, kind) {
  try { return { items: (await installer.getCatalog(ctx, kind)).items, error: null }; } catch (e) { return { items: [], error: e.message || String(e) }; }
}

/**
 * POST /api/teamfile/plan {path}: what this machine already has and what would be installed.
 * Never changes anything.
 */
/**
 * What a project without phpstation.json most likely needs (a fresh clone): its .env.example /
 * .env tells the database (MySQL/MariaDB -> a MariaDB server, SQLite -> none). PURE over the texts.
 */
function implicitFile(dir, envText) {
  const env = envfile.parseEnv(envText || '');
  const conn = String(env.DB_CONNECTION || '').toLowerCase();
  const name = env.DB_DATABASE && DB_RE.test(env.DB_DATABASE) ? env.DB_DATABASE : null;
  const database = /^(mysql|mariadb)$/.test(conn) ? { engine: 'mariadb', version: null, name } : null;
  return { name: null, php: null, extensions: [], database, setup: null, port: null };
}

async function plan(ctx, dir, { implicit = false } = {}) {
  const d = util.checkUserPath(dir, { kind: 'dir', label: tr('label.projectFolder') });
  let r = read(d);
  if (!r.exists && implicit) {
    const envText = util.readText(win.join(d, '.env'), null) || util.readText(win.join(d, '.env.example'), '') || '';
    r = { exists: false, implicit: true, file: implicitFile(d, envText), errors: [] };
  }
  if (!r.exists && !r.implicit) throw new AppError('NO_TEAMFILE', tr('team.none', { file: FILE }), 404);
  if (!r.file) throw new AppError('BAD_TEAMFILE', tr('team.badJson', { file: FILE }), 400);
  const f = r.file;
  const info = projects.inspectProject(d);
  const cache = runtimes.getCache(ctx);
  const already = (ctx.store.data.projects || []).find((p) => util.samePath(p.path, d)) || null;
  const out = {
    path: d, file: f, errors: r.errors, name: f.name || win.basename(d), isLaravel: info.isLaravel, implicit: !!r.implicit,
    alreadyAdded: already ? already.id : null, installs: [], notes: [],
  };

  // ---- PHP
  const phpOk = cache.php.filter((p) => p.ok && p.version);
  const branch = f.php || (() => {
    // no "php" in the file: the newest installed PHP that composer.json allows
    const s = projects.suggestPhp(info, phpOk).find((x) => x.satisfies !== false && !x.hint);
    return s ? branchOf(s.version) : null;
  })();
  const havePhp = branch ? newestOf(phpOk.filter((p) => branchOf(p.version) === branch)) : null;
  out.php = { want: branch, have: havePhp ? { version: havePhp.version, path: havePhp.path } : null, install: null };
  if (branch && !havePhp) {
    const cat = await catalogItems(ctx, 'php');
    const item = cat.items.find((it) => branchOf(it.version) === branch);
    if (item) { out.php.install = { kind: 'php', version: item.version, sizeMB: item.sizeMB || null }; out.installs.push(out.php.install); } else out.notes.push({ level: 'bad', key: cat.error ? 'team.noNet' : 'team.noPhpBranch', params: { branch, error: cat.error || '' } });
  }
  if (!branch) out.notes.push({ level: 'warn', key: 'team.noPhpChoice', params: {} });

  // ---- extensions (checked on the PHP that will be used; a new install is checked after it)
  const phpForExt = havePhp;
  out.extensions = f.extensions.map((name) => {
    if (!phpForExt) return { name, state: 'later' };
    if (phpForExt.extensions.includes(name)) return { name, state: 'ok' };
    const ours = util.isInside(phpForExt.path, runtimes.toolRuntimesDir(ctx));
    const dll = util.existsFile(win.join(phpForExt.dir, 'ext', `php_${name}.dll`));
    return { name, state: ours && dll ? 'enable' : dll ? 'manual' : 'missing' };
  });

  // ---- DB server
  const entries = dbservers.buildEntries(ctx);
  if (f.database) {
    const want = f.database;
    const fits = entries.filter((e) => (want.engine === 'mysql' ? e.kind === 'mysql' : e.kind === 'mariadb') && (!want.version || branchOf(e.version) === want.version));
    const pick = fits.find((e) => !e.missingInstall && e.serverExe) || null;
    out.db = { want, have: pick ? { id: pick.id, label: pick.label, port: pick.effectivePort } : null, install: null };
    if (!pick) {
      if (want.engine === 'mysql') {
        const any = entries.find((e) => e.kind === 'mysql') || entries.find((e) => e.serverExe);
        out.db.have = any ? { id: any.id, label: any.label, port: any.effectivePort } : null;
        out.notes.push({ level: 'warn', key: 'team.mysqlNoInstall', params: { version: want.version || '' } });
      } else {
        const cat = await catalogItems(ctx, 'mariadb');
        const item = want.version ? cat.items.find((it) => branchOf(it.version) === want.version) : (cat.items.find((it) => it.lts && !it.eol) || cat.items[0]);
        if (item) { out.db.install = { kind: 'mariadb', version: item.version, sizeMB: item.sizeMB || null }; out.installs.push(out.db.install); } else {
          const any = entries.find((e) => e.kind === 'mariadb' && e.serverExe);
          out.db.have = any ? { id: any.id, label: any.label, port: any.effectivePort } : null;
          out.notes.push({ level: 'warn', key: cat.error ? 'team.noNet' : 'team.noDbVersion', params: { version: want.version || '', error: cat.error || '' } });
        }
      }
    }
  } else {
    out.db = null;
  }

  // ---- Composer
  const comp = newestOf(cache.composer.filter((c) => c.ok && !c.sameAs));
  out.composer = { have: comp ? { id: comp.id, version: comp.version } : null, install: null };
  if (!comp && (info.hasComposerJson || info.isLaravel)) {
    const cat = await catalogItems(ctx, 'composer');
    const item = cat.items.find((x) => !x.lts) || cat.items[0];
    if (item) { out.composer.install = { kind: 'composer', version: item.version }; out.installs.push(out.composer.install); }
  }

  out.steps = f.setup || (info.isLaravel ? [...LARAVEL_DEFAULT_STEPS] : (info.hasComposerJson ? ['composer-install'] : []));
  return out;
}

// ------------------------------------------------------------------------------------------ apply

/** php.ini of one of PHP Station's own PHP builds: adds extension=<name> lines (backup first). */
function enableExtensions(ctx, php, names, log) {
  if (!util.isInside(php.path, runtimes.toolRuntimesDir(ctx))) return [];
  const ini = win.join(php.dir, 'php.ini');
  const text = util.readText(ini, null);
  if (text == null) return [];
  const add = names.filter((n) => util.existsFile(win.join(php.dir, 'ext', `php_${n}.dll`)) && !installer.iniLoadsExtension(text, n));
  if (!add.length) return [];
  fs.copyFileSync(ini, `${ini}.${util.stamp()}.bak`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(ini, `${text.replace(/\s+$/, '')}${eol}; added by PHP Station for phpstation.json${eol}${add.map((n) => `extension=${n}`).join(eol)}${eol}`);
  log('ok', tr('team.extEnabled', { list: add.join(', '), version: php.version }));
  return add;
}

async function artisanStep(ctx, p, php, args, log, { allowFail = false } = {}) {
  log('info', `php artisan ${args.join(' ')}`);
  const r = await setup.artisan(ctx, p, php, args, log, 30 * 60 * 1000);
  if (r.code !== 0 && !allowFail) {
    throw new AppError('COMMAND_FAILED', tr('team.stepFailed', { step: `artisan ${args[0]}`, line: util.firstLine(r.stderr) || util.firstLine(r.stdout) || util.describeExit(r, php.path) }), 500);
  }
  return r.code === 0;
}

/** The one job: installs, extensions, project record, DB server, setup steps. */
async function applyJob(ctx, dir, log, job, opts = {}) {
  const pl = await plan(ctx, dir, opts);
  const f = pl.file;
  const total = pl.installs.length + 3 + pl.steps.length;
  let stepNo = 0;
  const progress = (stage) => { job.progress = { stage, done: stepNo++, total }; };

  // 1. installs (official sources, SHA-256 checked)
  const installed = {};
  for (const it of pl.installs) {
    progress('install');
    log('info', tr('team.installing', { what: `${it.kind} ${it.version}` }));
    const r = await installer.installJob(ctx, it, (lvl, text) => log(lvl, `  ${text}`), job);
    installed[it.kind] = r;
  }

  // 2. PHP + extensions
  progress('php');
  const cache = runtimes.getCache(ctx);
  const phpOk = cache.php.filter((p) => p.ok && p.version);
  let php = pl.php.want ? newestOf(phpOk.filter((p) => branchOf(p.version) === pl.php.want)) : null;
  if (!php) {
    const info = projects.inspectProject(pl.path);
    const s = projects.suggestPhp(info, phpOk)[0];
    php = s ? runtimes.resolvePhp(ctx, s.version, s.path) : null;
  }
  if (!php) throw new AppError('PHP_MISSING', tr('err.noPhpRuntime'), 409);
  log('ok', tr('team.phpChosen', { version: php.version, path: php.path }));
  const missingExt = f.extensions.filter((n) => !php.extensions.includes(n));
  if (missingExt.length) {
    const added = enableExtensions(ctx, php, missingExt, log);
    if (added.length) {
      await runtimes.scan(ctx, () => {});
      php = runtimes.resolvePhp(ctx, php.version, php.path) || php;
    }
    const still = missingExt.filter((n) => !php.extensions.includes(n));
    if (still.length) log('warn', tr('team.extMissing', { list: still.join(', '), version: php.version }));
  }

  // 3. DB server
  progress('db');
  let dbServerId = null;
  if (installed.mariadb && installed.mariadb.instanceId) dbServerId = installed.mariadb.instanceId;
  else if (pl.db && pl.db.have) dbServerId = pl.db.have.id;

  // 4. project record (a registered project is updated only while it is stopped)
  progress('project');
  const comp = newestOf(runtimes.getCache(ctx).composer.filter((c) => c.ok && !c.sameAs));
  let p = (ctx.store.data.projects || []).find((x) => util.samePath(x.path, pl.path)) || null;
  if (p) {
    const patch = { phpVersion: php.version, phpPath: php.path };
    if (dbServerId) patch.dbServerId = dbServerId;
    if (!p.composerId && comp) patch.composerId = comp.id;
    p = await projects.updateProject(ctx, p.id, patch);
    log('ok', tr('team.projectUpdated', { name: p.name }));
  } else {
    p = await projects.addProject(ctx, {
      path: pl.path, name: f.name || win.basename(pl.path), phpVersion: php.version, phpPath: php.path,
      composerId: comp ? comp.id : null, dbServerId, port: f.port || undefined,
    });
    log('ok', tr('team.projectAdded', { name: p.name, port: p.port }));
  }

  if (dbServerId && pl.steps.some((s) => ['database', 'migrate', 'seed'].includes(s))) {
    const { status } = await dbservers.isEntryRunning(ctx, dbServerId);
    if (status.status !== 'running') {
      const e = dbservers.getEntry(ctx, dbServerId);
      log('info', tr('team.dbStarting', { label: e.label }));
      await dbservers.startServer(ctx, dbServerId, { log: (lvl, text) => log(lvl, `  ${text}`) });
    }
  }

  // 5. setup steps
  const needPhpExe = () => projects.resolveProjectPhp(ctx, p) || php;
  const envPath = win.join(p.path, '.env');
  for (const step of STEPS.filter((s) => pl.steps.includes(s))) {
    progress(step);
    log('info', `— ${tr(`team.step.${step}`)}`);
    if (step === 'env') {
      const actions = ['CREATE_ENV'];
      if (dbServerId) actions.push('SET_DB');
      if (pl.isLaravel) actions.push('SET_APP_URL');
      await setup.setupJob(ctx, p.id, actions.filter((a) => a !== 'CREATE_ENV' || !util.existsFile(envPath)), log, { progress: null });
      if (f.database && f.database.name && util.existsFile(envPath)) {
        const w = setup.writeEnv(ctx, p, { DB_DATABASE: f.database.name });
        if (w.changed.length) log('ok', tr('setup.envKeys', { keys: 'DB_DATABASE' }));
      }
    } else if (step === 'composer-install') {
      if (projects.inspectProject(p.path).vendor) { log('info', tr('team.vendorThere')); continue; }
      await setup.setupJob(ctx, p.id, ['COMPOSER_INSTALL'], log, { progress: null });
    } else if (step === 'key') {
      if (!pl.isLaravel) continue;
      await setup.setupJob(ctx, p.id, ['GENERATE_KEY'], log, { progress: null });
    } else if (step === 'database') {
      const env = envfile.parseEnv(util.readText(envPath, '') || '');
      if (String(env.DB_CONNECTION || '').toLowerCase() === 'sqlite') {
        // Laravel 11+ default: an empty database\database.sqlite (what `laravel new` makes)
        const file = env.DB_DATABASE && /\.sqlite$/i.test(env.DB_DATABASE) && win.isAbsolute(env.DB_DATABASE) ? env.DB_DATABASE : win.join(p.path, 'database', 'database.sqlite');
        if (!util.existsFile(file) && util.isInside(file, p.path)) {
          util.ensureDir(win.dirname(file));
          fs.writeFileSync(file, '');
          log('ok', tr('team.sqliteCreated', { file: win.relative(p.path, file) }));
        } else log('info', tr('team.dbExists', { db: win.basename(file) }));
        continue;
      }
      const db = env.DB_DATABASE;
      const entry = projects.dbEntryFor(ctx, p);
      if (!entry || !db || !DB_RE.test(db)) { log('warn', tr('team.noDbToCreate')); continue; }
      const creds = dbservers.resolveCreds(ctx, null, p.id);
      if (await dbservers.databaseExists(ctx, entry, db, creds)) { log('info', tr('team.dbExists', { db })); continue; }
      await dbservers.query(ctx, entry, `CREATE DATABASE \`${db.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`, creds);
      log('ok', tr('team.dbCreated', { db, label: entry.label }));
    } else if (step === 'migrate') {
      if (!pl.isLaravel) continue;
      await artisanStep(ctx, p, needPhpExe(), ['migrate', '--force'], log);
    } else if (step === 'seed') {
      if (!pl.isLaravel) continue;
      await artisanStep(ctx, p, needPhpExe(), ['db:seed', '--force'], log);
    } else if (step === 'storage-link') {
      if (!pl.isLaravel) continue;
      if (util.existsDir(win.join(p.path, 'public', 'storage'))) { log('info', tr('team.linkThere')); continue; }
      await artisanStep(ctx, p, needPhpExe(), ['storage:link'], log, { allowFail: true });
    }
  }
  job.progress = { stage: 'done', done: total, total };
  log('ok', tr('team.done', { name: p.name }));
  return { projectId: p.id, name: p.name, port: p.port };
}

module.exports = { FILE, STEPS, SCHEMA_URL, validate, read, exists, implicitFile, fromProject, writeFile, plan, applyJob, branchOf };
