'use strict';
/*
 * Shutdown guard, backups and repair: the pure parts (no servers, no network).
 * The end-to-end flow (dump / snapshot / restore / crash / repair / rescue against a real MariaDB)
 * was run by hand on a throw-away server; see the commit notes.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = (n) => require(path.join(__dirname, '..', 'lib', n));
const dbrepair = lib('dbrepair.js');
const backups = lib('backups.js');
const guard = lib('guard.js');
const stateLib = lib('state.js');

after(() => {
  const procs = lib('procs.js');
  if (typeof procs.stopHelper === 'function') try { procs.stopHelper(); } catch { /* ignore */ }
});

describe('dbrepair.analyzeLog', () => {
  it('names the known XAMPP / MariaDB crash patterns', () => {
    const log = [
      "2026-07-07 10:00:01 0 [ERROR] mysqld.exe: Table '.\\mysql\\db' is marked as crashed and should be repaired",
      "2026-07-07 10:00:01 0 [ERROR] Fatal error: Can't open and lock privilege tables: Index for table 'global_priv' is corrupt; try to repair it",
      '2026-07-07 10:00:01 0 [ERROR] Aria recovery failed. Please run aria_chk -r on all Aria tables and delete all aria_log.######## files',
      '2026-07-07 10:00:02 0 [ERROR] InnoDB: Database page corruption on disk or a failed file read of page [page id: space=0, page number=5]',
      '2026-07-07 10:00:03 0 [ERROR] InnoDB: Unable to lock ./ibdata1 error: 33',
      "2026-07-07 10:00:04 0 [ERROR] Can't start server: Bind on TCP/IP port. Got error: 10048",
      "2026-07-07 10:00:05 3 [ERROR] mysqld.exe: Table './shop/logs' is marked as crashed and last (automatic?) repair failed",
    ].join('\r\n');
    const issues = dbrepair.analyzeLog(log);
    const codes = issues.map((x) => x.code).sort();
    assert.deepEqual(codes, ['ARIA', 'CRASHED_TABLES', 'INNODB', 'LOCKED', 'PORT', 'PRIV_TABLES']);
    assert.deepEqual(issues.find((x) => x.code === 'CRASHED_TABLES').tables.sort(), ['mysql/db', 'shop/logs']);
  });
  it('tablespaces copied from another datadir and tables missing in the engine', () => {
    const log = [
      '2026-11-12 10:48:38 71 [ERROR] InnoDB: Page [page id: space=1302, page number=1] log sequence number 121225455 is in the future! Current system log sequence number 45790833.',
      '2026-11-12 10:48:38 71 [ERROR] InnoDB: Your database may be corrupt or you may have copied the InnoDB tablespace but not the InnoDB log files. Please refer to https://mariadb.com/kb/en/library/innodb-recovery-modes/ for information about forcing recovery.',
      '2026-11-12 10:48:39 71 [ERROR] InnoDB: Page [page id: space=836, page number=4] log sequence number 120394580 is in the future! Current system log sequence number 45790833.',
      "2026-11-12 10:48:40 72 [ERROR] mysqld.exe: Table 'chat.poll_options' doesn't exist in engine",
    ].join('\n');
    const issues = dbrepair.analyzeLog(log);
    assert.deepEqual(issues.map((x) => x.code).sort(), ['LSN_FUTURE', 'MISSING_IN_ENGINE']);
    assert.deepEqual(issues.find((x) => x.code === 'LSN_FUTURE').spaces.sort((a, b) => a - b), [836, 1302]);
    assert.deepEqual(issues.find((x) => x.code === 'MISSING_IN_ENGINE').tables, ['chat/poll_options']);
  });
  it('a clean log has no issues; only the last start counts', () => {
    assert.deepEqual(dbrepair.analyzeLog('[Note] mysqld.exe: ready for connections.\n[Note] Shutdown complete'), []);
    const t = "old [ERROR] Aria recovery failed\n2026 [Note] Starting MariaDB 10.4.32 as process 1\n[Note] ready for connections.";
    assert.deepEqual(dbrepair.analyzeLog(dbrepair.lastStartPart(t)), []);
  });
});

