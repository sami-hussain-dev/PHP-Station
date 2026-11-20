'use strict';
// MCP server (lib/mcp.js), Upgrade Lab (lib/upgradelab.js), Security scan (lib/secscan.js), QR (public/qr.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mcp = require('../lib/mcp');
const lab = require('../lib/upgradelab');
const sec = require('../lib/secscan');

const PROJECTS = [
  { id: 'shop-1a2b', name: 'shop', path: 'D:\\www\\shop', status: 'running', url: 'http://127.0.0.1:8001', phpVersion: '8.3.1', info: { laravel: '11.0.0', env: { database: 'shop' } } },
  { id: 'blog-3c4d', name: 'blog', path: 'D:\\www\\blog', status: 'stopped', phpVersion: '8.1.2', info: {} },
  { id: 'shop-admin-5e6f', name: 'shop-admin', path: 'D:\\www\\shop\\admin', status: 'stopped', info: {} },
];

function fakePanel(overrides = {}) {
  const calls = [];
  const routes = Object.assign({
    'GET /api/state': { ok: true, projects: PROJECTS },
    'GET /api/mail/m1': { ok: true, mail: { id: 'm1', subject: 'Your code is 482913', from: { address: 'a@b.c' }, to: [] }, text: 'Use 482913 to sign in. Or open https://shop.test/verify?t=abc. (c) 2026', attachments: [] },
    'POST /api/projects/shop-1a2b/restore-point': { ok: true, jobId: 'j1' },
    'POST /api/projects/shop-1a2b/undo': { ok: true, jobId: 'j2' },
  }, overrides);
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    const key = `${method} ${url.split('?')[0]}`;
    if (!(key in routes)) throw new mcp.ToolError(`no route ${key}`);
    const r = routes[key];
    if (r && r.ok === false) { const e = new mcp.ToolError(r.error); e.fromPanel = true; throw e; }
    return typeof r === 'function' ? r(body) : r;
  };
  const waitJob = async (id) => ({ status: 'done', result: id === 'j1' ? { point: { name: '20261120-101010_manual', tables: 12 } } : { ok: true } });
  return { api, waitJob, calls };
}

// ------------------------------------------------------------------------------------------ MCP protocol

test('MCP: initialize answers with a supported protocol version and server info', async () => {
  const f = fakePanel();
  const handle = mcp.createServer({ api: f.api, waitJob: f.waitJob, cwd: null, version: '9.9.9' });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.strictEqual(r.result.protocolVersion, '2025-03-26');
  assert.strictEqual(r.result.serverInfo.name, 'php-station');
  assert.strictEqual(r.result.serverInfo.version, '9.9.9');
  assert.ok(r.result.capabilities.tools);
  const r2 = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.strictEqual(r2.result.protocolVersion, mcp.PROTOCOLS[0]);
});

