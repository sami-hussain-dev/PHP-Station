'use strict';
/*
 * Installer end-to-end against a LOCAL https fixture server (127.0.0.1:7178, test-only
 * certificate). The production URL policy runs unchanged: official URLs are checked against
 * the allow-list (https, allowed hosts, redirects), and only then does the test fetcher's
 * `rewrite` hook send the request to the fixture server. That hook exists only in code
 * (installer.createFetcher); the HTTP API never passes it. Nothing is downloaded from the
 * internet and nothing downloaded is executed (the fixture "php.exe" is a text file).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const H = require('./helpers');

const lib = (m) => require(path.join(__dirname, '..', 'lib', m));
const FIXTURE_PORT = 7178;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const PHP_VER = '8.5.99';
const PHP_FILE = `php-${PHP_VER}-1-nts-Win32-vs17-x64.zip`;
const PHP_OLD_TOOLSET = `php-${PHP_VER}-1-nts-Win32-vs16-x64.zip`;
const INI_DEV = [
  '[PHP]',
  'engine = On',
  ';extension_dir = "ext"',
  ';extension=curl',
  ';extension=gd',
  ';extension=mbstring',
  ';extension=openssl',
  ';extension=pdo_mysql',
  'extension=zip',
  '',
].join('\r\n');

const PHP_ZIP = H.makeZip([
  { name: 'php.exe', data: 'fixture: not a real program' },
  { name: 'php.ini-development', data: INI_DEV },
  { name: 'php.ini-production', data: '[PHP]\r\n' },
  { name: 'ext/', data: null },
  { name: 'ext/php_curl.dll', data: 'x' },
  { name: 'ext/php_mbstring.dll', data: 'x' },
  { name: 'ext/php_openssl.dll', data: 'x' },
  { name: 'ext/php_pdo_mysql.dll', data: 'x' },
  { name: 'ext/php_zip.dll', data: 'x' },
  { name: 'ext/php_exif.dll', data: 'x' },
]);
const CACERT = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n';
const MDB_VER = '11.99.1';
const MDB_FILE = `mariadb-${MDB_VER}-winx64.zip`;
const MDB_ZIP = H.makeZip([
  { name: `mariadb-${MDB_VER}-winx64/`, data: null },
  { name: `mariadb-${MDB_VER}-winx64/bin/mariadbd.exe`, data: 'fixture' },
  { name: `mariadb-${MDB_VER}-winx64/bin/mariadb.exe`, data: 'fixture' },
  { name: `mariadb-${MDB_VER}-winx64/bin/mariadb-install-db.exe`, data: 'fixture' },
  { name: `mariadb-${MDB_VER}-winx64/share/README`, data: 'fixture' },
]);
const PHAR = Buffer.from('<?php // fixture composer.phar, never executed\n');
const SLIP_ZIP = H.makeZip([{ name: 'php.exe', data: 'x' }, { name: '../evil.txt', data: 'escaped' }]);
const LINK_ZIP = H.makeZip([{ name: 'php.exe', data: 'x' }, { name: 'link', data: 'C:/Windows', unixMode: 0o120777 }]);

function phpReleases(zipSha, file = PHP_FILE) {
  return {
    8.5: {
      version: `${PHP_VER}-1`,
      'nts-vs16-x64': { zip: { path: PHP_OLD_TOOLSET, size: '1MB', sha256: 'a'.repeat(64) } },
      'nts-vs17-x64': { mtime: 'x', zip: { path: file, size: '0.01MB', sha256: zipSha } },
      'ts-vs17-x64': { zip: { path: `php-${PHP_VER}-1-Win32-vs17-x64.zip`, size: '1MB', sha256: 'b'.repeat(64) } },
      'nts-vs17-x86': { zip: { path: `php-${PHP_VER}-1-nts-Win32-vs17-x86.zip`, size: '1MB', sha256: 'c'.repeat(64) } },
      source: { path: 'php-src.zip', size: '1MB', sha256: 'd'.repeat(64) },
    },
  };
}

/** Fixture behaviour per profile. */
function handler(profile, url, req, res) {
  const send = (status, body, headers) => H.sendFixture(res, status, body, headers);
  const redirect = (to) => { res.writeHead(302, { Location: to, 'Content-Length': 0 }); res.end(); };
  const u = new URL(url);
  // shared: CA bundle
  if (url === 'https://curl.se/ca/cacert.pem.sha256') return send(200, `${sha(Buffer.from(CACERT))}  cacert.pem\n`);
  if (url === 'https://curl.se/ca/cacert.pem') return send(200, CACERT);
  if (url === 'https://windows.php.net/downloads/releases/releases.json') {
    // windows.php.net answers with a redirect to downloads.php.net, like the real one
    return redirect('https://downloads.php.net/~windows/releases/releases.json');
  }
  if (url === 'https://downloads.php.net/~windows/releases/releases.json') {
    if (profile === 'php-badsha') return send(200, phpReleases('0'.repeat(64)));
    if (profile === 'php-slip') return send(200, phpReleases(sha(SLIP_ZIP)));
    if (profile === 'php-link') return send(200, phpReleases(sha(LINK_ZIP)));
    return send(200, phpReleases(sha(PHP_ZIP)));
  }
  if (url === `https://windows.php.net/downloads/releases/${PHP_FILE}`) {
    if (profile === 'php-evil') return redirect('https://evil.example/php.zip');
    if (profile === 'php-http') return redirect(`http://downloads.php.net/~windows/releases/${PHP_FILE}`);
    if (profile === 'php-loop') return redirect('https://downloads.php.net/~windows/loop/1');
    return redirect(`https://downloads.php.net/~windows/releases/${PHP_FILE}`);
  }
  if (u.host === 'downloads.php.net' && u.pathname.startsWith('/~windows/loop/')) {
    const n = Number(u.pathname.split('/').pop());
    return redirect(`https://downloads.php.net/~windows/loop/${n + 1}`);
  }
  if (url === `https://downloads.php.net/~windows/releases/${PHP_FILE}`) {
    if (profile === 'php-slip') return send(200, SLIP_ZIP);
    if (profile === 'php-link') return send(200, LINK_ZIP);
    return send(200, PHP_ZIP);
  }
  // composer
  if (url === 'https://getcomposer.org/versions') {
    return send(200, {
      stable: [
        { path: '/download/2.99.1/composer.phar', version: '2.99.1', 'min-php': 70205, lts: false },
        { path: '/download/2.2.99/composer.phar', version: '2.2.99', 'min-php': 50300, lts: true },
      ],
      1: [{ path: '/download/1.10.99/composer.phar', version: '1.10.99' }],
    });
  }
  if (/^https:\/\/getcomposer\.org\/download\/2\.(99\.1|2\.99)\/composer\.phar\.sha256sum$/.test(url)) return send(200, `${sha(PHAR)}  composer.phar\n`);
  if (/^https:\/\/getcomposer\.org\/download\/2\.(99\.1|2\.99)\/composer\.phar$/.test(url)) return send(200, PHAR);
  // mariadb
  if (url === 'https://downloads.mariadb.org/rest-api/mariadb/') {
    return send(200, {
      major_releases: [
        { release_id: '12.0', release_status: 'Preview', release_support_type: null, release_eol_date: null },
        { release_id: '11.99', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2099-01-01' },
        { release_id: '10.0', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2020-01-01' },
      ],
    });
  }
  if (url === 'https://downloads.mariadb.org/rest-api/mariadb/11.99/latest/') {
    return send(200, {
      releases: {
        [MDB_VER]: {
          release_id: MDB_VER,
          date_of_release: '2026-11-01',
          files: [
            { file_name: `mariadb-${MDB_VER}-winx64.msi`, checksum: { sha256sum: 'e'.repeat(64) } },
            { file_name: MDB_FILE, os: 'Windows', cpu: 'x86_64', checksum: { sha256sum: sha(MDB_ZIP) }, file_download_url: `http://downloads.mariadb.org/rest-api/mariadb/${MDB_VER}/${MDB_FILE}` },
          ],
        },
      },
    });
  }
  if (url === `https://archive.mariadb.org/mariadb-${MDB_VER}/winx64-packages/${MDB_FILE}`) return send(200, MDB_ZIP, { 'Content-Type': 'application/zip' });
  return send(404, 'not in fixture');
}

describe('installer (local https fixture, no internet)', { timeout: 10 * 60 * 1000 }, () => {
  let fx;
  let tmp;
  const I = () => lib('installer.js');
  const runtimes = () => lib('runtimes.js');

  const newCtx = (name) => {
    const base = path.join(tmp, name);
    const toolDir = path.join(base, 'tool');
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(toolDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    return {
      toolDir,
      dataDir,
      log: () => {},
      store: {
        data: {
          settings: { runtimeRoots: [], extraPaths: [], dbPortRange: [3391, 3392], webPortRange: [8890, 8897], dbBindLocal: true },
          projects: [], runs: {}, dbServers: {}, dbRuns: {},
        },
        save() {},
      },
    };
  };
  const fetcherFor = (profile) => I().createFetcher({ rewrite: fx.rewriteTo(profile), ca: fx.ca });
  const run = async (ctx, profile, kind, version) => {
    const steps = [];
    const job = { progress: null };
    const log = (level, text) => steps.push({ level, text });
    try {
      const result = await I().installJob(ctx, { kind, version }, log, job, { fetcher: fetcherFor(profile) });
      return { ok: true, result, steps, job };
    } catch (e) {
      return { ok: false, error: e, steps, job };
    }
  };
  const leftovers = (ctx) => {
    const r = path.join(ctx.toolDir, 'runtimes');
    const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
    return { tmp: list(path.join(r, '_tmp')), downloads: list(path.join(r, '_downloads')) };
  };

  before(async () => {
    tmp = H.makeTempDir('dp-inst-');
    fx = await H.startHttpsFixture({ port: FIXTURE_PORT, handler });
  });
  after(async () => {
    if (fx) await fx.close();
    try { lib('procs.js').stopHelper(); } catch { /* ignore */ }
    try { await H.removeDir(tmp); } catch { /* ignore */ }
  });

  it('PHP: catalog -> download (via an allowed redirect) -> SHA-256 -> extract -> php.ini -> runtimes\\php\\<v>', async () => {
    const ctx = newCtx('php');
    const cat = await I().getCatalog(ctx, 'php', { fetcher: fetcherFor('php') });
    assert.equal(cat.items.length, 1);
    assert.equal(cat.items[0].version, PHP_VER);
    assert.equal(cat.items[0].file, PHP_FILE, 'newest VS toolset (vs17) chosen');
    assert.equal(cat.items[0].installed, false);

    const r = await run(ctx, 'php', 'php', PHP_VER);
    assert.equal(r.ok, true, r.error && `${r.error.code} ${r.error.message}\n${r.steps.map((s) => s.text).join('\n')}`);
    const target = path.join(ctx.toolDir, 'runtimes', 'php', PHP_VER);
    assert.ok(H.samePath(r.result.path, target), r.result.path);
    assert.equal(fs.readFileSync(path.join(target, 'php.exe'), 'utf8'), 'fixture: not a real program');
    const ini = fs.readFileSync(path.join(target, 'php.ini'), 'utf8');
    assert.match(ini, /^; generated by PHP Station/);
    assert.ok(ini.includes(`extension_dir="${path.join(target, 'ext')}"`), ini);
    for (const e of ['curl', 'mbstring', 'openssl', 'pdo_mysql', 'exif']) assert.match(ini, new RegExp(`^extension=${e}\\r?$`, 'm'), e);
    assert.doesNotMatch(ini, /^extension=gd\r?$/m, 'gd DLL is not in the fixture');
    assert.equal((ini.match(/^extension=zip\r?$/gm) || []).length, 1, 'already enabled extension not added twice');
    const cacert = path.join(ctx.toolDir, 'runtimes', 'cacert.pem');
    assert.equal(fs.readFileSync(cacert, 'utf8'), CACERT);
    assert.ok(ini.includes(`curl.cainfo="${cacert}"`) && ini.includes(`openssl.cafile="${cacert}"`));
    assert.ok(ini.includes('\r\n'), 'template line endings kept');
    assert.deepEqual(leftovers(ctx), { tmp: [], downloads: [] }, 'no temp folders or archives left');
    assert.ok(r.steps.some((s) => s.level === 'ok' && /SHA-256/.test(s.text)), 'SHA step logged');
    assert.ok(r.steps.some((s) => /^Download: /.test(s.text)), 'download progress logged');
    assert.equal(r.job.progress.stage, 'done');
    // only the vs17 x64 NTS zip was downloaded, through the redirect
    const got = fx.requests.filter((q) => q.profile === 'php').map((q) => q.url);
    assert.ok(got.includes(`https://downloads.php.net/~windows/releases/${PHP_FILE}`));
    assert.ok(!got.some((x) => x.includes('vs16') || x.includes('x86') || x.includes('-Win32-vs17-x64.zip') && !x.includes('nts')));
    // the runtime scan includes <tool>\runtimes (the fixture exe cannot run, so it is listed as not ok)
    const scanned = runtimes().getCache(ctx).php.find((p) => H.samePath(p.path, path.join(target, 'php.exe')));
    assert.ok(scanned, 'runtimes\\php not scanned');
    assert.equal(scanned.source, 'devpanel');
    // catalog marks it installed; a second install is refused before any network access
    assert.equal((await I().getCatalog(ctx, 'php', { fetcher: fetcherFor('php') })).items[0].installed, true);
    const before = fx.requests.length;
    const again = await run(ctx, 'php', 'php', PHP_VER);
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'EXISTS');
    assert.equal(fx.requests.length, before, 'no request for an existing version');
  });

  it('Composer: versions -> .sha256sum -> runtimes\\composer\\<v>\\composer.phar', async () => {
    const ctx = newCtx('composer');
    const cat = await I().getCatalog(ctx, 'composer', { fetcher: fetcherFor('composer') });
    assert.deepEqual(cat.items.map((x) => x.version), ['2.99.1', '2.2.99']);
    assert.equal(cat.items[1].lts, true);
    assert.equal(cat.items[0].sha256, sha(PHAR));
    const r = await run(ctx, 'composer', 'composer', '2.99.1');
    assert.equal(r.ok, true, r.error && r.error.message);
    const phar = path.join(ctx.toolDir, 'runtimes', 'composer', '2.99.1', 'composer.phar');
    assert.deepEqual(fs.readFileSync(phar), PHAR);
    assert.deepEqual(leftovers(ctx), { tmp: [], downloads: [] });
  });

  it('MariaDB: stable majors only -> archive.mariadb.org zip -> top folder unwrapped; instance needs a real server (fixture: refused cleanly)', async () => {
    const ctx = newCtx('mariadb');
    const cat = await I().getCatalog(ctx, 'mariadb', { fetcher: fetcherFor('mariadb') });
    assert.deepEqual(cat.items.map((x) => x.version), [MDB_VER], 'Preview and end-of-life majors skipped');
    assert.equal(cat.items[0].url, `https://archive.mariadb.org/mariadb-${MDB_VER}/winx64-packages/${MDB_FILE}`);
    assert.equal(cat.items[0].lts, true);
    assert.equal(typeof cat.items[0].sizeMB, 'number', 'size from a HEAD request');
    assert.ok(fx.requests.some((q) => q.profile === 'mariadb' && q.method === 'HEAD' && q.url === cat.items[0].url));
    const r = await run(ctx, 'mariadb', 'mariadb', MDB_VER);
    const target = path.join(ctx.toolDir, 'runtimes', 'mariadb', MDB_VER);
    assert.ok(fs.existsSync(path.join(target, 'bin', 'mariadbd.exe')), 'top folder unwrapped into runtimes\\mariadb\\<v>');
    assert.ok(fs.existsSync(path.join(target, 'share', 'README')));
    // the fixture server exe cannot run, so no DB server instance can be made: clear error, binaries kept
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INSTANCE_FAILED', r.error.message);
    assert.equal(fs.existsSync(path.join(target, 'data')), false, 'no datadir created');
    assert.deepEqual(Object.keys(ctx.store.data.dbServers), []);
    assert.deepEqual(leftovers(ctx), { tmp: [], downloads: [] });
  });

  it('SHA-256 mismatch: file deleted, nothing extracted or installed', async () => {
    const ctx = newCtx('badsha');
    const r = await run(ctx, 'php-badsha', 'php', PHP_VER);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'SHA_MISMATCH');
    assert.equal(fs.existsSync(path.join(ctx.toolDir, 'runtimes', 'php', PHP_VER)), false);
    assert.deepEqual(leftovers(ctx), { tmp: [], downloads: [] });
  });

  it('redirects: other host, plain http and more than 5 hops are refused', async () => {
    for (const [profile, code] of [['php-evil', 'URL_NOT_ALLOWED'], ['php-http', 'URL_NOT_ALLOWED'], ['php-loop', 'TOO_MANY_REDIRECTS']]) {
      const ctx = newCtx(profile);
      const r = await run(ctx, profile, 'php', PHP_VER);
      assert.equal(r.ok, false, profile);
      assert.equal(r.error.code, code, `${profile}: ${r.error.message}`);
      assert.equal(fs.existsSync(path.join(ctx.toolDir, 'runtimes', 'php', PHP_VER)), false);
      assert.deepEqual(leftovers(ctx), { tmp: [], downloads: [] }, profile);
    }
    assert.ok(!fx.requests.some((q) => /evil\.example/.test(q.url)), 'evil host never contacted');
    const hops = fx.requests.filter((q) => q.profile === 'php-loop' && /\/loop\//.test(q.url)).length;
    assert.ok(hops <= 5, `followed ${hops} loop redirects`);
  });

  it('zip slip and links in the archive are refused before extraction', async () => {
    for (const profile of ['php-slip', 'php-link']) {
      const ctx = newCtx(profile);
      const r = await run(ctx, profile, 'php', PHP_VER);
      assert.equal(r.ok, false, profile);
      assert.equal(r.error.code, 'UNSAFE_ARCHIVE', `${profile}: ${r.error.message}`);
      assert.equal(fs.existsSync(path.join(ctx.toolDir, 'runtimes', 'evil.txt')), false);
      assert.equal(fs.existsSync(path.join(ctx.toolDir, 'runtimes', '_tmp', 'evil.txt')), false);
      assert.equal(fs.existsSync(path.join(ctx.toolDir, 'runtimes', 'php', PHP_VER)), false);
      assert.deepEqual(leftovers(ctx), { tmp: [], downloads: [] }, profile);
    }
  });

  it('the strict (production) fetcher cannot reach the fixture; rewrite only to 127.0.0.1', async () => {
    const { STRICT, checkUrl, createFetcher } = I();
    assert.equal(STRICT.strict, true);
    await assert.rejects(STRICT.getText(`https://127.0.0.1:${FIXTURE_PORT}/php/x`), (e) => e.code === 'URL_NOT_ALLOWED');
    assert.throws(() => checkUrl('https://localhost/x'), (e) => e.code === 'URL_NOT_ALLOWED');
    const bad = createFetcher({ rewrite: () => 'https://example.com/x', ca: fx.ca });
    await assert.rejects(bad.getText('https://getcomposer.org/versions'), (e) => e.code === 'URL_NOT_ALLOWED');
    // bad input before any network access
    const ctx = newCtx('input');
    await assert.rejects(I().installJob(ctx, { kind: 'node', version: '1.2.3' }, () => {}, {}, { fetcher: fetcherFor('php') }), (e) => e.code === 'BAD_INPUT');
    await assert.rejects(I().installJob(ctx, { kind: 'php', version: '../8.1.0' }, () => {}, {}, { fetcher: fetcherFor('php') }), (e) => e.code === 'BAD_INPUT');
  });
});
