'use strict';
/*
 * Tests for the Setup Wizard and the automatic DB handling (pure parts + stubbed client calls).
 * Run: node --test tests/wizard.test.js
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = (n) => require(path.join(__dirname, '..', 'lib', n));
const util = lib('util.js');
const installer = lib('installer.js');
const projects = lib('projects.js');
const wizard = lib('wizard.js');
const dbservers = lib('dbservers.js');
const stateLib = lib('state.js');

after(() => {
  const procs = lib('procs.js');
  if (typeof procs.stopHelper === 'function') try { procs.stopHelper(); } catch { /* ignore */ }
});

describe('projects.dbEnvOverride', () => {
  const env = (o) => Object.assign({ exists: true, connection: 'mysql', host: '127.0.0.1', port: 3306 }, o);
  const use = { port: 3308 };
  it('local mysql/mariadb with another port -> DB_PORT override', () => {
    assert.deepEqual(projects.dbEnvOverride({}, env(), use), { DB_PORT: '3308' });
    assert.deepEqual(projects.dbEnvOverride({}, env({ port: null, host: null, connection: null }), use), { DB_PORT: '3308' });
    assert.deepEqual(projects.dbEnvOverride({}, env({ connection: 'mariadb', host: 'localhost' }), use), { DB_PORT: '3308' });
  });
  it('nothing to override: same port, setting off, no .env, remote host, sqlite, no server', () => {
    assert.equal(projects.dbEnvOverride({}, env({ port: 3308 }), use), null);
    assert.equal(projects.dbEnvOverride({ dbEnvOverride: false }, env(), use), null);
    assert.equal(projects.dbEnvOverride({}, { exists: false }, use), null);
    assert.equal(projects.dbEnvOverride({}, env({ host: 'db.example.com' }), use), null);
    assert.equal(projects.dbEnvOverride({}, env({ connection: 'sqlite' }), use), null);
    assert.equal(projects.dbEnvOverride({}, env(), null), null);
  });
});

describe('state: new settings', () => {
  it('defaults on, booleans only', () => {
    assert.equal(stateLib.DEFAULT_SETTINGS.autoStartDb, true);
    assert.equal(stateLib.DEFAULT_SETTINGS.dbEnvOverride, true);
    assert.equal(stateLib.DEFAULT_SETTINGS.wizardDone, false);
    const cur = Object.assign({}, stateLib.DEFAULT_SETTINGS);
    const next = stateLib.validateSettings({ autoStartDb: false, dbEnvOverride: false, wizardDone: true }, cur);
    assert.equal(next.autoStartDb, false);
    assert.equal(next.dbEnvOverride, false);
    assert.equal(next.wizardDone, true);
    assert.throws(() => stateLib.validateSettings({ autoStartDb: 'yes' }, cur), (e) => e.code === 'BAD_SETTINGS');
  });
});

