'use strict';
/*
 * "Shift from XAMPP / Laragon / WAMP": finds every project such a stack serves (its htdocs / www
 * folders and its Apache / nginx virtual hosts, wherever their DocumentRoot points) and proposes,
 * per project, the SAME PHP and DB server that stack used. Read-only: nothing in the old stack is
 * changed, moved or copied; its databases stay in its own datadir and PHP Station simply uses that
 * server (or starts it on the same data). The projects are then added with the normal
 * POST /api/projects call.
 */
const path = require('path');
const util = require('./util');
const semver = require('./semver');
const runtimes = require('./runtimes');
const dbservers = require('./dbservers');
const projects = require('./projects');

const win = path.win32;
const MAX_PER_STACK = 300;

// ------------------------------------------------------------------------------------------ parsers (PURE)

/** Minimal INI reader: {section: {key: value}} with lower-cased section and key names. */
function parseIni(text) {
  const out = {};
  let sec = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const s = /^\[([^\]]+)\]$/.exec(line);
    if (s) { sec = s[1].trim().toLowerCase(); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv) continue;
    if (!out[sec]) out[sec] = {};
    out[sec][kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/**
 * Apache vhosts -> [{docroot, serverName, aliases[]}] (only active, uncommented blocks).
 * Also understands nginx `server { root ...; server_name ...; }`.
 */
function parseVhosts(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*#.*$/, '').trim());
  let cur = null;
  let depth = 0;
  for (const line of lines) {
    if (!line) continue;
    if (/^<VirtualHost\b/i.test(line)) { cur = { docroot: null, serverName: null, aliases: [] }; continue; }
    if (/^<\/VirtualHost>/i.test(line)) { if (cur && cur.docroot) out.push(cur); cur = null; continue; }
    if (/^server\s*\{/i.test(line)) { cur = { docroot: null, serverName: null, aliases: [], nginx: true }; depth = 1; continue; }
    if (cur && cur.nginx) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      const root = /^root\s+("?)([^";]+)\1\s*;/i.exec(line);
      if (root && !cur.docroot) cur.docroot = root[2].trim();
      const sn = /^server_name\s+([^;]+);/i.exec(line);
      if (sn) { const names = sn[1].trim().split(/\s+/); cur.serverName = names[0]; cur.aliases.push(...names.slice(1)); }
      if (depth <= 0) { if (cur.docroot) out.push(cur); cur = null; }
      continue;
    }
    if (!cur) continue;
    const dr = /^DocumentRoot\s+("?)(.+?)\1\s*$/i.exec(line);
    if (dr) cur.docroot = dr[2].trim();
    const sn = /^ServerName\s+(\S+)/i.exec(line);
    if (sn) cur.serverName = sn[1].replace(/:\d+$/, '');
    const sa = /^ServerAlias\s+(.+)$/i.exec(line);
    if (sa) cur.aliases.push(...sa[1].trim().split(/\s+/));
  }
  return out;
}

/** "D:/laragon/www/shop/public" -> project folder (the parent when docroot is a Laravel public\). */
function projectDirFromDocroot(docroot, exists = util.existsFile) {
  const d = util.cleanPath(String(docroot || '').replace(/\//g, '\\'));
  if (!d) return null;
  if (/\\public$/i.test(d) && (exists(win.join(win.dirname(d), 'artisan')) || exists(win.join(win.dirname(d), 'composer.json')))) return win.dirname(d);
  return d;
}

// ------------------------------------------------------------------------------------------ stack detection

function stackKind(root) {
  if (util.existsFile(win.join(root, 'laragon.exe')) || util.existsFile(win.join(root, 'usr', 'laragon.ini'))) return 'Laragon';
  if (util.existsFile(win.join(root, 'xampp-control.exe')) || util.existsDir(win.join(root, 'htdocs'))) return 'XAMPP';
  if (/wamp/i.test(root) || util.existsFile(win.join(root, 'wampmanager.exe'))) return 'WAMP';
  return null;
}

/** Folders that hold this stack's projects (document roots). */
function webRoots(kind, root) {
  const out = [];
  if (kind === 'Laragon') {
    const ini = parseIni(util.readText(win.join(root, 'usr', 'laragon.ini'), '') || '');
    const dr = ini.apache && ini.apache.documentroot;
    if (dr) out.push(util.cleanPath(dr.replace(/\//g, '\\')));
    out.push(win.join(root, 'www'));
  } else if (kind === 'XAMPP') {
    out.push(win.join(root, 'htdocs'));
  } else if (kind === 'WAMP') {
    out.push(win.join(root, 'www'));
  }
  const seen = new Set();
  return out.filter((d) => util.existsDir(d) && !seen.has(util.normPath(d)) && seen.add(util.normPath(d)));
}

function vhostFiles(kind, root) {
  const files = [];
  const addDir = (d) => { for (const f of util.listFileNames(d)) if (/\.conf$/i.test(f)) files.push(win.join(d, f)); };
  try {
    if (kind === 'Laragon') {
      addDir(win.join(root, 'etc', 'apache2', 'sites-enabled'));
      addDir(win.join(root, 'etc', 'nginx', 'sites-enabled'));
    } else if (kind === 'XAMPP') {
      files.push(win.join(root, 'apache', 'conf', 'extra', 'httpd-vhosts.conf'));
    } else if (kind === 'WAMP') {
      for (const a of util.listDirNames(win.join(root, 'bin', 'apache'))) files.push(win.join(root, 'bin', 'apache', a, 'conf', 'extra', 'httpd-vhosts.conf'));
    }
  } catch { /* unreadable folder */ }
  return files.filter((f) => util.existsFile(f));
}

/** php.exe the stack itself uses (XAMPP: <root>\php, Laragon: [php] Version or the only one). */
function stackPhpExe(kind, root) {
  if (kind === 'XAMPP') {
    const p = win.join(root, 'php', 'php.exe');
    return util.existsFile(p) ? p : null;
  }
  if (kind === 'Laragon') {
    const ini = parseIni(util.readText(win.join(root, 'usr', 'laragon.ini'), '') || '');
    const base = win.join(root, 'bin', 'php');
    const want = ini.php && ini.php.version;
    if (want && util.existsFile(win.join(base, want, 'php.exe'))) return win.join(base, want, 'php.exe');
    const all = util.listDirNames(base).filter((d) => util.existsFile(win.join(base, d, 'php.exe')));
    if (all.length === 1) return win.join(base, all[0], 'php.exe');
    return null;
  }
  return null;
}

/** Stack roots: top-level xampp / laragon / wamp folders (the settings' runtime roots). */
function stackRoots(ctx) {
  const out = [];
  const seen = new Set();
  for (const r of ctx.store.data.settings.runtimeRoots || []) {
    const root = util.cleanPath(r);
    const kind = stackKind(root);
    if (!kind || seen.has(util.normPath(root))) continue;
    seen.add(util.normPath(root));
    out.push({ kind, root });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ plan

function looksLikeProject(dir) {
  return ['artisan', 'composer.json', 'index.php'].some((f) => util.existsFile(win.join(dir, f)))
    || util.existsFile(win.join(dir, 'public', 'index.php'));
}

/** GET /api/import/plan */
function plan(ctx) {
  const cache = runtimes.getCache(ctx);
  const phpOk = cache.php.filter((p) => p.ok && p.version);
  const composers = cache.composer.filter((c) => c.ok && !c.sameAs).sort((a, b) => semver.compare(b.version, a.version));
  const entries = dbservers.buildEntries(ctx);
  const registered = ctx.store.data.projects || [];
  const stacks = [];

  for (const { kind, root } of stackRoots(ctx)) {
    const inStack = (p) => p && util.isInside(p, root);
    const php = phpOk.filter((p) => inStack(p.path));
    const stackPhp = (() => {
      const exe = stackPhpExe(kind, root);
      return (exe && phpOk.find((p) => util.samePath(p.path, exe))) || php.slice().sort((a, b) => semver.compare(b.version, a.version))[0] || null;
    })();
    const dbs = entries.filter((e) => inStack(e.serverExe) || inStack(e.datadir));
    const composer = composers.find((c) => inStack(c.path)) || composers[0] || null;
    const items = new Map();
    const add = (dir, from, domain) => {
      if (!dir || !util.existsDir(dir) || items.size >= MAX_PER_STACK) return;
      const key = util.normPath(dir);
      const prev = items.get(key);
      if (prev) { if (domain && !prev.domains.includes(domain)) prev.domains.push(domain); return; }
      if (!looksLikeProject(dir)) return;
      items.set(key, { path: util.cleanPath(dir), from, domains: domain ? [domain] : [] });
    };
    // virtual hosts first (they carry the domain the developer actually used)
    for (const f of vhostFiles(kind, root)) {
      for (const v of parseVhosts(util.readText(f, '') || '')) {
        const dir = projectDirFromDocroot(v.docroot);
        if (!dir) continue;
        // the stack's own default host for the whole www/htdocs folder is not a project
        if (webRoots(kind, root).some((w) => util.samePath(w, dir))) continue;
        add(dir, 'vhost', v.serverName && !/^(localhost|_|\*)$/i.test(v.serverName) ? v.serverName : null);
      }
    }
    for (const w of webRoots(kind, root)) {
      for (const name of util.listDirNames(w)) {
        if (name.startsWith('.') || /^(dashboard|img|webalizer|xampp|phpmyadmin)$/i.test(name)) continue;
        add(win.join(w, name), kind === 'XAMPP' ? 'htdocs' : 'www', kind === 'Laragon' ? `${name.toLowerCase()}.test` : null);
      }
    }

    const list = [...items.values()].map((it) => {
      const info = projects.inspectProject(it.path);
      const sugg = projects.suggestPhp(info, phpOk);
      // keep the PHP the project ran on (the stack's) unless composer.json forbids it
      const stackFits = stackPhp && (!info.composerPhp || semver.satisfies(stackPhp.version, info.composerPhp) !== false);
      const pick = stackFits ? stackPhp : (sugg.find((s) => s.satisfies !== false && !s.hint) || sugg[0] || null);
      const dbView = dbs.map((e) => ({ id: e.id, port: e.effectivePort, status: 'stopped' }));
      const db = projects.suggestDbServer(info, dbView) || (dbs[0] ? dbs[0].id : null);
      const already = registered.find((p) => util.samePath(p.path, it.path));
      return {
        path: it.path,
        name: win.basename(it.path),
        from: it.from,
        domains: it.domains.slice(0, 4),
        laravel: projects.laravelVersionOf(info) || (info.isLaravel ? info.laravelConstraint || '?' : null),
        isLaravel: info.isLaravel,
        composerPhp: info.composerPhp || null,
        database: info.env.database || null,
        php: pick ? { version: pick.version, path: pick.path, same: !!(stackPhp && util.samePath(pick.path, stackPhp.path)) } : null,
        dbServerId: db,
        composerId: composer ? composer.id : null,
        alreadyAdded: already ? already.id : null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    stacks.push({
      kind,
      root,
      php: stackPhp ? { version: stackPhp.version, path: stackPhp.path } : null,
      phpVersions: [...new Set(php.map((p) => p.version))].sort((a, b) => semver.compare(b, a)),
      db: dbs.map((e) => ({ id: e.id, label: e.label, kind: e.kind, version: e.version, port: e.effectivePort, datadir: e.datadir })),
      composer: composer ? { id: composer.id, version: composer.version } : null,
      projects: list,
    });
  }
  return { stacks, scanning: cache.scanning, scannedAt: cache.scannedAt };
}

module.exports = { parseIni, parseVhosts, projectDirFromDocroot, stackKind, stackPhpExe, webRoots, plan };
