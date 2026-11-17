'use strict';
/*
 * Apache .htaccess for projects served without Apache (tools\fastserve.js): the rules most
 * projects use, evaluated per request the way Apache does in per-directory context.
 *
 *   mod_rewrite  RewriteEngine, RewriteBase, RewriteCond (%{REQUEST_FILENAME} -f/-d/-s, %{REQUEST_URI},
 *                %{QUERY_STRING}, %{HTTP_HOST}, %{HTTP:X}, %{REQUEST_METHOD}, %{HTTPS}, %{THE_REQUEST} ...,
 *                [NC], [OR]), RewriteRule with $n / %n back-references and [L], [END], [NC], [R=301],
 *                [F], [G], [QSA], [QSD], [S=n], [NE]; internal rewrites run again on the new URL
 *                (as Apache does) up to MAX_ROUNDS times
 *   mod_alias    Redirect, RedirectPermanent, RedirectTemp, RedirectMatch
 *   access       Require all denied / granted, Deny from all, <Files> / <FilesMatch> with either
 *   mod_dir      DirectoryIndex
 *   core         ErrorDocument 403 / 404 / 500 with a local path
 *   mod_headers  Header [always] set / append / unset
 * <IfModule> blocks: the modules above count as loaded. Anything else (php_value, SetEnv, AuthType,
 * <Limit> ...) is listed by analyze() so the panel can say which lines do nothing here.
 *
 * PURE: the file system comes in as io = { kind(absPath) -> 'file' | 'dir' | null,
 * read(absPath) -> text | null }.
 */
const path = require('path');

const MAX_ROUNDS = 10;
const LOADED = new Set(['mod_rewrite', 'mod_alias', 'mod_headers', 'mod_dir', 'mod_mime', 'mod_authz_core', 'mod_authz_host',
  'mod_access_compat', 'mod_expires', 'mod_deflate', 'mod_filter', 'mod_setenvif', 'mod_env', 'mod_negotiation', 'mod_php',
  'mod_php5', 'mod_php7', 'mod_php8', 'mod_gzip', 'mod_version', 'mod_autoindex', 'mod_security', 'mod_security2']);
// lines that only tune Apache itself: nothing to do, nothing lost
const HARMLESS = /^(Options|AddDefaultCharset|AddCharset|AddType|AddEncoding|AddLanguage|AddHandler|AddOutputFilter|AddOutputFilterByType|RemoveHandler|RemoveType|DefaultLanguage|ExpiresActive|ExpiresByType|ExpiresDefault|FileETag|ServerSignature|SetOutputFilter|BrowserMatch|IndexIgnore|IndexOptions|DirectorySlash|LimitRequestBody|ContentDigest|Order|Allow|Satisfy|SecFilterEngine|SecFilterScanPOST|SecRuleEngine|CheckSpelling|RewriteOptions|DeflateCompressionLevel|Header\s+(?:always\s+)?(?:edit|merge|echo)|RequestHeader|Protocols|LimitRequestFieldSize|AcceptPathInfo|CGIPassAuth)\b/i;

// ------------------------------------------------------------------------------------------ parse

