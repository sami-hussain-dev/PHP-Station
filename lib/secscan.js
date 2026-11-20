'use strict';
/*
 * Security scan of a project, three parts:
 *   1. Known vulnerabilities in the installed packages: `composer audit` with the project's own PHP and
 *      Composer. Composer sends the package names and versions to packagist.org to look them up.
 *   2. The code: vibe-security (https://github.com/sami-hussain-dev/vibe-security, same author, MIT,
 *      zero dependencies): leaked keys, injections, open endpoints, unsafe uploads, cloud misconfig.
 *      A copy installed with npm is used when there is one; otherwise npm fetches it from GitHub the
 *      first time (the user ticks this in the dialog). The scan itself runs offline.
 *   3. Serving mistakes PHP Station can see itself: debug mode on with APP_ENV=production, .env / .git
 *      / phpinfo() inside the public folder, an empty APP_KEY.
 * Nothing in the project is changed. Results stay on this PC.
 */

const fs = require('fs');
const path = require('path');
const util = require('./util');
const runtimes = require('./runtimes');
const projects = require('./projects');
const semver = require('./semver');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const VIBE_GITHUB = 'github:sami-hussain-dev/vibe-security';
const SEV = ['critical', 'high', 'medium', 'low'];

// ------------------------------------------------------------------------------------------ PURE

/** `composer audit --format=json` output -> {advisories[], abandoned[]}. PURE. */
function parseAudit(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let j;
  try { j = JSON.parse(s.slice(start)); } catch { return null; }
  const advisories = [];
  for (const [pkg, list] of Object.entries(j.advisories || {})) {
    for (const a of Array.isArray(list) ? list : Object.values(list || {})) {
      advisories.push({
        package: a.packageName || pkg, title: a.title || '', cve: a.cve || null, link: a.link || null,
        affected: a.affectedVersions || '', severity: String(a.severity || 'unknown').toLowerCase(), reportedAt: a.reportedAt || null,
      });
    }
  }
  const order = (x) => { const i = SEV.indexOf(x.severity); return i < 0 ? 9 : i; };
  advisories.sort((a, b) => order(a) - order(b) || a.package.localeCompare(b.package));
  const abandoned = Object.entries(j.abandoned || {}).map(([name, replacement]) => ({ name, replacement: typeof replacement === 'string' ? replacement : null }));
  return { advisories, abandoned };
}

