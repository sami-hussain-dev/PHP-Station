'use strict';
/*
 * Integration tests with real processes.
 *   Panel under test: 127.0.0.1:7171 (temp --data dir).
 *   Projects under test: 8890-8899 only.
 * The user's own servers (php on 8085/8086, MariaDB on 3307/3308) are only READ, never adopted,
 * stopped or signalled. Everything the tests start is recorded and cleaned up in after().
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const H = require('./helpers');

const PANEL_PORT = 7171;
const PORTS = { l8: 8890, plain: 8891, l12: 8892, extStop: 8898, extAdopt: 8899 };
const USER_PHP_PORTS = [8085, 8086];

function findPhp(state, version, preferDir) {
  const list = ((state.runtimes && state.runtimes.php) || []).filter((r) => r.ok && r.version === version);
  if (!list.length) return null;
  if (preferDir) {
    const hit = list.find((r) => H.samePath(r.dir || path.dirname(r.path), preferDir));
    if (hit) return hit;
  }
  return list[0];
}

function projectView(state, id) {
  return (state.projects || []).find((p) => p.id === id) || null;
}

function cleanChildEnv() {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (/^(PHPRC|PHP_INI_SCAN_DIR)$/i.test(k)) delete env[k];
  }
  return env;
}

// A real XAMPP is only used when present (PHPSTATION_TEST_XAMPP, default C:\xampp).
const XAMPP_DIR = process.env.PHPSTATION_TEST_XAMPP || 'C:\\xampp';

describe('PHP Station integration', { timeout: 20 * 60 * 1000 }, () => {
  let tmp;
  let dataDir;
  let projRoot;
  let panel = null;
  const ownPids = new Set();          // php.exe pids started by us or by the panel for our projects
  const createdProjects = new Set();  // project ids we created/adopted
  const children = [];                // ChildProcess objects we spawned directly
  const userServers = [];             // {port, pid, topPid} of the user's 8085/8086 servers (read only)
  let started = null;                 // {id, port, pid, expect} x3 after the run test
  let panelEnv = {};                  // composer home/cache inside the temp folder (setup test)

  const api = (...a) => panel.api(...a);
  const state = () => H.getState(api);

  before(async () => {
    tmp = H.makeTempDir('dp-int-');
    dataDir = path.join(tmp, 'data');
    projRoot = path.join(tmp, 'projects');
    fs.mkdirSync(projRoot, { recursive: true });
    panelEnv = { COMPOSER_HOME: path.join(tmp, 'composer-home'), COMPOSER_CACHE_DIR: path.join(tmp, 'composer-cache') };
    panel = await H.startPanel({ port: PANEL_PORT, dataDir, env: panelEnv });
    // Keep auto-picked project ports inside the test range.
    const r = await api('POST', '/api/settings', { webPortRange: [8890, 8897] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.ok, true, r.text);
  });

  after(async () => {
    // 1) stop + remove our projects through the panel (it only kills what it verified)
    if (panel && !panel.exited()) {
      for (const id of createdProjects) {
        try { await api('POST', `/api/projects/${id}/stop`, {}); } catch { /* ignore */ }
        try { await api('POST', `/api/projects/${id}/remove`, {}); } catch { /* ignore */ }
      }
    }
    // 2) our direct children
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        try { c.kill(); } catch { /* ignore */ }
      }
    }
    // 3) last resort: php.exe pids we started (directly or via the panel for our fixtures)
    for (const pid of ownPids) {
      try { await H.killOwnPid(pid, ['php.exe']); } catch { /* ignore */ }
    }
    // 4) the panel itself
    if (panel) {
      try { await panel.stop(); } catch { /* ignore */ }
    }
    await H.sleep(500);
    try { await H.removeDir(tmp); } catch (e) { console.error(`temp folder delete nahi hua: ${e.message}`); }
  });

  it('security: token, Host, Origin, content type, headers', async () => {
    const port = PANEL_PORT;
    const ping = await H.request({ port, urlPath: '/api/ping' });
    assert.equal(ping.status, 200);
    assert.equal(ping.data.app, 'devpanel');

    const noToken = await H.request({ port, urlPath: '/api/state' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.data.ok, false);
    assert.equal(noToken.data.code, 'BAD_TOKEN');

    const badToken = await H.request({ port, urlPath: '/api/state', headers: { 'X-DevPanel-Token': 'f'.repeat(64) } });
    assert.equal(badToken.status, 401);

    const badHost = await H.request({ port, urlPath: '/api/state', headers: { Host: `evil.example:${port}`, 'X-DevPanel-Token': panel.token } });
    assert.equal(badHost.status, 403);
    const badHostPage = await H.request({ port, urlPath: '/', headers: { Host: 'evil.example' } });
    assert.equal(badHostPage.status, 403);

    const badOrigin = await H.request({
      port, method: 'POST', urlPath: '/api/settings', body: {},
      headers: { Origin: 'http://evil.example', 'X-DevPanel-Token': panel.token },
    });
    assert.equal(badOrigin.status, 403);

    const goodOrigin = await H.request({ port, urlPath: '/api/state', headers: { Origin: `http://127.0.0.1:${port}`, 'X-DevPanel-Token': panel.token } });
    assert.equal(goodOrigin.status, 200);

    const plainText = await H.request({
      port, method: 'POST', urlPath: '/api/settings', rawBody: '{}',
      headers: { 'Content-Type': 'text/plain', 'X-DevPanel-Token': panel.token },
    });
    assert.equal(plainText.status, 415);

    const page = await H.request({ port, urlPath: '/' });
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy'] || ''), /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.ok(!page.text.includes('__DEVPANEL_TOKEN__'));
    assert.match(String(goodOrigin.headers['cache-control'] || ''), /no-store/);
  });

  it('runtimes scan finds PHP 8.5.9, 8.2.12 (relocated php.ini) and 8.0.3', { timeout: 300000 }, async (t) => {
    const r = await api('POST', '/api/runtimes/scan', {});
    if (r.data && r.data.jobId) {
      const job = await H.waitForJob(api, r.data.jobId, 240000);
      assert.equal(job.status, 'done', H.describeJob(job));
    }
    const st = await H.waitForRuntimes(api, 240000);
    const php = st.runtimes.php || [];
    if (!php.length) {
      t.skip('is machine par koi PHP nahi mila');
      return;
    }
    for (const rt of php) {
      assert.ok(rt.path && rt.id, 'runtime has id and path');
      assert.ok(typeof rt.ok === 'boolean');
    }

    if (fs.existsSync(path.join(XAMPP_DIR, 'php', 'php.exe'))) {
      const rt = php.find((x) => H.samePath(x.path, path.join(XAMPP_DIR, 'php', 'php.exe')));
      assert.ok(rt, `${XAMPP_DIR}\\php scan me nahi aya`);
      assert.equal(rt.ok, true, rt.error || '');
      assert.equal(rt.version, '8.5.9');
    }
    if (fs.existsSync(path.join(XAMPP_DIR, 'php8.2', 'php.exe'))) {
      const rt = php.find((x) => H.samePath(x.path, path.join(XAMPP_DIR, 'php8.2', 'php.exe')));
      assert.ok(rt, `${XAMPP_DIR}\\php8.2 scan me nahi aya`);
      assert.equal(rt.version, '8.2.12');
      assert.equal(rt.ok, true, rt.error || '');
      assert.equal(rt.iniRelocated, true);
      assert.ok(rt.iniFile && H.samePath(path.dirname(rt.iniFile), path.join(dataDir, 'php-ini')), `iniFile ${rt.iniFile}`);
      const iniText = fs.readFileSync(rt.iniFile, 'utf8');
      assert.match(iniText, /^; generated by PHP Station from /);
      assert.ok(!iniText.includes('php8.28.2'));
    }
    if (fs.existsSync('D:\\xampp8\\php\\php.exe') || fs.existsSync('C:\\xampp 8\\php\\php.exe')) {
      assert.ok(php.some((x) => x.ok && x.version === '8.0.3'), 'PHP 8.0.3 nahi mila');
    }
  });

  it('three projects run at the same time on PHP 8.0.3, 8.2.12 and 8.5.9', { timeout: 180000 }, async (t) => {
    const st = await state();
    const rt803 = findPhp(st, '8.0.3', 'D:\\xampp8\\php');
    const rt8212 = findPhp(st, '8.2.12', path.join(XAMPP_DIR, 'php8.2'));
    const rt859 = findPhp(st, '8.5.9', path.join(XAMPP_DIR, 'php'));
    if (!rt803 || !rt8212 || !rt859) {
      t.skip('PHP 8.0.3 / 8.2.12 / 8.5.9 me se koi nahi mila');
      return;
    }
    for (const p of [PORTS.l8, PORTS.plain, PORTS.l12]) {
      assert.equal(await H.isPortOpen(p), false, `port ${p} pehle se busy hai`);
    }

    const defs = [
      { key: 'l8', kind: 'laravel-root-router', name: 'dp-test-l8', rt: rt803, port: PORTS.l8, prefix: 'L8' },
      { key: 'plain', kind: 'plain', name: 'dp-test-plain', rt: rt8212, port: PORTS.plain, prefix: 'PLAIN' },
      { key: 'l12', kind: 'laravel-vendor-router', name: 'dp-test-l12', rt: rt859, port: PORTS.l12, prefix: 'L12' },
    ];
    for (const d of defs) {
      d.dir = H.makeFixtureProject(d.kind, { parent: projRoot, name: d.name });
      const ins = await api('POST', '/api/projects/inspect', { path: d.dir });
      assert.equal(ins.data && ins.data.ok, true, ins.text);
      const add = await api('POST', '/api/projects', { path: d.dir, name: d.name, phpVersion: d.rt.version, phpPath: d.rt.path });
      assert.equal(add.data && add.data.ok, true, add.text);
      d.id = add.data.project.id;
      createdProjects.add(d.id);
      const upd = await api('POST', `/api/projects/${d.id}/update`, { port: d.port });
      assert.equal(upd.data && upd.data.ok, true, upd.text);
      assert.equal(upd.data.project.port, d.port);
    }
    // the same folder cannot be added twice
    const dup = await api('POST', '/api/projects', { path: defs[0].dir.toUpperCase(), phpVersion: rt803.version, phpPath: rt803.path });
    assert.notEqual(dup.data && dup.data.ok, true, 'same path dobara add ho gaya');

    const results = await Promise.all(defs.map((d) => api('POST', `/api/projects/${d.id}/start`, {})));
    results.forEach((r, i) => {
      assert.equal(r.data && r.data.ok, true, `${defs[i].name}: ${r.text}`);
      assert.ok(r.data.url, 'url missing');
      defs[i].port = Number(new URL(r.data.url).port);
      assert.ok(defs[i].port >= 8890 && defs[i].port <= 8897, `port ${defs[i].port} test range se bahar`);
    });

    for (const d of defs) {
      const page = await H.httpGetText(d.port, '/');
      assert.equal(page.status, 200, page.text);
      assert.equal(page.text.trim(), `${d.prefix}:${d.rt.version}`);
    }

    const after1 = await state();
    started = [];
    for (const d of defs) {
      const v = projectView(after1, d.id);
      assert.ok(v, 'project view missing');
      assert.equal(v.status, 'running');
      assert.ok(v.run && v.run.pid, 'run.pid missing');
      assert.equal(v.run.external, false);
      ownPids.add(Number(v.run.pid));
      started.push({ id: d.id, port: d.port, pid: Number(v.run.pid), expect: `${d.prefix}:${d.rt.version}` });
    }
    // the panel must not report our own servers as external
    for (const s of started) {
      const ext = (after1.external.php || []).find((x) => x.port === s.port);
      assert.ok(!ext || ext.matchesProjectId === s.id, 'own server shown as unrelated external');
    }
  });

  it('panel restart keeps projects running; stop closes ports and ends pids', { timeout: 180000 }, async (t) => {
    if (!started) {
      t.skip('pichla test nahi chala');
      return;
    }
    await panel.stop();
    assert.equal(panel.exited(), true, 'panel band nahi hua');
    // projects survive the panel
    for (const s of started) {
      assert.equal(H.pidAlive(s.pid), true, `pid ${s.pid} panel ke sath band ho gaya`);
      const page = await H.httpGetText(s.port, '/');
      assert.equal(page.text.trim(), s.expect);
    }

    panel = await H.startPanel({ port: PANEL_PORT, dataDir, env: panelEnv });
    const st = await state();
    for (const s of started) {
      const v = projectView(st, s.id);
      assert.equal(v.status, 'running', `${s.id} restart ke baad running nahi`);
      assert.equal(Number(v.run.pid), s.pid);
    }

    for (const s of started) {
      const r = await api('POST', `/api/projects/${s.id}/stop`, {});
      assert.equal(r.data && r.data.ok, true, r.text);
    }
    for (const s of started) {
      await H.waitPortClosed(s.port, 10000);
      await H.waitPidGone(s.pid, 10000);
    }
    const st2 = await state();
    for (const s of started) assert.equal(projectView(st2, s.id).status, 'stopped');
  });

  it('external php -S servers: detect, adopt + stop, external stop, foreign pids refused', { timeout: 180000 }, async (t) => {
    const st = await state();
    const rt = (st.runtimes.php || []).filter((r) => r.ok).sort((a, b) => Number(a.iniRelocated) - Number(b.iniRelocated))[0];
    if (!rt) {
      t.skip('koi chalne wala PHP nahi');
      return;
    }
    const pre = rt.iniRelocated && rt.iniFile ? ['-c', rt.iniFile] : [];

    const startRaw = async (port, name) => {
      assert.equal(await H.isPortOpen(port), false, `port ${port} pehle se busy hai`);
      const dir = H.makeFixtureProject('plain', { parent: projRoot, name });
      const child = spawn(rt.path, [...pre, '-S', `127.0.0.1:${port}`, '-t', dir], {
        cwd: dir, stdio: 'ignore', windowsHide: true, env: cleanChildEnv(),
      });
      children.push(child);
      ownPids.add(child.pid);
      await H.waitPortOpen(port, 15000);
      return { child, dir, pid: child.pid };
    };

    const findExt = async (pid) => H.waitFor(async () => {
      const s = await state();
      return (s.external.php || []).find((x) => Number(x.pid) === pid) || null;
    }, { timeoutMs: 20000, intervalMs: 700, what: `external pid ${pid}` });

    // --- adopt + stop through the project API
    const a = await startRaw(PORTS.extAdopt, 'ext-adopt');
    const extA = await findExt(a.pid);
    assert.equal(extA.port, PORTS.extAdopt);
    assert.equal(extA.via, 'php -S');
    assert.equal(Number(extA.topPid), a.pid);
    assert.ok(H.samePath(extA.projectPath, a.dir), `projectPath ${extA.projectPath}`);
    assert.ok(!extA.matchesProjectId);

    const adopt = await api('POST', '/api/external/adopt', { pid: a.pid });
    assert.equal(adopt.data && adopt.data.ok, true, adopt.text);
    const proj = adopt.data.project;
    createdProjects.add(proj.id);
    assert.ok(H.samePath(proj.path, a.dir));
    assert.equal(Number(proj.port), PORTS.extAdopt);

    const v = await H.waitFor(async () => {
      const s = await state();
      const pv = projectView(s, proj.id);
      return pv && pv.status === 'running' ? pv : null;
    }, { timeoutMs: 15000, what: 'adopted project running' });
    assert.equal(Number(v.run.pid), a.pid);

    const stopA = await api('POST', `/api/projects/${proj.id}/stop`, {});
    assert.equal(stopA.data && stopA.data.ok, true, stopA.text);
    await H.waitPortClosed(PORTS.extAdopt, 10000);
    await H.waitPidGone(a.pid, 10000);

    // --- stop an unadopted external server
    const b = await startRaw(PORTS.extStop, 'ext-stop');
    await findExt(b.pid);
    const stopB = await api('POST', '/api/external/stop', { pid: b.pid });
    assert.equal(stopB.data && stopB.data.ok, true, stopB.text);
    await H.waitPortClosed(PORTS.extStop, 10000);
    await H.waitPidGone(b.pid, 10000);

    // --- pids that are not in the external list are refused (and left alone)
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    children.push(sleeper);
    await H.sleep(300);
    const refStop = await api('POST', '/api/external/stop', { pid: sleeper.pid });
    assert.notEqual(refStop.data && refStop.data.ok, true, 'foreign pid stop ho gaya');
    assert.ok(refStop.status >= 400, `status ${refStop.status}`);
    const refAdopt = await api('POST', '/api/external/adopt', { pid: sleeper.pid });
    assert.notEqual(refAdopt.data && refAdopt.data.ok, true, 'foreign pid adopt ho gaya');
    await H.sleep(500);
    assert.equal(H.pidAlive(sleeper.pid), true, 'sleeper ko kisi ne band kar diya');
    sleeper.kill();
  });

  it("the user's 8085/8086 servers are listed as external and never touched", { timeout: 60000 }, async (t) => {
    for (const port of USER_PHP_PORTS) {
      if (!(await H.isPortOpen(port))) continue;
      const ext = await H.waitFor(async () => {
        const s = await state();
        return (s.external.php || []).find((x) => x.port === port) || null;
      }, { timeoutMs: 15000, intervalMs: 700, what: `external :${port}` });
      assert.ok(ext.pid, 'pid missing');
      assert.ok(['artisan serve', 'kit serve', 'php -S'].includes(ext.via));
      assert.ok(ext.projectPath, 'projectPath missing');
      userServers.push({ port, pid: Number(ext.pid), topPid: Number(ext.topPid) });
    }
    if (!userServers.length) {
      t.skip('8085/8086 par abhi koi server nahi chal raha');
      return;
    }
    // none of our projects points at them
    const s = await state();
    for (const u of userServers) {
      for (const id of createdProjects) {
        const pv = projectView(s, id);
        if (pv && pv.run) assert.notEqual(Number(pv.run.pid), u.topPid);
      }
      assert.equal(H.pidAlive(u.pid), true);
      assert.equal(H.pidAlive(u.topPid), true);
    }
  });

  it('write-env-db: backup in the data dir, only DB_PORT changes', { timeout: 60000 }, async (t) => {
    const original = [
      'APP_NAME=EnvFixture',
      'APP_ENV=local',
      '',
      'DB_CONNECTION=mysql',
      'DB_HOST=127.0.0.1',
      'DB_PORT=3307',
      'DB_DATABASE=dp_fixture',
      'DB_USERNAME=root',
      'DB_PASSWORD=NotARealSecret',
      '',
      'CACHE_DRIVER=file',
      '',
    ].join('\r\n');
    const dir = H.makeFixtureProject('laravel-root-router', { parent: projRoot, name: 'env-app', env: original });
    const st = await state();
    const rt = (st.runtimes.php || []).find((r) => r.ok);
    if (!rt) {
      t.skip('koi chalne wala PHP nahi');
      return;
    }
    const add = await api('POST', '/api/projects', { path: dir, name: 'dp-test-env', phpVersion: rt.version, phpPath: rt.path });
    assert.equal(add.data && add.data.ok, true, add.text);
    const id = add.data.project.id;
    createdProjects.add(id);

    const r = await api('POST', `/api/projects/${id}/write-env-db`, { port: 3392 });
    assert.equal(r.data && r.data.ok, true, r.text);
    assert.ok(Array.isArray(r.data.changed) && r.data.changed.includes('DB_PORT'), r.text);
    assert.ok(!r.text.includes('NotARealSecret'), 'response me password');

    const backup = r.data.backup;
    assert.ok(backup && fs.existsSync(backup), `backup missing: ${backup}`);
    const backupsRoot = path.join(dataDir, 'env-backups').toLowerCase() + path.sep;
    assert.ok(path.resolve(backup).toLowerCase().startsWith(backupsRoot), `backup data dir se bahar: ${backup}`);
    assert.equal(fs.readFileSync(backup, 'utf8'), original);

    const now = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const a = original.split('\r\n');
    const b = now.split('\r\n');
    assert.equal(b.length, a.length);
    const diff = a.map((l, i) => (l !== b[i] ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(diff, [5]);
    assert.equal(b[5], 'DB_PORT=3392');

    // nothing extra written inside the project
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('.env'));
    assert.deepEqual(files, ['.env']);

    // the project view now reports the new port
    const st2 = await state();
    assert.equal(String(projectView(st2, id).info.env.port), '3392');
  });

  // ---------------------------------------------------------------------------------------- v1.1
  const okPhp = (st) => (st.runtimes.php || []).filter((r) => r.ok).sort((a, b) => Number(a.iniRelocated) - Number(b.iniRelocated))[0] || null;

  it('PORT_CONFIRM: the port is asked once before the first run; bad, busy and taken ports are refused', { timeout: 120000 }, async (t) => {
    const st = await state();
    const rt = okPhp(st);
    if (!rt) {
      t.skip('koi chalne wala PHP nahi');
      return;
    }
    const dir = H.makeFixtureProject('plain', { parent: projRoot, name: 'port-ask' });
    const add = await api('POST', '/api/projects', { path: dir, name: 'dp-test-port', phpVersion: rt.version, phpPath: rt.path });
    assert.equal(add.data && add.data.ok, true, add.text);
    const id = add.data.project.id;
    createdProjects.add(id);
    assert.equal(add.data.project.portConfirmed, false);
    assert.equal(projectView(await state(), id).portConfirmed, false);
    const other = await api('POST', '/api/projects', { path: H.makeFixtureProject('plain', { parent: projRoot, name: 'port-other' }), name: 'dp-test-port-other', phpVersion: rt.version, phpPath: rt.path });
    assert.equal(other.data && other.data.ok, true, other.text);
    createdProjects.add(other.data.project.id);

    const ask = await api('POST', `/api/projects/${id}/start`, {});
    assert.equal(ask.status, 409, ask.text);
    assert.equal(ask.data.code, 'PORT_CONFIRM');
    const suggested = ask.data.suggestedPort;
    assert.ok(Number.isInteger(suggested) && suggested >= 8890 && suggested <= 8897, `suggestedPort ${suggested}`);
    assert.ok(ask.data.error, 'message missing');

    for (const bad of ['abc', 80, 70000, 8890.5, true]) {
      const r = await api('POST', `/api/projects/${id}/start`, { port: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
      assert.equal(r.data.code, 'BAD_INPUT');
    }
    const busy = await api('POST', `/api/projects/${id}/start`, { port: PANEL_PORT });
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.data.code, 'PORT_BUSY');
    const taken = await api('POST', `/api/projects/${id}/start`, { port: other.data.project.port });
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.data.code, 'PORT_TAKEN');
    assert.equal(projectView(await state(), id).portConfirmed, false, 'refused ports are not saved');

    assert.equal(await H.isPortOpen(suggested), false, `port ${suggested} busy`);
    const go = await api('POST', `/api/projects/${id}/start`, { port: suggested });
    assert.equal(go.data && go.data.ok, true, go.text);
    assert.equal(Number(new URL(go.data.url).port), suggested);
    const page = await H.httpGetText(suggested, '/');
    assert.equal(page.text.trim(), `PLAIN:${rt.version}`);
    let v = projectView(await state(), id);
    assert.equal(v.portConfirmed, true);
    assert.equal(v.port, suggested);
    ownPids.add(Number(v.run.pid));
    assert.equal((await api('POST', `/api/projects/${id}/stop`, {})).data.ok, true);
    await H.waitPortClosed(suggested, 10000);

    // never asked again
    const again = await api('POST', `/api/projects/${id}/start`, {});
    assert.equal(again.data && again.data.ok, true, again.text);
    v = projectView(await state(), id);
    ownPids.add(Number(v.run.pid));
    assert.equal((await api('POST', `/api/projects/${id}/stop`, {})).data.ok, true);
    await H.waitPortClosed(suggested, 10000);

    // update {port} also confirms
    const upd = await api('POST', `/api/projects/${other.data.project.id}/update`, { port: other.data.project.port });
    assert.equal(upd.data.project.portConfirmed, true);
  });

  it('setup checklist: CREATE_ENV, SET_DB, SET_APP_URL, COMPOSER_INSTALL, GENERATE_KEY (fake artisan) + config:clear', { timeout: 300000 }, async (t) => {
    const st = await state();
    const rt = okPhp(st);
    if (!rt) {
      t.skip('koi chalne wala PHP nahi');
      return;
    }
    const server = (st.dbServers || []).find((d) => d.port !== 3306) || null; // .env.example uses 3306
    const composer = (st.runtimes.composer || []).find((c) => c.ok) || null;
    const dir = path.join(projRoot, 'setup-app');
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    // Fake artisan (only what the setup job calls). Not Laravel: GENERATE_KEY is tested with this stand-in.
    w('artisan', [
      '<?php',
      '$cmd = isset($argv[1]) ? $argv[1] : "";',
      'if ($cmd === "key:generate") {',
      '  $env = file_get_contents(__DIR__ . "/.env");',
      '  $key = "base64:" . base64_encode(random_bytes(32));',
      '  $n = 0;',
      '  $env = preg_replace("/^APP_KEY=[^\\r\\n]*/m", "APP_KEY=" . $key, $env, 1, $n);',
      '  if (!$n) { $env .= "\\nAPP_KEY=" . $key . "\\n"; }',
      '  file_put_contents(__DIR__ . "/.env", $env);',
      '  echo "Application key set successfully.\\n";',
      '  exit(0);',
      '}',
      'if ($cmd === "config:clear") { @unlink(__DIR__ . "/bootstrap/cache/config.php"); echo "Configuration cache cleared.\\n"; exit(0); }',
      'fwrite(STDERR, "fixture artisan: unknown command $cmd\\n");',
      'exit(1);',
      '',
    ].join('\n'));
    w('public/index.php', "<?php echo 'SETUP';\n");
    w('bootstrap/cache/config.php', '<?php return [];\n');
    // no dependencies and packagist switched off: composer install works offline
    w('composer.json', JSON.stringify({ name: 'fixture/setup', require: {}, repositories: [{ 'packagist.org': false }] }, null, 4));
    const example = ['APP_NAME=SetupFixture', 'APP_KEY=', 'APP_URL=http://localhost', '', 'DB_CONNECTION=mysql', 'DB_HOST=127.0.0.1',
      'DB_PORT=3306', 'DB_DATABASE=laravel', 'DB_USERNAME=root', 'DB_PASSWORD=NotARealSecret', ''].join('\r\n');
    w('.env.example', example);
    if (!composer) w('vendor/autoload.php', '<?php\n');

    const add = await api('POST', '/api/projects', { path: dir, name: 'dp-test-setup', phpVersion: rt.version, phpPath: rt.path });
    assert.equal(add.data && add.data.ok, true, add.text);
    const id = add.data.project.id;
    createdProjects.add(id);
    const port = add.data.project.port;
    if (server) {
      const u = await api('POST', `/api/projects/${id}/update`, { dbServerId: server.id });
      assert.equal(u.data && u.data.ok, true, u.text);
    }

    const g1 = await api('GET', `/api/projects/${id}/setup`);
    assert.equal(g1.data && g1.data.ok, true, g1.text);
    const expected = ['CREATE_ENV', ...(server ? ['SET_DB'] : []), 'SET_APP_URL', ...(composer ? ['COMPOSER_INSTALL'] : []), 'GENERATE_KEY'];
    assert.deepEqual(g1.data.actions, expected);
    assert.equal(g1.data.isLaravel, true);
    assert.deepEqual(g1.data.env, { exists: false, exampleExists: true, appKeySet: false, appUrl: 'http://localhost', dbHost: '127.0.0.1', dbPort: 3306, dbDatabase: 'laravel' });
    assert.equal(g1.data.composerSelected, false);
    assert.deepEqual(g1.data.server, server ? { id: server.id, port: server.port } : null);
    assert.ok(!g1.text.includes('NotARealSecret'));

    for (const body of [{ actions: 'CREATE_ENV' }, { actions: [] }, { actions: ['NOPE'] }, {}]) {
      const r = await api('POST', `/api/projects/${id}/setup`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    }
    if (!server) {
      const r = await api('POST', `/api/projects/${id}/setup`, { actions: ['SET_DB'] });
      assert.equal(r.data.code, 'NO_DB_SERVER');
    }

    const run = await api('POST', `/api/projects/${id}/setup`, { actions: [...expected].reverse() });
    assert.equal(run.data && run.data.ok, true, run.text);
    const job = await H.waitForJob(api, run.data.jobId, 240000);
    assert.equal(job.status, 'done', H.describeJob(job));
    assert.deepEqual(job.result.done, expected, 'run in the fixed order');
    assert.equal(job.result.configCleared, true);
    const jobText = JSON.stringify(job);
    assert.ok(!jobText.includes('NotARealSecret'), 'password in the job');

    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const lines = env.split('\r\n');
    assert.ok(env.includes('\r\n') && !/[^\r]\n/.test(env), 'CRLF kept');
    const key = lines.find((l) => l.startsWith('APP_KEY='));
    assert.match(key, /^APP_KEY=base64:[A-Za-z0-9+/=]{40,}$/);
    assert.ok(!jobText.includes(key.slice(8)), 'APP_KEY in the job log');
    assert.ok(lines.includes(`APP_URL=http://127.0.0.1:${port}`), env);
    if (server) assert.ok(lines.includes(`DB_PORT=${server.port}`), env);
    assert.ok(lines.includes('DB_DATABASE=laravel'), 'existing DB_DATABASE kept');
    assert.ok(lines.includes('DB_USERNAME=root') && lines.includes('DB_PASSWORD=NotARealSecret') && lines.includes('APP_NAME=SetupFixture'));
    assert.equal(fs.existsSync(path.join(dir, 'bootstrap', 'cache', 'config.php')), false, 'config:clear ran');
    assert.ok(fs.existsSync(path.join(dir, 'vendor', 'autoload.php')), 'vendor/autoload.php');
    assert.equal(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), example, '.env.example untouched');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.env')).sort(), ['.env', '.env.example'], 'no backups inside the project');
    const backups = fs.readdirSync(path.join(dataDir, 'env-backups', id));
    assert.equal(backups.length, job.result.backups.length);
    assert.ok(backups.length >= 2, `backups: ${backups.join(', ')}`);
    assert.equal(new Set(backups).size, backups.length);

    const g2 = await api('GET', `/api/projects/${id}/setup`);
    assert.deepEqual(g2.data.actions, [], JSON.stringify(g2.data));
    assert.equal(g2.data.env.appKeySet, true);

    // CREATE_ENV never overwrites
    const before = fs.readFileSync(path.join(dir, '.env'));
    const again = await api('POST', `/api/projects/${id}/setup`, { actions: ['CREATE_ENV', 'GENERATE_KEY'] });
    const job2 = await H.waitForJob(api, again.data.jobId, 60000);
    assert.equal(job2.status, 'done', H.describeJob(job2));
    assert.deepEqual(job2.result.skipped, ['CREATE_ENV', 'GENERATE_KEY']);
    assert.deepEqual(fs.readFileSync(path.join(dir, '.env')), before, '.env unchanged');

    // db-provision: validation happens before any job / DB access
    const prov = (body) => api('POST', `/api/projects/${id}/db-provision`, body);
    assert.equal((await prov({ mode: 'drop' })).status, 400);
    if (server) {
      const rel = await prov({ mode: 'import', file: 'dump.sql' });
      assert.equal(rel.status, 400, rel.text);
      assert.equal(rel.data.code, 'BAD_PATH');
      const notSql = await prov({ mode: 'import', file: path.join(dir, 'composer.json') });
      assert.equal(notSql.data.code, 'BAD_PATH', notSql.text);
      assert.equal((await prov({ mode: 'move' })).status, 400);
      assert.equal((await prov({ mode: 'move', fromServerId: server.id })).status, 400, 'same server');
    } else {
      assert.equal((await prov({ mode: 'empty' })).data.code, 'NO_DB_SERVER');
    }
  });

  it('installer API (no network): system summary, input checks, confirm required', async () => {
    const sys = await api('GET', '/api/installer/system');
    assert.equal(sys.data && sys.data.ok, true, sys.text);
    for (const k of ['php', 'mariadb', 'mysql', 'composer', 'missing', 'recommended']) assert.ok(Array.isArray(sys.data[k]), k);
    assert.equal(typeof sys.data.node.version, 'string');
    assert.ok(H.samePath(sys.data.runtimesDir, path.join(H.TOOL_DIR, 'runtimes')), sys.data.runtimesDir);
    const cat = await api('GET', '/api/installer/catalog?kind=node');
    assert.equal(cat.status, 400, cat.text);
    const noConfirm = await api('POST', '/api/installer/install', { kind: 'php', version: '8.4.1' });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.data.code, 'CONFIRM_REQUIRED');
    for (const body of [{ kind: 'node', version: '24.1.0', confirm: true }, { kind: 'php', version: '..\\8.4.1', confirm: true }, { kind: 'php', version: 'latest', confirm: true, url: 'https://evil.example/php.zip' }]) {
      const r = await api('POST', '/api/installer/install', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      assert.equal(r.data.code, 'BAD_INPUT');
    }
    // pick-file / open-url refuse without opening anything
    const pf = await api('POST', '/api/pick-file', { kind: 'exe' });
    assert.equal(pf.status, 400);
    const ou = await api('POST', '/api/open-url', { url: 'https://evil.example/' });
    assert.equal(ou.status, 403);
    assert.equal(ou.data.code, 'URL_NOT_ALLOWED');
  });

  it("the user's servers are still alive at the end", async (t) => {
    if (!userServers.length) {
      t.skip('koi user server record nahi hua');
      return;
    }
    for (const u of userServers) {
      assert.equal(H.pidAlive(u.pid), true, `user server pid ${u.pid} band ho gaya!`);
      assert.equal(await H.isPortOpen(u.port), true, `user port ${u.port} band ho gaya!`);
    }
  });
});