test('MCP: notifications get no answer, unknown methods get -32601, bad messages -32600', async () => {
  const f = fakePanel();
  const handle = mcp.createServer({ api: f.api, waitJob: f.waitJob });
  assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.strictEqual((await handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
  assert.strictEqual((await handle({ id: 4, method: 'ping' })).error.code, -32600);
  assert.deepStrictEqual((await handle({ jsonrpc: '2.0', id: 5, method: 'ping' })).result, {});
});

test('MCP: every tool has a schema and annotations; destructive tools are marked', () => {
  const names = new Set();
  for (const t of mcp.TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.strictEqual(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 30);
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean');
  }
  for (const n of ['restore_database', 'undo_db_action']) assert.strictEqual(mcp.TOOLS.find((t) => t.name === n).annotations.destructiveHint, true);
});

test('MCP: unknown tool -> -32602; a failing tool -> isError result, not a crash', async () => {
  const f = fakePanel({ 'GET /api/state': { ok: false, error: 'boom' } });
  const handle = mcp.createServer({ api: f.api, waitJob: f.waitJob });
  assert.strictEqual((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm_rf' } })).error.code, -32602);
  const r = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /boom/);
});

test('MCP: resolveProject by id, name, folder, unique part, current folder, only running one', () => {
  assert.strictEqual(mcp.resolveProject(PROJECTS, 'blog-3c4d').name, 'blog');
  assert.strictEqual(mcp.resolveProject(PROJECTS, 'SHOP').id, 'shop-1a2b');
  assert.strictEqual(mcp.resolveProject(PROJECTS, 'd:\\www\\blog\\').id, 'blog-3c4d');
  assert.strictEqual(mcp.resolveProject(PROJECTS, 'adm').id, 'shop-admin-5e6f');
  assert.throws(() => mcp.resolveProject(PROJECTS, 'sho'), /more than one/);
  assert.throws(() => mcp.resolveProject(PROJECTS, 'nothing'), /No project/);
  // the deepest project folder that holds the current folder wins
  assert.strictEqual(mcp.resolveProject(PROJECTS, null, 'D:\\www\\shop\\admin\\app\\Http').id, 'shop-admin-5e6f');
  assert.strictEqual(mcp.resolveProject(PROJECTS, null, 'D:\\www\\shop\\routes').id, 'shop-1a2b');
  assert.strictEqual(mcp.resolveProject(PROJECTS, undefined, 'C:\\elsewhere').id, 'shop-1a2b'); // the only running one
  assert.throws(() => mcp.resolveProject(PROJECTS.map((p) => Object.assign({}, p, { status: 'stopped' })), null, 'C:\\x'), /Say which project/);
});

test('MCP: read_mail returns links and OTP-like codes (no years, no parts of links)', async () => {
  const f = fakePanel();
  const handle = mcp.createServer({ api: f.api, waitJob: f.waitJob });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_mail', arguments: { id: 'm1' } } });
  const out = JSON.parse(r.result.content[0].text);
  assert.deepStrictEqual(out.possibleCodes, ['482913']);
  assert.deepStrictEqual(out.links, ['https://shop.test/verify?t=abc']);
});

test('MCP: read_mail of an HTML-only mail reads the sandboxed view as text', async () => {
  const f = fakePanel({ 'GET /api/mail/m2': { ok: true, mail: { id: 'm2', subject: 'Reset' }, text: null, htmlUrl: '/mail-view/m2?k=1', attachments: [] } });
  const handle = mcp.createServer({ api: f.api, waitJob: f.waitJob, getText: async () => '<p>Code <b>7731</b></p><a href="https://x.test/r?a=1&amp;b=2">Reset</a><style>.x{}</style>' });
  const out = JSON.parse((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_mail', arguments: { id: 'm2' } } })).result.content[0].text);
  assert.deepStrictEqual(out.possibleCodes, ['7731']);
  assert.deepStrictEqual(out.links, ['https://x.test/r?a=1&b=2']);
  assert.ok(!/style|<p>/.test(out.text));
});

test('MCP: create_restore_point and restore_database go through the panel with confirm', async () => {
  const f = fakePanel();
  const handle = mcp.createServer({ api: f.api, waitJob: f.waitJob, cwd: 'D:\\www\\shop' });
  const a = JSON.parse((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_restore_point', arguments: {} } })).result.content[0].text);
  assert.strictEqual(a.saved.name, '20261120-101010_manual');
  await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'restore_database', arguments: { point: '20261120-101010_manual' } } });
  const undo = f.calls.find((c) => c.url.endsWith('/undo'));
  assert.deepStrictEqual(undo.body, { name: '20261120-101010_manual', confirm: true });
});

test('MCP: trim keeps answers small', () => {
  const t = mcp.trim({ a: 'x'.repeat(5000), b: Array.from({ length: 80 }, (_, i) => i), c: null, d: '' });
  assert.ok(t.a.length < 2100 && /more characters/.test(t.a));
  assert.strictEqual(t.b.length, 51);
  assert.ok(!('c' in t) && !('d' in t));
});

test('MCP: client configs point at tools/mcp.js', () => {
  const c = mcp.clientConfigs({ node: 'C:\\node\\node.exe', script: 'D:\\ps\\tools\\mcp.js' });
  assert.match(c.claudeCode, /^claude mcp add php-station/);
  assert.deepStrictEqual(JSON.parse(c.cursor).mcpServers['php-station'].args, ['D:\\ps\\tools\\mcp.js']);
  assert.strictEqual(JSON.parse(c.vscode).servers['php-station'].type, 'stdio');
  assert.match(c.codex, /\[mcp_servers\.php-station\]/);
});

test('MCP: tools/mcp.js speaks JSON-RPC over stdio', async () => {
  const { spawnSync } = require('child_process');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((m) => JSON.stringify(m)).join('\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'mcp.js'), '--data', path.join(require('os').tmpdir(), 'ps-mcp-test-none')], { input, encoding: 'utf8', timeout: 20000 });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[1].result.tools.length, mcp.TOOLS.length);
});

// ------------------------------------------------------------------------------------------ Upgrade Lab

test('Upgrade Lab: packages whose php constraint excludes the target', () => {
  const lock = {
    packages: [
      { name: 'old/lib', version: '1.0.0', require: { php: '>=7.2 <8.2' } },
      { name: 'good/lib', version: '2.0.0', require: { php: '^8.0' } },
      { name: 'no/php', version: '1.0.0', require: { 'ext-json': '*' } },
    ],
    'packages-dev': [{ name: 'dev/tool', version: '0.1', require: { php: '~8.1.0' } }],
  };
  const bad = lab.incompatiblePackages(lock, '8.4.1');
  assert.deepStrictEqual(bad.map((x) => [x.name, x.dev]), [['dev/tool', true], ['old/lib', false]]);
  assert.deepStrictEqual(lab.incompatiblePackages(lock, '8.1.5').map((x) => x.name), []);
});

test('Upgrade Lab: required extensions and php -m parsing', () => {
  const need = lab.requiredExtensions({ require: { 'ext-intl': '*', php: '^8.2' } }, { packages: [{ require: { 'ext-GD': '*' } }] });
  assert.deepStrictEqual(need, ['gd', 'intl']);
  const mods = lab.parseModules('[PHP Modules]\nCore\ngd\nintl\nPDO\n\n[Zend Modules]\nZend OPcache\n');
  assert.ok(mods.has('gd') && mods.has('pdo') && mods.has('opcache') && !mods.has('[php modules]'));
});

test('Upgrade Lab: only safe GET routes without parameters', () => {
  const list = [
    { method: 'GET|HEAD', uri: '/' }, { method: 'GET|HEAD', uri: 'dashboard', name: 'dashboard' },
    { method: 'GET|HEAD', uri: 'users/{id}' }, { method: 'POST', uri: 'login' },
    { method: 'GET|HEAD', uri: 'logout' }, { method: 'GET|HEAD', uri: 'cache/clear' },
    { method: 'GET|HEAD', uri: 'reports/monthly', name: 'reports.delete' },
    { method: 'GET|HEAD', uri: '_ignition/health-check' }, { method: 'GET|HEAD', uri: 'admin', domain: 'admin.test' },
    { method: 'GET|HEAD', uri: 'about' }, { method: 'GET|HEAD', uri: 'about' },
  ];
  assert.deepStrictEqual(lab.filterRoutes(list), ['/', '/about', '/dashboard']);
  assert.deepStrictEqual(lab.filterRoutes(list, 2), ['/', '/about']);
});

test('Upgrade Lab: page links stay on the site and skip assets / risky links', () => {
  const html = '<a href="/about">a</a><a href="contact.php?x=1&amp;y=2">c</a><a href="https://other.com/x">o</a>'
    + '<a href="/logout">l</a><a href="/app.css">s</a><a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="http://127.0.0.1:8000/shop">s</a>';
  assert.deepStrictEqual(lab.extractLinks(html, '/blog/'), ['/about', '/blog/contact.php?x=1&y=2', '/shop']);
});

test('Upgrade Lab: PHP errors printed into a page are found', () => {
  const m = lab.pageMarkers('<br />\n<b>Deprecated</b>:  Creation of dynamic property A::$b is deprecated in <b>C:\\x\\a.php</b> on line <b>12</b><br />');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].level, 'Deprecated');
  assert.strictEqual(m[0].line, 12);
  assert.deepStrictEqual(lab.pageMarkers('<p>All good</p>'), []);
});

test('Upgrade Lab: log growth is parsed; php -S access lines are ignored', () => {
  const e = lab.parseLogChunk([
    '[2026-11-20 10:00:00] local.ERROR: Call to undefined function each() {"exception":"..."}',
    '[2026-11-20 10:00:01] local.WARNING: strftime() is deprecated',
    '[Thu Nov 20 10:00:02 2026] 127.0.0.1:5555 [200]: GET /about',
    'PHP Deprecated:  Implicitly marking parameter $x as nullable is deprecated in C:\\a.php on line 3',
  ].join('\n'));
  assert.deepStrictEqual(e.map((x) => [x.level, x.deprecation]), [['ERROR', false], ['WARNING', true], ['DEPRECATED', true]]);
});

test('Upgrade Lab: verdict per route', () => {
  const s = (status, extra) => Object.assign({ status, location: null, markers: [], log: [] }, extra);
  assert.strictEqual(lab.verdict(s(200), s(200)), 'same');
  assert.strictEqual(lab.verdict(s(200), s(500)), 'broken');
  assert.strictEqual(lab.verdict(s(200), s(0)), 'broken');
  assert.strictEqual(lab.verdict(s(200), s(200, { log: [{ level: 'ERROR', message: 'x', deprecation: false }] })), 'broken');
  assert.strictEqual(lab.verdict(s(302, { location: '/login' }), s(302, { location: '/home' })), 'changed');
  assert.strictEqual(lab.verdict(s(200), s(200, { log: [{ level: 'WARNING', message: 'x is deprecated', deprecation: true }] })), 'deprecated');
  assert.strictEqual(lab.verdict(s(500), s(500)), 'bothFail');
  const fatal = { level: 'Fatal error', message: 'Uncaught x' };
  assert.strictEqual(lab.verdict(s(200, { markers: [fatal] }), s(200, { markers: [fatal] })), 'bothFail');
});

test('Upgrade Lab: cookie input is cleaned and checked', () => {
  assert.strictEqual(lab.cleanCookie('Cookie: laravel_session=abc; XSRF-TOKEN=x'), 'laravel_session=abc; XSRF-TOKEN=x');
  assert.strictEqual(lab.cleanCookie('  '), null);
  assert.strictEqual(lab.cleanCookie(null), null);
  assert.throws(() => lab.cleanCookie('a=b\r\nX-Evil: 1'), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => lab.cleanCookie('just text'), (e) => e.code === 'BAD_INPUT');
});

// ------------------------------------------------------------------------------------------ Security scan

test('Security scan: composer audit JSON is parsed and sorted by severity', () => {
  const text = 'Found 2 security vulnerability advisories\n' + JSON.stringify({
    advisories: {
      'guzzlehttp/psr7': [{ advisoryId: 'A1', packageName: 'guzzlehttp/psr7', affectedVersions: '<1.9.1', title: 'Header injection', cve: 'CVE-2023-29197', link: 'https://x', severity: 'medium' }],
      'laravel/framework': { 0: { packageName: 'laravel/framework', title: 'RCE', severity: 'critical', affectedVersions: '<8.83' } },
    },
    abandoned: { 'fzaninotto/faker': 'fakerphp/faker', 'old/thing': null },
  });
  const r = sec.parseAudit(text);
  assert.deepStrictEqual(r.advisories.map((a) => [a.package, a.severity]), [['laravel/framework', 'critical'], ['guzzlehttp/psr7', 'medium']]);
  assert.deepStrictEqual(r.abandoned, [{ name: 'fzaninotto/faker', replacement: 'fakerphp/faker' }, { name: 'old/thing', replacement: null }]);
  assert.strictEqual(sec.parseAudit('not json'), null);
});

test('Security scan: vibe-security report is parsed', () => {
  const r = sec.parseVibe({ version: '0.2.0', filesScanned: 10, summary: { critical: 1, high: 0 }, score: 70, findings: [
    { id: 'LOW', severity: 'low', title: 'l', file: 'b.php', line: 2 },
    { id: 'SQLI', severity: 'critical', title: 'SQL injection', file: 'a.php', line: 5, snippet: 'x'.repeat(500), ur: 'Bindings use karein' },
  ] });
  assert.deepStrictEqual(r.findings.map((f) => f.id), ['SQLI', 'LOW']);
  assert.strictEqual(r.findings[0].snippet.length, 240);
  assert.strictEqual(r.score, 70);
  assert.strictEqual(sec.parseVibe({}), null);
});

test('Security scan: .env flags and serving mistakes in the public folder', () => {
  assert.deepStrictEqual(sec.envFlags('APP_ENV="production"\nAPP_DEBUG=true\nAPP_KEY=\nDB_PASSWORD=secret'), { APP_ENV: 'production', APP_DEBUG: 'true', APP_KEY: '' });
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-sec-'));
  try {
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'artisan'), '<?php');
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^11.0' } }));
    fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=production\nAPP_DEBUG=true\nAPP_KEY=\n');
    fs.writeFileSync(path.join(dir, 'public', 'info.php'), '<?php phpinfo();');
    fs.writeFileSync(path.join(dir, 'public', 'backup.sql'), '--');
    const ids = sec.localChecks({ path: dir }).map((x) => x.id).sort();
    assert.deepStrictEqual(ids, ['BACKUP_PUBLIC', 'DEBUG_IN_PROD', 'NO_APP_KEY', 'PHPINFO_PUBLIC']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ QR

test('QR: encodes a share link with finder patterns and the right size', () => {
  const sandbox = { window: {}, TextEncoder };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'qr.js'), 'utf8'), sandbox);
  const q = sandbox.window.DP_QR.encode('https://quiet-river-bright-fox.trycloudflare.com');
  assert.strictEqual(q.size, q.version * 4 + 17);
  // finder pattern corners: dark ring, light ring, dark centre
  for (const [x, y] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
    assert.ok(q.dark(x, y) && q.dark(x + 6, y + 6) && q.dark(x + 3, y + 3));
    assert.ok(!q.dark(x + 1, y + 1) && !q.dark(x + 5, y + 1));
  }
  assert.ok(q.dark(8, q.size - 8)); // the always-dark module
  assert.strictEqual(sandbox.window.DP_QR.encode('x'.repeat(400)), null);
});