/** vibe-security JSON report -> findings sorted by severity (at most 300). PURE. */
function parseVibe(j) {
  if (!j || !Array.isArray(j.findings)) return null;
  const order = (x) => { const i = SEV.indexOf(x.severity); return i < 0 ? 9 : i; };
  const findings = j.findings.map((f) => ({
    id: f.id, severity: String(f.severity || 'low').toLowerCase(), category: f.category || null, title: f.title || f.id,
    why: f.why || null, fix: f.fix || null, ur: f.ur || null, file: f.file || null, line: Number.isInteger(f.line) ? f.line : null,
    snippet: typeof f.snippet === 'string' ? f.snippet.slice(0, 240) : null,
  })).sort((a, b) => order(a) - order(b) || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  return { findings: findings.slice(0, 300), total: findings.length, summary: j.summary || null, score: j.score == null ? null : typeof j.score === 'object' ? (Number.isFinite(j.score.value) ? j.score.value : null) : j.score, grade: j.score && typeof j.score === 'object' ? j.score.grade || null : null, version: j.version || null, files: j.filesScanned || null };
}

/** .env text -> {APP_ENV, APP_DEBUG, APP_KEY} (only these). PURE. */
function envFlags(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(APP_ENV|APP_DEBUG|APP_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// ------------------------------------------------------------------------------------------ local checks

function localChecks(p) {
  const inf = projects.inspectProject(p.path);
  const out = [];
  const env = envFlags(util.readText(win.join(p.path, '.env'), ''));
  if (/^(true|1|on|yes)$/i.test(env.APP_DEBUG || '') && /^prod/i.test(env.APP_ENV || '')) out.push({ id: 'DEBUG_IN_PROD', severity: 'high' });
  if (inf.isLaravel && util.existsFile(win.join(p.path, '.env')) && env.APP_KEY !== undefined && !env.APP_KEY) out.push({ id: 'NO_APP_KEY', severity: 'medium' });
  const docroot = inf.docroot;
  if (docroot) {
    if (util.existsFile(win.join(docroot, '.env'))) out.push({ id: 'ENV_PUBLIC', severity: 'critical', file: win.relative(p.path, win.join(docroot, '.env')) || '.env' });
    if (util.existsDir(win.join(docroot, '.git'))) out.push({ id: 'GIT_PUBLIC', severity: 'high', file: win.relative(p.path, win.join(docroot, '.git')) || '.git' });
    for (const name of util.listFileNames(docroot).filter((n) => /\.php$/i.test(n)).slice(0, 400)) {
      const text = util.readText(win.join(docroot, name), '') || '';
      if (text.length < 200000 && /\bphpinfo\s*\(\s*\)/i.test(text)) out.push({ id: 'PHPINFO_PUBLIC', severity: 'medium', file: win.relative(p.path, win.join(docroot, name)) });
    }
    for (const n of util.listFileNames(docroot)) {
      if (/\.(sql|sql\.gz|bak|old|zip|tar|gz|7z|rar)$/i.test(n) || /^(backup|dump|db)[^/]*\.(sql|zip)$/i.test(n)) out.push({ id: 'BACKUP_PUBLIC', severity: 'high', file: win.relative(p.path, win.join(docroot, n)) });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ vibe-security

/** How to run vibe-security: an npm-installed copy, else npx from GitHub (needs `allowFetch`). */
function vibeCommand({ allowFetch }) {
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'vibe-security', 'bin', 'vibe-security.js'));
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'vibe-security', 'bin', 'vibe-security.js'));
  for (const c of candidates) if (util.existsFile(c)) return { file: process.execPath, pre: [c], source: 'installed', where: c };
  if (!allowFetch) return null;
  const npx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!util.existsFile(npx)) return null;
  return { file: process.execPath, pre: [npx, '--yes', VIBE_GITHUB], source: 'github', where: VIBE_GITHUB };
}

// ------------------------------------------------------------------------------------------ job

function info(ctx, id) {
  const p = projects.getProject(ctx, id);
  const vibe = vibeCommand({ allowFetch: false });
  return {
    hasLock: util.existsFile(win.join(p.path, 'composer.lock')),
    composer: !!pickComposer(ctx, p),
    vibeInstalled: !!vibe,
    npx: util.existsFile(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')),
  };
}

function pickComposer(ctx, p) {
  return runtimes.findComposer(ctx, p.composerId)
    || runtimes.getCache(ctx).composer.filter((c) => c.ok && !c.sameAs).sort((a, b) => semver.compare(b.version, a.version))[0]
    || null;
}

async function runJob(ctx, id, opts, log, job) {
  const p = projects.getProject(ctx, id);
  if (!util.existsDir(p.path)) throw new AppError('NOT_FOUND', tr('err.projectFolderMissing', { path: p.path }), 404);
  const result = { startedAt: util.nowIso() };
  const progress = (phase) => { if (job) job.progress = { phase }; };

  // 3 first: instant
  result.local = localChecks(p);
  log(result.local.length ? 'warn' : 'ok', tr('sec.local', { n: result.local.length }));

  // 1. composer audit
  if (opts.audit !== false) {
    progress('audit');
    const php = projects.resolveProjectPhp(ctx, p);
    const comp = pickComposer(ctx, p);
    if (!util.existsFile(win.join(p.path, 'composer.lock'))) result.audit = { skipped: 'NO_LOCK' };
    else if (!php || !comp) result.audit = { skipped: 'NO_COMPOSER' };
    else {
      log('info', tr('sec.auditStart', { version: comp.version }));
      const inv = runtimes.phpInvocation(php);
      const env = util.cleanEnv({ set: { COMPOSER_NO_INTERACTION: '1' } });
      const r = await util.run(inv.file, [...inv.preArgs, comp.path, 'audit', '--format=json', '--locked', '--no-interaction', '--no-ansi'],
        { cwd: p.path, env, timeoutMs: 180000 });
      const parsed = parseAudit(r.stdout);
      if (!parsed) {
        const line = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^\s*$/.test(l));
        result.audit = { error: /command "audit" is not defined/i.test(`${r.stderr}${r.stdout}`) ? tr('sec.auditOld', { version: comp.version }) : (line || util.describeExit(r, inv.file)) };
        log('warn', tr('sec.auditFail', { message: result.audit.error }));
      } else {
        result.audit = parsed;
        log(parsed.advisories.length ? 'bad' : 'ok', tr('sec.auditDone', { n: parsed.advisories.length, abandoned: parsed.abandoned.length }));
        for (const a of parsed.advisories.slice(0, 15)) log('bad', `  [${a.severity}] ${a.package}: ${a.title}${a.cve ? ` (${a.cve})` : ''}`);
      }
    }
  }

  // 2. vibe-security
  if (opts.code !== false) {
    progress('code');
    const cmd = vibeCommand({ allowFetch: opts.allowFetch === true });
    if (!cmd) {
      result.code = { skipped: 'NOT_INSTALLED' };
      log('warn', tr('sec.vibeMissing'));
    } else {
      log('info', cmd.source === 'github' ? tr('sec.vibeFetch') : tr('sec.vibeStart'));
      const outFile = path.join(ctx.dataDir, 'tmp', `secscan-${p.id}-${Date.now()}.json`);
      util.ensureDir(path.dirname(outFile));
      const lang = (ctx.store.data.settings.lang || 'roman') === 'en' ? 'en' : 'ur';
      const r = await util.run(cmd.file, [...cmd.pre, p.path, '--json', outFile, '--quiet', '--no-prompts', '--lang', lang, '--fail-on', 'critical'],
        { cwd: p.path, env: util.cleanEnv({ set: { NO_COLOR: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false' } }), timeoutMs: 10 * 60 * 1000 });
      const parsed = parseVibe(util.readJson(outFile, null));
      try { fs.unlinkSync(outFile); } catch { /* not written */ }
      if (!parsed) {
        const line = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
        result.code = { error: line || util.describeExit(r, cmd.file) };
        log('warn', tr('sec.vibeFail', { message: result.code.error }));
      } else {
        result.code = Object.assign(parsed, { source: cmd.source });
        const s = parsed.summary || {};
        log((s.critical || s.high) ? 'bad' : 'ok', tr('sec.vibeDone', { n: parsed.total, critical: s.critical || 0, high: s.high || 0 }));
      }
    }
  }

  const crit = (result.audit && result.audit.advisories ? result.audit.advisories.filter((a) => ['critical', 'high'].includes(a.severity)).length : 0)
    + (result.code && result.code.summary ? (result.code.summary.critical || 0) + (result.code.summary.high || 0) : 0)
    + result.local.filter((x) => ['critical', 'high'].includes(x.severity)).length;
  result.serious = crit;
  result.endedAt = util.nowIso();
  return result;
}

module.exports = { parseAudit, parseVibe, envFlags, localChecks, vibeCommand, info, runJob, VIBE_GITHUB };
