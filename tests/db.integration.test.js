'use strict';
/*
 * DB integration tests (real MariaDB servers). Runs ONLY with DEVPANEL_DB_TESTS=1:
 *   set DEVPANEL_DB_TESTS=1 && node --test tests/db.integration.test.js
 *
 * Uses only brand-new datadirs inside a temp folder, on ports 3391 (MariaDB 10.4.32 from
 * <PHPSTATION_TEST_XAMPP, default C:\xampp>\mysql\bin) and 3392 (MariaDB 12.3.3 from Laragon). The user's live servers
 * (if any) are only read and must keep their PIDs.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const H = require('./helpers');

const ENABLED = process.env.DEVPANEL_DB_TESTS === '1';
const PANEL_PORT = 7175;
const PORT_A = 3391;
const PORT_B = 3392;
const XAMPP_BIN = path.join(process.env.PHPSTATION_TEST_XAMPP || 'C:\\xampp', 'mysql', 'bin');
const LARAGON_BIN = 'C:\\laragon\\bin\\mysql\\mariadb-12.3.3-winx64\\bin';
const URDU = 'دار المدینہ';
const ROWS = 1200;

/** Runs a MariaDB client with SQL on stdin as root/empty password over TCP -> {code, stdout, stderr}. */
function runClient(client, port, sql, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) {
      if (/^(MYSQL_PWD|MYSQL_HOST|MYSQL_TCP_PORT|MARIADB_PWD)$/i.test(k)) delete env[k];
    }
    const args = ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '--skip-ssl',
      '--default-character-set=utf8mb4', '-N', '-B'];
    const child = spawn(client, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    const out = [];
    const err = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`client timeout on port ${port}`)); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(Buffer.from(sql, 'utf8'));
  });
}

function lines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
}

function seedSql() {
  const values = [`('${URDU}', 'Karachi')`];
  for (let i = 2; i <= ROWS; i++) values.push(`('Talib ${i}', '${i % 2 ? 'Lahore' : 'Multan'}')`);
  return [
    'CREATE DATABASE dp_src CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    'USE dp_src;',
    'CREATE TABLE talaba (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, city VARCHAR(60), created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;',
    'CREATE TABLE audit_log (id INT AUTO_INCREMENT PRIMARY KEY, talib_id INT NOT NULL, note VARCHAR(100)) ENGINE=InnoDB;',
    "CREATE TRIGGER trg_talaba_ai AFTER INSERT ON talaba FOR EACH ROW INSERT INTO audit_log (talib_id, note) VALUES (NEW.id, 'added');",
    `INSERT INTO talaba (name, city) VALUES ${values.join(',\n')};`,
    'CREATE VIEW v_talaba AS SELECT id, name FROM talaba;',
    'SELECT COUNT(*) FROM talaba;',
    'SELECT COUNT(*) FROM audit_log;',
    '',
  ].join('\n');
}