/** Splits a directive line into arguments (double / single quotes kept together). PURE. */
function splitArgs(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function flagsOf(arg) {
  const m = /^\[(.*)\]$/.exec(String(arg || '').trim());
  if (!m) return {};
  const f = {};
  for (const part of m[1].split(',')) {
    const [k, ...v] = part.trim().split('=');
    if (!k) continue;
    f[k.trim().toUpperCase()] = v.length ? v.join('=').trim() : true;
  }
  return f;
}

function toRegex(src, nocase) {
  try { return new RegExp(src, nocase ? 'i' : ''); } catch { return null; }
}

/**
 * One .htaccess -> {rewriteOn, base, rules, aliases, access, files, index, errors, headers, unsupported}.
 * rules: [{conds: [{test, op, pattern, re, negate, or}], re, negate, subst, flags, line}]
 */
function parse(text) {
  const conf = {
    rewriteOn: false, base: null, rules: [], aliases: [], access: null, files: [], index: null, errors: {}, headers: [],
    unsupported: [], ignored: 0,
  };
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const stack = []; // open blocks: {kind, active, files?}
  let pendingConds = [];
  const active = () => stack.every((b) => b.active);
  const files = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].files) return stack[i].files; return null; };
  // line continuation with a trailing backslash
  const joined = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const n = i + 1;
    while (/\\$/.test(l) && i + 1 < lines.length) { l = l.slice(0, -1) + lines[++i]; }
    joined.push({ n, text: l });
  }
  for (const { n, text: raw } of joined) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const open = /^<\s*(\w+)\s*([^>]*)>$/.exec(line);
    if (open) {
      const kind = open[1].toLowerCase();
      const arg = open[2].trim().replace(/^["']|["']$/g, '');
      if (kind === 'ifmodule') {
        const neg = arg.startsWith('!');
        const mod = arg.replace(/^!/, '').replace(/\.c$/i, '').replace(/_module$/i, '').toLowerCase();
        const name = mod.startsWith('mod_') ? mod : `mod_${mod}`;
        stack.push({ kind, active: neg ? !LOADED.has(name) : LOADED.has(name) });
      } else if (kind === 'ifversion' || kind === 'ifdefine') {
        stack.push({ kind, active: true });
      } else if (kind === 'files' || kind === 'filesmatch') {
        const isRe = kind === 'filesmatch' || open[2].trim().startsWith('~');
        const src = arg.replace(/^~\s*/, '').replace(/^["']|["']$/g, '');
        const re = isRe ? toRegex(src, true) : toRegex(`^${src.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, true);
        const f = { re, access: null, line: n };
        if (re && active()) conf.files.push(f);
        else if (!re) conf.unsupported.push({ line: n, text: line });
        stack.push({ kind, active: true, files: f });
      } else {
        // <Limit>, <LimitExcept>, <Directory> ... : what is inside is not applied
        conf.unsupported.push({ line: n, text: line });
        stack.push({ kind, active: false });
      }
      continue;
    }
    if (/^<\s*\/\s*\w+\s*>$/.test(line)) { stack.pop(); continue; }
    if (!active()) continue;
    const args = splitArgs(line);
    const name = (args[0] || '').toLowerCase();
    const f = files();
    // access rules (also inside <Files>)
    if ((name === 'require' && /^all$/i.test(args[1] || '')) || (name === 'deny' && /^from$/i.test(args[1] || '') && /^all$/i.test(args[2] || ''))) {
      const deny = name === 'deny' || /^denied$/i.test(args[2] || '');
      if (f) f.access = deny ? 'deny' : 'allow'; else conf.access = deny ? 'deny' : 'allow';
      continue;
    }
    if (name === 'allow' && /^from$/i.test(args[1] || '') && /^all$/i.test(args[2] || '')) {
      if (f) f.access = f.access || 'allow'; else conf.access = conf.access || 'allow';
      continue;
    }
    if (f) {
      if (!HARMLESS.test(line)) conf.unsupported.push({ line: n, text: line }); else conf.ignored++;
      continue;
    }
    if (name === 'rewriteengine') { conf.rewriteOn = /^on$/i.test(args[1] || ''); continue; }
    if (name === 'rewritebase') { conf.base = (args[1] || '/').replace(/\/?$/, '/'); continue; }
    if (name === 'rewritecond' && args.length >= 3) {
      const fl = flagsOf(args[3]);
      let pat = args[2];
      const negate = pat.startsWith('!');
      if (negate) pat = pat.slice(1);
      let op = 're';
      if (/^-[fdsFUlLhxe]$/.test(pat)) op = pat;
      else if (/^[=<>]/.test(pat)) { op = pat[0]; pat = pat.slice(1); }
      const re = op === 're' ? toRegex(pat, !!fl.NC || !!fl.NOCASE) : null;
      if (op === 're' && !re) { conf.unsupported.push({ line: n, text: line }); pendingConds.push({ bad: true }); continue; }
      pendingConds.push({ test: args[1], op, pattern: pat, re, negate, or: !!(fl.OR || fl.ORNEXT), nc: !!(fl.NC || fl.NOCASE) });
      continue;
    }
    if (name === 'rewriterule' && args.length >= 3) {
      const fl = flagsOf(args[3]);
      let pat = args[1];
      const negate = pat.startsWith('!');
      if (negate) pat = pat.slice(1);
      const re = toRegex(pat, !!(fl.NC || fl.NOCASE));
      const conds = pendingConds;
      pendingConds = [];
      if (!re || conds.some((c) => c.bad) || fl.C || fl.CHAIN) { conf.unsupported.push({ line: n, text: line }); continue; }
      conf.rules.push({ conds, re, negate, subst: args[2], flags: fl, line: n });
      continue;
    }
    if (name === 'redirect' || name === 'redirectpermanent' || name === 'redirecttemp' || name === 'redirectmatch') {
      let rest = args.slice(1);
      let status = name === 'redirectpermanent' ? 301 : 302;
      if (rest[0] && /^(permanent|temp|seeother|gone|\d{3})$/i.test(rest[0])) {
        const s = rest[0].toLowerCase();
        status = s === 'permanent' ? 301 : s === 'temp' ? 302 : s === 'seeother' ? 303 : s === 'gone' ? 410 : Number(s);
        rest = rest.slice(1);
      }
      if (!rest[0]) { conf.unsupported.push({ line: n, text: line }); continue; }
      if (name === 'redirectmatch') {
        const re = toRegex(rest[0], false);
        if (!re) { conf.unsupported.push({ line: n, text: line }); continue; }
        conf.aliases.push({ re, to: rest[1] || null, status, line: n });
      } else {
        conf.aliases.push({ prefix: rest[0], to: rest[1] || null, status, line: n });
      }
      continue;
    }
    if (name === 'directoryindex') { conf.index = args.slice(1).filter((x) => !/^disabled$/i.test(x)); continue; }
    if (name === 'errordocument' && /^\d{3}$/.test(args[1] || '') && args[2]) {
      if (args[2].startsWith('/')) conf.errors[Number(args[1])] = args[2];
      else if (/^https?:\/\//i.test(args[2])) conf.errors[Number(args[1])] = { redirect: args[2] };
      else conf.errors[Number(args[1])] = { text: args.slice(2).join(' ') };
      continue;
    }
    if (name === 'header') {
      let i = 1;
      if (/^(always|onsuccess)$/i.test(args[i] || '')) i++;
      const action = (args[i] || '').toLowerCase();
      if (['set', 'append', 'add', 'unset'].includes(action) && args[i + 1] && !/^(env|expr)=/i.test(args[i + 3] || '')) {
        conf.headers.push({ action, name: args[i + 1], value: args[i + 2] || '' });
        continue;
      }
    }
    if (HARMLESS.test(line)) { conf.ignored++; continue; }
    conf.unsupported.push({ line: n, text: line });
  }
  return conf;
}

/** What of a .htaccess is applied: {rules, redirects, access, headers, unsupported: [{line, text}]}. PURE. */
function analyze(text) {
  const c = parse(text);
  return {
    rewrite: c.rewriteOn ? c.rules.length : 0, redirects: c.aliases.length, access: !!(c.access || c.files.length),
    headers: c.headers.length, errors: Object.keys(c.errors).length, unsupported: c.unsupported,
  };
}

// ------------------------------------------------------------------------------------------ evaluate

/** URL path of each existing folder from the docroot down to the one holding `urlPath`: ['/', '/a/', ...]. */
function dirChain(docroot, urlPath, io) {
  const segs = urlPath.split('/').filter(Boolean);
  const out = ['/'];
  let cur = '/';
  for (let i = 0; i < segs.length; i++) {
    const next = `${cur}${segs[i]}/`;
    if (io.kind(fsPath(docroot, next)) !== 'dir') break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** %{REQUEST_FILENAME}: like Apache, the longest existing file of the path (/index.php/x -> index.php). */
function requestFilename(docroot, urlPath, io) {
  const segs = String(urlPath).split('/').filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    const p = path.join(docroot, ...segs.slice(0, i));
    const k = io.kind(p);
    if (k === 'file') return p;
    if (k !== 'dir') break;
  }
  return fsPath(docroot, urlPath);
}

function fsPath(docroot, urlPath) {
  const segs = String(urlPath).split('/').filter(Boolean);
  return segs.length ? path.join(docroot, ...segs) : docroot;
}

/** Parsed .htaccess of each folder of the chain (cached by the caller through io.read). */
function confsFor(docroot, chain, io, cache) {
  return chain.map((dir) => {
    const file = path.join(fsPath(docroot, dir), '.htaccess');
    const text = io.read(file);
    if (text == null) return { dir, conf: null };
    const hit = cache && cache.get(file);
    if (hit && hit.text === text) return { dir, conf: hit.conf };
    const conf = parse(text);
    if (cache) cache.set(file, { text, conf });
    return { dir, conf };
  });
}

function expand(str, ruleM, condM, vars) {
  return String(str)
    .replace(/%\{([^}]+)\}/g, (m, k) => varOf(k, vars))
    .replace(/\$(\d)/g, (m, d) => (ruleM && ruleM[d] != null ? ruleM[d] : ''))
    .replace(/%(\d)/g, (m, d) => (condM && condM[d] != null ? condM[d] : ''));
}

function varOf(name, v) {
  const k = String(name);
  const up = k.toUpperCase();
  if (up.startsWith('HTTP:')) return v.headers[k.slice(5).toLowerCase()] || '';
  if (up.startsWith('ENV:')) return '';
  switch (up) {
    case 'REQUEST_FILENAME': case 'SCRIPT_FILENAME': return v.filename;
    case 'REQUEST_URI': return v.uri;
    case 'QUERY_STRING': return v.query;
    case 'HTTP_HOST': return v.headers.host || '';
    case 'SERVER_NAME': return String(v.headers.host || '').replace(/:\d+$/, '');
    case 'SERVER_PORT': return String(v.port || '');
    case 'HTTP_USER_AGENT': return v.headers['user-agent'] || '';
    case 'HTTP_REFERER': return v.headers.referer || '';
    case 'HTTP_COOKIE': return v.headers.cookie || '';
    case 'HTTP_ACCEPT': return v.headers.accept || '';
    case 'HTTP_AUTHORIZATION': return v.headers.authorization || '';
    case 'REQUEST_METHOD': return v.method;
    case 'REQUEST_SCHEME': return v.https ? 'https' : 'http';
    case 'HTTPS': return v.https ? 'on' : 'off';
    case 'THE_REQUEST': return `${v.method} ${v.rawUrl} HTTP/1.1`;
    case 'DOCUMENT_ROOT': return v.docroot;
    case 'REMOTE_ADDR': return '127.0.0.1';
    case 'SERVER_PROTOCOL': return 'HTTP/1.1';
    default: return '';
  }
}

function condMatches(c, vars, ruleM, prevCondM, io) {
  const test = expand(c.test, ruleM, prevCondM, vars);
  let ok;
  let m = null;
  switch (c.op) {
    case '-f': case '-F': ok = io.kind(test) === 'file'; break;
    case '-U': ok = io.kind(test) === 'file'; break;
    case '-d': ok = io.kind(test) === 'dir'; break;
    case '-s': ok = io.kind(test) === 'file' && (io.size ? io.size(test) > 0 : true); break;
    case '-l': case '-L': case '-h': ok = false; break;
    case '-x': ok = false; break;
    case '-e': ok = io.kind(test) !== null; break;
    case '=': ok = c.nc ? test.toLowerCase() === c.pattern.toLowerCase() : test === c.pattern; break;
    case '<': ok = test < c.pattern; break;
    case '>': ok = test > c.pattern; break;
    default: m = c.re.exec(test); ok = !!m;
  }
  if (c.negate) return { ok: !ok, m: null };
  return { ok, m };
}

/** Runs the RewriteRules of one .htaccess on `rel` (path below its folder). -> outcome | null (no change). */
function runRules(level, rel, vars, io) {
  const { conf, dir } = level;
  const base = conf.base || dir;
  for (let i = 0; i < conf.rules.length; i++) {
    const r = conf.rules[i];
    const m = r.re.exec(rel);
    if (r.negate ? m : !m) continue;
    const ruleM = r.negate ? null : m;
    // conditions: ANDed, [OR] joins one with the next
    let condM = null;
    let ok = true;
    let orOpen = false;
    let orHit = false;
    for (const c of r.conds) {
      const res = condMatches(c, vars, ruleM, condM, io);
      if (res.m) condM = res.m;
      if (c.or) { orOpen = true; orHit = orHit || res.ok; continue; }
      if (orOpen) { ok = ok && (orHit || res.ok); orOpen = false; orHit = false; continue; }
      ok = ok && res.ok;
    }
    if (orOpen) ok = ok && orHit;
    if (!ok) continue;
    const f = r.flags;
    if (f.F) return { action: 'status', status: 403, line: r.line };
    if (f.G) return { action: 'status', status: 410, line: r.line };
    if (r.subst === '-') {
      if (f.R) return null;
      if (f.L || f.END) return { action: 'stop', line: r.line };
      if (f.S) i += Number(f.S) || 0;
      continue;
    }
    let target = expand(r.subst, ruleM, condM, vars);
    let query = null;
    const q = target.indexOf('?');
    if (q >= 0) { query = target.slice(q + 1); target = target.slice(0, q); }
    let newQuery = vars.query;
    if (query !== null) newQuery = f.QSA && vars.query ? (query ? `${query}&${vars.query}` : vars.query) : query;
    if (f.QSD) newQuery = query !== null ? query : '';
    const external = /^https?:\/\//i.test(target);
    if (!external && !target.startsWith('/')) target = base + target;
    if (f.R || external) {
      const status = f.R === true || !f.R ? 302 : Number(f.R) || 302;
      return { action: 'redirect', status: status >= 300 && status < 400 ? status : 302, location: target + (newQuery ? `?${newQuery}` : ''), line: r.line };
    }
    return { action: 'rewrite', path: target, query: newQuery || '', end: !!f.END, line: r.line };
  }
  return null;
}

/**
 * Decides what a request becomes:
 *   {action: 'pass'}                                 nothing applies, serve as usual
 *   {action: 'status', status, errorDoc?}            403 / 404 / 410 (errorDoc: local path to show)
 *   {action: 'redirect', status, location}
 *   {action: 'serve', path, query, status?}          this URL path (a file or a script) instead
 *   plus headers: [{action, name, value}] for the response.
 * req: {method, url, headers (lower-case keys), port, https}
 */
function evaluate(docroot, req, io, cache) {
  const rawUrl = String(req.url || '/');
  const qi = rawUrl.indexOf('?');
  let urlPath = qi >= 0 ? rawUrl.slice(0, qi) : rawUrl;
  let query = qi >= 0 ? rawUrl.slice(qi + 1) : '';
  try { urlPath = decodeURIComponent(urlPath); } catch { return { action: 'status', status: 400, headers: [] }; }
  if (!urlPath.startsWith('/') || urlPath.includes('\0')) return { action: 'status', status: 400, headers: [] };
  if (urlPath.split('/').some((s) => s === '..')) return { action: 'status', status: 403, headers: [] };
  const originalPath = urlPath;
  let headers = [];
  let rewritten = false;
  const seen = new Set();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const chain = dirChain(docroot, urlPath, io);
    const levels = confsFor(docroot, chain, io, cache).filter((x) => x.conf);
    headers = [];
    for (const l of levels) {
      for (const h of l.conf.headers) headers.push(h);
    }
    const errorDoc = (code) => {
      for (let i = levels.length - 1; i >= 0; i--) if (levels[i].conf.errors[code]) return levels[i].conf.errors[code];
      return null;
    };
    const fail = (status) => ({ action: 'status', status, errorDoc: errorDoc(status), headers });
    // .ht* files are never served (Apache's default configuration)
    const name = urlPath.split('/').filter(Boolean).pop() || '';
    if (/^\.ht/i.test(name)) return fail(403);
    // access: the deepest folder that says something wins; <Files> rules match the file name
    let access = null;
    for (const l of levels) {
      if (l.conf.access) access = l.conf.access;
      for (const f of l.conf.files) if (f.access && f.re && f.re.test(name)) access = f.access;
    }
    if (access === 'deny') return fail(403);
    // mod_alias (runs before mod_rewrite in Apache's per-directory phase too)
    if (round === 0) {
      for (const l of levels) {
        for (const a of l.conf.aliases) {
          let to = null;
          if (a.re) {
            const m = a.re.exec(urlPath);
            if (m) to = a.to ? a.to.replace(/\$(\d)/g, (x, d) => m[d] || '') : '';
          } else if (urlPath === a.prefix || urlPath.startsWith(a.prefix.replace(/\/?$/, '/'))) {
            to = a.to ? a.to + urlPath.slice(a.prefix.length) : '';
          }
          if (to === null) continue;
          if (a.status === 410 || !a.to) return fail(410);
          return { action: 'redirect', status: a.status, location: to + (query ? `?${query}` : ''), headers };
        }
      }
    }
    // mod_rewrite: the deepest .htaccess with rules (rules are not inherited, as in Apache)
    let rw = null;
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i].conf.rules.length) { rw = levels[i]; break; }
    }
    if (rw && rw.conf.rewriteOn) {
      const rel = urlPath.slice(rw.dir.length);
      const vars = {
        method: String(req.method || 'GET').toUpperCase(), uri: urlPath, query, headers: req.headers || {}, port: req.port,
        https: !!req.https, rawUrl, docroot, filename: requestFilename(docroot, urlPath, io),
      };
      const out = runRules(rw, rel, vars, io);
      if (out && out.action === 'status') return fail(out.status);
      if (out && out.action === 'redirect') return { action: 'redirect', status: out.status, location: out.location, headers };
      if (out && out.action === 'rewrite') {
        // as Apache: another round only when the PATH changed (a query that keeps growing with
        // [QSA] on the same script does not loop)
        const changed = out.path !== urlPath;
        if (out.path !== urlPath || out.query !== query) rewritten = true;
        urlPath = out.path;
        query = out.query;
        if (changed && !out.end && !seen.has(urlPath)) { seen.add(urlPath); continue; }
      }
    }
    // the result: a file, a folder (DirectoryIndex), a script with extra path, or nothing
    const kind = io.kind(fsPath(docroot, urlPath));
    if (kind === 'dir') {
      let index = ['index.php', 'index.html', 'index.htm'];
      for (const l of levels) if (l.conf.index && l.conf.index.length) index = l.conf.index;
      const dir = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
      if (!urlPath.endsWith('/') && !rewritten) {
        // Apache's DirectorySlash: /folder -> /folder/
        return { action: 'redirect', status: 301, location: `${dir}${query ? `?${query}` : ''}`, headers };
      }
      for (const ix of index) {
        const p = ix.startsWith('/') ? ix : dir + ix;
        if (io.kind(fsPath(docroot, p)) === 'file') return { action: 'serve', path: p, query, headers, rewritten: true };
      }
      return fail(403);
    }
    if (kind === 'file') {
      if (!rewritten) return { action: 'pass', headers };
      return { action: 'serve', path: urlPath, query, headers, rewritten: true };
    }
    // /script.php/extra/path: PATH_INFO, php -S handles it
    const segs = urlPath.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const head = `/${segs.slice(0, i).join('/')}`;
      if (/\.php$/i.test(head) && io.kind(fsPath(docroot, head)) === 'file') {
        return rewritten ? { action: 'serve', path: urlPath, query, headers, rewritten: true } : { action: 'pass', headers };
      }
    }
    return fail(404);
  }
  // rewrote itself in circles
  void originalPath;
  return { action: 'status', status: 500, headers };
}

module.exports = { parse, analyze, evaluate, splitArgs, MAX_ROUNDS };
