'use strict';
/*
 * Installer for PHP, MariaDB and Composer from their official sources only.
 *  - every request is https to an allow-listed host; redirects are followed only to allow-listed
 *    hosts (at most 5); timeouts everywhere;
 *  - every download is checked against the official SHA-256 BEFORE anything is extracted
 *    (mismatch -> the file is deleted and the job fails);
 *  - installs go only into <tool>\runtimes\<kind>\<version>: extracted into a temp folder first,
 *    then renamed into place (no half-installed folders), never over an existing folder;
 *  - no admin rights, no system PATH changes, nothing downloaded is run by this module (the
 *    runtime scan afterwards probes the new PHP like any other PHP, and MariaDB's own
 *    install-db tool creates the new server's datadir).
 * This is the only module of PHP Station that talks to the network.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const util = require('./util');
const semver = require('./semver');
const ports = require('./ports');
const procs = require('./procs');
const runtimes = require('./runtimes');
const dbservers = require('./dbservers');
const { tr } = require('./i18n');

const { AppError, MB } = util;
const win = path.win32;

const DEFAULT_TOOL_DIR = path.resolve(__dirname, '..');
const VERSION = (util.readJson(path.join(DEFAULT_TOOL_DIR, 'package.json'), {}) || {}).version || '1.1.0';

// windows.php.net answers every download with a redirect to downloads.php.net (PHP's own
// download host), so that host is allowed too.
const ALLOWED_HOSTS = Object.freeze([
  'windows.php.net', 'downloads.php.net',
  'downloads.mariadb.org', 'archive.mariadb.org', 'dlm.mariadb.com',
  'getcomposer.org', 'nodejs.org', 'curl.se',
  'www.phpmyadmin.net', 'files.phpmyadmin.net',
  // cloudflared (live share links): the release list comes from GitHub's API, the file from the
  // release page, which redirects to GitHub's asset hosts. The SHA-256 is GitHub's asset digest.
  'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);
const MAX_REDIRECTS = 5;
const INDEX_TIMEOUT_MS = 30000;
const IDLE_TIMEOUT_MS = 60000;
const MAX_INDEX_BYTES = 8 * MB;
const MAX_DOWNLOAD_BYTES = 1024 * MB;
const MAX_UNPACKED_BYTES = 4096 * MB;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const KINDS = Object.freeze(['php', 'mariadb', 'composer', 'phpmyadmin', 'cloudflared']);
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;

// The MariaDB REST API's file_download_url is plain http and redirects to a geo mirror; the
// official archive host serves the same files (same sha256) over https.
const SOURCES = Object.freeze({
  phpReleases: 'https://windows.php.net/downloads/releases/releases.json',
  phpBase: 'https://windows.php.net/downloads/releases/',
  mariadbMajors: 'https://downloads.mariadb.org/rest-api/mariadb/',
  mariadbLatest: (major) => `https://downloads.mariadb.org/rest-api/mariadb/${major}/latest/`,
  mariadbMajor: (major) => `https://downloads.mariadb.org/rest-api/mariadb/${major}/`,
  mariadbSums: (version) => `https://archive.mariadb.org/mariadb-${version}/winx64-packages/sha256sums.txt`,
  mariadbFile: (version, file) => `https://archive.mariadb.org/mariadb-${version}/winx64-packages/${file}`,
  composerVersions: 'https://getcomposer.org/versions',
  composerPhar: (v) => `https://getcomposer.org/download/${v}/composer.phar`,
  composerSha: (v) => `https://getcomposer.org/download/${v}/composer.phar.sha256sum`,
  nodeIndex: 'https://nodejs.org/dist/index.json',
  nodeShasums: (v) => `https://nodejs.org/dist/${v}/SHASUMS256.txt`,
  nodeZip: (v) => `https://nodejs.org/dist/${v}/node-${v}-win-x64.zip`,
  pmaVersions: 'https://www.phpmyadmin.net/home_page/version.json',
  pmaZip: (v) => `https://files.phpmyadmin.net/phpMyAdmin/${v}/phpMyAdmin-${v}-all-languages.zip`,
  pmaSha: (v) => `https://files.phpmyadmin.net/phpMyAdmin/${v}/phpMyAdmin-${v}-all-languages.zip.sha256`,
  cloudflaredRelease: 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest',
  cloudflaredPrefix: 'https://github.com/cloudflare/cloudflared/releases/download/',
  cacert: 'https://curl.se/ca/cacert.pem',
  cacertSha: 'https://curl.se/ca/cacert.pem.sha256',
});

// php.ini: extensions enabled when their DLL exists (order matters: exif after mbstring).
const PHP_EXTENSIONS = Object.freeze(['curl', 'fileinfo', 'gd', 'intl', 'mbstring', 'mysqli', 'openssl', 'pdo_mysql',
  'pdo_sqlite', 'sodium', 'zip', 'exif']);

// ------------------------------------------------------------------------------------------ URL policy (PURE)

function shortUrl(u) {
  return String(u == null ? '' : u).slice(0, 200);
}

/** Parses a URL and enforces the policy: https, default port, no credentials, allowed host. */
function checkUrl(raw, allowHosts = ALLOWED_HOSTS) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new AppError('URL_NOT_ALLOWED', tr('inst.urlBad', { url: shortUrl(raw) }), 400);
  }
  if (u.protocol !== 'https:') throw new AppError('URL_NOT_ALLOWED', tr('inst.urlNotHttps', { url: shortUrl(raw) }), 400);
  if (u.username || u.password) throw new AppError('URL_NOT_ALLOWED', tr('inst.urlBad', { url: shortUrl(raw) }), 400);
  if (u.port && u.port !== '443') throw new AppError('URL_NOT_ALLOWED', tr('inst.urlBad', { url: shortUrl(raw) }), 400);
  if (!allowHosts.includes(u.hostname.toLowerCase())) {
    throw new AppError('URL_NOT_ALLOWED', tr('inst.hostNotAllowed', { host: u.hostname }), 400);
  }
  return u;
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

// ------------------------------------------------------------------------------------------ fetcher

function netError(e) {
  if (e instanceof AppError) return e;
  return new AppError('NET_FAILED', tr('inst.netFailed', { message: e && e.message ? e.message : String(e) }), 502);
}

