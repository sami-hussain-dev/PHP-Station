'use strict';
/*
 * Shared helpers for the PHP Station integration tests.
 *
 * Safety: everything here only touches processes the tests start themselves (the panel child,
 * raw php servers) and folders created under the OS temp folder. Nothing in user projects,
 * no foreign PIDs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');

const TOOL_DIR = path.resolve(__dirname, '..');
const TMP_BASE = process.env.DEVPANEL_TEST_TMP || os.tmpdir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** New empty temp folder (outside the tool folder). */
function makeTempDir(prefix = 'dp-test-') {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_BASE, prefix));
}

/** Recursive delete with a few retries (Windows keeps handles open for a moment after exit). */
async function removeDir(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  // Hard guard: only delete inside the temp base, never the tool folder or anything else.
  const base = path.resolve(TMP_BASE).toLowerCase() + path.sep;
  if (!resolved.toLowerCase().startsWith(base)) throw new Error(`refusing to delete outside temp: ${resolved}`);
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 9) throw e;
      await sleep(500);
    }
  }
}

/** Raw HTTP request against 127.0.0.1:port -> {status, headers, text, data (parsed JSON or null)}. */
function request({ port, method = 'GET', urlPath = '/', headers = {}, body, rawBody, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    let payload = null;
    if (rawBody !== undefined) {
      payload = Buffer.from(String(rawBody));
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    }
    if (payload) h['Content-Length'] = String(payload.length);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout ${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** GET http://127.0.0.1:port/path -> {status, text}. */
function httpGetText(port, urlPath = '/', timeoutMs = 15000) {
  return request({ port, urlPath, timeoutMs });
}

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ port, host });
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= end) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

async function waitPortOpen(port, timeoutMs = 15000) {
  return waitFor(() => isPortOpen(port), { timeoutMs, what: `port ${port} to open` });
}

