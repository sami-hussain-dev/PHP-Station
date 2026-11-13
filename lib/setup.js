'use strict';
/*
 * Project environment set up by PHP Station (checklist): CREATE_ENV, SET_DB, SET_APP_URL,
 * COMPOSER_INSTALL, GENERATE_KEY. The .env is never overwritten as a whole: CREATE_ENV only
 * copies .env.example when .env is missing, every other change makes a backup in
 * <data>\env-backups\<id>\ first and only touches its own keys (setEnvValues).
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const semver = require('./semver');
const envfile = require('./envfile');
const runtimes = require('./runtimes');
const projects = require('./projects');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;

// Execution order. COMPOSER_INSTALL runs before GENERATE_KEY because artisan needs vendor\.
const ACTIONS = Object.freeze(['CREATE_ENV', 'SET_DB', 'SET_APP_URL', 'COMPOSER_INSTALL', 'GENERATE_KEY']);

/** Database name from a project name: lower case, [a-z0-9_], max 64 (PURE). */
function dbNameFromProject(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64).replace(/_+$/g, '');
  return s || 'laravel';
}

function appUrlFor(port) {
  return `http://127.0.0.1:${port}`;
}

function sameUrl(a, b) {
  return String(a || '').trim().replace(/\/+$/, '').toLowerCase() === String(b || '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Suggested actions (PURE). facts = {isLaravel, hasComposerJson, vendor, projectPort,
 * server:{port}|null, envExists, exampleExists, env:{...values of .env, or of .env.example when
 * .env is missing}}.
 */
function suggestActions(facts) {
  const f = facts || {};
  const env = f.env || {};
  const out = [];
  const createEnv = !f.envExists && !!f.exampleExists;
  const willHaveEnv = !!f.envExists || createEnv;
  if (createEnv) out.push('CREATE_ENV');
  const conn = String(env.DB_CONNECTION || '').trim();
  if (willHaveEnv && f.server && (!conn || /^(mysql|mariadb)$/i.test(conn))) {
    const host = String(env.DB_HOST || '').trim();
    const port = Number.parseInt(env.DB_PORT, 10);
    if (!conn || !host || !util.isLocalHost(host) || port !== Number(f.server.port) || !env.DB_DATABASE || !env.DB_USERNAME) out.push('SET_DB');
  }
  if (f.isLaravel && willHaveEnv && Number.isInteger(f.projectPort) && !sameUrl(env.APP_URL, appUrlFor(f.projectPort))) out.push('SET_APP_URL');
  if ((f.isLaravel || f.hasComposerJson) && !f.vendor) out.push('COMPOSER_INSTALL');
  if (f.isLaravel && willHaveEnv && !String(env.APP_KEY || '').trim()) out.push('GENERATE_KEY');
  return out;
}

function readEnvFiles(dir) {
  const envText = util.readText(win.join(dir, '.env'), null);
  const exampleText = util.readText(win.join(dir, '.env.example'), null);
  return { envText, exampleText };
}

/** GET /api/projects/:id/setup */
function setupInfo(ctx, id) {
  const p = projects.getProject(ctx, id);
  const info = projects.inspectProject(p.path);
  const { envText, exampleText } = readEnvFiles(p.path);
  const values = envfile.parseEnv(envText != null ? envText : (exampleText || ''));
  const entry = projects.dbEntryFor(ctx, p);
  const server = entry ? { id: entry.id, port: entry.effectivePort } : null;
  const port = Number.parseInt(values.DB_PORT, 10);
  const actions = info.exists ? suggestActions({
    isLaravel: info.isLaravel,
    hasComposerJson: info.hasComposerJson,
    vendor: info.vendor,
    projectPort: p.port,
    server,
    envExists: envText != null,
    exampleExists: exampleText != null,
    env: values,
  }) : [];
  return {
    isLaravel: info.isLaravel,
    env: {
      exists: envText != null,
      exampleExists: exampleText != null,
      appKeySet: !!String(values.APP_KEY || '').trim(),
      appUrl: values.APP_URL || null,
      dbHost: values.DB_HOST || null,
      dbPort: Number.isInteger(port) ? port : null,
      dbDatabase: values.DB_DATABASE || null,
    },
    vendor: info.vendor,
    composerSelected: !!(p.composerId && runtimes.findComposer(ctx, p.composerId)),
    server,
    projectPort: p.port,
    actions,
  };
}

/** Validates POST /api/projects/:id/setup before the job; returns the actions in run order. */
function prepare(ctx, id, body) {
  const p = projects.getProject(ctx, id);
  const list = body && body.actions;
  if (!Array.isArray(list) || !list.length || list.length > ACTIONS.length) throw new AppError('BAD_INPUT', tr('setup.badActions'), 400);
  for (const a of list) if (typeof a !== 'string' || !ACTIONS.includes(a)) throw new AppError('BAD_INPUT', tr('setup.unknownAction', { action: String(a).slice(0, 30) }), 400);
  if (!util.existsDir(p.path)) throw new AppError('NOT_FOUND', tr('err.projectFolderMissing', { path: p.path }), 404);
  if (list.includes('SET_DB') && !projects.dbEntryFor(ctx, p)) throw new AppError('NO_DB_SERVER', tr('setup.needDbServer'), 409);
  return ACTIONS.filter((a) => list.includes(a));
}

/** Unique backup file name in <data>\env-backups\<id>\ (never replaces an earlier backup). */
function backupEnv(ctx, p, raw) {
  const dir = util.ensureDir(path.join(ctx.dataDir, 'env-backups', p.id));
  const base = path.join(dir, `.env.${util.stamp()}`);
  let file = base;
  for (let i = 2; fs.existsSync(file); i++) file = `${base}-${i}`;
  fs.writeFileSync(file, raw, { flag: 'wx' });
  return file;
}

/** Applies updates to .env (backup first); returns {changed, backup}. Values are never logged. */
function writeEnv(ctx, p, updates) {
  const envPath = win.join(p.path, '.env');
  if (!util.existsFile(envPath)) throw new AppError('NO_ENV', tr('err.noEnv'), 404);
  const raw = fs.readFileSync(envPath);
  const text = util.readText(envPath, '');
  const cur = envfile.parseEnv(text);
  const changed = Object.keys(updates).filter((k) => cur[k] !== updates[k]);
  if (!changed.length) return { changed, backup: null };
  const backup = backupEnv(ctx, p, raw);
  const sub = {};
  for (const k of changed) sub[k] = updates[k];
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? '﻿' : '';
  fs.writeFileSync(envPath, bom + envfile.setEnvValues(text, sub));
  ctx.log(`setup ${p.id}: .env keys ${changed.join(',')} (backup ${backup})`);
  return { changed, backup };
}

/** Streams a child's output lines into the job log (no secrets: drops lines with keys). */
function lineLogger(log, prefix = '') {
  let buf = '';
  let count = 0;
  const emit = (line) => {
    const t = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (!t || /base64:[A-Za-z0-9+/=]{20,}/.test(t)) return;
    if (count++ < 2000) log('info', `${prefix}${t.slice(0, 400)}`);
  };
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      parts.forEach(emit);
    },
    flush() { if (buf) emit(buf); buf = ''; },
  };
}