/**
 * Creates the HTTPS client. The production one is STRICT (no options). Tests may pass
 * `rewrite` (maps an already policy-checked official URL to a local https://127.0.0.1 fixture
 * server; nothing else can be reached) and `ca` (trust the fixture's certificate). The HTTP API
 * never passes options, so the policy cannot be widened from the UI.
 */
function createFetcher({ rewrite = null, ca = null, timeoutMs = INDEX_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  const connectUrl = (u) => {
    if (!rewrite) return u;
    const r = new URL(String(rewrite(u.toString())));
    if (r.protocol !== 'https:' || !['127.0.0.1', 'localhost'].includes(r.hostname)) {
      throw new AppError('URL_NOT_ALLOWED', tr('inst.hostNotAllowed', { host: r.hostname }), 400);
    }
    return r;
  };

  /** One request (no redirects) -> the response object. */
  const requestOnce = (u, method) => new Promise((resolve, reject) => {
    const target = connectUrl(u);
    const opts = {
      method,
      headers: { 'User-Agent': `PHP-Station/${VERSION}`, Accept: '*/*', 'Accept-Encoding': 'identity' },
      timeout: idleTimeoutMs,
    };
    if (ca) opts.ca = ca;
    const req = https.request(target, opts, resolve);
    req.on('timeout', () => req.destroy(new Error(tr('inst.timeout'))));
    req.on('error', reject);
    req.end();
  });

  /** Follows allowed redirects; resolves {res, url} with a 200 response. */
  const open = async (url, method = 'GET') => {
    let cur = checkUrl(url);
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await requestOnce(cur, method);
      } catch (e) {
        throw netError(e);
      }
      if (isRedirect(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) throw new AppError('NET_FAILED', tr('inst.httpStatus', { status: res.statusCode, url: shortUrl(cur) }), 502);
        if (hop >= MAX_REDIRECTS) throw new AppError('TOO_MANY_REDIRECTS', tr('inst.tooManyRedirects', { url: shortUrl(url) }), 502);
        cur = checkUrl(new URL(loc, cur).toString());
        continue;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new AppError('NET_FAILED', tr('inst.httpStatus', { status: res.statusCode, url: shortUrl(cur) }), 502);
      }
      return { res, url: cur.toString() };
    }
  };

  const getText = async (url, { maxBytes = MAX_INDEX_BYTES } = {}) => {
    const work = (async () => {
      const { res } = await open(url);
      return new Promise((resolve, reject) => {
        const chunks = [];
        let len = 0;
        res.on('data', (d) => {
          len += d.length;
          if (len > maxBytes) {
            res.destroy(new Error(tr('inst.tooBig', { url: shortUrl(url) })));
            return;
          }
          chunks.push(d);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', (e) => reject(netError(e)));
        res.on('aborted', () => reject(netError(new Error('aborted'))));
      });
    })();
    let timer;
    const limit = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new AppError('NET_FAILED', tr('inst.netFailed', { message: tr('inst.timeout') }), 502)), timeoutMs);
    });
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  };

  const getJson = async (url, opts) => {
    const text = await getText(url, opts);
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('NET_FAILED', tr('inst.badJson', { url: shortUrl(url) }), 502);
    }
  };

  const head = async (url) => {
    const { res, url: finalUrl } = await open(url, 'HEAD');
    res.resume();
    const len = Number(res.headers['content-length']);
    return { url: finalUrl, size: Number.isFinite(len) && len >= 0 ? len : null };
  };

  /**
   * Streams url into file (via file.part), hashing on the way. With sha256 the hash must match
   * or the file is deleted and SHA_MISMATCH is thrown. onProgress({bytes, total}).
   */
  const download = async (url, file, { sha256 = null, onProgress = null, maxBytes = MAX_DOWNLOAD_BYTES } = {}) => {
    const part = `${file}.part`;
    try { fs.unlinkSync(part); } catch { /* not there */ }
    const { res, url: finalUrl } = await open(url);
    const total = Number(res.headers['content-length']);
    if (Number.isFinite(total) && total > maxBytes) {
      res.resume();
      throw new AppError('TOO_LARGE', tr('inst.tooBig', { url: shortUrl(url) }), 502);
    }
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      let failed = null;
      const fail = (e) => {
        if (failed) return;
        failed = e;
        try { res.destroy(); } catch { /* ignore */ }
        out.destroy();
      };
      res.on('data', (d) => {
        bytes += d.length;
        if (bytes > maxBytes) { fail(new AppError('TOO_LARGE', tr('inst.tooBig', { url: shortUrl(url) }), 502)); return; }
        hash.update(d);
        if (onProgress) { try { onProgress({ bytes, total: Number.isFinite(total) ? total : null }); } catch { /* ignore */ } }
      });
      res.on('aborted', () => fail(netError(new Error('aborted'))));
      res.on('error', (e) => fail(netError(e)));
      out.on('error', (e) => fail(e));
      out.on('close', () => {
        if (failed) reject(failed);
        else if (Number.isFinite(total) && bytes !== total) reject(new AppError('NET_FAILED', tr('inst.incomplete', { url: shortUrl(url) }), 502));
        else resolve();
      });
      res.pipe(out);
    }).catch((e) => {
      try { fs.unlinkSync(part); } catch { /* ignore */ }
      throw e;
    });
    const got = hash.digest('hex');
    if (sha256 && got !== String(sha256).toLowerCase()) {
      try { fs.unlinkSync(part); } catch { /* ignore */ }
      throw new AppError('SHA_MISMATCH', tr('inst.shaMismatch', { file: path.basename(file) }), 502, { expected: String(sha256).toLowerCase(), got });
    }
    fs.renameSync(part, file);
    return { bytes, sha256: got, url: finalUrl };
  };

  return Object.freeze({ getText, getJson, head, download, strict: !rewrite && !ca });
}

const STRICT = createFetcher();

// ------------------------------------------------------------------------------------------ parsers (PURE)

function parseSizeMB(s) {
  const m = /^\s*([\d.]+)\s*(B|KB|MB|GB)?\s*$/i.exec(String(s == null ? '' : s));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || 'B').toUpperCase();
  const mb = unit === 'GB' ? n * 1024 : unit === 'MB' ? n : unit === 'KB' ? n / 1024 : n / MB;
  return Math.round(mb * 100) / 100;
}

function validSha(s) {
  const x = String(s || '').trim().toLowerCase();
  return SHA_RE.test(x) ? x : null;
}