describe('terminal shims (direct)', () => {
  let tmp;
  after(async () => {
    try { await H.removeDir(tmp); } catch { /* ignore */ }
  });

  it('writeShims + buildTerminalScript', async () => {
    const projects = require(path.join(H.TOOL_DIR, 'lib', 'projects.js'));
    tmp = H.makeTempDir('dp-shim-');
    const dataDir = path.join(tmp, 'data');
    const dir = H.makeFixtureProject('laravel-vendor-router', { parent: tmp, name: 'shim-app' });
    const iniFile = path.join(dataDir, 'php-ini', 'php-8.2.12-abcdef.ini');
    fs.mkdirSync(path.dirname(iniFile), { recursive: true });
    fs.writeFileSync(iniFile, '; test ini\n');

    const project = { id: 'shim-app-ab12', name: 'Shim 100% App', path: dir, phpVersion: '8.2.12', phpPath: path.join(XAMPP_DIR, 'php8.2', 'php.exe'), port: 8890 };
    const php = {
      id: 'php-8.2.12-abcdef', version: '8.2.12', path: path.join(XAMPP_DIR, 'php8.2', 'php.exe'), dir: path.join(XAMPP_DIR, 'php8.2'),
      iniRelocated: true, iniFile, ok: true, label: 'PHP 8.2.12 · ' + path.join(XAMPP_DIR, 'php8.2'),
    };
    const composer = { id: 'composer-2.10.3-aaaaaa', version: '2.10.3', path: path.join(XAMPP_DIR, 'composer', 'composer-2.10.3.phar'), ok: true, label: 'Composer 2.10.3' };
    const db = {
      id: 'db-mariadb-12.3.3-bbbbbb', label: 'MariaDB 12.3.3 · C:\\laragon', kind: 'mariadb', version: '12.3.3',
      port: 3392, effectivePort: 3392, binDir: 'C:\\laragon\\bin\\mysql\\mariadb-12.3.3-winx64\\bin',
    };

    const r = await Promise.resolve(projects.writeShims({ dataDir, project, php, composer, db }));
    assert.ok(H.samePath(r.dir, path.join(dataDir, 'shims', project.id)), `dir ${r.dir}`);
    const phpBat = fs.readFileSync(r.phpBat, 'utf8');
    assert.ok(phpBat.includes(`"${php.path}"`), phpBat);
    assert.ok(phpBat.includes(`-c "${iniFile}"`), phpBat);
    assert.ok(phpBat.includes('%*'), phpBat);
    assert.ok(r.composerBat, 'composerBat missing');
    const compBat = fs.readFileSync(r.composerBat, 'utf8');
    assert.ok(compBat.includes(`"${composer.path}"`), compBat);
    assert.ok(compBat.includes(`"${php.path}"`), compBat);
    assert.ok(compBat.includes('%*'));
    const term = fs.readFileSync(r.terminalCmd, 'utf8');
    assert.match(term, /@echo off/i);
    assert.ok(term.includes(`cd /d "${dir}"`), term);
    assert.ok(term.includes('8.2.12'));
    const title = term.split(/\r?\n/).find((l) => /^\s*title\s/i.test(l));
    assert.ok(title, 'title line missing');
    assert.ok(!title.replace(/%%/g, '').includes('%'), `unescaped % in title: ${title}`);

    // no composer, no relocated ini
    const project2 = Object.assign({}, project, { id: 'shim-app-cd34', name: 'Shim App 2' });
    const php2 = Object.assign({}, php, { iniRelocated: false, iniFile: path.join(XAMPP_DIR, 'php8.2', 'php.ini') });
    const r2 = await Promise.resolve(projects.writeShims({ dataDir, project: project2, php: php2, composer: null, db: null }));
    assert.equal(r2.composerBat, null);
    assert.equal(fs.existsSync(path.join(r2.dir, 'composer.bat')), false);
    const phpBat2 = fs.readFileSync(r2.phpBat, 'utf8');
    assert.ok(!/\s-c\s/.test(phpBat2), phpBat2);

    const script = async (action) => Promise.resolve(projects.buildTerminalScript({ project, php, composer, db, action }));
    assert.match(await script('composer-install'), /call composer install/);
    assert.match(await script('composer-update-dry'), /call composer update -W --dry-run/);
    assert.match(await script('check-platform'), /call composer check-platform-reqs/);
    assert.match(await script('migrate-status'), /php artisan migrate:status/);
    assert.match(await script('optimize-clear'), /php artisan optimize:clear/);
    assert.match(await script('tinker'), /php artisan tinker/);
    const shell = await script('shell');
    assert.ok(!/composer install|artisan/.test(shell), shell);
    assert.ok(shell.includes(`cd /d "${dir}"`));
  });
});