describe('installer: MariaDB catalog incl. end-of-life majors', () => {
  it('parseMariadbMajorsAll: stable majors, EOL flagged, legacy 10.4/10.5 added, newest first', () => {
    const json = {
      major_releases: [
        { release_id: '13.2', release_status: 'Preview' },
        { release_id: '12.3', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2029-06-12' },
        { release_id: '10.6', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2026-07-06' },
      ],
    };
    const r = installer.parseMariadbMajorsAll(json, new Date('2026-11-11'));
    assert.deepEqual(r.map((x) => x.major), ['12.3', '10.6', '10.5', '10.4']);
    assert.equal(r[0].eol, false);
    assert.equal(r[1].eol, true);
    assert.equal(r[3].eol, true);
  });
  it('parseMariadbLatest picks the newest winx64.zip of a full release list', () => {
    const f = (v, sha) => ({ file_name: `mariadb-${v}-winx64.zip`, checksum: { sha256sum: sha } });
    const json = { releases: {
      '10.4.32': { files: [f('10.4.32', 'a'.repeat(64))] },
      '10.4.34': { files: [{ file_name: 'mariadb-10.4.34-linux.tar.gz' }, f('10.4.34', 'b'.repeat(64))] },
      '10.4.33': { files: [f('10.4.33', 'c'.repeat(64))] },
    } };
    const r = installer.parseMariadbLatest(json, '10.4');
    assert.equal(r.version, '10.4.34');
    assert.equal(r.sha256, 'b'.repeat(64));
    assert.match(r.url, /^https:\/\/archive\.mariadb\.org\/mariadb-10\.4\.34\/winx64-packages\/mariadb-10\.4\.34-winx64\.zip$/);
  });
  it('shaFor reads the archive sha256sums.txt format ("./file")', () => {
    const text = `${'d'.repeat(64)}  ./mariadb-10.4.34-winx64.zip\n${'e'.repeat(64)}  ./mariadb-10.4.34-winx64.msi\n`;
    assert.equal(installer.shaFor(text, 'mariadb-10.4.34-winx64.zip'), 'd'.repeat(64));
  });
});

describe('installer.normalizeBatch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-batch-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ctx = { toolDir: tmp, dataDir: path.join(tmp, 'data'), store: { data: { settings: {} } } };
  // runtimesDir(ctx) -> <toolDir>\runtimes in the runtimes module; make one version "installed".
  const rdir = installer.runtimesDir(ctx);
  fs.mkdirSync(path.join(rdir, 'php', '8.3.1'), { recursive: true });

  it('validates, de-duplicates, skips installed, orders DB -> PHP -> Composer', () => {
    const r = installer.normalizeBatch(ctx, [
      { kind: 'composer', version: '2.11.2' }, { kind: 'php', version: '8.1.2' }, { kind: 'php', version: '8.4.1' },
      { kind: 'php', version: '8.4.1' }, { kind: 'php', version: '8.3.1' }, { kind: 'mariadb', version: '11.4.5' },
    ]);
    assert.deepEqual(r.map((x) => `${x.kind}@${x.version}`), ['mariadb@11.4.5', 'php@8.4.1', 'php@8.1.2', 'composer@2.11.2']);
  });
  it('rejects bad input', () => {
    assert.throws(() => installer.normalizeBatch(ctx, []), (e) => e.code === 'BAD_INPUT');
    assert.throws(() => installer.normalizeBatch(ctx, [{ kind: 'mysql', version: '8.4.3' }]), (e) => e.code === 'BAD_INPUT');
    assert.throws(() => installer.normalizeBatch(ctx, [{ kind: 'php', version: '8.4' }]), (e) => e.code === 'BAD_INPUT');
    assert.throws(() => installer.normalizeBatch(ctx, [{ kind: 'php', version: '..\\..\\x' }]), (e) => e.code === 'BAD_INPUT');
    const many = Array.from({ length: 13 }, (_, i) => ({ kind: 'php', version: `8.${i}.0` }));
    assert.throws(() => installer.normalizeBatch(ctx, many), (e) => e.code === 'BAD_INPUT');
  });
  it('batchJob: a failing item does not stop the others; all failing fails the job', async () => {
    const calls = [];
    const orig = installer.installJob;
    // batchJob calls the module-level installJob; stub through a fake fetcher that fails the catalog
    const fetcher = { getJson: async () => { throw new Error('offline'); }, getText: async () => { throw new Error('offline'); } };
    const log = (lvl, text) => calls.push([lvl, text]);
    await assert.rejects(installer.batchJob(Object.assign({}, ctx, { installer: { catalog: {} } }), [{ kind: 'php', version: '9.9.9' }], log, {}, { fetcher }),
      (e) => e.code === 'INSTALL_FAILED');
    assert.ok(calls.some(([lvl]) => lvl === 'bad'));
    assert.equal(installer.installJob, orig);
  });
});

describe('wizard (pure parts)', () => {
  it('stackOf / rootOf', () => {
    assert.equal(wizard.stackOf('C:\\laragon\\bin\\php\\php-8.3\\php.exe'), 'Laragon');
    assert.equal(wizard.stackOf('D:\\Xampp-8.2\\php\\php.exe'), 'XAMPP');
    assert.equal(wizard.stackOf('C:\\wamp64\\bin\\php\\php.exe'), 'WAMP');
    assert.equal(wizard.stackOf('D:\\dev-tools\\devpanel\\runtimes\\php\\8.4.1\\php.exe', 'D:\\dev-tools\\devpanel\\runtimes'), 'PHP Station');
    assert.equal(wizard.stackOf('C:\\php\\php.exe'), 'PATH');
    assert.equal(wizard.rootOf('D:\\Xampp-8.2\\php\\php.exe'), 'D:\\Xampp-8.2');
    assert.equal(wizard.rootOf('D:\\dev-tools\\devpanel\\runtimes\\php\\8.4.1\\php.exe', 'D:\\dev-tools\\devpanel\\runtimes'), 'D:\\dev-tools\\devpanel\\runtimes');
  });
  it('pickBranchForProject: composer constraint + Laravel support table', () => {
    const branches = ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];
    const info = (composerPhp, laravel) => ({ composerPhp, laravelLocked: laravel, laravelInstalled: null, laravelConstraint: null });
    // Laravel 8 (php ^7.3|^8.0): 8.2+ gives deprecation hints -> 8.1
    assert.deepEqual(wizard.pickBranchForProject(info('^7.3|^8.0', '8.83.27'), branches), { branch: '8.1', exact: true });
    // Laravel 11 needs >= 8.2 -> newest allowed
    assert.deepEqual(wizard.pickBranchForProject(info('^8.2', '11.9.0'), branches), { branch: '8.5', exact: true });
    // Laravel 10: max 8.3
    assert.deepEqual(wizard.pickBranchForProject(info('^8.1', '10.48.0'), branches), { branch: '8.3', exact: true });
    // plain composer project
    assert.deepEqual(wizard.pickBranchForProject(info('>=7.4 <8.1', null), branches), { branch: '8.0', exact: true });
    // nothing fits
    assert.equal(wizard.pickBranchForProject(info('^5.6', null), branches), null);
  });
});