/** releases.json -> one item per PHP branch: the x64 NTS build with the newest VS/VC toolset. */
function parsePhpReleases(json, base = SOURCES.phpBase) {
  const items = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return items;
  for (const [branch, rel] of Object.entries(json)) {
    if (!/^\d+\.\d+$/.test(branch) || !rel || typeof rel !== 'object') continue;
    let best = null;
    for (const [key, build] of Object.entries(rel)) {
      const m = /^nts-(v[cs])(\d+)-x64$/i.exec(key);
      if (!m || !build || typeof build !== 'object' || !build.zip) continue;
      const tool = Number(m[2]);
      if (!best || tool > best.tool) best = { tool, toolset: `${m[1].toUpperCase()}${m[2]}`, zip: build.zip };
    }
    if (!best) continue;
    const file = String(best.zip.path || '');
    if (!/^php-[A-Za-z0-9._-]+-x64\.zip$/.test(file)) continue;
    const build = String(rel.version || '');
    const vm = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.]+)?$/.exec(build);
    if (!vm) continue;
    items.push({
      version: vm[1],
      build,
      branch,
      label: `PHP ${build} · NTS x64 · ${best.toolset}`,
      file,
      url: base + file,
      sha256: validSha(best.zip.sha256),
      sizeMB: parseSizeMB(best.zip.size),
    });
  }
  items.sort((a, b) => semver.compare(b.version, a.version));
  return items;
}

/** MariaDB major release list -> stable, not end-of-life majors (newest first, max 6). */
function parseMariadbMajors(json, now = new Date()) {
  const list = json && Array.isArray(json.major_releases) ? json.major_releases : [];
  return list
    .filter((r) => r && /^\d+\.\d+$/.test(String(r.release_id)) && /^stable$/i.test(String(r.release_status || ''))
      && (!r.release_eol_date || !(new Date(r.release_eol_date) <= now)))
    .map((r) => ({
      major: String(r.release_id),
      lts: /long\s*term/i.test(String(r.release_support_type || '')),
      support: r.release_support_type || null,
      eol: r.release_eol_date || null,
    }))
    .sort((a, b) => semver.compare(b.major, a.major))
    .slice(0, 6);
}

/**
 * <major>/latest (or the full <major>/ release list) -> {version, file, url, sha256} of the NEWEST
 * winx64.zip, or null.
 */
function parseMariadbLatest(json, major = null) {
  const rels = json && json.releases && typeof json.releases === 'object' ? Object.values(json.releases) : [];
  let best = null;
  for (const rel of rels) {
    for (const f of (rel && Array.isArray(rel.files) ? rel.files : [])) {
      const name = String((f && f.file_name) || '');
      const m = /^mariadb-(\d+\.\d+\.\d+)-winx64\.zip$/.exec(name);
      if (!m) continue;
      if (major && !m[1].startsWith(`${major}.`)) continue;
      if (best && semver.compare(m[1], best.version) <= 0) continue;
      best = {
        version: m[1],
        file: name,
        url: SOURCES.mariadbFile(m[1], name),
        sha256: validSha(f.checksum && f.checksum.sha256sum),
        date: (rel && rel.date_of_release) || null,
      };
    }
  }
  return best;
}

// Majors no longer in the REST major list but still common (XAMPP ships 10.4); their files and
// SHA-256 are still on the official hosts.
const LEGACY_MARIADB_MAJORS = Object.freeze(['10.5', '10.4']);

/**
 * Every stable MariaDB major (also end-of-life ones, flagged) plus the legacy majors above,
 * newest first. Used by the wizard catalog, which lets old projects match an old server. PURE.
 */
function parseMariadbMajorsAll(json, now = new Date()) {
  const list = json && Array.isArray(json.major_releases) ? json.major_releases : [];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || !/^\d+\.\d+$/.test(String(r.release_id)) || !/^stable$/i.test(String(r.release_status || ''))) continue;
    const major = String(r.release_id);
    seen.add(major);
    out.push({
      major,
      lts: /long\s*term/i.test(String(r.release_support_type || '')),
      support: r.release_support_type || null,
      eol: !!(r.release_eol_date && new Date(r.release_eol_date) <= now),
    });
  }
  for (const major of LEGACY_MARIADB_MAJORS) {
    if (!seen.has(major)) out.push({ major, lts: true, support: 'Long Term Support', eol: true });
  }
  return out.sort((a, b) => semver.compare(b.major, a.major)).slice(0, 10);
}

/** getcomposer.org/versions -> stable 2.x items (newest first; 2.2 is the LTS line). */
function parseComposerVersions(json) {
  const out = [];
  const seen = new Set();
  for (const v of (json && Array.isArray(json.stable) ? json.stable : [])) {
    const ver = String((v && v.version) || '');
    if (!/^2\.\d+\.\d+$/.test(ver) || seen.has(ver)) continue;
    seen.add(ver);
    const minPhp = Number(v['min-php']);
    out.push({
      version: ver,
      lts: v.lts === true,
      minPhp: Number.isInteger(minPhp) && minPhp > 0
        ? `${Math.floor(minPhp / 10000)}.${Math.floor(minPhp / 100) % 100}.${minPhp % 100}` : null,
      file: 'composer.phar',
      url: SOURCES.composerPhar(ver),
    });
  }
  out.sort((a, b) => semver.compare(b.version, a.version));
  return out;
}

/** phpmyadmin.net version.json -> [{version, label, file, url, php}] (newest first). PURE. */
function parsePmaVersions(json) {
  const out = [];
  const seen = new Set();
  for (const r of (json && Array.isArray(json.releases) ? json.releases : [])) {
    const v = String((r && r.version) || '');
    if (!VERSION_RE.test(v) || seen.has(v)) continue;
    seen.add(v);
    const file = `phpMyAdmin-${v}-all-languages.zip`;
    const php = r.php_versions ? String(r.php_versions).slice(0, 40) : null;
    out.push({ version: v, label: `phpMyAdmin ${v}${php ? ` (PHP ${php})` : ''}`, file, url: SOURCES.pmaZip(v), php });
  }
  return out.sort((a, b) => semver.compare(b.version, a.version));
}

const CLOUDFLARED_FILE = 'cloudflared-windows-amd64.exe';

/**
 * GitHub "latest release" of cloudflare/cloudflared -> [{version, file, url, sha256, sizeMB}] for the
 * Windows x64 exe, or []. Only a download URL under the official release path is accepted; the
 * checksum is GitHub's asset digest, else the "cloudflared-windows-amd64.exe: <sha>" line of the
 * release notes. PURE.
 */