describe('PHP Station DB servers + DB move', { skip: ENABLED ? false : 'DEVPANEL_DB_TESTS=1 set nahi (DB tests skip)', timeout: 30 * 60 * 1000 }, () => {
  let tmp;
  let dataDir;
  let dumpDir;
  let panel = null;
  let xamppPid = null;    // the user's live XAMPP MariaDB on 3307 (read only)
  let laragonPid = null;  // the user's Laragon MariaDB on 3308 (read only)
  let inst104 = null;
  let inst123 = null;
  const ent = { A: null, B: null };     // DbServerView of our instances
  const ownDbPids = new Set();
  let ready = false;

  const api = (...a) => panel.api(...a);
  const state = () => H.getState(api);
  const entryById = (st, id) => (st.dbServers || []).find((d) => d.id === id) || null;

  const isProtected = (pid) => {
    const n = Number(pid);
    return n === Number(xamppPid) || n === Number(laragonPid);
  };

  before(async () => {
    xamppPid = await H.listenerPid(3307);
    laragonPid = await H.listenerPid(3308);
    for (const p of [PORT_A, PORT_B]) {
      if (await H.isPortOpen(p)) throw new Error(`port ${p} pehle se busy hai — DB tests nahi chalenge`);
    }
    tmp = H.makeTempDir('dp-db-');
    dataDir = path.join(tmp, 'data');
    dumpDir = path.join(tmp, 'dumps');
    fs.mkdirSync(dumpDir, { recursive: true });
    panel = await H.startPanel({ port: PANEL_PORT, dataDir });
    const s = await api('POST', '/api/settings', { dumpDir });
    assert.equal(s.data && s.data.ok, true, s.text);
  });

  after(async () => {
    // Stop anything of ours that is still running: API first, taskkill only as a last resort.
    if (panel && !panel.exited()) {
      for (const e of [ent.A, ent.B]) {
        if (!e) continue;
        try {
          const st = await state();
          const cur = entryById(st, e.id);
          if (cur && cur.status === 'running') {
            const r = await api('POST', `/api/db/${e.id}/stop`, {});
            if (r.data && r.data.jobId) await H.waitForJob(api, r.data.jobId, 120000);
          }
        } catch { /* ignore */ }
      }
    }
    for (const pid of ownDbPids) {
      if (isProtected(pid)) continue; // hard guard: never the user's servers
      try { await H.killOwnPid(pid, ['mysqld.exe', 'mariadbd.exe']); } catch { /* ignore */ }
    }
    if (panel && !panel.exited()) {
      for (const e of [ent.A, ent.B]) {
        if (!e) continue;
        try { await api('POST', `/api/db/${e.id}/remove`, {}); } catch { /* ignore */ }
      }
    }
    if (panel) {
      try { await panel.stop(); } catch { /* ignore */ }
    }
    await H.sleep(1500);
    try { await H.removeDir(tmp); } catch (e) { console.error(`temp folder delete nahi hua: ${e.message}`); }
  });

  it('runtime scan finds MariaDB 10.4.32 (XAMPP) and 12.3.3 (Laragon)', { timeout: 300000 }, async (t) => {
    const r = await api('POST', '/api/runtimes/scan', {});
    if (r.data && r.data.jobId) await H.waitForJob(api, r.data.jobId, 240000);
    const st = await H.waitForRuntimes(api, 240000);
    const db = st.runtimes.db || [];
    inst104 = db.find((d) => d.ok && d.serverExe && H.samePath(d.binDir, XAMPP_BIN) && d.version === '10.4.32') || null;
    inst123 = db.find((d) => d.ok && d.serverExe && H.samePath(d.binDir, LARAGON_BIN) && d.version === '12.3.3') || null;
    if (!inst104 || !inst123) {
      t.skip('MariaDB 10.4.32 ya 12.3.3 install nahi mila');
      return;
    }
    assert.equal(inst104.kind, 'mariadb');
    assert.equal(inst123.kind, 'mariadb');
    assert.ok(inst104.installDb, '10.4 install-db tool missing');
    assert.ok(inst123.installDb, '12.3 install-db tool missing');
  });

  it('creates two NEW instances (3391 from 10.4.32, 3392 from 12.3.3)', { timeout: 600000 }, async (t) => {
    if (!inst104 || !inst123) {
      t.skip('installs nahi mile');
      return;
    }
    const defs = [
      ['A', inst104, 'dp-test-a', PORT_A],
      ['B', inst123, 'dp-test-b', PORT_B],
    ];
    const dataRoot = path.resolve(dataDir).toLowerCase() + path.sep;
    for (const [key, inst, name, port] of defs) {
      const r = await api('POST', '/api/db/create', { installId: inst.id, name, port });
      assert.equal(r.data && r.data.ok, true, r.text);
      const job = await H.waitForJob(api, r.data.jobId, 300000);
      assert.equal(job.status, 'done', H.describeJob(job));
      const st = await state();
      const e = (st.dbServers || []).find((d) => d.created && Number(d.port) === port);
      assert.ok(e, `instance ${name} list me nahi`);
      assert.ok(path.resolve(e.datadir).toLowerCase().startsWith(dataRoot), `datadir temp data dir se bahar: ${e.datadir}`);
      assert.ok(fs.existsSync(path.join(e.datadir, 'my.ini')), 'my.ini missing');
      const myIni = fs.readFileSync(path.join(e.datadir, 'my.ini'), 'utf8');
      assert.match(myIni, /bind-address\s*=\s*127\.0\.0\.1/);
      assert.equal(e.status, 'stopped');
      ent[key] = e;
    }
  });

  it('starts both; the XAMPP 3307 entry keeps its own pid', { timeout: 300000 }, async (t) => {
    if (!ent.A || !ent.B) {
      t.skip('instances nahi bane');
      return;
    }
    // without confirm the start is refused
    const nc = await api('POST', `/api/db/${ent.A.id}/start`, {});
    if (nc.data && nc.data.ok && nc.data.jobId) {
      const j = await H.waitForJob(api, nc.data.jobId, 60000);
      assert.equal(j.status, 'failed', 'confirm ke baghair start ho gaya');
    } else {
      assert.notEqual(nc.data && nc.data.ok, true);
    }
    assert.equal(await H.isPortOpen(PORT_A), false);

    for (const key of ['A', 'B']) {
      const r = await api('POST', `/api/db/${ent[key].id}/start`, { confirm: true });
      assert.equal(r.data && r.data.ok, true, r.text);
      const job = await H.waitForJob(api, r.data.jobId, 120000);
      assert.equal(job.status, 'done', H.describeJob(job));
    }

    const st = await state();
    for (const [key, port] of [['A', PORT_A], ['B', PORT_B]]) {
      const e = entryById(st, ent[key].id);
      assert.equal(e.status, 'running', `${key} running nahi`);
      assert.ok(e.pid, `${key} pid missing`);
      assert.equal(e.controllable, true);
      assert.ok(!isProtected(e.pid), `${key} ko user ke server ki pid mil gayi (${e.pid})`);
      assert.equal(await H.listenerPid(port), Number(e.pid));
      ownDbPids.add(Number(e.pid));
      ent[key] = e;
    }
    assert.notEqual(Number(ent.A.pid), Number(ent.B.pid));

    if (xamppPid) {
      const x = (st.dbServers || []).find((d) => !d.created && Number(d.port) === 3307);
      assert.ok(x, 'XAMPP 3307 entry missing');
      assert.equal(x.status, 'running');
      assert.equal(Number(x.pid), Number(xamppPid), 'XAMPP entry ko ghalat pid mili');
      assert.notEqual(Number(ent.A.pid), Number(xamppPid));
    }
    if (laragonPid) {
      const l = (st.dbServers || []).find((d) => !d.created && Number(d.port) === 3308 && d.status === 'running');
      if (l) assert.equal(Number(l.pid), Number(laragonPid));
    }
    ready = true;
  });

  it('seeds A/dp_src (2 tables, view, trigger, Urdu text)', { timeout: 180000 }, async (t) => {
    if (!ready) {
      t.skip('servers nahi chale');
      return;
    }
    const client = inst104.client || path.join(XAMPP_BIN, 'mysql.exe');
    const r = await runClient(client, PORT_A, seedSql());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), [String(ROWS), String(ROWS)]);

    const dbs = await api('POST', `/api/db/${ent.A.id}/databases`, {});
    assert.equal(dbs.data && dbs.data.ok, true, dbs.text);
    const names = dbs.data.databases.map((d) => d.name);
    assert.ok(names.includes('dp_src'));
    assert.ok(!names.includes('mysql') && !names.includes('information_schema'));
  });

  it('moves A/dp_src -> B/dp_moved with identical counts', { timeout: 900000 }, async (t) => {
    if (!ready) {
      t.skip('servers nahi chale');
      return;
    }
    const r = await api('POST', '/api/dbmove', { fromServerId: ent.A.id, fromDb: 'dp_src', toServerId: ent.B.id, toDb: 'dp_moved' });
    assert.equal(r.data && r.data.ok, true, r.text);
    const job = await H.waitForJob(api, r.data.jobId, 600000);
    assert.equal(job.status, 'done', H.describeJob(job));
    const res = job.result || {};
    assert.ok(Array.isArray(res.diff) && res.diff.length === 0, `diff: ${JSON.stringify(res.diff)}`);
    if (typeof res.tables === 'number') assert.equal(res.tables, 2);
    if (typeof res.rows === 'number') assert.equal(res.rows, ROWS * 2);
    assert.ok(!JSON.stringify(job).toLowerCase().includes('mysql_pwd='), 'job log me password env');

    // dump file in <dumpDir>\devpanel
    assert.ok(res.dumpFile && fs.existsSync(res.dumpFile), `dump missing: ${res.dumpFile}`);
    const dumpRoot = path.join(dumpDir, 'devpanel').toLowerCase() + path.sep;
    assert.ok(path.resolve(res.dumpFile).toLowerCase().startsWith(dumpRoot), res.dumpFile);
    assert.match(res.dumpFile, /\.sql$/i);
    const size = fs.statSync(res.dumpFile).size;
    const fd = fs.openSync(res.dumpFile, 'r');
    const buf = Buffer.alloc(Math.min(4096, size));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    assert.match(buf.toString('utf8'), /Dump completed/);

    const clientB = inst123.client || path.join(LARAGON_BIN, 'mariadb.exe');
    const q = await runClient(clientB, PORT_B, [
      'SELECT name FROM dp_moved.talaba WHERE id = 1;',
      'SELECT COUNT(*) FROM dp_moved.talaba;',
      'SELECT COUNT(*) FROM dp_moved.audit_log;',
      "SELECT COUNT(*) FROM information_schema.views WHERE table_schema = 'dp_moved';",
      "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = 'dp_moved';",
      '',
    ].join('\n'));
    assert.equal(q.code, 0, q.stderr);
    assert.deepEqual(lines(q.stdout), [URDU, String(ROWS), String(ROWS), '1', '1']);

    // the source is untouched
    const clientA = inst104.client || path.join(XAMPP_BIN, 'mysql.exe');
    const src = await runClient(clientA, PORT_A, 'SELECT COUNT(*) FROM dp_src.talaba;\n');
    assert.deepEqual(lines(src.stdout), [String(ROWS)]);

    // never overwrites: moving again into the existing dp_moved must fail
    const again = await api('POST', '/api/dbmove', { fromServerId: ent.A.id, fromDb: 'dp_src', toServerId: ent.B.id, toDb: 'dp_moved' });
    if (again.data && again.data.ok && again.data.jobId) {
      const j2 = await H.waitForJob(api, again.data.jobId, 120000);
      assert.equal(j2.status, 'failed', 'existing target overwrite ho gaya');
    } else {
      assert.notEqual(again.data && again.data.ok, true);
    }
    const q2 = await runClient(clientB, PORT_B, 'SELECT COUNT(*) FROM dp_moved.talaba;\n');
    assert.deepEqual(lines(q2.stdout), [String(ROWS)]);

    // dump delete: refused outside dumpDir\devpanel, works inside
    const outside = path.join(tmp, 'outside.sql');
    fs.writeFileSync(outside, '-- not a dump\n');
    const bad = await api('POST', '/api/dumps/delete', { file: outside });
    assert.notEqual(bad.data && bad.data.ok, true);
    assert.equal(fs.existsSync(outside), true);
    const del = await api('POST', '/api/dumps/delete', { file: res.dumpFile });
    assert.equal(del.data && del.data.ok, true, del.text);
    assert.equal(fs.existsSync(res.dumpFile), false);
  });

  it('v1.1: DB_MISSING on start, then db-provision move / import / empty (never overwrites)', { timeout: 900000 }, async (t) => {
    if (!ready) {
      t.skip('servers nahi chale');
      return;
    }
    const st0 = await state();
    const rt = (st0.runtimes.php || []).filter((r) => r.ok).sort((a, b) => Number(a.iniRelocated) - Number(b.iniRelocated))[0];
    if (!rt) {
      t.skip('koi chalne wala PHP nahi');
      return;
    }
    const set = await api('POST', '/api/settings', { webPortRange: [8893, 8897] });
    assert.equal(set.data && set.data.ok, true, set.text);
    const clientA = inst104.client || path.join(XAMPP_BIN, 'mysql.exe');
    const clientB = inst123.client || path.join(LARAGON_BIN, 'mariadb.exe');
    const projRoot = path.join(tmp, 'projects');
    const own = [];

    const mkProject = async (name, db, port) => {
      const env = ['APP_NAME=Prov', 'DB_CONNECTION=mysql', 'DB_HOST=127.0.0.1', `DB_PORT=${PORT_B}`, `DB_DATABASE=${db}`, 'DB_USERNAME=root', 'DB_PASSWORD=', ''].join('\r\n');
      const dir = H.makeFixtureProject('plain', { parent: projRoot, name, env });
      const add = await api('POST', '/api/projects', { path: dir, name, phpVersion: rt.version, phpPath: rt.path });
      assert.equal(add.data && add.data.ok, true, add.text);
      const id = add.data.project.id;
      own.push({ id, port });
      const upd = await api('POST', `/api/projects/${id}/update`, { dbServerId: ent.B.id, port });
      assert.equal(upd.data && upd.data.ok, true, upd.text);
      return id;
    };
    const startOk = async (id, port, body = {}) => {
      const r = await api('POST', `/api/projects/${id}/start`, body);
      assert.equal(r.data && r.data.ok, true, r.text);
      assert.equal((await H.httpGetText(port, '/')).text.trim(), `PLAIN:${rt.version}`);
      const stop = await api('POST', `/api/projects/${id}/stop`, {});
      assert.equal(stop.data && stop.data.ok, true, stop.text);
      await H.waitPortClosed(port, 10000);
      return r.data;
    };
    const provision = async (id, body) => {
      const r = await api('POST', `/api/projects/${id}/db-provision`, body);
      assert.equal(r.data && r.data.ok, true, r.text);
      return H.waitForJob(api, r.data.jobId, 600000);
    };
    const hasDb = async (client, port, db) => lines((await runClient(client, port, `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '${db}';\n`)).stdout)[0] === '1';

    try {
      // 1) dp_src is on A only -> DB_MISSING with A in foundOn -> move -> start works
      const p1 = await mkProject('prov-move', 'dp_src', 8893);
      const miss = await api('POST', `/api/projects/${p1}/start`, {});
      assert.equal(miss.status, 409, miss.text);
      assert.equal(miss.data.code, 'DB_MISSING');
      assert.equal(miss.data.database, 'dp_src');
      assert.equal(miss.data.dbServerId, ent.B.id);
      assert.ok(Array.isArray(miss.data.foundOn), miss.text);
      const onA = miss.data.foundOn.find((f) => f.serverId === ent.A.id);
      assert.ok(onA, `A missing from foundOn: ${miss.text}`);
      assert.equal(onA.port, PORT_A);
      assert.equal(typeof onA.sizeMB, 'number');
      assert.ok(!miss.data.foundOn.some((f) => f.serverId === ent.B.id));
      assert.equal(await H.isPortOpen(8893), false, 'nothing started on DB_MISSING');

      const mv = await provision(p1, { mode: 'move', fromServerId: ent.A.id });
      assert.equal(mv.status, 'done', H.describeJob(mv));
      assert.equal(mv.result.tables, 2);
      assert.equal(mv.result.rows, ROWS * 2);
      assert.deepEqual(mv.result.diff, []);
      assert.ok(!JSON.stringify(mv).toLowerCase().includes('mysql_pwd='));
      const q = await runClient(clientB, PORT_B, 'SELECT name FROM dp_src.talaba WHERE id = 1;\nSELECT COUNT(*) FROM dp_src.talaba;\n');
      assert.deepEqual(lines(q.stdout), [URDU, String(ROWS)]);
      if (mv.result.dumpFile) { try { fs.unlinkSync(mv.result.dumpFile); } catch { /* ignore */ } }
      await startOk(p1, 8893);
      const mv2 = await provision(p1, { mode: 'move', fromServerId: ent.A.id });
      assert.equal(mv2.status, 'failed', 'existing database overwritten');
      assert.equal(mv2.code, 'TARGET_EXISTS', H.describeJob(mv2));

      // 2) import a .sql file (Urdu text, 500 rows)
      const p2 = await mkProject('prov-import', 'dp_imported', 8894);
      const m2 = await api('POST', `/api/projects/${p2}/start`, {});
      assert.equal(m2.data.code, 'DB_MISSING', m2.text);
      assert.ok(!m2.data.foundOn.some((f) => f.serverId === ent.A.id || f.serverId === ent.B.id));
      const values = [`('${URDU}')`];
      for (let i = 2; i <= 500; i++) values.push(`('Kitab ${i}')`);
      const sqlFile = path.join(tmp, 'import-ok.sql');
      fs.writeFileSync(sqlFile, `-- fixture dump\nCREATE TABLE kutub (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(100) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\nINSERT INTO kutub (title) VALUES ${values.join(',\n')};\n`);
      const im = await provision(p2, { mode: 'import', file: sqlFile });
      assert.equal(im.status, 'done', H.describeJob(im));
      assert.equal(im.result.tables, 1);
      assert.equal(im.result.bytes, fs.statSync(sqlFile).size);
      assert.ok(im.steps.some((s) => s.level === 'ok' && /\b1\b/.test(s.text)), 'table count reported');
      const q2 = await runClient(clientB, PORT_B, 'SELECT title FROM dp_imported.kutub WHERE id = 1;\nSELECT COUNT(*) FROM dp_imported.kutub;\nSELECT default_collation_name FROM information_schema.schemata WHERE schema_name = \'dp_imported\';\n');
      assert.deepEqual(lines(q2.stdout), [URDU, '500', 'utf8mb4_unicode_ci']);
      await startOk(p2, 8894);
      const im2 = await provision(p2, { mode: 'import', file: sqlFile });
      assert.equal(im2.status, 'failed');
      assert.equal(im2.code, 'TARGET_EXISTS', H.describeJob(im2));
      const q3 = await runClient(clientB, PORT_B, 'SELECT COUNT(*) FROM dp_imported.kutub;\n');
      assert.deepEqual(lines(q3.stdout), ['500'], 'not imported twice');

      // 3) a dump that switches database is refused before anything is created; skipDbCheck; empty
      const p3 = await mkProject('prov-empty', 'dp_empty_v11', 8895);
      const badSql = path.join(tmp, 'import-switch.sql');
      fs.writeFileSync(badSql, 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `dp_other_v11`;\nUSE `dp_other_v11`;\nCREATE TABLE x (id INT);\n');
      const bad = await provision(p3, { mode: 'import', file: badSql });
      assert.equal(bad.status, 'failed');
      assert.equal(bad.code, 'SQL_SWITCHES_DB', H.describeJob(bad));
      assert.equal(await hasDb(clientB, PORT_B, 'dp_empty_v11'), false);
      assert.equal(await hasDb(clientB, PORT_B, 'dp_other_v11'), false);
      await startOk(p3, 8895, { skipDbCheck: true });
      const em = await provision(p3, { mode: 'empty' });
      assert.equal(em.status, 'done', H.describeJob(em));
      assert.equal(await hasDb(clientB, PORT_B, 'dp_empty_v11'), true);
      const em2 = await provision(p3, { mode: 'empty' });
      assert.equal(em2.code, 'TARGET_EXISTS', H.describeJob(em2));
      const ok3 = await startOk(p3, 8895);
      assert.equal(ok3.dbCheckWarning, undefined);

      // the source on A is untouched
      const src = await runClient(clientA, PORT_A, 'SELECT COUNT(*) FROM dp_src.talaba;\n');
      assert.deepEqual(lines(src.stdout), [String(ROWS)]);
    } finally {
      for (const p of own) {
        try { await api('POST', `/api/projects/${p.id}/stop`, {}); } catch { /* ignore */ }
        try { await api('POST', `/api/projects/${p.id}/remove`, {}); } catch { /* ignore */ }
      }
    }
  });

  it('stops both via the API with the named event', { timeout: 400000 }, async (t) => {
    if (!ready) {
      t.skip('servers nahi chale');
      return;
    }
    for (const [key, port] of [['A', PORT_A], ['B', PORT_B]]) {
      const pid = Number(ent[key].pid);
      assert.ok(!isProtected(pid));
      const r = await api('POST', `/api/db/${ent[key].id}/stop`, {});
      assert.equal(r.data && r.data.ok, true, r.text);
      const job = await H.waitForJob(api, r.data.jobId, 180000);
      assert.equal(job.status, 'done', H.describeJob(job));
      assert.equal(job.result && job.result.method, 'event', H.describeJob(job));
      await H.waitPidGone(pid, 90000);
      await H.waitPortClosed(port, 15000);
      ownDbPids.delete(pid);
    }
    const st = await state();
    assert.equal(entryById(st, ent.A.id).status, 'stopped');
    assert.equal(entryById(st, ent.B.id).status, 'stopped');
  });

  it("the user's live DB servers still run with the same pids", async () => {
    if (xamppPid) {
      assert.equal(H.pidAlive(xamppPid), true, `XAMPP MariaDB pid ${xamppPid} band ho gaya!`);
      assert.equal(await H.listenerPid(3307), Number(xamppPid));
    }
    if (laragonPid) {
      assert.equal(H.pidAlive(laragonPid), true, `Laragon MariaDB pid ${laragonPid} band ho gaya!`);
      assert.equal(await H.listenerPid(3308), Number(laragonPid));
    }
  });
});