async function waitPortClosed(port, timeoutMs = 10000) {
  return waitFor(async () => !(await isPortOpen(port)), { timeoutMs, what: `port ${port} to close` });
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitPidGone(pid, timeoutMs = 10000) {
  return waitFor(() => !pidAlive(pid), { timeoutMs, what: `pid ${pid} to exit` });
}

/** Image name of a pid via tasklist (lower-case) or null. */
function processName(pid) {
  return new Promise((resolve) => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) { resolve(null); return; }
    execFile('tasklist.exe', ['/FI', `PID eq ${n}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = /^"([^"]+)","(\d+)"/m.exec(String(stdout));
      resolve(m && Number(m[2]) === n ? m[1].toLowerCase() : null);
    });
  });
}

/**
 * Last-resort cleanup for a pid the tests started (directly or through the panel). Kills only
 * when the pid is still alive and its image name is one of expectNames.
 */
async function killOwnPid(pid, expectNames = ['php.exe']) {
  if (!pidAlive(pid)) return false;
  const name = await processName(pid);
  if (!name || !expectNames.includes(name)) return false;
  await new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(Number(pid)), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
  return true;
}

/** netstat -ano listeners: [{port, pid}] (TCP LISTENING, IPv4 + IPv6). */
function netstatListeners() {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const out = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || !/^TCP/i.test(parts[0]) || !/^LISTEN/i.test(parts[3])) continue;
        const local = parts[1];
        const port = Number(local.slice(local.lastIndexOf(':') + 1));
        const pid = Number(parts[4]);
        if (Number.isInteger(port) && Number.isInteger(pid)) out.push({ port, pid });
      }
      // Also include IPv6 (netstat -p TCP shows IPv4 only on some builds).
      execFile('netstat.exe', ['-ano', '-p', 'TCPv6'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err2, stdout2) => {
        for (const line of String(stdout2 || '').split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5 || !/^TCP/i.test(parts[0]) || !/^LISTEN/i.test(parts[3])) continue;
          const local = parts[1];
          const port = Number(local.slice(local.lastIndexOf(':') + 1));
          const pid = Number(parts[4]);
          if (Number.isInteger(port) && Number.isInteger(pid)) out.push({ port, pid });
        }
        resolve(out);
      });
    });
  });
}

async function listenerPid(port) {
  const list = await netstatListeners();
  const hit = list.find((l) => l.port === port);
  return hit ? hit.pid : null;
}

/**
 * Starts `node server.js --serve --port <p> --data <dir> --no-open` (cwd = tool folder), waits for
 * /api/ping, reads the token from GET / and returns {port, token, pid, api, stop, output}.
 */
async function startPanel({ port, dataDir, timeoutMs = 30000, env = {} }) {
  if (await isPortOpen(port)) throw new Error(`port ${port} pehle se busy hai — test panel start nahi kiya`);
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['server.js', '--serve', '--port', String(port), '--data', dataDir, '--no-open'], {
    cwd: TOOL_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env, env, { DEVPANEL_DATA: dataDir }),
  });
  let output = '';
  const keep = (d) => {
    output += d.toString('utf8');
    if (output.length > 65536) output = output.slice(-65536);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  let exitCode = null;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      resolve(code);
    });
  });

  const end = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error(`panel exit ho gaya (code ${exitCode}) start hone se pehle:\n${output}`);
    try {
      const r = await request({ port, urlPath: '/api/ping', timeoutMs: 2000 });
      if (r.status === 200 && r.data && r.data.app === 'devpanel') break;
    } catch { /* not up yet */ }
    if (Date.now() >= end) {
      child.kill();
      throw new Error(`panel ${timeoutMs} ms me start nahi hua:\n${output}`);
    }
    await sleep(200);
  }

  const page = await request({ port, urlPath: '/', headers: { Accept: 'text/html' } });
  const m = /<meta[^>]*name=["']devpanel-token["'][^>]*content=["']([^"']+)["']/i.exec(page.text)
    || /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']devpanel-token["']/i.exec(page.text);
  if (!m || m[1] === '__DEVPANEL_TOKEN__') {
    child.kill();
    throw new Error('GET / me devpanel-token meta nahi mila');
  }
  const token = m[1];

  const api = async (method, urlPath, body) => {
    const headers = { 'X-DevPanel-Token': token, Accept: 'application/json' };
    const r = await request({ port, method, urlPath, headers, body: body === undefined && method === 'POST' ? {} : body });
    return r;
  };

  // Make sure we are talking to OUR child, not some other panel that owns the port.
  const st = await api('GET', '/api/state');
  if (!st.data || !st.data.panel || Number(st.data.panel.pid) !== child.pid) {
    child.kill();
    throw new Error(`port ${port} par koi aur panel jawab de raha hai (pid ${st.data && st.data.panel && st.data.panel.pid})`);
  }

  const stop = async () => {
    if (exited) return exitCode;
    try {
      await api('POST', '/api/shutdown', {});
    } catch { /* connection may drop while shutting down */ }
    const timer = sleep(10000).then(() => 'timeout');
    const res = await Promise.race([exitPromise, timer]);
    if (res === 'timeout' && !exited) {
      child.kill();
      await Promise.race([exitPromise, sleep(5000)]);
    }
    return exitCode;
  };

  return {
    port,
    token,
    pid: child.pid,
    dataDir,
    api,
    stop,
    output: () => output,
    exited: () => exited,
  };
}

/** GET /api/state -> state object (throws on HTTP errors). */
async function getState(api) {
  const r = await api('GET', '/api/state');
  if (r.status !== 200 || !r.data) throw new Error(`/api/state failed: ${r.status} ${r.text.slice(0, 300)}`);
  return r.data;
}

/** Polls GET /api/jobs/:id until the job is no longer running; returns the job. */
async function waitForJob(api, jobId, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await api('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
    const job = r.data && r.data.job;
    if (job && job.status !== 'running') return job;
    if (Date.now() >= end) {
      const steps = job && job.steps ? job.steps.map((s) => `[${s.level}] ${s.text}`).join('\n') : '';
      throw new Error(`job ${jobId} ${timeoutMs} ms me khatam nahi hua\n${steps}`);
    }
    await sleep(500);
  }
}

/** Human readable job log for assertion messages. */
function describeJob(job) {
  if (!job) return '(no job)';
  const steps = (job.steps || []).map((s) => `  [${s.level}] ${s.text}`).join('\n');
  return `job ${job.id} ${job.type} status=${job.status} error=${job.error || ''}\n${steps}`;
}

/** Waits until a runtime scan is finished (scannedAt set, scanning false); returns the state. */
async function waitForRuntimes(api, timeoutMs = 180000) {
  let st;
  await waitFor(async () => {
    st = await getState(api);
    return st.runtimes && !st.runtimes.scanning && st.runtimes.scannedAt ? st : null;
  }, { timeoutMs, intervalMs: 1000, what: 'runtime scan' });
  return st;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const VENDOR_ROUTER = [
  '<?php',
  '',
  '// Same behaviour as Laravel\'s Illuminate/Foundation/resources/server.php:',
  '// the public folder is the working directory of the php -S process.',
  '$publicPath = getcwd();',
  '',
  '$uri = urldecode(parse_url($_SERVER[\'REQUEST_URI\'] ?? \'\', PHP_URL_PATH) ?? \'\');',
  '',
  'if ($uri !== \'/\' && file_exists($publicPath.$uri)) {',
  '    return false;',
  '}',
  '',
  'require_once $publicPath.\'/index.php\';',
  '',
].join('\n');

const ROOT_ROUTER = [
  '<?php',
  '',
  '$uri = urldecode(parse_url($_SERVER[\'REQUEST_URI\'], PHP_URL_PATH));',
  '',
  'if ($uri !== \'/\' && file_exists(__DIR__.\'/public\'.$uri)) {',
  '    return false;',
  '}',
  '',
  'require_once __DIR__.\'/public/index.php\';',
  '',
].join('\n');

/**
 * Creates a fixture project in a new temp folder and returns its path.
 *   'plain'                 index.php printing PLAIN:<PHP_VERSION>
 *   'laravel-root-router'   artisan + root server.php + public/index.php printing L8:<PHP_VERSION>
 *   'laravel-vendor-router' artisan + composer.json/lock (Laravel 12, php ^8.2) + vendor router,
 *                           public/index.php printing L12:<PHP_VERSION>
 * opts.env: text for a .env file; opts.parent: folder to create the project in.
 */
function makeFixtureProject(kind, opts = {}) {
  const parent = opts.parent || makeTempDir('dp-fixture-');
  const name = opts.name || `fx-${kind}`;
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  switch (kind) {
    case 'plain':
      write(path.join(dir, 'index.php'), "<?php\necho 'PLAIN:' . PHP_VERSION;\n");
      break;
    case 'laravel-root-router':
      write(path.join(dir, 'artisan'), "#!/usr/bin/env php\n<?php\n// fixture artisan (fake)\necho 'fake artisan';\n");
      write(path.join(dir, 'server.php'), ROOT_ROUTER);
      write(path.join(dir, 'public', 'index.php'), "<?php\necho 'L8:' . PHP_VERSION;\n");
      write(path.join(dir, 'composer.json'), JSON.stringify({
        name: 'fixture/l8',
        require: { php: '^7.3|^8.0', 'laravel/framework': '^8.75', 'ext-json': '*' },
      }, null, 4));
      write(path.join(dir, 'composer.lock'), JSON.stringify({
        packages: [{ name: 'laravel/framework', version: 'v8.83.27' }],
        'packages-dev': [],
      }, null, 4));
      break;
    case 'laravel-vendor-router':
      write(path.join(dir, 'artisan'), "#!/usr/bin/env php\n<?php\n// fixture artisan (fake)\necho 'fake artisan';\n");
      write(path.join(dir, 'public', 'index.php'), "<?php\necho 'L12:' . PHP_VERSION;\n");
      write(path.join(dir, 'composer.json'), JSON.stringify({
        name: 'fixture/l12',
        require: { php: '^8.2', 'laravel/framework': '^12.0' },
      }, null, 4));
      write(path.join(dir, 'composer.lock'), JSON.stringify({
        packages: [{ name: 'laravel/framework', version: 'v12.1.0' }],
        'packages-dev': [],
      }, null, 4));
      write(path.join(dir, 'vendor', 'composer', 'installed.json'), JSON.stringify({
        packages: [{ name: 'laravel/framework', version: 'v12.1.0', version_normalized: '12.1.0.0' }],
        dev: true,
      }, null, 4));
      write(path.join(dir, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Foundation', 'resources', 'server.php'), VENDOR_ROUTER);
      break;
    default:
      throw new Error(`unknown fixture kind: ${kind}`);
  }
  if (opts.env !== undefined) write(path.join(dir, '.env'), opts.env);
  return dir;
}

/** Same path check as the panel uses (case-insensitive, slash-agnostic, no trailing slash). */
function samePath(a, b) {
  const n = (p) => path.win32.normalize(String(p || '').replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();
  return !!a && !!b && n(a) === n(b);
}

// ------------------------------------------------------------------------------------------ zip + https fixtures

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Minimal zip writer (stored entries) for fixtures. entries: [{name, data?, unixMode?}] —
 * a name ending in "/" is a folder; unixMode (e.g. 0o120777 = symlink) marks a Unix entry.
 */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data == null ? Buffer.alloc(0) : Buffer.from(e.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.unixMode ? (3 << 8) | 20 : 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.unixMode ? (e.unixMode * 65536) >>> 0 : (e.name.endsWith('/') ? 0x10 : 0), 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

/** Test-only certificate for https://127.0.0.1 (self-signed; never used by PHP Station itself). */
function testTls() {
  return {
    cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'test-localhost-cert.pem'), 'utf8'),
    key: fs.readFileSync(path.join(__dirname, 'fixtures', 'test-localhost-key.pem'), 'utf8'),
  };
}

/**
 * HTTPS fixture server on 127.0.0.1:port. Requests arrive as /<profile>/<host><path> (see
 * rewriteTo). handler(profile, officialUrl, req, res) answers; every request is recorded.
 */
async function startHttpsFixture({ port, handler }) {
  const https = require('https');
  const tls = testTls();
  const requests = [];
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    const m = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(req.url);
    if (!m) { res.writeHead(404); res.end('no'); return; }
    const official = `https://${m[2]}${m[3] || '/'}`;
    requests.push({ profile: m[1], method: req.method, url: official });
    try {
      handler(m[1], official, req, res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e && e.message));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    ca: tls.cert,
    requests,
    rewriteTo: (profile) => (u) => {
      const x = new URL(u);
      return `https://127.0.0.1:${port}/${profile}/${x.host}${x.pathname}${x.search}`;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Sends a body (Buffer/string/object as JSON) with Content-Length. */
function sendFixture(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, Object.assign({ 'Content-Length': buf.length }, headers));
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(buf);
}

module.exports = {
  TOOL_DIR,
  TMP_BASE,
  sleep,
  makeTempDir,
  removeDir,
  request,
  httpGetText,
  isPortOpen,
  waitFor,
  waitPortOpen,
  waitPortClosed,
  pidAlive,
  waitPidGone,
  processName,
  killOwnPid,
  netstatListeners,
  listenerPid,
  startPanel,
  getState,
  waitForJob,
  describeJob,
  waitForRuntimes,
  makeFixtureProject,
  samePath,
  crc32,
  makeZip,
  testTls,
  startHttpsFixture,
  sendFixture,
};