function parseCloudflaredRelease(json) {
  if (!json || typeof json !== 'object') return [];
  const tag = String(json.tag_name || '').replace(/^v/i, '');
  if (!VERSION_RE.test(tag)) return [];
  const asset = (Array.isArray(json.assets) ? json.assets : []).find((a) => a && a.name === CLOUDFLARED_FILE);
  if (!asset) return [];
  const url = String(asset.browser_download_url || '');
  const okUrls = [`${SOURCES.cloudflaredPrefix}${tag}/${CLOUDFLARED_FILE}`, `${SOURCES.cloudflaredPrefix}v${tag}/${CLOUDFLARED_FILE}`];
  if (!okUrls.includes(url)) return [];
  const dm = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  let sha = dm ? dm[1].toLowerCase() : null;
  if (!sha) {
    const line = String(json.body || '').split(/\r?\n/).find((l) => l.includes(`${CLOUDFLARED_FILE}:`));
    const bm = line ? /:\s*([0-9a-f]{64})\b/i.exec(line) : null;
    sha = bm ? bm[1].toLowerCase() : null;
  }
  const size = Number(asset.size);
  return [{
    version: tag, label: `cloudflared ${tag}`, file: CLOUDFLARED_FILE, url, sha256: sha,
    sizeMB: Number.isFinite(size) && size > 0 ? Math.round((size / MB) * 100) / 100 : null,
  }];
}

/** nodejs.org/dist/index.json -> the newest LTS release with a win-x64 zip, or null. */
function parseNodeIndex(json) {
  const list = (Array.isArray(json) ? json : [])
    .filter((r) => r && /^v\d+\.\d+\.\d+$/.test(String(r.version)) && r.lts && Array.isArray(r.files) && r.files.includes('win-x64-zip'))
    .sort((a, b) => semver.compare(b.version, a.version));
  if (!list.length) return null;
  const v = list[0].version;
  return { version: v, lts: String(list[0].lts), file: `node-${v}-win-x64.zip`, url: SOURCES.nodeZip(v) };
}

/** "<sha256>  <file>" lines (sha256sum / SHASUMS256.txt format) -> Map(file -> sha). */
function parseShasums(text) {
  const map = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(\S.*?)\s*$/.exec(raw);
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

/** Checksum of fileName from a checksum document; a single bare hash also counts. */
function shaFor(text, fileName) {
  const map = parseShasums(text);
  if (map.has(fileName)) return map.get(fileName);
  const bare = /^\s*([0-9a-fA-F]{64})\s*$/.exec(String(text || ''));
  return bare ? bare[1].toLowerCase() : null;
}

// ------------------------------------------------------------------------------------------ php.ini (PURE)

/** True when php.ini text already loads the extension (an uncommented extension= line). */
function iniLoadsExtension(text, name) {
  const re = new RegExp(`^\\s*extension\\s*=\\s*["']?(?:php_)?${name}(?:\\.dll)?["']?\\s*(?:;.*)?$`, 'im');
  return re.test(String(text || ''));
}

/**
 * php.ini for a freshly installed PHP: the template (php.ini-development) unchanged plus a
 * PHP Station block at the end (later values win): extension_dir, the extensions whose DLL exists
 * and the CA bundle for curl/openssl.
 */
function buildPhpIni(template, { phpDir, extensions = [], cacert = null, source = 'php.ini-development' } = {}) {
  const text = String(template || '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = [`; generated by PHP Station ${VERSION} from ${source}`];
  lines.push(text.replace(/\s+$/, ''));
  lines.push('');
  lines.push('; ------------------------------------------------------------------ PHP Station');
  lines.push(`extension_dir="${win.join(phpDir, 'ext')}"`);
  for (const ext of extensions) {
    if (!iniLoadsExtension(text, ext)) lines.push(`extension=${ext}`);
  }
  if (cacert) {
    lines.push(`curl.cainfo="${cacert}"`);
    lines.push(`openssl.cafile="${cacert}"`);
  }
  return lines.join(eol) + eol;
}

/** Extension names (in PHP_EXTENSIONS order) whose DLL exists in extDir (gd -> gd2 on old PHP). */
function presentExtensions(extDir, exists = util.existsFile) {
  const out = [];
  for (const name of PHP_EXTENSIONS) {
    if (exists(win.join(extDir, `php_${name}.dll`))) out.push(name);
    else if (name === 'gd' && exists(win.join(extDir, 'php_gd2.dll'))) out.push('gd2');
  }
  return out;
}

// ------------------------------------------------------------------------------------------ zip safety (PURE-ish)

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

function u64(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return hi * 0x100000000 + lo;
}

/** Central directory of a zip file -> [{name, size, compressedSize, isDir, isSymlink}]. */
function listZipEntries(file) {
  const bad = (why) => new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: why }), 502);
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw bad('too small');
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw bad('no end of central directory');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = eocd - 20;
      if (locPos < 0 || tail.readUInt32LE(locPos) !== 0x07064b50) throw bad('zip64 locator missing');
      const z64Pos = u64(tail, locPos + 8);
      const z64 = readAt(fd, z64Pos, 56);
      if (z64.length < 56 || z64.readUInt32LE(0) !== 0x06064b50) throw bad('zip64 record missing');
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    if (cdOffset + cdSize > size || cdSize > 256 * MB || count > 200000) throw bad('central directory out of range');
    const cd = readAt(fd, cdOffset, cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw bad('broken central directory');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      let compressedSize = cd.readUInt32LE(p + 20);
      let sizeU = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      if (sizeU === 0xffffffff || compressedSize === 0xffffffff) {
        // zip64 extra field (id 0x0001): uncompressed then compressed size when they overflow
        const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        for (let q = 0; q + 4 <= extra.length;) {
          const id = extra.readUInt16LE(q);
          const len = extra.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            if (sizeU === 0xffffffff && r + 8 <= q + 4 + len) { sizeU = u64(extra, r); r += 8; }
            if (compressedSize === 0xffffffff && r + 8 <= q + 4 + len) { compressedSize = u64(extra, r); }
            break;
          }
          q += 4 + len;
        }
      }
      const unixMode = (madeBy >> 8) === 3 ? (extAttr >>> 16) : 0;
      out.push({
        name,
        size: sizeU,
        compressedSize,
        isDir: name.endsWith('/') || name.endsWith('\\'),
        isSymlink: (unixMode & 0o170000) === 0o120000,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Refuses archives that could write outside the target folder (zip slip), links and zip bombs. */
function checkZipEntries(entries) {
  const unsafe = (name) => new AppError('UNSAFE_ARCHIVE', tr('inst.unsafeArchive', { name: String(name).slice(0, 120) }), 502);
  if (!Array.isArray(entries) || !entries.length) throw new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: 'empty' }), 502);
  let total = 0;
  for (const e of entries) {
    const n = String(e.name || '').replace(/\\/g, '/');
    if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes(':') || n.includes('\0')) throw unsafe(e.name);
    if (n.split('/').some((seg) => seg === '..')) throw unsafe(e.name);
    if (e.isSymlink) throw unsafe(e.name);
    total += Number(e.size) || 0;
  }
  if (total > MAX_UNPACKED_BYTES) throw new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: 'too large when unpacked' }), 502);
  return true;
}