function pickComposer(ctx, p) {
  return runtimes.findComposer(ctx, p.composerId)
    || runtimes.getCache(ctx).composer.filter((c) => c.ok && !c.sameAs).sort((a, b) => semver.compare(b.version, a.version))[0]
    || null;
}

async function artisan(ctx, p, php, args, log, timeoutMs = 120000) {
  const inv = runtimes.phpInvocation(php);
  const out = lineLogger(log, '  ');
  const r = await util.run(inv.file, [...inv.preArgs, 'artisan', ...args, '--no-ansi'], {
    cwd: p.path, env: projects.projectEnv(ctx, p, php, projects.dbEntryFor(ctx, p)), timeoutMs,
    onStdout: (d) => out.push(d), onStderr: (d) => out.push(d),
  });
  out.flush();
  return r;
}

/** The setup job: runs the chosen actions in ACTIONS order; stops at the first failure. */
async function setupJob(ctx, id, actions, log, job) {
  const p = projects.getProject(ctx, id);
  const done = [];
  const skipped = [];
  const backups = [];
  let envChanged = false;
  const envPath = win.join(p.path, '.env');
  const needPhp = () => {
    const php = projects.resolveProjectPhp(ctx, p);
    if (!php) throw projects.phpMissingError(p.phpVersion);
    return php;
  };
  for (const action of actions) {
    job.progress = { stage: action, done: done.length + skipped.length, total: actions.length };
    log('info', `— ${tr(`setup.action.${action}`)}`);
    switch (action) {
      case 'CREATE_ENV': {
        if (util.existsFile(envPath)) { log('info', tr('setup.envExists')); skipped.push(action); break; }
        const example = win.join(p.path, '.env.example');
        if (!util.existsFile(example)) throw new AppError('NO_ENV_EXAMPLE', tr('setup.noExample'), 404);
        fs.copyFileSync(example, envPath, fs.constants.COPYFILE_EXCL);
        envChanged = true;
        log('ok', tr('setup.envCreated'));
        done.push(action);
        break;
      }
      case 'SET_DB': {
        const entry = projects.dbEntryFor(ctx, p);
        if (!entry) throw new AppError('NO_DB_SERVER', tr('setup.needDbServer'), 409);
        const cur = envfile.parseEnv(util.readText(envPath, '') || '');
        const updates = { DB_HOST: '127.0.0.1', DB_PORT: String(entry.effectivePort) };
        if (!String(cur.DB_CONNECTION || '').trim()) updates.DB_CONNECTION = 'mysql';
        if (!String(cur.DB_DATABASE || '').trim()) updates.DB_DATABASE = dbNameFromProject(p.name);
        if (!String(cur.DB_USERNAME || '').trim()) updates.DB_USERNAME = 'root';
        const r = writeEnv(ctx, p, updates);
        if (r.backup) backups.push(r.backup);
        if (r.changed.length) { envChanged = true; log('ok', tr('setup.envKeys', { keys: r.changed.join(', ') })); done.push(action); } else { log('info', tr('setup.nothingToChange')); skipped.push(action); }
        break;
      }
      case 'SET_APP_URL': {
        const r = writeEnv(ctx, p, { APP_URL: appUrlFor(p.port) });
        if (r.backup) backups.push(r.backup);
        if (r.changed.length) { envChanged = true; log('ok', tr('setup.appUrl', { url: appUrlFor(p.port) })); done.push(action); } else { log('info', tr('setup.nothingToChange')); skipped.push(action); }
        break;
      }
      case 'COMPOSER_INSTALL': {
        const php = needPhp();
        const comp = pickComposer(ctx, p);
        if (!comp) throw new AppError('NO_COMPOSER', tr('setup.noComposer'), 409);
        if (!p.composerId) log('info', tr('check.composerFallback', { version: comp.version }));
        const inv = runtimes.phpInvocation(php);
        log('info', `composer install --no-interaction (PHP ${php.version}, Composer ${comp.version})`);
        const out = lineLogger(log, '  ');
        const env = projects.projectEnv(ctx, p, php, projects.dbEntryFor(ctx, p));
        env.COMPOSER_NO_INTERACTION = '1';
        const r = await util.run(inv.file, [...inv.preArgs, comp.path, 'install', '--no-interaction', '--no-ansi'], {
          cwd: p.path, env, timeoutMs: 30 * 60 * 1000, onStdout: (d) => out.push(d), onStderr: (d) => out.push(d),
        });
        out.flush();
        if (r.code !== 0) {
          const line = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).find((l) => /error|problem|fail/i.test(l));
          throw new AppError('COMMAND_FAILED', tr('setup.composerFailed', { line: line || util.describeExit(r, inv.file) }), 500);
        }
        log('ok', tr('setup.composerOk'));
        done.push(action);
        break;
      }
      case 'GENERATE_KEY': {
        const cur = envfile.parseEnv(util.readText(envPath, '') || '');
        if (!util.existsFile(envPath)) throw new AppError('NO_ENV', tr('err.noEnv'), 404);
        if (String(cur.APP_KEY || '').trim()) { log('info', tr('setup.keyExists')); skipped.push(action); break; }
        if (!util.existsFile(win.join(p.path, 'artisan'))) throw new AppError('NOT_LARAVEL', tr('err.notLaravel'), 400);
        if (!util.existsFile(win.join(p.path, 'vendor', 'autoload.php'))) throw new AppError('NO_VENDOR', tr('setup.keyNeedsVendor'), 409);
        const php = needPhp();
        backups.push(backupEnv(ctx, p, fs.readFileSync(envPath)));
        const r = await artisan(ctx, p, php, ['key:generate', '--force'], log);
        const after = envfile.parseEnv(util.readText(envPath, '') || '');
        if (r.code !== 0 || !String(after.APP_KEY || '').trim()) {
          throw new AppError('COMMAND_FAILED', tr('setup.keyFailed', { line: util.firstLine(r.stderr) || util.firstLine(r.stdout) || util.describeExit(r, php.path) }), 500);
        }
        envChanged = true;
        ctx.log(`setup ${p.id}: APP_KEY generated`);
        log('ok', tr('setup.keyOk'));
        done.push(action);
        break;
      }
      default:
        throw new AppError('BAD_INPUT', tr('setup.unknownAction', { action }), 400);
    }
  }
  let configCleared = null;
  if (envChanged && util.existsFile(win.join(p.path, 'bootstrap', 'cache', 'config.php'))) {
    const php = projects.resolveProjectPhp(ctx, p);
    if (php) {
      const r = await artisan(ctx, p, php, ['config:clear'], log, 60000);
      configCleared = r.code === 0;
      if (configCleared) log('ok', tr('setup.configCleared'));
      else log('warn', tr('msg.configClearFailed', { line: util.firstLine(r.stderr) || util.firstLine(r.stdout) }));
    } else {
      configCleared = false;
      log('warn', tr('msg.configClearNoPhp'));
    }
  }
  job.progress = { stage: 'done', done: actions.length, total: actions.length };
  return { done, skipped, backups, configCleared };
}

module.exports = { ACTIONS, dbNameFromProject, suggestActions, setupInfo, prepare, setupJob, backupEnv, writeEnv, artisan };
