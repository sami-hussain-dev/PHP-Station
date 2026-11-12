'use strict';
/*
 * Setup Wizard: what is already on this machine (XAMPP, Laragon, WAMP, PHP Station's own runtimes,
 * PATH), what the projects need (composer.json PHP constraint + Laravel's PHP support table) and,
 * from the official catalogs, which PHP / MariaDB / Composer versions to install. Read-only: the
 * installs themselves go through installer.startBatchInstall (SHA-256 checked, runtimes\ only).
 */
const path = require('path');
const util = require('./util');
const semver = require('./semver');
const runtimes = require('./runtimes');
const installer = require('./installer');
const projects = require('./projects');
const pma = require('./pma');
const { tr } = require('./i18n');

const win = path.win32;
const MAX_PROJECTS = 300;

// ------------------------------------------------------------------------------------------ helpers (PURE)

/** "XAMPP" / "Laragon" / "WAMP" / "PHP Station" / "PATH" for an install path. */
function stackOf(p, runtimesDir) {
  const s = String(p || '');
  if (runtimesDir && util.isInside(s, runtimesDir)) return 'PHP Station';
  if (/laragon/i.test(s)) return 'Laragon';
  if (/xampp/i.test(s)) return 'XAMPP';
  if (/wamp/i.test(s)) return 'WAMP';
  return 'PATH';
}