/** After extraction: every entry must be a plain file/folder inside root (no links, no escapes). */
function verifyExtracted(root) {
  const realRoot = fs.realpathSync(root);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new AppError('UNSAFE_ARCHIVE', tr('inst.unsafeArchive', { name: e.name }), 502);
      const real = fs.realpathSync(full);
      if (!util.isInside(real, realRoot)) throw new AppError('UNSAFE_ARCHIVE', tr('inst.unsafeArchive', { name: e.name }), 502);
      if (st.isDirectory()) stack.push(full);
    }
  }
}

// ------------------------------------------------------------------------------------------ folders

function runtimesDir(ctx) {
  return runtimes.toolRuntimesDir(ctx);
}

function targetDir(ctx, kind, version) {
  if (!KINDS.includes(kind) || !VERSION_RE.test(String(version))) throw new AppError('BAD_INPUT', tr('inst.badKindVersion'), 400);
  return path.join(runtimesDir(ctx), kind, version);
}

/** Deletes a folder we created, but only when it is inside <tool>\runtimes. */
function removeInside(ctx, p) {
  if (!p || !util.isInside(p, runtimesDir(ctx))) return;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

function renameWithRetry(from, to) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      util.sleepSync(250); // antivirus scanners hold fresh files for a moment
    }
  }
  throw last;
}

function instState(ctx) {
  if (!ctx.installer) ctx.installer = { catalog: {} };
  return ctx.installer;
}

// ------------------------------------------------------------------------------------------ catalog

function installedVersion(ctx, kind, version) {
  if (util.existsDir(path.join(runtimesDir(ctx), kind, version))) return true;
  const cache = runtimes.getCache(ctx);
  if (kind === 'php') return cache.php.some((p) => p.ok && p.version === version);
  if (kind === 'composer') return cache.composer.some((c) => c.ok && c.version === version);
  if (kind === 'phpmyadmin' || kind === 'cloudflared') return false;
  return cache.db.some((d) => d.kind === 'mariadb' && d.serverExe && d.version === version);
}

const BUILDERS = {
  async php(fetcher) {
    return parsePhpReleases(await fetcher.getJson(SOURCES.phpReleases)).map((it) => ({
      version: it.version, label: it.label, file: it.file, url: it.url, sha256: it.sha256, sizeMB: it.sizeMB, build: it.build,
    }));
  },
  async mariadb(fetcher) {
    const majors = parseMariadbMajorsAll(await fetcher.getJson(SOURCES.mariadbMajors));
    const items = await util.mapLimit(majors, 3, async (m) => {
      let latest = null;
      try { latest = parseMariadbLatest(await fetcher.getJson(SOURCES.mariadbLatest(m.major)), m.major); } catch { latest = null; }
      if (!latest) {
        // end-of-life majors have no /latest/: the full release list of the major has the same data
        try { latest = parseMariadbLatest(await fetcher.getJson(SOURCES.mariadbMajor(m.major)), m.major); } catch { latest = null; }
      }
      if (!latest) return null;
      let sizeMB = null;
      try {
        const h = await fetcher.head(latest.url);
        if (h.size) sizeMB = Math.round((h.size / MB) * 100) / 100;
      } catch { /* size is optional */ }
      return {
        version: latest.version, label: `MariaDB ${latest.version}${m.lts ? ' LTS' : ''}${m.eol ? ' (EOL)' : ''}`, file: latest.file, url: latest.url,
        sha256: latest.sha256, sizeMB, lts: m.lts, eol: m.eol,
      };
    });
    return items.filter(Boolean);
  },
  async phpmyadmin(fetcher) {
    const list = parsePmaVersions(await fetcher.getJson(SOURCES.pmaVersions));
    return util.mapLimit(list, 2, async (it) => {
      let sha = null;
      try { sha = shaFor(await fetcher.getText(SOURCES.pmaSha(it.version), { maxBytes: 4096 }), it.file); } catch { sha = null; }
      let sizeMB = null;
      try { const h = await fetcher.head(it.url); if (h.size) sizeMB = Math.round((h.size / MB) * 100) / 100; } catch { /* optional */ }
      return Object.assign({}, it, { sha256: sha, sizeMB });
    });
  },
  async cloudflared(fetcher) {
    return parseCloudflaredRelease(await fetcher.getJson(SOURCES.cloudflaredRelease));
  },
  async composer(fetcher) {
    const list = parseComposerVersions(await fetcher.getJson(SOURCES.composerVersions));
    return util.mapLimit(list, 2, async (c) => {
      let sha = null;
      try { sha = shaFor(await fetcher.getText(SOURCES.composerSha(c.version), { maxBytes: 4096 }), 'composer.phar'); } catch { sha = null; }
      return {
        version: c.version, label: `Composer ${c.version}${c.lts ? ' LTS' : ''}${c.minPhp ? ` (PHP >= ${c.minPhp})` : ''}`,
        file: c.file, url: c.url, sha256: sha, sizeMB: null, lts: c.lts,
      };
    });
  },
};