describe('phpMyAdmin (pure parts)', () => {
  const pma = lib('pma.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pma-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  it('choosePhp: mysqli + >= 7.2.5, below 8.4 preferred, else newest', () => {
    const p = (version, ext = ['mysqli']) => ({ ok: true, version, extensions: ext, path: `C:\\php${version}\\php.exe` });
    assert.equal(pma.choosePhp([p('8.5.9'), p('8.3.30'), p('8.2.12'), p('7.3.27')]).version, '8.3.30');
    assert.equal(pma.choosePhp([p('8.5.9'), p('8.4.1')]).version, '8.5.9');
    assert.equal(pma.choosePhp([p('8.3.1', ['curl']), p('7.1.0')]), null);
  });
  it('buildConfig: one cookie-login server per port, values escaped, no password', () => {
    const c = pma.buildConfig({ servers: [{ label: "MariaDB 10.4 · D:\\Xampp's", port: 3307 }, { label: 'L', port: 3308 }], secret: 'a'.repeat(32), tempDir: 'D:\\dp\\tmp' });
    assert.match(c, /^<\?php/);
    assert.equal((c.match(/\$i\+\+;/g) || []).length, 2);
    assert.match(c, /\['port'\] = '3307';/);
    assert.match(c, /D:\\\\Xampp\\'s/);
    assert.match(c, /'auth_type'\] = 'cookie'/);
    assert.doesNotMatch(c, /'password'\]/);
  });
  it('parsePmaVersions + versionOf/isPmaDir', () => {
    const r = installer.parsePmaVersions({ releases: [{ version: '4.9.11', php_versions: '>=5.5,<8.0' }, { version: '5.2.3', php_versions: '>=7.2,<8.4' }, { version: 'x' }] });
    assert.deepEqual(r.map((x) => x.version), ['5.2.3', '4.9.11']);
    assert.equal(r[0].url, 'https://files.phpmyadmin.net/phpMyAdmin/5.2.3/phpMyAdmin-5.2.3-all-languages.zip');
    const d = path.join(tmp, 'phpMyAdmin');
    fs.mkdirSync(path.join(d, 'libraries', 'classes'), { recursive: true });
    fs.writeFileSync(path.join(d, 'index.php'), '<?php');
    assert.equal(pma.isPmaDir(d), false);
    fs.writeFileSync(path.join(d, 'libraries', 'classes', 'Version.php'), "<?php\n    public const VERSION = '5.2.1' . VERSION_SUFFIX;");
    assert.equal(pma.versionOf(d), '5.2.1');
    assert.equal(pma.isPmaDir(d), true);
  });
});

describe('dbservers.findDatadirServer (stubbed client)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-dd-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  it('normDatadir: slashes, trailing slash and case do not matter', () => {
    assert.equal(dbservers.normDatadir('C:/laragon/data/mariadb-12.3/'), dbservers.normDatadir('c:\\Laragon\\data\\mariadb-12.3'));
  });
  it('returns null without a datadir and never throws on an empty snapshot', async () => {
    const ctx = { store: { data: { settings: {}, projects: [], dbServers: {}, dbRuns: {} } }, dataDir: tmp };
    assert.equal(await dbservers.findDatadirServer(ctx, { datadir: null }, { procs: [], listeners: [] }), null);
  });
  it('util.isLocalHost is used for the env override', () => {
    assert.equal(util.isLocalHost('127.0.0.1'), true);
    assert.equal(util.isLocalHost('localhost'), true);
  });
});