/** Top folder of an install: "D:\Xampp-8.2\php\php.exe" -> "D:\Xampp-8.2". */
function rootOf(p, runtimesDir) {
  const s = util.cleanPath(String(p || ''));
  if (runtimesDir && util.isInside(s, runtimesDir)) return runtimesDir;
  const parts = s.split('\\').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}\\${parts[1]}` : s;
}

function branchOf(v) {
  const n = semver.normalizeVersion(v);
  return n ? `${n[0]}.${n[1]}` : null;
}

/**
 * The PHP branch a project should run on, from the branches on offer (newest first):
 * composer.json allows it AND Laravel supports it -> newest such; else composer allows it -> newest;
 * else null (no constraint known -> caller decides). PURE.
 */
function pickBranchForProject(info, branches) {
  const major = info ? projects.laravelMajorOf(info) : null;
  const constraint = info && info.composerPhp;
  const ok = (b) => {
    const v = `${b}.99`;
    const sat = constraint ? semver.satisfies(v, constraint) !== false || semver.satisfies(`${b}.0`, constraint) !== false : true;
    return sat;
  };
  const clean = branches.filter((b) => ok(b) && !projects.laravelPhpHint(major, `${b}.0`));
  if (clean.length) return { branch: clean[0], exact: true };
  const loose = branches.filter(ok);
  if (loose.length) return { branch: loose[0], exact: false };
  return null;
}

// ------------------------------------------------------------------------------------------ inputs

/** Registered projects + project-like folders in the project roots (deduplicated). */
function collectProjects(ctx) {
  const out = [];
  const seen = new Set();
  const add = (dir, name, registered) => {
    const k = util.normPath(dir);
    if (!k || seen.has(k) || out.length >= MAX_PROJECTS) return;
    if (!util.existsFile(win.join(dir, 'composer.json'))) return;
    seen.add(k);
    const info = projects.inspectProject(dir);
    out.push({ name, path: util.cleanPath(dir), registered, info });
  };
  for (const p of ctx.store.data.projects || []) add(p.path, p.name, true);
  for (const root of ctx.store.data.settings.projectRoots || []) {
    for (const name of util.listDirNames(root)) {
      if (name.startsWith('.')) continue;
      add(win.join(util.cleanPath(root), name), name, false);
    }
  }
  return out;
}

/** Installed stacks grouped by their top folder: [{stack, root, php:[], db:[], composer:[]}]. */
function existingStacks(ctx) {
  const cache = runtimes.getCache(ctx);
  const rdir = installer.runtimesDir(ctx);
  const map = new Map();
  const slot = (p) => {
    const root = rootOf(p, rdir);
    const k = util.normPath(root);
    if (!map.has(k)) map.set(k, { stack: stackOf(p, rdir), root, php: [], db: [], composer: [] });
    return map.get(k);
  };
  for (const p of cache.php) if (p.ok && p.version) slot(p.path).php.push(p.version);
  for (const d of cache.db) {
    if (!d.serverExe) continue;
    slot(d.serverExe).db.push(`${d.kind === 'mysql' ? 'MySQL' : 'MariaDB'} ${d.version}`);
  }
  for (const c of cache.composer) if (c.ok && c.version && !c.sameAs) slot(c.path).composer.push(c.version);
  const sortV = (a) => [...new Set(a)].sort((x, y) => semver.compare(String(y).replace(/^\D+/, ''), String(x).replace(/^\D+/, '')));
  return [...map.values()]
    .map((s) => Object.assign(s, { php: sortV(s.php), db: sortV(s.db), composer: sortV(s.composer) }))
    .sort((a, b) => a.stack.localeCompare(b.stack) || a.root.localeCompare(b.root));
}

async function safeCatalog(ctx, kind) {
  try {
    const c = await installer.getCatalog(ctx, kind);
    return { items: c.items, fetchedAt: c.fetchedAt, error: null };
  } catch (e) {
    return { items: [], fetchedAt: null, error: { code: e.code || 'NET_FAILED', error: e.message || String(e) } };
  }
}

// ------------------------------------------------------------------------------------------ plan

/**
 * GET /api/wizard/plan -> {
 *   stacks: existingStacks, projects: [{name, path, registered, laravel, composerPhp, branch, exact, havePhp}],
 *   kinds: {php|mariadb|composer: {items:[catalog item + recommended, reasons[], have]}, error, fetchedAt},
 *   summary: {php, db, composer} (counts found), mysqlNote
 * }
 */
async function plan(ctx) {
  const cache = runtimes.getCache(ctx);
  const [php, mariadb, composer, pmaCat] = await Promise.all([safeCatalog(ctx, 'php'), safeCatalog(ctx, 'mariadb'), safeCatalog(ctx, 'composer'), safeCatalog(ctx, 'phpmyadmin')]);
  const installedPhp = cache.php.filter((p) => p.ok && p.version);
  const installedBranches = new Set(installedPhp.map((p) => branchOf(p.version)).filter(Boolean));
  const catBranches = php.items.map((it) => branchOf(it.version)).filter(Boolean);

  // ---- projects -> PHP branches
  const projList = collectProjects(ctx).map((p) => {
    const pick = pickBranchForProject(p.info, catBranches);
    // a PHP that is already installed and fits this project (any source) means nothing to download;
    // when no branch fits cleanly (composer.json and Laravel disagree), composer.json alone decides
    const sugg = projects.suggestPhp(p.info, installedPhp);
    const fitting = sugg.find((s) => s.satisfies !== false && !s.hint)
      || (pick && !pick.exact ? sugg.find((s) => s.satisfies === true) : null)
      || (pick && installedBranches.has(pick.branch) ? installedPhp.find((x) => branchOf(x.version) === pick.branch) : null);
    return {
      name: p.name,
      path: p.path,
      registered: p.registered,
      laravel: projects.laravelVersionOf(p.info) || p.info.laravelConstraint || null,
      composerPhp: p.info.composerPhp || null,
      branch: pick ? pick.branch : null,
      exact: pick ? pick.exact : false,
      havePhp: fitting ? fitting.version : null,
    };
  });

  const reasons = { php: new Map(), mariadb: new Map(), composer: new Map(), phpmyadmin: new Map() };
  const addReason = (kind, version, text) => {
    if (!reasons[kind].has(version)) reasons[kind].set(version, []);
    reasons[kind].get(version).push(text);
  };

  for (const pr of projList) {
    if (!pr.branch || pr.havePhp) continue;
    const item = php.items.find((it) => branchOf(it.version) === pr.branch);
    if (item) addReason('php', item.version, tr('wiz.reasonProject', { name: pr.name, need: pr.composerPhp || '-', laravel: pr.laravel || '-' }));
  }
  if (!installedPhp.length && php.items.length && !reasons.php.size) {
    // nothing installed and no project asks for anything particular: the newest stable branch
    addReason('php', php.items[0].version, tr('wiz.reasonNoPhp'));
  }

  // ---- DB server
  const haveDb = cache.db.some((d) => d.serverExe);
  if (!haveDb && mariadb.items.length) {
    const pick = mariadb.items.find((x) => x.lts && !x.eol) || mariadb.items[0];
    addReason('mariadb', pick.version, tr('wiz.reasonNoDb'));
  }

  // ---- Composer
  // ---- phpMyAdmin (DB admin): only when PHP Station has none and no XAMPP/Laragon copy can be used
  if (pmaCat.items.length && !pma.installed(ctx).length && !pma.detectLocal(ctx).length) {
    addReason('phpmyadmin', pmaCat.items[0].version, tr('wiz.reasonNoPma'));
  }

  const haveComposer = cache.composer.some((c) => c.ok);
  if (composer.items.length) {
    const latest = composer.items.find((x) => !x.lts) || composer.items[0];
    if (!haveComposer) addReason('composer', latest.version, tr('wiz.reasonNoComposer'));
    // A project on PHP < 7.2.5 (old XAMPP) can only use the Composer 2.2 LTS line
    const old = (v) => v && semver.compare(v, '7.2.5') < 0;
    const oldPhp = projList.some((pr) => old(pr.havePhp))
      || (ctx.store.data.projects || []).some((pr) => old(pr.phpVersion));
    const lts = composer.items.find((x) => x.lts);
    const haveLts = cache.composer.some((c) => c.ok && /^2\.2\./.test(String(c.version)));
    if (oldPhp && lts && !haveLts) addReason('composer', lts.version, tr('wiz.reasonOldPhp'));
  }

  const decorate = (kind, cat) => cat.items.map((it) => {
    const have = kind === 'php' ? installedBranches.has(branchOf(it.version)) : false;
    const r = reasons[kind].get(it.version) || [];
    return Object.assign({}, it, { recommended: r.length > 0 && !it.installed, reasons: r, haveBranch: have });
  });

  return {
    stacks: existingStacks(ctx),
    projects: projList,
    kinds: {
      php: { items: decorate('php', php), error: php.error, fetchedAt: php.fetchedAt },
      mariadb: { items: decorate('mariadb', mariadb), error: mariadb.error, fetchedAt: mariadb.fetchedAt },
      composer: { items: decorate('composer', composer), error: composer.error, fetchedAt: composer.fetchedAt },
      phpmyadmin: { items: decorate('phpmyadmin', pmaCat), error: pmaCat.error, fetchedAt: pmaCat.fetchedAt },
    },
    summary: {
      php: installedPhp.length,
      db: cache.db.filter((d) => d.serverExe).length,
      composer: cache.composer.filter((c) => c.ok && !c.sameAs).length,
    },
    runtimesDir: installer.runtimesDir(ctx),
    wizardDone: !!ctx.store.data.settings.wizardDone,
    scanning: cache.scanning,
  };
}

module.exports = { plan, stackOf, rootOf, branchOf, pickBranchForProject, existingStacks, collectProjects };