/** {kind, items, fetchedAt} (network, cached 1 h per panel). */
async function getCatalog(ctx, kind, { fetcher = STRICT, force = false } = {}) {
  if (!KINDS.includes(kind)) throw new AppError('BAD_INPUT', tr('inst.badKind'), 400);
  const st = instState(ctx);
  let c = st.catalog[kind];
  if (force || !c || Date.now() - c.at > CATALOG_TTL_MS) {
    let items;
    try {
      items = await BUILDERS[kind](fetcher);
    } catch (e) {
      throw netError(e);
    }
    if (!items.length) throw new AppError('NET_FAILED', tr('inst.catalogEmpty'), 502);
    c = { at: Date.now(), fetchedAt: util.nowIso(), items };
    st.catalog[kind] = c;
  }
  return {
    kind,
    fetchedAt: c.fetchedAt,
    items: c.items.map((it) => Object.assign({}, it, { installed: installedVersion(ctx, kind, it.version) })),
  };
}

// ------------------------------------------------------------------------------------------ system summary (no network)

function uniqueSorted(list) {
  return [...new Set(list.filter(Boolean))].sort((a, b) => semver.compare(b, a));
}

function systemSummary(ctx) {
  const cache = runtimes.getCache(ctx);
  const php = uniqueSorted(cache.php.filter((p) => p.ok).map((p) => p.version));
  const mariadb = uniqueSorted(cache.db.filter((d) => d.serverExe && d.kind === 'mariadb').map((d) => d.version));
  const mysql = uniqueSorted(cache.db.filter((d) => d.serverExe && d.kind === 'mysql').map((d) => d.version));
  const composer = uniqueSorted(cache.composer.filter((c) => c.ok).map((c) => c.version));
  const missing = [];
  if (!php.length) missing.push({ kind: 'php', reason: tr('inst.missingPhp') });
  if (!mariadb.length && !mysql.length) missing.push({ kind: 'mariadb', reason: tr('inst.missingDb') });
  if (!composer.length) missing.push({ kind: 'composer', reason: tr('inst.missingComposer') });
  const cat = instState(ctx).catalog;
  const newest = (kind) => {
    const c = cat[kind];
    if (!c || !c.items.length) return null;
    const pick = kind === 'composer' ? c.items.find((x) => !x.lts) || c.items[0] : kind === 'mariadb' ? c.items.find((x) => x.lts) || c.items[0] : c.items[0];
    return pick.version;
  };
  return {
    php,
    mariadb,
    mysql,
    composer,
    node: { version: process.versions.node, path: process.execPath },
    missing,
    recommended: missing.map((m) => ({ kind: m.kind, version: newest(m.kind) })),
    runtimesDir: runtimesDir(ctx),
    scannedAt: cache.scannedAt,
    scanning: cache.scanning,
  };
}

// ------------------------------------------------------------------------------------------ install

function fmtProgress(bytes, total) {
  if (total) return `${util.fmtMB(bytes)} / ${util.fmtMB(total)} (${Math.floor((bytes / total) * 100)}%)`;
  return util.fmtMB(bytes);
}

const TAR_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const EXPAND_SCRIPT = String.raw`
try {
  Expand-Archive -LiteralPath $env:DP_ZIP -DestinationPath $env:DP_DEST -Force
  [Console]::Out.WriteLine('{"ok":true}')
} catch {
  [Console]::Out.WriteLine((DP-Ascii (ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message } -Compress)))
}
`;

/** tar.exe -xf (Windows 10+), PowerShell Expand-Archive as the fallback. */
async function extractZip(zip, dest, log) {
  util.ensureDir(dest);
  if (util.existsFile(TAR_EXE)) {
    const r = await util.run(TAR_EXE, ['-xf', zip, '-C', dest], { timeoutMs: 15 * 60 * 1000, env: util.cleanEnv({ remove: [] }) });
    if (r.code === 0) return 'tar';
    log('warn', tr('inst.tarFailed', { message: util.firstLine(r.stderr) || util.describeExit(r, TAR_EXE) }));
    for (const e of fs.readdirSync(dest)) fs.rmSync(path.join(dest, e), { recursive: true, force: true });
  }
  const env = util.cleanEnv({ remove: [], set: { DP_ZIP: zip, DP_DEST: dest } });
  const r = await procs.psOneShot(EXPAND_SCRIPT, { env, timeoutMs: 15 * 60 * 1000 });
  if (!r.json || !r.json.ok) throw new AppError('EXTRACT_FAILED', tr('inst.extractFailed', { message: (r.json && r.json.error) || r.error || '?' }), 500);
  return 'Expand-Archive';
}

function archiveRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  return dir;
}

async function ensureCacert(ctx, fetcher, log) {
  const file = path.join(runtimesDir(ctx), 'cacert.pem');
  if (util.existsFile(file)) return file;
  try {
    const sha = shaFor(await fetcher.getText(SOURCES.cacertSha, { maxBytes: 4096 }), 'cacert.pem');
    if (!sha) throw new AppError('NO_CHECKSUM', tr('inst.noChecksum'), 502);
    const tmp = path.join(util.ensureDir(path.join(runtimesDir(ctx), '_downloads')), 'cacert.pem');
    await fetcher.download(SOURCES.cacert, tmp, { sha256: sha, maxBytes: 5 * MB });
    renameWithRetry(tmp, file);
    log('ok', tr('inst.cacertOk', { path: file }));
    return file;
  } catch (e) {
    log('warn', tr('inst.cacertFailed', { message: e.message }));
    return null;
  }
}

function uniqueInstanceName(ctx, base) {
  const used = ctx.store.data.dbServers || {};
  for (let i = 1; i < 100; i++) {
    const name = (i === 1 ? base : `${base}-${i}`).slice(0, 30);
    if (!used[`dbi-${name}`]) return name;
  }
  return `${base.slice(0, 22)}-${util.randomHex(3)}`;
}

/** After a MariaDB install: a new DB server instance with its datadir inside the version folder. */
async function createDbInstance(ctx, version, target, log) {
  const binDir = path.join(target, 'bin');
  const inst = runtimes.getCache(ctx).db.find((d) => util.samePath(d.binDir, binDir));
  if (!inst || !inst.ok || !inst.serverExe || !inst.installDb || inst.kind !== 'mariadb') {
    throw new AppError('INSTANCE_FAILED', tr('inst.instanceFailed', { message: (inst && inst.error) || tr('inst.notRecognised') }), 500, { path: target });
  }
  const s = ctx.store.data.settings;
  const reserved = dbservers.buildEntries(ctx).map((e) => e.effectivePort);
  let busy = [];
  try { busy = (await procs.listListeners({ maxAgeMs: 0 })).map((l) => l.port); } catch { /* best effort */ }
  const port = ports.pickPort({ from: s.dbPortRange[0], to: s.dbPortRange[1], reserved, busy });
  if (!port) throw new AppError('INSTANCE_FAILED', tr('inst.instanceFailed', { message: tr('inst.noDbPort') }), 409, { path: target });
  let datadir = path.join(target, 'data');
  for (let i = 2; fs.existsSync(datadir) && i < 50; i++) datadir = path.join(target, `data-${i}`);
  const name = uniqueInstanceName(ctx, `mariadb-${version.replace(/\./g, '-')}`);
  const r = await dbservers.createInstance(ctx, { installId: inst.id, name, port }, log, { datadir });
  return { instanceId: r.id, port: r.port, datadir: r.datadir };
}