// A DB server that opens its port and then aborts (e.g. crashed mysql.db privilege table) must
// not count as started. A tiny node "server" plays the DB; no real datadir is involved.
describe('DB start confirmation (fake server that opens its port, then aborts)', () => {
  const FAKE_PORT = 8896;
  const lib = (m) => require(path.join(__dirname, '..', 'lib', m));
  const kids = [];
  let tmp;

  const FAKE = String.raw`
const net = require('net');
const fs = require('fs');
const [port, mode, logFile] = process.argv.slice(1);
const log = (l) => fs.appendFileSync(logFile, l + '\r\n');
const srv = net.createServer((s) => s.destroy());
srv.listen(Number(port), '127.0.0.1', () => {
  log('[Note] Server socket created on IP: 127.0.0.1.');
  if (mode === 'crash') {
    setTimeout(() => { log("[ERROR] Fatal error: Can't open and lock privilege tables"); log('[ERROR] Aborting'); }, 100);
    setTimeout(() => process.exit(1), 900);
  } else if (mode === 'quick-crash') {
    setTimeout(() => process.exit(1), 350);
  } else if (mode === 'ready') {
    setTimeout(() => log('mysqld.exe: ready for connections.'), 100);
  }
});
setTimeout(() => process.exit(0), 20000);
`;

  async function runFake(mode) {
    const logFile = path.join(tmp, `${mode}.err`);
    fs.writeFileSync(logFile, '');
    const child = spawn(process.execPath, ['-e', FAKE, String(FAKE_PORT), mode, logFile], { stdio: 'ignore', windowsHide: true });
    kids.push(child);
    const procs = lib('procs.js');
    const ports = lib('ports.js');
    const D = lib('dbservers.js');
    const isAlive = () => procs.pidExists(child.pid);
    const t0 = Date.now();
    const opened = await ports.waitForPort(FAKE_PORT, { timeoutMs: 8000, intervalMs: 50, isAlive });
    const c = opened
      ? await D.confirmStarted({
        isAlive, isPortOpen: () => ports.isPortOpen(FAKE_PORT), readLog: () => D.readNewText(logFile, 0),
        settleMs: 600, timeoutMs: 6000, intervalMs: 100,
      })
      : { ok: false, alive: isAlive() };
    const result = { opened, ...c, ms: Date.now() - t0 };
    if (child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
    await H.waitPortClosed(FAKE_PORT, 5000).catch(() => {});
    return result;
  }

  before(() => { tmp = H.makeTempDir('dp-confirm-'); });
  after(async () => {
    for (const c of kids) if (c.exitCode === null && c.signalCode === null) { try { c.kill(); } catch { /* ignore */ } }
    try { lib('procs.js').stopHelper(); } catch { /* ignore */ }
    try { await H.removeDir(tmp); } catch { /* ignore */ }
  });

  it('opens the port, logs Aborting and lingers → not started (even past the settle window)', async (t) => {
    if (await H.isPortOpen(FAKE_PORT)) { t.skip(`port ${FAKE_PORT} busy`); return; }
    const r = await runFake('crash');
    assert.equal(r.opened, true, 'the fake server should open its port first');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.aborting, true, JSON.stringify(r));
    assert.equal(r.alive, false, JSON.stringify(r));
  });

  it('opens the port and dies without a log line → not started', async (t) => {
    if (await H.isPortOpen(FAKE_PORT)) { t.skip(`port ${FAKE_PORT} busy`); return; }
    const r = await runFake('quick-crash');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.alive, false, JSON.stringify(r));
  });

  it('"ready for connections" after the port opened → started at once', async (t) => {
    if (await H.isPortOpen(FAKE_PORT)) { t.skip(`port ${FAKE_PORT} busy`); return; }
    const r = await runFake('ready');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.via, 'log');
  });

  it('no log at all but stays up → started after the settle window', async (t) => {
    if (await H.isPortOpen(FAKE_PORT)) { t.skip(`port ${FAKE_PORT} busy`); return; }
    const r = await runFake('quiet');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.via, 'settle');
    assert.ok(r.ms >= 600, `confirmed too early (${r.ms} ms)`);
  });
});