describe('backups (pure parts)', () => {
  it('stamps sort by time and match the folder name rule', () => {
    const s = backups.stampNow(new Date(2026, 10, 12, 9, 5, 7));
    assert.equal(s, '20261112-090507');
    for (const r of ['auto', 'manual', 'pre-repair', 'pre-rescue', 'pre-restore']) assert.ok(backups.NAME_RE.test(`${s}_${r}`));
    assert.ok(!backups.NAME_RE.test(`${s}_x`));
    assert.ok(!backups.NAME_RE.test(`..\\${s}_manual`));
  });
  it('dueForDailyDump: running servers whose last dump/try is older than a day', () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    const ctx = { store: { data: { settings: { dailyDump: true }, backupState: {
      a: { lastDumpAt: '2026-11-12T01:00:00Z' }, b: { lastDumpAt: '2026-11-10T09:00:00Z' }, c: { lastTryAt: '2026-11-12T09:00:00Z' },
    } } } };
    const views = [{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }, { id: 'c', status: 'running' }, { id: 'd', status: 'running' }, { id: 'e', status: 'stopped' }];
    assert.deepEqual(backups.dueForDailyDump(ctx, views, now), ['b', 'd']);
    ctx.store.data.settings.dailyDump = false;
    assert.deepEqual(backups.dueForDailyDump(ctx, views, now), []);
  });
});

describe('guard.writeList', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-guard-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  it('writes running pids only, rewrites only on change', () => {
    const ctx = { dataDir: tmp };
    const views = [{ id: 'x', label: 'MariaDB\t10.4', status: 'running', pid: 42 }, { id: 'y', status: 'stopped', pid: null }];
    assert.equal(guard.writeList(ctx, views), true);
    assert.equal(fs.readFileSync(path.join(tmp, 'guard', 'dbs.txt'), 'utf8'), '42\tMariaDB 10.4');
    assert.equal(guard.writeList(ctx, views), false);
    assert.equal(guard.writeList(ctx, []), true);
    assert.equal(fs.readFileSync(path.join(tmp, 'guard', 'dbs.txt'), 'utf8'), '');
  });
});

describe('shortcuts.shouldAuto', () => {
  const shortcuts = lib('shortcuts.js');
  const tool = 'C:\\Tools\\php-station';
  const mk = (dataDir, shortcutsState) => ({ dataDir, store: { data: { shortcuts: shortcutsState } } });
  it('only for the real install (default data folder), once per install folder', () => {
    if (process.platform !== 'win32') return;
    assert.equal(shortcuts.shouldAuto(mk(tool + '\\data', null), tool, {}), true);
    // test runs / temporary panels use another data folder: never touch the desktop
    assert.equal(shortcuts.shouldAuto(mk('C:\\Temp\\dp-test\\data', null), tool, {}), false);
    // already made for this folder (also when the user deleted them on purpose)
    assert.equal(shortcuts.shouldAuto(mk(tool + '\\data', { for: tool.toUpperCase() }), tool, {}), false);
    // the folder was moved: fresh shortcuts
    assert.equal(shortcuts.shouldAuto(mk(tool + '\\data', { for: 'D:\\old\\php-station' }), tool, {}), true);
    // switched off
    assert.equal(shortcuts.shouldAuto(mk(tool + '\\data', null), tool, { DEVPANEL_NO_SHORTCUTS: '1' }), false);
  });
});

describe('state: safety settings', () => {
  it('defaults and validation', () => {
    const d = stateLib.DEFAULT_SETTINGS;
    assert.equal(d.shutdownGuard, true);
    assert.equal(d.snapshotOnStart, 'daily');
    assert.equal(d.dailyDump, true);
    const next = stateLib.validateSettings({ snapshotOnStart: 'always', snapshotKeep: 3, dumpKeep: 10, snapshotMaxMB: 2048, shutdownGuard: false }, Object.assign({}, d));
    assert.equal(next.snapshotOnStart, 'always');
    assert.equal(next.snapshotKeep, 3);
    assert.equal(next.shutdownGuard, false);
    for (const bad of [{ snapshotOnStart: 'weekly' }, { snapshotKeep: 0 }, { dumpKeep: 101 }, { snapshotMaxMB: 10 }, { dailyDump: 'yes' }]) {
      assert.throws(() => stateLib.validateSettings(bad, Object.assign({}, d)), (e) => e.code === 'BAD_SETTINGS');
    }
  });
});