/**
 * The install job: catalog lookup -> download into runtimes\_downloads -> SHA-256 check ->
 * zip check + extraction into runtimes\_tmp -> rename to runtimes\<kind>\<version> ->
 * runtime scan (-> MariaDB: new DB server instance).
 */
async function installJob(ctx, { kind, version }, log, job, { fetcher = STRICT } = {}) {
  const target = targetDir(ctx, kind, version);
  const rdir = runtimesDir(ctx);
  if (fs.existsSync(target)) throw new AppError('EXISTS', tr('inst.exists', { path: target }), 409);
  job.progress = { stage: 'catalog', bytes: 0, total: null, percent: null };
  const cat = await getCatalog(ctx, kind, { fetcher });
  const item = cat.items.find((x) => x.version === version);
  if (!item) throw new AppError('NOT_IN_CATALOG', tr('inst.notInCatalog', { kind, version }), 404);
  let sha = validSha(item.sha256);
  if (!sha && kind === 'composer') sha = shaFor(await fetcher.getText(SOURCES.composerSha(version), { maxBytes: 4096 }), 'composer.phar');
  if (!sha && kind === 'phpmyadmin') {
    try { sha = shaFor(await fetcher.getText(SOURCES.pmaSha(version), { maxBytes: 4096 }), String(item.file || '')); } catch { sha = null; }
  }
  if (!sha && kind === 'mariadb') {
    try { sha = shaFor(await fetcher.getText(SOURCES.mariadbSums(version), { maxBytes: 256 * 1024 }), String(item.file || '')); } catch { sha = null; }
  }
  if (!sha) throw new AppError('NO_CHECKSUM', tr('inst.noChecksum'), 502);
  const fileName = path.basename(String(item.file || ''));
  const nameOk = kind === 'cloudflared' ? fileName === CLOUDFLARED_FILE : /^[A-Za-z0-9._-]+\.(zip|phar)$/.test(fileName);
  if (!nameOk) throw new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: 'file name' }), 502);
  log('info', tr('inst.source', { url: item.url, size: item.sizeMB ? `${item.sizeMB} MB` : '?' }));
  log('info', tr('inst.target', { path: target }));

  const dlDir = util.ensureDir(path.join(rdir, '_downloads'));
  const archive = path.join(dlDir, fileName);
  const tmpBase = util.ensureDir(path.join(rdir, '_tmp'));
  const tmp = path.join(tmpBase, `${kind}-${version}-${util.randomHex(3)}`);
  try {
    const cacert = kind === 'php' ? await ensureCacert(ctx, fetcher, log) : null;

    // download + verify
    job.progress = { stage: 'download', bytes: 0, total: null, percent: 0 };
    let lastLog = 0;
    try { fs.unlinkSync(archive); } catch { /* stale copy */ }
    const dl = await fetcher.download(item.url, archive, {
      sha256: sha,
      onProgress: ({ bytes, total }) => {
        job.progress = { stage: 'download', bytes, total, percent: total ? Math.floor((bytes / total) * 100) : null };
        if (Date.now() - lastLog >= 2000) { lastLog = Date.now(); log('info', `Download: ${fmtProgress(bytes, total)}`); }
      },
    });
    log('info', `Download: ${fmtProgress(dl.bytes, dl.bytes)}`);
    log('ok', tr('inst.shaOk', { sha: sha.slice(0, 16) }));
    job.progress = { stage: 'extract', bytes: dl.bytes, total: dl.bytes, percent: 100 };

    // unpack into the temp folder
    util.ensureDir(tmp);
    let root = tmp;
    if (kind === 'composer') {
      fs.copyFileSync(archive, path.join(tmp, 'composer.phar'));
    } else if (kind === 'cloudflared') {
      fs.copyFileSync(archive, path.join(tmp, 'cloudflared.exe'));
    } else {
      checkZipEntries(listZipEntries(archive));
      const how = await extractZip(archive, tmp, log);
      verifyExtracted(tmp);
      root = archiveRoot(tmp);
      log('ok', tr('inst.extracted', { how }));
    }
    if (kind === 'php' && !util.existsFile(path.join(root, 'php.exe'))) throw new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: 'php.exe missing' }), 502);
    if (kind === 'mariadb' && !['mariadbd.exe', 'mysqld.exe'].some((f) => util.existsFile(path.join(root, 'bin', f)))) {
      throw new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: 'bin\\mariadbd.exe missing' }), 502);
    }
    if (kind === 'phpmyadmin' && !(util.existsFile(path.join(root, 'index.php')) && util.existsDir(path.join(root, 'libraries')))) {
      throw new AppError('BAD_ARCHIVE', tr('inst.badArchive', { reason: 'index.php / libraries missing' }), 502);
    }
    if (kind === 'php') {
      const tplName = ['php.ini-development', 'php.ini-production'].find((f) => util.existsFile(path.join(root, f)));
      const tpl = tplName ? fs.readFileSync(path.join(root, tplName), 'utf8') : '';
      const exts = presentExtensions(path.join(root, 'ext'));
      fs.writeFileSync(path.join(root, 'php.ini'), buildPhpIni(tpl, { phpDir: target, extensions: exts, cacert, source: tplName || 'defaults' }));
      log('ok', tr('inst.phpIni', { list: exts.join(', ') || '-' }));
    }

    // move into place (never over an existing folder)
    job.progress = { stage: 'install', bytes: dl.bytes, total: dl.bytes, percent: 100 };
    if (fs.existsSync(target)) throw new AppError('EXISTS', tr('inst.exists', { path: target }), 409);
    util.ensureDir(path.dirname(target));
    renameWithRetry(root, target);
    log('ok', tr('inst.installed', { path: target }));
  } finally {
    removeInside(ctx, tmp);
    try { fs.unlinkSync(archive); } catch { /* already gone */ }
    try { fs.unlinkSync(`${archive}.part`); } catch { /* already gone */ }
  }

  // make it visible (runtimes\ is a scan root) and create the DB server for MariaDB
  const result = { kind, version, path: target };
  job.progress = { stage: 'scan', bytes: null, total: null, percent: 100 };
  if (kind !== 'cloudflared') {
    log('info', tr('inst.scanning'));
    await runtimes.scan(ctx, () => {});
  }
  if (kind === 'mariadb') {
    Object.assign(result, await createDbInstance(ctx, version, target, log));
    log('ok', tr('inst.instanceOk', { port: result.port }));
  }
  job.progress = { stage: 'done', bytes: null, total: null, percent: 100 };
  return result;
}

/** POST /api/installer/install (validation before the job; no options from the request). */
function startInstall(ctx, jobs, body) {
  const b = body || {};
  if (b.confirm !== true) throw new AppError('CONFIRM_REQUIRED', tr('inst.confirmRequired'), 400);
  const kind = String(b.kind || '');
  const version = String(b.version || '');
  if (!KINDS.includes(kind)) throw new AppError('BAD_INPUT', tr('inst.badKind'), 400);
  if (!VERSION_RE.test(version)) throw new AppError('BAD_INPUT', tr('inst.badKindVersion'), 400);
  const target = targetDir(ctx, kind, version);
  if (fs.existsSync(target)) throw new AppError('EXISTS', tr('inst.exists', { path: target }), 409);
  if (jobs.findRunning('install')) throw new AppError('BUSY', tr('inst.busy'), 409);
  const title = tr('job.install', { kind: kindName(kind), version });
  return { jobId: jobs.createJob('install', title, (log, job) => installJob(ctx, { kind, version }, log, job)) };
}

function kindName(kind) {
  return kind === 'php' ? 'PHP' : kind === 'mariadb' ? 'MariaDB' : kind === 'phpmyadmin' ? 'phpMyAdmin' : kind === 'cloudflared' ? 'cloudflared' : 'Composer';
}

const MAX_BATCH = 12;

/**
 * Validated, de-duplicated batch list [{kind, version}] (throws on bad input). Versions that are
 * already installed are left out (never overwritten). PURE apart from the folder check.
 */
function normalizeBatch(ctx, items) {
  if (!Array.isArray(items) || !items.length) throw new AppError('BAD_INPUT', tr('inst.batchEmpty'), 400);
  if (items.length > MAX_BATCH) throw new AppError('BAD_INPUT', tr('inst.batchTooMany', { max: MAX_BATCH }), 400);
  const out = [];
  const seen = new Set();
  const order = { mariadb: 0, php: 1, composer: 2, phpmyadmin: 3, cloudflared: 4 }; // DB first (longest), Composer last (needs a PHP)
  for (const raw of items) {
    const kind = String((raw && raw.kind) || '');
    const version = String((raw && raw.version) || '');
    if (!KINDS.includes(kind)) throw new AppError('BAD_INPUT', tr('inst.badKind'), 400);
    if (!VERSION_RE.test(version)) throw new AppError('BAD_INPUT', tr('inst.badKindVersion'), 400);
    const key = `${kind}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(targetDir(ctx, kind, version))) continue;
    out.push({ kind, version });
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind] || semver.compare(b.version, a.version));
}

/**
 * One job that installs several items one after the other (the Setup Wizard). A failed item is
 * logged and the next one continues; the job fails only when nothing could be installed.
 */
async function batchJob(ctx, list, log, job, { fetcher = STRICT } = {}) {
  const done = [];
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const tag = `[${i + 1}/${list.length}] ${kindName(it.kind)} ${it.version}`;
    job.batch = { index: i + 1, total: list.length, kind: it.kind, version: it.version };
    log('info', `${tag} — ${tr('inst.batchItemStart')}`);
    const sub = (level, text) => log(level, `${tag}: ${text}`);
    try {
      const r = await installJob(ctx, it, sub, job, { fetcher });
      done.push(Object.assign({}, it, r));
      log('ok', `${tag} — ${tr('inst.batchItemOk')}`);
    } catch (e) {
      failed.push(Object.assign({}, it, { code: e.code || 'FAILED', error: e.message || String(e) }));
      log('bad', `${tag} — ${tr('inst.batchItemFailed', { message: e.message || String(e) })}`);
    }
  }
  if (!done.length && failed.length) {
    throw new AppError('INSTALL_FAILED', tr('inst.batchAllFailed', { n: failed.length }), 500, { failed });
  }
  log(failed.length ? 'warn' : 'ok', tr('inst.batchSummary', { ok: done.length, failed: failed.length }));
  return { batch: true, done, failed };
}

/** POST /api/installer/install-batch {items:[{kind, version}], confirm:true}. */
function startBatchInstall(ctx, jobs, body) {
  const b = body || {};
  if (b.confirm !== true) throw new AppError('CONFIRM_REQUIRED', tr('inst.confirmRequired'), 400);
  const list = normalizeBatch(ctx, b.items);
  if (!list.length) throw new AppError('NOTHING_TO_DO', tr('inst.batchNothing'), 409);
  if (jobs.findRunning('install')) throw new AppError('BUSY', tr('inst.busy'), 409);
  const title = tr('job.installBatch', { list: list.map((x) => `${kindName(x.kind)} ${x.version}`).join(', ') });
  return { jobId: jobs.createJob('install', title, (log, job) => batchJob(ctx, list, log, job)), items: list };
}

module.exports = {
  ALLOWED_HOSTS,
  SOURCES,
  KINDS,
  PHP_EXTENSIONS,
  STRICT,
  // pure
  checkUrl,
  parseSizeMB,
  parsePhpReleases,
  parseMariadbMajors,
  parseMariadbMajorsAll,
  LEGACY_MARIADB_MAJORS,
  parseMariadbLatest,
  parseComposerVersions,
  parsePmaVersions,
  parseNodeIndex,
  parseCloudflaredRelease,
  CLOUDFLARED_FILE,
  parseShasums,
  shaFor,
  buildPhpIni,
  iniLoadsExtension,
  presentExtensions,
  listZipEntries,
  checkZipEntries,
  // network / install
  createFetcher,
  getCatalog,
  systemSummary,
  installJob,
  startInstall,
  normalizeBatch,
  batchJob,
  startBatchInstall,
  runtimesDir,
  installedVersion,
};
