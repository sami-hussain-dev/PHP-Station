'use strict';
/*
 * Unit tests for the PURE parts of PHP Station (no servers, no network, no user files).
 * Run: node --test tests/
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lazy loading keeps one missing/broken module from hiding the results of the others.
const loaded = {};
function load(name) {
  if (!loaded[name]) loaded[name] = require(path.join(__dirname, '..', 'lib', name));
  return loaded[name];
}

after(() => {
  // procs.js may hold a PowerShell helper if something started it; make sure the process can exit.
  if (loaded['procs.js'] && typeof loaded['procs.js'].stopHelper === 'function') {
    try { loaded['procs.js'].stopHelper(); } catch { /* ignore */ }
  }
});

const lc = (p) => path.win32.normalize(String(p).replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();

// ------------------------------------------------------------------------------------------ semver
describe('semver', () => {
  const S = () => load('semver.js');

  it('normalizeVersion', () => {
    const { normalizeVersion } = S();
    assert.deepEqual(normalizeVersion('8.5.9'), [8, 5, 9]);
    assert.deepEqual(normalizeVersion('v13.40.0'), [13, 40, 0]);
    assert.deepEqual(normalizeVersion('8.2'), [8, 2, 0]);
    assert.deepEqual(normalizeVersion('8'), [8, 0, 0]);
    assert.equal(normalizeVersion('abc'), null);
    assert.equal(normalizeVersion(''), null);
  });

  it('compare', () => {
    const { compare } = S();
    assert.equal(compare('8.2.12', '8.10.0'), -1);
    assert.equal(compare('8.5.9', '8.5.8'), 1);
    assert.equal(compare('8.2.0', '8.2'), 0);
    assert.equal(compare('v12.1.0', '12.1.0'), 0);
    assert.equal(compare('7.4.33', '8.0.3'), -1);
  });

  const cases = [
    ['8.5.9', '^8.2', true],
    ['8.5.9', '^7.3|^8.0', true],
    ['8.5.9', '^7.3 || ^8.0', true],
    ['7.2.0', '^7.3|^8.0', false],
    ['8.0.3', '^8.0.2', true],
    ['8.0.1', '^8.0.2', false],
    ['9.0.0', '^8.0.2', false],
    ['8.5.9', '>=5.2.4', true],
    ['5.2.3', '>=5.2.4', false],
    ['8.3.0', '~8.1', true],
    ['9.0.0', '~8.1', false],
    ['8.2.0', '~8.1.0', false],
    ['8.1.9', '~8.1.0', true],
    ['8.1.2', '~8.1.2', true],
    ['8.1.1', '~8.1.2', false],
    ['8.4.1', '8.*', true],
    ['9.0.0', '8.*', false],
    ['8.2.12', '8.x', true],
    ['7.4.33', '8.x', false],
    ['8.5.9', '*', true],
    ['7.4.33', '>=7.2 <8.0', true],
    ['8.0.0', '>=7.2 <8.0', false],
    ['7.1.9', '>=7.2 <8.0', false],
    ['7.4.33', '>=7.2,<8.0', true],
    ['8.0.3', '7.4 - 8.1', true],
    ['8.1.27', '7.4 - 8.1', true],
    ['8.2.0', '7.4 - 8.1', false],
    ['7.3.9', '7.4 - 8.1', false],
    ['8.1.5', '7.4 - 8.1.5', true],
    ['8.1.6', '7.4 - 8.1.5', false],
    ['8.2.12', '^8.3', false],
    ['8.3.30', '^8.3', true],
    ['8.2.12', '8.2', true],
    ['8.3.0', '8.2', false],
    ['8.2.12', '=8.2.12', true],
    ['8.2.11', '8.2.12', false],
    ['0.3.5', '^0.3', true],
    ['0.4.0', '^0.3', false],
    ['8.1.0', '!=8.1.0', false],
    ['8.1.1', '!=8.1.0', true],
    ['8.1.0', '>8.1.0', false],
    ['8.1.1', '>8.1.0', true],
    ['8.1.0', '<8.1.0', false],
    ['8.0.30', '<=8.1.0', true],
    ['8.2.5', '^8.2@dev', true],
    ['8.2.0', '>=8.2.0-RC1', true],
    ['v8.2.12', '^8.2', true],
    ['8.2.12', '>=8.1 <8.3 || ^7.4', true],
    ['8.3.1', '>=8.1 <8.3 || ^7.4', false],
    ['7.4.10', '>=8.1 <8.3 || ^7.4', true],
    ['8.5.9', 'garbage', null],
    ['8.5.9', 'not a version', null],
  ];
  for (const [version, constraint, expected] of cases) {
    it(`satisfies(${version}, "${constraint}") === ${expected}`, () => {
      assert.equal(S().satisfies(version, constraint), expected);
    });
  }
});

// ------------------------------------------------------------------------------------------ ini
describe('ini (php.ini)', () => {
  const I = () => load('ini.js');
  const HOME = 'D:\\Xampp-8.2\\php';
  const TO = 'D:\\Xampp-8.2\\php8.2';
  const PHP82_INI = [
    '[PHP]',
    'engine=On',
    ';extension_dir = "ext"',
    'extension_dir = "D:\\Xampp-8.2\\php\\ext"',
    'include_path=".;D:\\Xampp-8.2\\php\\PEAR"',
    'error_log="D:\\Xampp-8.2\\php\\logs\\php_error_log"',
    'upload_tmp_dir="D:\\Xampp-8.2\\tmp"',
    'curl.cainfo = "D:/Xampp-8.2/php/extras/ssl/cacert.pem"',
    'openssl.cafile=d:\\xampp-8.2\\PHP\\extras\\ssl\\cacert.pem',
    'browscap="D:\\Xampp-8.2\\php8.2\\extras\\browscap.ini"',
    'doc_root=D:\\Xampp-8.2\\php',
    "user_dir='D:\\Xampp-8.2\\php'",
    'sys_temp_dir=D:\\Xampp-8.2\\php ; trailing comment',
    'extension=D:\\Xampp-8.2\\phpmyadmin\\fake.dll',
    '',
  ].join('\r\n');

  it('parseIniValue', () => {
    const { parseIniValue } = I();
    assert.equal(parseIniValue('"D:\\x\\ext"'), 'D:\\x\\ext');
    assert.equal(parseIniValue("'abc'"), 'abc');
    assert.equal(parseIniValue('On ; comment'), 'On');
    assert.equal(parseIniValue('"a;b" ; c'), 'a;b');
    assert.equal(parseIniValue('  128M  '), '128M');
  });

  it('getPhpIniValue returns the last non-commented value', () => {
    const { getPhpIniValue } = I();
    assert.equal(getPhpIniValue(PHP82_INI, 'extension_dir'), 'D:\\Xampp-8.2\\php\\ext');
    assert.equal(getPhpIniValue('a=1\n;a=2\na = 3\n', 'a'), '3');
    assert.equal(getPhpIniValue('memory_limit=1G\n', 'missing'), null);
    assert.equal(getPhpIniValue(';memory_limit=1G\n', 'memory_limit'), null);
  });

  it('detectIniHome', () => {
    const { detectIniHome } = I();
    assert.equal(detectIniHome(PHP82_INI, TO), HOME);
    assert.equal(detectIniHome('extension_dir="C:/php/ext"\n', 'C:\\php'), 'C:/php');
    assert.equal(detectIniHome('extension_dir = "ext"\n', 'C:\\php'), null);
    assert.equal(detectIniHome('memory_limit=1G\n', 'C:\\php'), null);
    assert.equal(detectIniHome(';extension_dir="C:\\x\\ext"\n', 'C:\\x'), null);
    assert.equal(detectIniHome('extension_dir="C:\\php\\extensions"\n', 'C:\\php'), null);
  });

  it('relocatePhpIni: php8.2 case incl. the prefix trap', () => {
    const { relocatePhpIni } = I();
    const out = relocatePhpIni(PHP82_INI, HOME, TO, `${TO}\\php.ini`);
    const lines = out.split(/\r?\n/);
    assert.match(lines[0], /^; generated by PHP Station from /);
    assert.ok(lines[0].includes(`${TO}\\php.ini`), 'header names the source path');
    assert.ok(lines[0].includes(`(relocated ${HOME} -> ${TO})`), 'header names from -> to');
    const body = lines.slice(1).join('\n');

    assert.ok(body.includes('extension_dir = "D:\\Xampp-8.2\\php8.2\\ext"'));
    assert.ok(body.includes('include_path=".;D:\\Xampp-8.2\\php8.2\\PEAR"'));
    assert.ok(body.includes('error_log="D:\\Xampp-8.2\\php8.2\\logs\\php_error_log"'));
    // forward slashes keep their style
    assert.ok(body.includes('curl.cainfo = "D:/Xampp-8.2/php8.2/extras/ssl/cacert.pem"'));
    // case-insensitive match
    assert.ok(/openssl\.cafile=D:\\Xampp-8\.2\\php8\.2\\extras\\ssl\\cacert\.pem/i.test(body));
    // end of line / quotes / ";" are boundaries
    assert.ok(body.includes('doc_root=D:\\Xampp-8.2\\php8.2'));
    assert.ok(body.includes("user_dir='D:\\Xampp-8.2\\php8.2'"));
    assert.ok(body.includes('sys_temp_dir=D:\\Xampp-8.2\\php8.2 ; trailing comment'));
    // THE TRAP: an existing php8.2 path must stay exactly as it is (no "php8.28.2")
    assert.ok(body.includes('browscap="D:\\Xampp-8.2\\php8.2\\extras\\browscap.ini"'));
    assert.ok(!body.includes('php8.28.2'));
    // longer folder names starting with "php" are not touched
    assert.ok(body.includes('extension=D:\\Xampp-8.2\\phpmyadmin\\fake.dll'));
    // unrelated folders untouched
    assert.ok(body.includes('upload_tmp_dir="D:\\Xampp-8.2\\tmp"'));
    // no stale reference to the old home with a boundary remains
    assert.ok(!/D:[\\/]Xampp 8\.2\.12[\\/]php(?=[\\/"'\s;]|$)/im.test(body));
  });

  it('relocatePhpIni: running it twice never doubles the suffix', () => {
    const { relocatePhpIni } = I();
    const once = relocatePhpIni(PHP82_INI, HOME, TO);
    const twice = relocatePhpIni(once, HOME, TO);
    assert.ok(!twice.includes('php8.28.2'));
    assert.ok(twice.includes('extension_dir = "D:\\Xampp-8.2\\php8.2\\ext"'));
  });

  it('relocatePhpIni: forward-slash fromHome and LF text', () => {
    const { relocatePhpIni } = I();
    const text = 'extension_dir="C:/tools/php/ext"\nerror_log=C:\\tools\\php\\err.log\nx=C:/tools/php-old/ext\n';
    const out = relocatePhpIni(text, 'C:/tools/php', 'E:\\php82');
    assert.match(out, /^; generated by PHP Station from /);
    assert.ok(out.includes('extension_dir="E:/php82/ext"'));
    assert.ok(out.includes('error_log=E:\\php82\\err.log'));
    assert.ok(out.includes('x=C:/tools/php-old/ext'));
  });
});

// ------------------------------------------------------------------------------------------ my.ini
describe('ini (my.ini)', () => {
  const I = () => load('ini.js');

  it('XAMPP style: quoted values, relative log_error, client section ignored', () => {
    const text = [
      '[client]',
      'port=3306',
      'socket="C:/xampp/mysql/mysql.sock"',
      '',
      '[mysqld]',
      'port= 3307',
      'basedir="D:/Xampp-8.2/mysql"',
      'datadir="D:/Xampp-8.2/mysql/data"',
      'log_error="mysql_error.log"',
      'bind-address = 127.0.0.1 # local only',
      '',
      '[mysqldump]',
      'port=9999',
    ].join('\r\n');
    const r = I().parseMyIni(text, 'D:\\Xampp-8.2\\mysql\\bin\\my.ini');
    assert.equal(r.port, 3307);
    assert.equal(lc(r.datadir), lc('D:\\Xampp-8.2\\mysql\\data'));
    assert.ok(!r.datadir.includes('/'), 'datadir uses backslashes');
    assert.equal(lc(r.basedir), lc('D:\\Xampp-8.2\\mysql'));
    assert.equal(lc(r.logError), lc('D:\\Xampp-8.2\\mysql\\data\\mysql_error.log'));
    assert.equal(r.bindAddress, '127.0.0.1');
  });

  it('relative datadir resolves against the ini folder, or basedir when set', () => {
    const { parseMyIni } = I();
    const a = parseMyIni('[mysqld]\ndatadir=data\nport=3391\n', 'C:\\temp\\inst\\my.ini');
    assert.equal(lc(a.datadir), lc('C:\\temp\\inst\\data'));
    assert.equal(a.port, 3391);
    const b = parseMyIni('[mysqld]\nbasedir=C:/maria\ndatadir=data\n', 'C:\\temp\\inst\\my.ini');
    assert.equal(lc(b.datadir), lc('C:\\maria\\data'));
  });

  it('dash/underscore keys and multiple sections (later wins)', () => {
    const text = [
      '[mysqld]',
      'port=3306',
      'log-error=C:/logs/a.err',
      'bind_address=0.0.0.0',
      '[server]',
      'datadir=C:/srv/data',
      '[mariadb]',
      'port=3392',
      'bind-address=127.0.0.1',
    ].join('\n');
    const r = I().parseMyIni(text, 'C:\\srv\\my.ini');
    assert.equal(r.port, 3392);
    assert.equal(lc(r.logError), lc('C:\\logs\\a.err'));
    assert.equal(lc(r.datadir), lc('C:\\srv\\data'));
    assert.equal(r.bindAddress, '127.0.0.1');
  });

  it('missing values are null', () => {
    const r = I().parseMyIni('[client]\nport=3306\n', 'C:\\x\\my.ini');
    assert.deepEqual(r, { port: null, datadir: null, basedir: null, logError: null, bindAddress: null });
  });
});

// ------------------------------------------------------------------------------------------ envfile
describe('envfile', () => {
  const E = () => load('envfile.js');
  const ENV = [
    'APP_NAME="Darul Madina"',
    'APP_ENV=local',
    '# comment line',
    'export APP_DEBUG=true',
    'DB_CONNECTION=mysql',
    'DB_HOST=127.0.0.1',
    'DB_PORT=3307',
    'DB_DATABASE=shop_db # inline comment',
    "DB_USERNAME='root'",
    'DB_PASSWORD="p#ss word"',
    'EMPTY=',
    'DB_PORT=9999',
    '',
  ].join('\r\n');

  it('parseEnv: quotes, export, inline comments, CRLF', () => {
    const env = E().parseEnv(ENV);
    assert.equal(env.APP_NAME, 'Darul Madina');
    assert.equal(env.APP_ENV, 'local');
    assert.equal(env.APP_DEBUG, 'true');
    assert.equal(env.DB_HOST, '127.0.0.1');
    assert.equal(env.DB_DATABASE, 'shop_db');
    assert.equal(env.DB_USERNAME, 'root');
    assert.equal(env.DB_PASSWORD, 'p#ss word');
    assert.equal(env.EMPTY, '');
    assert.ok(!Object.keys(env).some((k) => k.includes('#')));
    for (const v of Object.values(env)) assert.ok(!v.endsWith('\r'), 'no CR left in values');
  });

  it('setEnvValues: only the first DB_PORT line changes, CRLF preserved', () => {
    const out = E().setEnvValues(ENV, { DB_PORT: 3392 });
    const before = ENV.split('\r\n');
    const after = out.split('\r\n');
    assert.equal(after.length, before.length);
    const changed = before.map((l, i) => (l !== after[i] ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(changed, [6]);
    assert.equal(after[6], 'DB_PORT=3392');
    assert.equal(after[11], 'DB_PORT=9999', 'second occurrence untouched');
    assert.ok(!/[^\r]\n/.test(out), 'no bare LF introduced');
  });

  it('setEnvValues: appends missing keys, keeps LF style, keeps export prefix', () => {
    const text = 'export DB_HOST=localhost\nDB_PORT=3306';
    const out = E().setEnvValues(text, { DB_HOST: '127.0.0.1', DB_DATABASE: 'dp_moved' });
    assert.equal(out, 'export DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=dp_moved\n');
    const parsed = E().parseEnv(out);
    assert.equal(parsed.DB_DATABASE, 'dp_moved');
    assert.equal(parsed.DB_HOST, '127.0.0.1');
  });

  it('setEnvValues: values with spaces are quoted and round-trip', () => {
    const out = E().setEnvValues('APP_NAME=x\n', { APP_NAME: 'Dar ul Madina' });
    assert.equal(E().parseEnv(out).APP_NAME, 'Dar ul Madina');
  });
});

// ------------------------------------------------------------------------------------------ ports
describe('ports.pickPort', () => {
  const P = () => load('ports.js');
  it('preferred when free', () => {
    assert.equal(P().pickPort({ from: 8000, to: 8010, preferred: 8005, reserved: new Set(), busy: new Set() }), 8005);
  });
  it('lowest free when preferred is reserved or busy', () => {
    assert.equal(P().pickPort({ from: 8000, to: 8010, preferred: 8005, reserved: new Set([8005, 8000]), busy: new Set([8001]) }), 8002);
    assert.equal(P().pickPort({ from: 8000, to: 8010, preferred: 8003, reserved: [8000], busy: [8003, 8001] }), 8002);
  });
  it('preferred outside the range is ignored', () => {
    assert.equal(P().pickPort({ from: 8890, to: 8899, preferred: 8085, reserved: [], busy: [] }), 8890);
  });
  it('null when everything is taken', () => {
    assert.equal(P().pickPort({ from: 3391, to: 3392, preferred: null, reserved: new Set([3391]), busy: new Set([3392]) }), null);
  });
  it('no preferred', () => {
    assert.equal(P().pickPort({ from: 3310, to: 3399, reserved: new Set([3310]), busy: new Set() }), 3311);
  });
});

// ------------------------------------------------------------------------------------------ procs (pure)
const PHP_XAMPP = 'D:\\Xampp-8.2\\php\\php.exe';
const KIT_CMD = '"D:\\Xampp-8.2\\php\\php.exe" "D:\\dev-tools\\php-kit\\kit.php" serve D:\\Xampp8\\htdocs\\blog-app 8086';
const ARTISAN_8086_CMD = '"D:\\Xampp-8.2\\php\\php.exe" "artisan" "serve" "--host=127.0.0.1" "--port=8086"';
const SERVER_8086_CMD = '"D:\\Xampp-8.2\\php\\php.exe" -S 127.0.0.1:8086 D:\\Xampp8\\htdocs\\blog-app\\server.php';
const ARTISAN_8085_CMD = '"D:\\Xampp-8.2\\php\\php.exe" artisan serve --host=127.0.0.1 --port=8085 --no-ansi';
const SERVER_8085_CMD = '"D:\\Xampp-8.2\\php\\php.exe" -S 127.0.0.1:8085 D:\\Xampp8\\htdocs\\crm-panel\\server.php';

describe('procs (pure)', () => {
  const PR = () => load('procs.js');

  it('parseNetstat: IPv4 + IPv6 LISTENING only', () => {
    const text = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:8085         0.0.0.0:0              LISTENING       5001',
      '  TCP    127.0.0.1:8085         127.0.0.1:50123        ESTABLISHED     5001',
      '  TCP    127.0.0.1:50123        127.0.0.1:8085         TIME_WAIT       0',
      '  TCP    [::]:3308              [::]:0                 LISTENING       4444',
      '  TCP    [::1]:3307             [::]:0                 LISTENING       17484',
      '  UDP    0.0.0.0:500            *:*                                    3333',
      '  UDP    [::]:500               *:*                                    3333',
      '',
    ].join('\r\n');
    const list = PR().parseNetstat(text);
    assert.equal(list.length, 4);
    const by = (port) => list.find((l) => l.port === port);
    assert.deepEqual([by(135).pid, by(8085).pid, by(3308).pid, by(3307).pid], [1234, 5001, 4444, 17484]);
    assert.equal(by(8085).address, '127.0.0.1');
    assert.ok(by(3308).address.includes('::'), 'IPv6 address kept');
    for (const l of list) {
      assert.match(l.proto, /tcp/i);
      assert.equal(typeof l.port, 'number');
      assert.equal(typeof l.pid, 'number');
    }
  });

  it('splitCommandLine: MSVCRT rules', () => {
    const { splitCommandLine } = PR();
    assert.deepEqual(splitCommandLine(SERVER_8085_CMD), [
      PHP_XAMPP, '-S', '127.0.0.1:8085', 'D:\\Xampp8\\htdocs\\crm-panel\\server.php',
    ]);
    assert.deepEqual(splitCommandLine(ARTISAN_8086_CMD), [PHP_XAMPP, 'artisan', 'serve', '--host=127.0.0.1', '--port=8086']);
    assert.deepEqual(splitCommandLine('a "b c" d'), ['a', 'b c', 'd']);
    assert.deepEqual(splitCommandLine('x "a\\"b"'), ['x', 'a"b']);
    assert.deepEqual(splitCommandLine('x "C:\\path\\\\"'), ['x', 'C:\\path\\']);
    assert.deepEqual(splitCommandLine('x a\\\\b'), ['x', 'a\\\\b']);
    assert.deepEqual(splitCommandLine('x --defaults-file="d:\\xampp-8.2\\mysql\\bin\\my.ini" --standalone'),
      ['x', '--defaults-file=d:\\xampp-8.2\\mysql\\bin\\my.ini', '--standalone']);
    assert.deepEqual(splitCommandLine(''), []);
  });

  const processes = [
    { pid: 9001, ppid: 100, name: 'php.exe', cmd: KIT_CMD, exe: PHP_XAMPP },
    { pid: 9002, ppid: 9001, name: 'php.exe', cmd: ARTISAN_8086_CMD, exe: PHP_XAMPP },
    { pid: 9003, ppid: 9002, name: 'php.exe', cmd: SERVER_8086_CMD, exe: PHP_XAMPP },
    { pid: 8001, ppid: 50, name: 'php.exe', cmd: ARTISAN_8085_CMD, exe: PHP_XAMPP },
    { pid: 8002, ppid: 8001, name: 'php.exe', cmd: SERVER_8085_CMD, exe: PHP_XAMPP },
    {
      pid: 7001, ppid: 1, name: 'php.exe', exe: null,
      cmd: '"C:\\laragon\\bin\\php\\php-8.3.30-Win32-vs16-x64\\php.exe" -S 127.0.0.1:8890 -t C:\\laragon\\www\\app12\\public C:\\laragon\\www\\app12\\vendor\\laravel\\framework\\src\\Illuminate\\Foundation\\resources\\server.php',
    },
    { pid: 7002, ppid: 1, name: 'php.exe', exe: 'C:\\xampp 8\\php\\php.exe', cmd: '"C:\\xampp 8\\php\\php.exe" -S localhost:8891 -t "D:\\Sites\\plain\\public"' },
    { pid: 7003, ppid: 1, name: 'php.exe', exe: 'C:\\xampp 8\\php\\php.exe', cmd: '"C:\\xampp 8\\php\\php.exe" -S 127.0.0.1:8892 -t D:\\Sites\\plain2' },
    { pid: 7004, ppid: 8001, name: 'php.exe', exe: PHP_XAMPP, cmd: '"D:\\Xampp-8.2\\php\\php.exe" artisan queue:work' },
    { pid: 17484, ppid: 1, name: 'mysqld.exe', exe: 'd:\\xampp-8.2\\mysql\\bin\\mysqld.exe', cmd: '"d:\\xampp-8.2\\mysql\\bin\\mysqld.exe" --defaults-file="d:\\xampp-8.2\\mysql\\bin\\my.ini" --standalone' },
    { pid: 6000, ppid: 1, name: 'node.exe', exe: 'C:\\nvm4w\\nodejs\\node.exe', cmd: 'node server.js --serve' },
  ];
  const listeners = [
    { proto: 'TCP', address: '127.0.0.1', port: 8085, pid: 8002 },
    { proto: 'TCP', address: '127.0.0.1', port: 8086, pid: 9003 },
    { proto: 'TCP', address: '127.0.0.1', port: 8890, pid: 7001 },
    { proto: 'TCP', address: '127.0.0.1', port: 8891, pid: 7002 },
    { proto: 'TCP', address: '127.0.0.1', port: 8892, pid: 7003 },
    { proto: 'TCP', address: '0.0.0.0', port: 3307, pid: 17484 },
  ];

  it('deriveExternalPhpServers: the user\'s real 8085/8086 chains', () => {
    const list = PR().deriveExternalPhpServers(processes, listeners);
    const s8086 = list.find((x) => x.port === 8086);
    const s8085 = list.find((x) => x.port === 8085);
    assert.ok(s8086 && s8085);
    // kit -> artisan -> php -S
    assert.equal(s8086.pid, 9003);
    assert.equal(s8086.topPid, 9001);
    assert.equal(s8086.via, 'kit serve');
    assert.equal(s8086.host, '127.0.0.1');
    assert.equal(lc(s8086.projectPath), lc('D:\\Xampp8\\htdocs\\blog-app'));
    assert.equal(lc(s8086.router), lc('D:\\Xampp8\\htdocs\\blog-app\\server.php'));
    assert.equal(lc(s8086.phpPath), lc(PHP_XAMPP));
    assert.equal(s8086.docroot, null);
    // artisan -> php -S
    assert.equal(s8085.pid, 8002);
    assert.equal(s8085.topPid, 8001);
    assert.equal(s8085.via, 'artisan serve');
    assert.equal(lc(s8085.projectPath), lc('D:\\Xampp8\\htdocs\\crm-panel'));
  });

  it('deriveExternalPhpServers: vendor router, -t public, -t folder, non-server php ignored', () => {
    const list = PR().deriveExternalPhpServers(processes, listeners);
    assert.equal(list.length, 5, 'only php -S processes');
    assert.ok(!list.some((x) => x.pid === 7004 || x.pid === 9001 || x.pid === 9002 || x.pid === 8001));

    const v = list.find((x) => x.port === 8890);
    assert.equal(v.pid, 7001);
    assert.equal(v.topPid, 7001);
    assert.equal(v.via, 'php -S');
    assert.equal(lc(v.projectPath), lc('C:\\laragon\\www\\app12'));
    assert.equal(lc(v.docroot), lc('C:\\laragon\\www\\app12\\public'));
    assert.equal(lc(v.phpPath), lc('C:\\laragon\\bin\\php\\php-8.3.30-Win32-vs16-x64\\php.exe'), 'argv[0] when exe is unknown');

    const pub = list.find((x) => x.port === 8891);
    assert.equal(pub.host, 'localhost');
    assert.equal(pub.router, null);
    assert.equal(lc(pub.projectPath), lc('D:\\Sites\\plain'));
    assert.equal(pub.via, 'php -S');

    const plain = list.find((x) => x.port === 8892);
    assert.equal(lc(plain.projectPath), lc('D:\\Sites\\plain2'));
    for (const x of list) assert.equal(typeof x.port, 'number');
  });
});

// ------------------------------------------------------------------------------------------ dbservers.matchDbProcess
describe('dbservers.matchDbProcess (port-based)', () => {
  const D = () => load('dbservers.js');
  const XAMPP_BIN = 'D:\\Xampp-8.2\\mysql\\bin';
  const TEMP_INI = 'C:\\Users\\tester\\AppData\\Local\\Temp\\dp-db-abc\\db\\dp-test-a\\data\\my.ini';
  const xamppEntry = {
    id: 'db-mariadb-10.4.32-aaaaaa', kind: 'mariadb', version: '10.4.32', binDir: XAMPP_BIN,
    serverExe: `${XAMPP_BIN}\\mysqld.exe`, defaultsFile: 'D:\\Xampp-8.2\\mysql\\bin\\my.ini',
    port: 3307, effectivePort: 3307, created: false,
  };
  const tempEntry = {
    id: 'dbi-dp-test-a', kind: 'mariadb', version: '10.4.32', binDir: XAMPP_BIN,
    serverExe: `${XAMPP_BIN}\\mysqld.exe`, defaultsFile: TEMP_INI, port: 3391, effectivePort: 3391, created: true,
  };
  const LARAGON_BIN = 'C:\\laragon\\bin\\mysql\\mariadb-12.3.3-winx64\\bin';
  const laragonEntry = {
    id: 'db-mariadb-12.3.3-bbbbbb', kind: 'mariadb', version: '12.3.3', binDir: LARAGON_BIN,
    serverExe: `${LARAGON_BIN}\\mariadbd.exe`, defaultsFile: 'C:\\laragon\\bin\\mysql\\mariadb-12.3.3-winx64\\my.ini',
    port: 3308, effectivePort: 3308, created: false,
  };
  const xamppProc = {
    pid: 17484, ppid: 1, name: 'mysqld.exe', exe: 'd:\\xampp-8.2\\mysql\\bin\\mysqld.exe',
    cmd: '"d:\\xampp-8.2\\mysql\\bin\\mysqld.exe" --defaults-file="d:\\xampp-8.2\\mysql\\bin\\my.ini" --standalone',
  };
  const elevatedProc = { pid: 5555, ppid: 1, name: 'mariadbd.exe', exe: null, cmd: null };
  const tempProc = {
    pid: 7777, ppid: 6000, name: 'mysqld.exe', exe: `${XAMPP_BIN}\\mysqld.exe`,
    cmd: `"${XAMPP_BIN}\\mysqld.exe" "--defaults-file=${TEMP_INI}" --bind-address=127.0.0.1`,
  };
  const L = (port, pid, address = '0.0.0.0') => ({ proto: 'TCP', address, port, pid });
  const baseListeners = [L(3307, 17484), L(3307, 17484, '::'), L(3308, 5555), L(3308, 5555, '::')];
  const pidOf = (r) => (r ? Number(r.pid) : null);

  it('XAMPP 3307 process matches the XAMPP entry, not the temp entry from the same bin', () => {
    const { matchDbProcess } = D();
    const procs = [xamppProc, elevatedProc];
    assert.equal(pidOf(matchDbProcess(xamppEntry, procs, baseListeners)), 17484);
    assert.equal(matchDbProcess(tempEntry, procs, baseListeners), null);
  });

  it('elevated process (exe/cmd unknown) on 3308 matches the Laragon 12.3.3 entry', () => {
    const { matchDbProcess } = D();
    assert.equal(pidOf(matchDbProcess(laragonEntry, [xamppProc, elevatedProc], baseListeners)), 5555);
  });

  it('with the temp instance running, each entry gets its own process', () => {
    const { matchDbProcess } = D();
    const procs = [xamppProc, elevatedProc, tempProc];
    const listeners = baseListeners.concat([L(3391, 7777, '127.0.0.1')]);
    assert.equal(pidOf(matchDbProcess(tempEntry, procs, listeners)), 7777);
    assert.equal(pidOf(matchDbProcess(xamppEntry, procs, listeners)), 17484);
    assert.equal(pidOf(matchDbProcess(laragonEntry, procs, listeners)), 5555);
  });

  it('never matches by exe path alone', () => {
    const { matchDbProcess } = D();
    // XAMPP process present but not listening anywhere
    assert.equal(matchDbProcess(xamppEntry, [xamppProc], []), null);
    // listening on another port
    assert.equal(matchDbProcess(xamppEntry, [xamppProc], [L(3399, 17484)]), null);
    // temp process (same bin) not listening yet
    assert.equal(matchDbProcess(tempEntry, [xamppProc, tempProc], baseListeners), null);
  });

  it('a different --defaults-file or an exe outside binDir does not match', () => {
    const { matchDbProcess } = D();
    // temp-instance command line listening on 3307 (hypothetical) must not be taken for XAMPP
    const wrongIni = Object.assign({}, tempProc, { pid: 8888 });
    assert.equal(matchDbProcess(xamppEntry, [wrongIni], [L(3307, 8888)]), null);
    // 12.3.2 server listening on 3308 must not be taken for the 12.3.3 entry
    const other = {
      pid: 4321, ppid: 1, name: 'mysqld.exe', exe: 'C:\\laragon\\bin\\mysql\\mariadb-12.3.2-winx64\\bin\\mysqld.exe',
      cmd: '"C:\\laragon\\bin\\mysql\\mariadb-12.3.2-winx64\\bin\\mysqld.exe"',
    };
    assert.equal(matchDbProcess(laragonEntry, [other], [L(3308, 4321)]), null);
  });

  it('a process without --defaults-file from the right bin on the right port matches', () => {
    const { matchDbProcess } = D();
    const p = { pid: 2468, ppid: 1, name: 'mysqld.exe', exe: `${XAMPP_BIN}\\mysqld.exe`, cmd: `"${XAMPP_BIN}\\mysqld.exe" --standalone` };
    assert.equal(pidOf(matchDbProcess(xamppEntry, [p], [L(3307, 2468)])), 2468);
  });
});

// ------------------------------------------------------------------------------------------ projects (pure + fixtures)
describe('projects', () => {
  const PJ = () => load('projects.js');

  it('laravelPhpHint support table', () => {
    const { laravelPhpHint } = PJ();
    const warn = [[7, '8.1.0'], [6, '8.2.12'], [8, '8.2.12'], [8, '8.5.9'], [9, '8.3.0'], [10, '8.4.1'],
      [11, '8.1.27'], [12, '8.1.0'], [13, '8.2.12']];
    const fine = [[6, '7.4.33'], [7, '8.0.3'], [8, '8.0.3'], [8, '8.1.27'], [9, '8.2.12'], [10, '8.3.30'],
      [11, '8.2.0'], [11, '8.4.1'], [12, '8.2.12'], [12, '8.5.9'], [13, '8.3.30'], [13, '8.5.9']];
    for (const [major, php] of warn) {
      const h = laravelPhpHint(major, php);
      assert.equal(typeof h, 'string', `Laravel ${major} + PHP ${php} should warn`);
      assert.ok(h.length > 5);
    }
    for (const [major, php] of fine) assert.equal(laravelPhpHint(major, php), null, `Laravel ${major} + PHP ${php} is fine`);
  });

  const runtimes = [
    { version: '8.0.3', path: 'D:\\xampp8\\php\\php.exe', ok: true },
    { version: '8.2.12', path: 'D:\\Xampp-8.2\\php8.2\\php.exe', ok: true },
    { version: '8.5.9', path: 'D:\\Xampp-8.2\\php\\php.exe', ok: true },
    { version: '8.3.30', path: 'C:\\laragon\\bin\\php\\php-8.3.30-Win32-vs16-x64\\php.exe', ok: true },
  ];

  it('suggestPhp: Laravel 12 (^8.2) → newest satisfying first, failing last', () => {
    const info = {
      exists: true, isLaravel: true, composerPhp: '^8.2', laravelConstraint: '^12.0',
      laravelLocked: 'v12.1.0', laravelInstalled: 'v12.1.0', vendor: true, requiredExt: [],
    };
    const list = PJ().suggestPhp(info, runtimes);
    assert.deepEqual(list.map((x) => x.version), ['8.5.9', '8.3.30', '8.2.12', '8.0.3']);
    assert.equal(list[0].satisfies, true);
    assert.equal(list[0].hint, null);
    assert.equal(list[3].satisfies, false);
    for (const x of list) {
      assert.equal(typeof x.score, 'number');
      assert.ok(x.path);
    }
  });

  it('suggestPhp: Laravel 8 (^7.3|^8.0) → 8.0.3 first, newer PHP gets a hint', () => {
    const info = {
      exists: true, isLaravel: true, composerPhp: '^7.3|^8.0', laravelConstraint: '^8.75',
      laravelLocked: 'v8.83.27', laravelInstalled: null, vendor: false, requiredExt: [],
    };
    const list = PJ().suggestPhp(info, runtimes);
    assert.equal(list[0].version, '8.0.3');
    assert.equal(list[0].hint, null);
    for (const v of ['8.2.12', '8.5.9']) {
      const item = list.find((x) => x.version === v);
      assert.ok(item.hint, `PHP ${v} should carry a Laravel hint`);
    }
  });

  it('suggestPhp: no constraint → satisfies null', () => {
    const list = PJ().suggestPhp({ exists: true, isLaravel: false, composerPhp: null, requiredExt: [] }, runtimes);
    assert.equal(list.length, 4);
    for (const x of list) assert.equal(x.satisfies, null);
  });

  describe('inspectProject on fixture folders', () => {
    let tmp;
    const w = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    const mk = () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-unit-'));
      // L8, root router, .env, cached config
      const l8 = path.join(tmp, 'l8-app');
      w(path.join(l8, 'artisan'), '<?php // fake');
      w(path.join(l8, 'server.php'), '<?php // router');
      w(path.join(l8, 'public', 'index.php'), "<?php echo 'L8';");
      w(path.join(l8, 'bootstrap', 'cache', 'config.php'), '<?php return [];');
      w(path.join(l8, 'composer.json'), JSON.stringify({
        require: { php: '^7.3|^8.0', 'laravel/framework': '^8.75', 'ext-gd': '*', 'ext-mbstring': '*', 'guzzlehttp/guzzle': '^7.0' },
      }));
      w(path.join(l8, 'composer.lock'), JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v8.83.27' }] }));
      w(path.join(l8, '.env'), [
        'APP_NAME=Fixture', 'DB_CONNECTION=mysql', 'DB_HOST=127.0.0.1', 'DB_PORT=3307',
        'DB_DATABASE=app_test', 'DB_USERNAME=root', 'DB_PASSWORD=SuperSecret123', '',
      ].join('\r\n'));
      // L12, vendor router, lock + installed.json ({packages:[...]})
      const l12 = path.join(tmp, 'l12-app');
      w(path.join(l12, 'artisan'), '<?php // fake');
      w(path.join(l12, 'public', 'index.php'), "<?php echo 'L12';");
      w(path.join(l12, 'composer.json'), JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^12.0' } }));
      w(path.join(l12, 'composer.lock'), JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v12.1.0' }] }));
      w(path.join(l12, 'vendor', 'composer', 'installed.json'), JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v12.1.0' }] }));
      w(path.join(l12, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Foundation', 'resources', 'server.php'), '<?php // router');
      // L11, installed.json as a plain array (Composer 1 format)
      const l11 = path.join(tmp, 'l11-app');
      w(path.join(l11, 'artisan'), '<?php // fake');
      w(path.join(l11, 'composer.json'), JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }));
      w(path.join(l11, 'vendor', 'composer', 'installed.json'), JSON.stringify([{ name: 'laravel/framework', version: 'v11.9.0' }]));
      // plain PHP
      const plain = path.join(tmp, 'plain-site');
      w(path.join(plain, 'index.php'), '<?php echo PHP_VERSION;');
      return { l8, l12, l11, plain };
    };
    let dirs;
    after(() => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('Laravel 8 with root router', () => {
      dirs = dirs || mk();
      const info = PJ().inspectProject(dirs.l8);
      assert.equal(info.exists, true);
      assert.equal(info.isLaravel, true);
      assert.equal(info.name, 'l8-app');
      assert.equal(info.composerPhp, '^7.3|^8.0');
      assert.equal(info.laravelConstraint, '^8.75');
      assert.deepEqual(load('semver.js').normalizeVersion(info.laravelLocked), [8, 83, 27]);
      assert.equal(info.vendor, false);
      assert.equal(info.router, 'root');
      assert.equal(lc(info.docroot), lc(path.join(dirs.l8, 'public')));
      assert.equal(info.configCached, true);
      assert.equal(info.env.exists, true);
      assert.equal(info.env.connection, 'mysql');
      assert.equal(info.env.host, '127.0.0.1');
      assert.equal(String(info.env.port), '3307');
      assert.equal(info.env.database, 'app_test');
      assert.equal(info.env.username, 'root');
      assert.equal(info.env.passwordSet, true);
      assert.ok(!JSON.stringify(info).includes('SuperSecret123'), 'password must never appear');
      assert.deepEqual([...info.requiredExt].sort(), ['ext-gd', 'ext-mbstring']);
    });

    it('Laravel 12 with vendor router, composer.lock and installed.json', () => {
      dirs = dirs || mk();
      const info = PJ().inspectProject(dirs.l12);
      const { normalizeVersion } = load('semver.js');
      assert.equal(info.isLaravel, true);
      assert.equal(info.composerPhp, '^8.2');
      assert.equal(info.laravelConstraint, '^12.0');
      assert.deepEqual(normalizeVersion(info.laravelLocked), [12, 1, 0]);
      assert.deepEqual(normalizeVersion(info.laravelInstalled), [12, 1, 0]);
      assert.equal(info.vendor, true);
      assert.equal(info.router, 'vendor');
      assert.equal(info.configCached, false);
      assert.equal(info.env.exists, false);
      assert.deepEqual(info.requiredExt, []);
    });

    it('installed.json as a plain array', () => {
      dirs = dirs || mk();
      const info = PJ().inspectProject(dirs.l11);
      assert.deepEqual(load('semver.js').normalizeVersion(info.laravelInstalled), [11, 9, 0]);
      assert.equal(info.router, 'none');
      assert.equal(lc(info.docroot), lc(dirs.l11), 'no public folder → docroot is the project folder');
    });

    it('plain PHP folder', () => {
      dirs = dirs || mk();
      const info = PJ().inspectProject(dirs.plain);
      assert.equal(info.exists, true);
      assert.equal(info.isLaravel, false);
      assert.equal(info.name, 'plain-site');
      assert.equal(info.router, 'none');
      assert.equal(info.vendor, false);
      assert.equal(lc(info.docroot), lc(dirs.plain));
      assert.ok(info.composerPhp == null);
      assert.equal(info.env.exists, false);
    });

    it('missing folder', () => {
      dirs = dirs || mk();
      const info = PJ().inspectProject(path.join(tmp, 'does-not-exist'));
      assert.equal(info.exists, false);
    });
  });
});

// ------------------------------------------------------------------------------------------ i18n (backend texts)
describe('i18n', () => {
  const I18N = () => load('i18n.js');
  // Every test leaves the language on the default so later tests see the original texts.
  const withLang = (lang, fn) => {
    const i = I18N();
    const before = i.getLang();
    i.setLang(lang);
    try { return fn(); } finally { i.setLang(before); }
  };
  const URDU_LETTER = /[\u0600-\u06FF]/;

  it('LANGS, default and setLang/getLang', () => {
    const i = I18N();
    assert.deepEqual([...i.LANGS], ['roman', 'en', 'ur']);
    assert.equal(i.DEFAULT_LANG, 'roman');
    assert.equal(i.getLang(), 'roman');
    assert.equal(i.setLang('en'), 'en');
    assert.equal(i.getLang(), 'en');
    assert.equal(i.setLang('xx'), 'roman', 'unknown language falls back to roman');
    assert.equal(i.setLang(undefined), 'roman');
    assert.equal(i.getLang(), 'roman');
  });

  it('every key exists in all three languages as a non-empty string', () => {
    const { CATALOG } = I18N();
    const keys = Object.keys(CATALOG.roman);
    assert.ok(keys.length > 200, `only ${keys.length} keys`);
    for (const lang of ['en', 'ur']) {
      assert.deepEqual(Object.keys(CATALOG[lang]).sort(), [...keys].sort(), `${lang} has a different key set`);
    }
    for (const lang of ['roman', 'en', 'ur']) {
      for (const k of keys) assert.ok(typeof CATALOG[lang][k] === 'string' && CATALOG[lang][k].trim(), `${lang}.${k} is empty`);
    }
  });

  it('translations use exactly the same placeholders', () => {
    const { CATALOG, placeholders } = I18N();
    for (const k of Object.keys(CATALOG.roman)) {
      const want = placeholders(CATALOG.roman[k]);
      assert.deepEqual(placeholders(CATALOG.en[k]), want, `en.${k}`);
      assert.deepEqual(placeholders(CATALOG.ur[k]), want, `ur.${k}`);
    }
  });

  it('Urdu texts are in Urdu script (except purely technical ones)', () => {
    const { CATALOG } = I18N();
    const technical = new Set(['job.lint', 'label.path']);
    const missing = Object.keys(CATALOG.ur).filter((k) => !technical.has(k) && !URDU_LETTER.test(CATALOG.ur[k]));
    assert.deepEqual(missing, []);
    for (const k of Object.keys(CATALOG.en)) assert.ok(!URDU_LETTER.test(CATALOG.en[k]), `en.${k} has Urdu script`);
  });

  it('tr(): substitution, one-pass replacement, unknown placeholders and fallback', () => {
    const i = I18N();
    assert.equal(i.tr('err.portUsedProject', { port: 8001 }), 'Port 8001 kisi aur project ka hai');
    withLang('en', () => assert.equal(i.tr('err.portUsedProject', { port: 8001 }), 'Port 8001 belongs to another project'));
    withLang('ur', () => {
      const t = i.tr('err.portUsedProject', { port: 8001 });
      assert.ok(t.includes('8001') && URDU_LETTER.test(t), t);
    });
    // values are not re-scanned, missing params stay visible
    assert.equal(i.format('a {x} b {y}', { x: '{y}' }), 'a {y} b {y}');
    assert.equal(i.format('{a}{b}', { a: 0, b: null }), '0null');
    assert.equal(i.tr('err.portUsedProject'), 'Port {port} kisi aur project ka hai');
    // unknown key -> the key itself
    withLang('en', () => assert.equal(i.tr('no.such.key', { a: 1 }), 'no.such.key'));
    // key missing in one language -> roman text
    const saved = i.CATALOG.en['err.badPort'];
    delete i.CATALOG.en['err.badPort'];
    try {
      withLang('en', () => assert.equal(i.tr('err.badPort'), 'Port galat hai'));
    } finally {
      i.CATALOG.en['err.badPort'] = saved;
    }
    assert.equal(i.trIn('en', 'err.badPort'), 'Invalid port');
    assert.equal(i.trIn('nope', 'err.badPort'), 'Port galat hai');
  });

  it('Roman Urdu texts stay the original ones', () => {
    const i = I18N();
    assert.equal(i.tr('move.targetExists', { db: 'dp_moved' }), 'Naye server par "dp_moved" pehle se maujood hai — kabhi overwrite nahi hota. Naya naam chunein.');
    assert.equal(i.tr('err.dbStopped', { label: 'A' }), 'DB server "A" band hai. Pehle use start karein?');
    assert.equal(i.tr('check.nextSteps', { list: 'x | y' }), 'Agla kaam: x | y');
    assert.equal(i.tr('err.badToken'), 'Token galat hai — page reload karein');
    assert.equal(i.tr('path.notAbsolute', { label: 'Path' }), 'Path poora (absolute) hona chahiye, misal: D:\\Xampp8\\htdocs\\my-project');
    assert.equal(i.tr('warn.configCached'), 'Config cache bana hua hai (bootstrap\\cache\\config.php) — .env ki tabdeeli tab tak asar nahi karegi jab tak "optimize:clear" na chalayein');
  });

  it('console texts: English for en, Roman Urdu otherwise', () => {
    const i = I18N();
    assert.equal(i.consoleLang('en'), 'en');
    assert.equal(i.consoleLang('ur'), 'roman');
    assert.equal(i.consoleLang('roman'), 'roman');
    withLang('ur', () => assert.equal(i.trConsole('cli.running', { url: 'u' }), 'PHP Station chal raha hai: u'));
    withLang('en', () => assert.equal(i.trConsole('cli.running', { url: 'u' }), 'PHP Station is running: u'));
  });

  it('localized module texts: laravelPhpHint, describeExit, checkUserPath', () => {
    const PJ = load('projects.js');
    const U = load('util.js');
    assert.equal(PJ.laravelPhpHint(8, '8.5.9'), 'Laravel 8 PHP 8.5 par deprecation/errors dega (8.1 tak support hai)');
    assert.equal(PJ.laravelPhpHint(12, '8.1.0'), 'Laravel 12 ko kam az kam PHP 8.2 chahiye');
    withLang('en', () => {
      assert.equal(PJ.laravelPhpHint(8, '8.5.9'), 'Laravel 8 gives deprecations/errors on PHP 8.5 (supported up to 8.1)');
      assert.equal(U.describeExit({ code: 3221225781 }, 'x.exe'), 'A required DLL is missing (0xC0000135): x.exe');
      assert.throws(() => U.checkUserPath(''), (e) => e.code === 'BAD_PATH' && e.message === 'Path is empty');
    });
    withLang('ur', () => {
      assert.ok(URDU_LETTER.test(PJ.laravelPhpHint(10, '8.4.1')));
      assert.throws(() => U.checkUserPath('relative'), (e) => e.code === 'BAD_PATH' && URDU_LETTER.test(e.message));
    });
  });

  it('validateSettings: lang accepts roman/en/ur, rejects anything else with 400 BAD_INPUT', () => {
    const S = load('state.js');
    const cur = Object.assign({}, S.DEFAULT_SETTINGS, { projectRoots: [], runtimeRoots: [] });
    assert.equal(S.DEFAULT_SETTINGS.lang, 'roman');
    for (const lang of ['roman', 'en', 'ur']) assert.equal(S.validateSettings({ lang }, cur).lang, lang);
    for (const bad of ['fr', '', 'EN', null, 5, ['en'], { en: 1 }]) {
      assert.throws(() => S.validateSettings({ lang: bad }, cur), (e) => e.code === 'BAD_INPUT' && e.status === 400, `lang ${JSON.stringify(bad)}`);
    }
    // the error message follows the current language; other settings errors keep their code
    withLang('en', () => {
      assert.throws(() => S.validateSettings({ lang: 'fr' }, cur), (e) => e.message === 'Language can only be roman, en or ur');
      assert.throws(() => S.validateSettings({ theme: 'pink' }, cur), (e) => e.code === 'BAD_SETTINGS' && e.message === 'Theme can only be black, silver or auto');
    });
    assert.throws(() => S.validateSettings({ theme: 'pink' }, cur), (e) => e.message === 'Theme sirf black, silver ya auto ho sakti hai');
  });

  it('loadState: missing or unknown lang -> roman, a valid one is kept', () => {
    const S = load('state.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-i18n-'));
    try {
      const write = (settings) => fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ settings: Object.assign({ projectRoots: [], runtimeRoots: [] }, settings) }));
      write({});
      assert.equal(S.loadState(tmp).data.settings.lang, 'roman');
      write({ lang: 'klingon' });
      assert.equal(S.loadState(tmp).data.settings.lang, 'roman');
      write({ lang: 'ur' });
      assert.equal(S.loadState(tmp).data.settings.lang, 'ur');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('DB server warnings: text follows the language, code/level kept, params added', () => {
    const D = load('dbservers.js');
    const missing = path.join(os.tmpdir(), `dp-i18n-missing-${process.pid}`, 'data');
    const ctx = {
      dataDir: os.tmpdir(),
      runtimes: { scanning: false, jobId: null, cache: { scannedAt: null, php: [], composer: [], db: [] } },
      store: {
        data: {
          settings: {}, projects: [], runs: {}, dbRuns: {},
          dbServers: {
            'dbi-a': { created: true, installId: 'gone', datadir: missing, name: 'a', port: 3391 },
            'dbi-b': { created: true, installId: 'gone', datadir: missing, name: 'b', port: 3391 },
          },
        },
      },
    };
    const snap = { ok: true, procs: [], listeners: [], externals: [] };
    const byCode = (list) => Object.fromEntries(list.map((w) => [w.code, w]));
    const roman = byCode(D.views(ctx, snap).list.find((s) => s.id === 'dbi-a').warnings);
    const en = withLang('en', () => byCode(D.views(ctx, snap).list.find((s) => s.id === 'dbi-a').warnings));
    const ur = withLang('ur', () => byCode(D.views(ctx, snap).list.find((s) => s.id === 'dbi-a').warnings));
    for (const code of ['SHARED_DATADIR', 'DATADIR_MISSING', 'PORT_CLASH', 'NO_CONFIG', 'NO_INSTALL']) {
      for (const w of [roman, en, ur]) {
        assert.ok(w[code], `${code} missing`);
        assert.equal(typeof w[code].params, 'object', `${code} params`);
      }
      assert.equal(en[code].level, roman[code].level);
      assert.notEqual(en[code].text, roman[code].text, `${code} en text`);
      assert.ok(URDU_LETTER.test(ur[code].text), `${code} ur text`);
    }
    assert.equal(roman.PORT_CLASH.text, 'Port 3391 ye bhi istemal karte hain: DB ? · b');
    assert.equal(en.PORT_CLASH.text, 'Port 3391 is also used by: DB ? · b');
    assert.deepEqual(roman.PORT_CLASH.params, { others: ['DB ? · b'], port: 3391 });
    assert.deepEqual(roman.PORT_CLASH.others, ['dbi-b'], 'existing others (ids) unchanged');
    assert.deepEqual(roman.SHARED_DATADIR.params.others, ['DB ? · b']);
    assert.equal(roman.NO_CONFIG.text, 'my.ini nahi mili');
  });
});

// ------------------------------------------------------------------------------------------ v1.1: installer (pure)
describe('installer (pure parts)', () => {
  const I = () => load('installer.js');
  const H = require('./helpers');

  it('checkUrl: https, default port, no credentials, allowed hosts only', () => {
    const { checkUrl, ALLOWED_HOSTS } = I();
    for (const h of ['windows.php.net', 'downloads.php.net', 'downloads.mariadb.org', 'archive.mariadb.org', 'dlm.mariadb.com', 'getcomposer.org', 'nodejs.org', 'curl.se']) {
      assert.ok(ALLOWED_HOSTS.includes(h), h);
      assert.equal(checkUrl(`https://${h}/x`).hostname, h);
    }
    assert.equal(checkUrl('https://WINDOWS.PHP.NET:443/a').hostname, 'windows.php.net');
    const refused = ['http://windows.php.net/x', 'https://evil.example/x', 'https://windows.php.net.evil.example/x',
      'https://user:pw@getcomposer.org/x', 'https://getcomposer.org:8443/x', 'ftp://nodejs.org/x', 'file:///C:/Windows/win.ini',
      'https://127.0.0.1/x', 'https://localhost/x', 'not a url', ''];
    for (const u of refused) assert.throws(() => checkUrl(u), (e) => e.code === 'URL_NOT_ALLOWED', u);
  });

  it('parsePhpReleases: x64 NTS with the newest toolset per branch, "-1" builds, sizes, bad entries skipped', () => {
    const json = {
      8.4: {
        version: '8.4.27-1',
        'nts-vs16-x64': { zip: { path: 'php-8.4.27-1-nts-Win32-vs16-x64.zip', size: '30MB', sha256: '1'.repeat(64) } },
        'nts-vs17-x64': { zip: { path: 'php-8.4.27-1-nts-Win32-vs17-x64.zip', size: '33.66MB', sha256: 'A'.repeat(64) } },
        'ts-vs17-x64': { zip: { path: 'php-8.4.27-1-Win32-vs17-x64.zip', size: '34MB', sha256: '2'.repeat(64) } },
        'nts-vs17-x86': { zip: { path: 'php-8.4.27-1-nts-Win32-vs17-x86.zip', size: '30MB', sha256: '3'.repeat(64) } },
      },
      7.4: { version: '7.4.33', 'nts-vc15-x64': { zip: { path: 'php-7.4.33-nts-Win32-vc15-x64.zip', size: '24.92MB', sha256: 'nothex' } } },
      8.9: { version: '8.9.0', 'nts-vs17-x64': { zip: { path: '../evil-x64.zip', size: '1MB', sha256: '4'.repeat(64) } } },
      junk: { version: '1.0.0' },
    };
    const items = I().parsePhpReleases(json);
    assert.deepEqual(items.map((x) => x.version), ['8.4.27', '7.4.33']);
    assert.equal(items[0].file, 'php-8.4.27-1-nts-Win32-vs17-x64.zip');
    assert.equal(items[0].url, 'https://windows.php.net/downloads/releases/php-8.4.27-1-nts-Win32-vs17-x64.zip');
    assert.equal(items[0].sha256, 'a'.repeat(64));
    assert.equal(items[0].sizeMB, 33.66);
    assert.equal(items[0].build, '8.4.27-1');
    assert.match(items[0].label, /VS17/);
    assert.equal(items[1].sha256, null, 'invalid checksum -> null (install refuses it)');
    assert.deepEqual(I().parsePhpReleases(null), []);
    assert.equal(I().parseSizeMB('1.5GB'), 1536);
    assert.equal(I().parseSizeMB('512KB'), 0.5);
    assert.equal(I().parseSizeMB('n/a'), null);
  });

  it('parseMariadbMajors / parseMariadbLatest: stable + not EOL, winx64.zip from archive.mariadb.org over https', () => {
    const majors = I().parseMariadbMajors({
      major_releases: [
        { release_id: '13.2', release_status: 'Preview' },
        { release_id: '13.1', release_status: 'RC', release_support_type: 'Rolling' },
        { release_id: '13.0', release_status: 'Stable', release_support_type: 'Rolling', release_eol_date: null },
        { release_id: '12.3', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2029-06-12' },
        { release_id: '10.11', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2028-02-16' },
        { release_id: '10.6', release_status: 'Stable', release_support_type: 'Long Term Support', release_eol_date: '2026-07-06' },
      ],
    }, new Date('2026-11-11T00:00:00Z'));
    assert.deepEqual(majors.map((m) => m.major), ['13.0', '12.3', '10.11']);
    assert.deepEqual(majors.map((m) => m.lts), [false, true, true]);
    const latest = I().parseMariadbLatest({
      releases: {
        '12.3.3': {
          date_of_release: '2026-10-01',
          files: [
            { file_name: 'mariadb-12.3.3-winx64-debugsymbols.zip', checksum: { sha256sum: '1'.repeat(64) } },
            { file_name: 'mariadb-12.3.3-winx64.msi', checksum: { sha256sum: '2'.repeat(64) } },
            { file_name: 'mariadb-12.3.3-winx64.zip', checksum: { sha256sum: '3'.repeat(64) }, file_download_url: 'http://downloads.mariadb.org/rest-api/mariadb/12.3.3/mariadb-12.3.3-winx64.zip' },
          ],
        },
      },
    }, '12.3');
    assert.deepEqual(latest, {
      version: '12.3.3', file: 'mariadb-12.3.3-winx64.zip', sha256: '3'.repeat(64), date: '2026-10-01',
      url: 'https://archive.mariadb.org/mariadb-12.3.3/winx64-packages/mariadb-12.3.3-winx64.zip',
    });
    assert.equal(I().parseMariadbLatest({ releases: { '12.3.3': { files: [] } } }, '12.3'), null);
    assert.equal(I().parseMariadbLatest({ releases: { x: { files: [{ file_name: 'mariadb-11.8.9-winx64.zip' }] } } }, '12.3'), null, 'other major ignored');
  });

  it('parseComposerVersions: stable 2.x only, LTS flag, min PHP', () => {
    const list = I().parseComposerVersions({
      stable: [
        { path: '/download/2.11.2/composer.phar', version: '2.11.2', 'min-php': 70205, lts: false },
        { path: '/download/2.2.32/composer.phar', version: '2.2.32', 'min-php': 50300, lts: true },
        { path: '/download/1.10.28/composer.phar', version: '1.10.28' },
        { path: '/composer.phar', version: 'd9d851d93b71' },
      ],
      preview: [{ version: '2.12.0-RC1' }],
    });
    assert.deepEqual(list.map((x) => [x.version, x.lts, x.minPhp]), [['2.11.2', false, '7.2.5'], ['2.2.32', true, '5.3.0']]);
    assert.equal(list[0].url, 'https://getcomposer.org/download/2.11.2/composer.phar');
  });

  it('parseNodeIndex + parseShasums / shaFor', () => {
    const n = I().parseNodeIndex([
      { version: 'v27.0.0', lts: false, files: ['win-x64-zip'] },
      { version: 'v26.13.0', lts: 'Lithium', files: ['win-x64-msi'] },
      { version: 'v24.22.2', lts: 'Krypton', files: ['win-x64-zip', 'win-x64-msi'] },
      { version: 'v24.22.1', lts: 'Krypton', files: ['win-x64-zip'] },
    ]);
    assert.deepEqual(n, { version: 'v24.22.2', lts: 'Krypton', file: 'node-v24.22.2-win-x64.zip', url: 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip' });
    assert.equal(I().parseNodeIndex([]), null);
    const text = `${'a'.repeat(64)}  node-v24.22.2-win-x64.zip\n${'B'.repeat(64)} *./other.zip\r\nnot a line\n`;
    const m = I().parseShasums(text);
    assert.equal(m.get('node-v24.22.2-win-x64.zip'), 'a'.repeat(64));
    assert.equal(m.get('other.zip'), 'b'.repeat(64));
    assert.equal(I().shaFor(`${'c'.repeat(64)}  cacert.pem\n`, 'cacert.pem'), 'c'.repeat(64));
    assert.equal(I().shaFor(`${'d'.repeat(64)}\n`, 'composer.phar'), 'd'.repeat(64), 'bare hash');
    assert.equal(I().shaFor('garbage', 'composer.phar'), null);
  });

  it('buildPhpIni: template kept, PHP Station block with extension_dir, present extensions, CA bundle', () => {
    const tpl = '[PHP]\r\n;extension=curl\r\nextension=mbstring\r\n';
    const dir = 'D:\\dev-tools\\devpanel\\runtimes\\php\\8.4.27';
    const ca = 'D:\\dev-tools\\devpanel\\runtimes\\cacert.pem';
    const ini = I().buildPhpIni(tpl, { phpDir: dir, extensions: ['curl', 'mbstring', 'exif'], cacert: ca });
    const lines = ini.split('\r\n');
    assert.match(lines[0], /^; generated by PHP Station /);
    assert.ok(ini.includes(';extension=curl\r\nextension=mbstring'), 'template unchanged');
    assert.ok(lines.includes(`extension_dir="${dir}\\ext"`));
    assert.ok(lines.includes('extension=curl') && lines.includes('extension=exif'));
    assert.equal(lines.filter((l) => l === 'extension=mbstring').length, 1, 'no duplicate for an enabled extension');
    assert.ok(lines.includes(`curl.cainfo="${ca}"`));
    assert.ok(lines.includes(`openssl.cafile="${ca}"`));
    assert.ok(!I().buildPhpIni('', { phpDir: 'C:\\p', extensions: [] }).includes('cainfo'));
    // the runtime scan sees this ini as "home = its own folder" (no relocation)
    assert.equal(lc(load('ini.js').detectIniHome(ini, dir)), lc(dir));
    const present = I().presentExtensions('C:\\php\\ext', (f) => /php_(curl|gd2|zip)\.dll$/i.test(f));
    assert.deepEqual(present, ['curl', 'gd2', 'zip']);
  });

  it('listZipEntries / checkZipEntries: names, folders, zip slip, absolute, drive, links', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-zip-'));
    try {
      const write = (name, entries) => { const f = path.join(tmp, name); fs.writeFileSync(f, H.makeZip(entries)); return f; };
      const ok = write('ok.zip', [{ name: 'top/', data: null }, { name: 'top/bin/mariadbd.exe', data: 'abc' }, { name: 'top/\u00fc.txt', data: 'x' }]);
      const list = I().listZipEntries(ok);
      assert.deepEqual(list.map((e) => [e.name, e.size, e.isDir, e.isSymlink]), [['top/', 0, true, false], ['top/bin/mariadbd.exe', 3, false, false], ['top/\u00fc.txt', 1, false, false]]);
      assert.equal(I().checkZipEntries(list), true);
      const bad = [
        ['dotdot', [{ name: 'a/../../evil.txt', data: 'x' }]],
        ['absolute', [{ name: '/etc/evil', data: 'x' }]],
        ['drive', [{ name: 'C:/Windows/evil.dll', data: 'x' }]],
        ['backslash-dotdot', [{ name: 'a\\..\\..\\evil.txt', data: 'x' }]],
        ['ads', [{ name: 'php.exe:stream', data: 'x' }]],
        ['symlink', [{ name: 'link', data: '/', unixMode: 0o120777 }]],
      ];
      for (const [label, entries] of bad) {
        const f = write(`${label}.zip`, entries);
        assert.throws(() => I().checkZipEntries(I().listZipEntries(f)), (e) => e.code === 'UNSAFE_ARCHIVE', label);
      }
      const notZip = path.join(tmp, 'no.zip');
      fs.writeFileSync(notZip, 'this is not a zip file at all, just text');
      assert.throws(() => I().listZipEntries(notZip), (e) => e.code === 'BAD_ARCHIVE');
      assert.throws(() => I().checkZipEntries([]), (e) => e.code === 'BAD_ARCHIVE');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('systemSummary works offline from the scan cache', () => {
    const ctx = {
      toolDir: os.tmpdir(),
      dataDir: os.tmpdir(),
      runtimes: {
        scanning: false,
        jobId: null,
        cache: {
          scannedAt: 'x',
          php: [{ ok: true, version: '8.2.12' }, { ok: false, version: '8.5.0' }, { ok: true, version: '8.4.1' }],
          composer: [],
          db: [{ kind: 'mariadb', version: '10.4.32', serverExe: 'x' }, { kind: 'mysql', version: '8.4.3', serverExe: null }],
        },
      },
    };
    const s = I().systemSummary(ctx);
    assert.deepEqual(s.php, ['8.4.1', '8.2.12']);
    assert.deepEqual(s.mariadb, ['10.4.32']);
    assert.deepEqual(s.mysql, []);
    assert.deepEqual(s.composer, []);
    assert.equal(s.node.version, process.versions.node);
    assert.deepEqual(s.missing.map((m) => m.kind), ['composer']);
    assert.deepEqual(s.recommended, [{ kind: 'composer', version: null }]);
    assert.equal(lc(s.runtimesDir), lc(path.join(os.tmpdir(), 'runtimes')));
  });
});

// ------------------------------------------------------------------------------------------ v1.1: setup / state / runtimes / db
describe('v1.1 setup, state, runtimes, db entries', () => {
  it('setup.suggestActions', () => {
    const { suggestActions } = load('setup.js');
    const base = {
      isLaravel: true, hasComposerJson: true, vendor: false, projectPort: 8001, server: { port: 3391 },
      envExists: false, exampleExists: true,
      env: { APP_KEY: '', APP_URL: 'http://localhost', DB_CONNECTION: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_DATABASE: 'laravel', DB_USERNAME: 'root' },
    };
    assert.deepEqual(suggestActions(base), ['CREATE_ENV', 'SET_DB', 'SET_APP_URL', 'COMPOSER_INSTALL', 'GENERATE_KEY']);
    const ready = Object.assign({}, base, {
      vendor: true,
      envExists: true,
      env: { APP_KEY: 'base64:abc', APP_URL: 'http://127.0.0.1:8001/', DB_CONNECTION: 'mysql', DB_HOST: 'localhost', DB_PORT: '3391', DB_DATABASE: 'x', DB_USERNAME: 'root' },
    });
    const withEnv = (extra) => Object.assign({}, ready, { env: Object.assign({}, ready.env, extra) });
    assert.deepEqual(suggestActions(ready), []);
    assert.deepEqual(suggestActions(Object.assign({}, ready, { server: null })), [], 'no server -> no SET_DB');
    assert.deepEqual(suggestActions(withEnv({ DB_CONNECTION: 'sqlite', DB_PORT: '' })), [], 'sqlite projects are left alone');
    assert.deepEqual(suggestActions(withEnv({ DB_HOST: 'db.example.com' })), ['SET_DB']);
    assert.deepEqual(suggestActions(withEnv({ DB_DATABASE: '' })), ['SET_DB']);
    assert.deepEqual(suggestActions(withEnv({ APP_URL: 'http://127.0.0.1:8002' })), ['SET_APP_URL']);
    assert.deepEqual(suggestActions(Object.assign({}, base, { exampleExists: false })), ['COMPOSER_INSTALL'], 'no .env and no example: only composer');
    assert.deepEqual(suggestActions({ isLaravel: false, hasComposerJson: false, vendor: false, envExists: false, exampleExists: false, env: {} }), []);
    assert.deepEqual(suggestActions({ isLaravel: false, hasComposerJson: true, vendor: false, envExists: false, exampleExists: false, env: {} }), ['COMPOSER_INSTALL']);
  });

  it('setup.dbNameFromProject', () => {
    const { dbNameFromProject } = load('setup.js');
    assert.equal(dbNameFromProject('my-university'), 'my_university');
    assert.equal(dbNameFromProject('  Acme CRM Panel! '), 'acme_crm_panel');
    assert.equal(dbNameFromProject('---'), 'laravel');
    assert.equal(dbNameFromProject('a'.repeat(80)).length, 64);
  });

  it('state: portConfirmed migration, tool-relative dump folder, saved settings kept', () => {
    const S = load('state.js');
    const list = S.migrateProjects([
      { id: 'a', lastStartedAt: '2026-11-10T00:00:00Z' }, { id: 'b', lastStartedAt: null },
      { id: 'c', portConfirmed: false, lastStartedAt: 'x' }, { id: 'd', portConfirmed: true },
    ]);
    assert.deepEqual(list.map((p) => p.portConfirmed), [true, false, false, true]);
    assert.equal(lc(S.DEFAULT_SETTINGS.dumpDir), lc(path.join(__dirname, '..', 'backups')));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-state-'));
    try {
      fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
        settings: { projectRoots: [], runtimeRoots: [], dumpDir: 'E:\\my-dumps' },
        projects: [{ id: 'p1', path: 'C:\\x', lastStartedAt: 'y' }, { id: 'p2', path: 'C:\\y' }],
      }));
      const st = S.loadState(tmp);
      assert.equal(st.data.settings.dumpDir, 'E:\\my-dumps', 'saved settings are kept');
      assert.deepEqual(st.data.projects.map((p) => p.portConfirmed), [true, false]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runtimes.findCandidates: <tool>\\runtimes layout (php, composer, mariadb)', () => {
    const R = load('runtimes.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-rt-'));
    try {
      const w = (rel) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
      w('php\\8.4.27\\php.exe');
      w('composer\\2.11.2\\composer.phar');
      w('mariadb\\11.8.9\\bin\\mariadbd.exe');
      w('_tmp\\php-1\\php.exe');
      const c = R.findCandidates([], [], { runtimesDir: tmp });
      assert.deepEqual(c.php.map((x) => [lc(x.path), x.source]), [[lc(path.join(tmp, 'php', '8.4.27', 'php.exe')), 'devpanel']]);
      assert.deepEqual(c.composer.map((x) => lc(x.path)), [lc(path.join(tmp, 'composer', '2.11.2', 'composer.phar'))]);
      assert.deepEqual(c.db.map((x) => lc(x.binDir)), [lc(path.join(tmp, 'mariadb', '11.8.9', 'bin'))]);
      assert.equal(lc(R.toolRuntimesDir({ toolDir: 'C:\\t' })), lc('C:\\t\\runtimes'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dbservers.buildEntries: an install whose my.ini belongs to a created instance is listed once', () => {
    const D = load('dbservers.js');
    const dir = 'D:\\dev-tools\\devpanel\\runtimes\\mariadb\\11.8.9';
    const inst = {
      id: 'db-mariadb-11.8.9-aaaaaa', kind: 'mariadb', version: '11.8.9', serverExe: `${dir}\\bin\\mariadbd.exe`, binDir: `${dir}\\bin`,
      client: null, dump: null, admin: null, installDb: null, defaultsFile: `${dir}\\data\\my.ini`, port: 3310, datadir: `${dir}\\data`, ok: true,
    };
    const ctx = {
      dataDir: os.tmpdir(),
      runtimes: { scanning: false, jobId: null, cache: { scannedAt: null, php: [], composer: [], db: [inst] } },
      store: { data: { settings: {}, projects: [], runs: {}, dbRuns: {}, dbServers: {} } },
    };
    assert.deepEqual(D.buildEntries(ctx).map((e) => e.id), ['db-mariadb-11.8.9-aaaaaa'], 'without an instance the install entry stays');
    ctx.store.data.dbServers['dbi-mariadb-11-8-9'] = {
      created: true, installId: inst.id, datadir: `${dir}\\data`, defaultsFile: `${dir}\\DATA\\my.ini`, name: 'mariadb-11-8-9', port: 3310,
    };
    assert.deepEqual(D.buildEntries(ctx).map((e) => e.id), ['dbi-mariadb-11-8-9']);
  });

  it('dbprovision.sqlDatabaseRefs: USE / CREATE / DROP DATABASE at line start', async () => {
    const P = load('dbprovision.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-sql-'));
    try {
      const f = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };
      const plain = f('plain.sql', '-- dump\nCREATE TABLE `t` (id INT);\nINSERT INTO t VALUES (1);\n/*!40101 SET NAMES utf8mb4 */;\n');
      assert.deepEqual(await P.sqlDatabaseRefs(plain), []);
      const dump = f('dump.sql', 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\r\n\r\nUSE `shop`;\r\nDROP DATABASE IF EXISTS old_db;\r\ncreate schema `x2`;\r\n  use y3 ;\r\n');
      assert.deepEqual((await P.sqlDatabaseRefs(dump)).sort(), ['old_db', 'shop', 'x2', 'y3']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('server: open-url allows only x8code.com (and a configured GitHub homepage); version from package.json', () => {
    const S = require(path.join(__dirname, '..', 'server.js'));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const allowed = S.allowedOpenUrls();
    assert.ok(allowed.includes('https://x8code.com'));
    assert.ok(!allowed.includes('http://x8code.com'));
    assert.ok(allowed.every((u) => /^https:\/\/(x8code\.com\/?$|github\.com\/)/.test(u)));
    if (pkg.homepage) assert.ok(allowed.includes(pkg.homepage), 'GitHub homepage must be allowed');
    assert.equal(S.VERSION, pkg.version);
  });
});

// ------------------------------------------------------------------------------------------ v1.1: DB_MISSING decision (stubbed DB calls)
describe('projects.findMissingDatabase (stubbed client calls)', () => {
  const PJ = () => load('projects.js');
  const D = () => load('dbservers.js');
  const PR = () => load('procs.js');
  const U = () => load('util.js');
  let tmp;
  const saved = {};
  const stub = (mod, name, fn) => { if (!saved[name]) saved[name] = [mod, mod[name]]; mod[name] = fn; };
  after(() => {
    for (const [name, [mod, fn]] of Object.entries(saved)) mod[name] = fn;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const setup = (envLines) => {
    tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'dp-miss-'));
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    fs.writeFileSync(path.join(dir, '.env'), envLines.join('\r\n'));
    const ctx = {
      dataDir: tmp,
      log: () => {},
      runtimes: { scanning: false, jobId: null, cache: { scannedAt: null, php: [], composer: [], db: [] } },
      store: { data: { settings: {}, projects: [{ id: 'p1', name: 'p1', path: dir, dbServerId: 'own', port: 8890 }], runs: {}, dbRuns: {}, dbServers: {} } },
    };
    return { ctx, project: ctx.store.data.projects[0] };
  };
  const own = { id: 'own', label: 'Own', effectivePort: 3392 };
  const other = { id: 'other', label: 'Other', effectivePort: 3391 };
  const ENV = ['DB_CONNECTION=mysql', 'DB_HOST=127.0.0.1', 'DB_PORT=3392', 'DB_DATABASE=shop', 'DB_USERNAME=app', 'DB_PASSWORD=NotARealSecret', ''];

  const install = (sizes) => {
    // sizes: (entryId, user) -> number | null | 'denied' | 'down'
    const calls = [];
    stub(D(), 'databaseSize', async (ctx, entry, name, creds) => {
      calls.push([entry.id, creds.user, name]);
      const r = sizes(entry.id, creds.user);
      if (r === 'denied') throw new (U().AppError)('NEED_CREDENTIALS', 'denied', 409);
      if (r === 'down') throw new (U().AppError)('DB_NOT_RUNNING', 'down', 409);
      return r;
    });
    stub(D(), 'buildEntries', () => [own, other]);
    stub(D(), 'entryStatus', () => ({ status: 'running' }));
    stub(PR(), 'getSnapshot', async () => ({ ok: true, procs: [], listeners: [], externals: [] }));
    return calls;
  };

  it('missing on its own server, found on another (with sizes); .env credentials first', async () => {
    const { ctx, project } = setup(ENV);
    const calls = install((id) => (id === 'other' ? 12.5 : null));
    const r = await PJ().findMissingDatabase(ctx, project, own);
    assert.deepEqual(r, { database: 'shop', dbServerId: 'own', foundOn: [{ serverId: 'other', label: 'Other', port: 3391, sizeMB: 12.5 }] });
    assert.deepEqual(calls[0], ['own', 'app', 'shop']);
    assert.ok(!JSON.stringify(r).includes('NotARealSecret'));
  });

  it('exists -> null; access denied for the .env user -> retried as root', async () => {
    const { ctx, project } = setup(ENV);
    const calls = install((id, user) => (user === 'app' ? 'denied' : 3));
    assert.equal(await PJ().findMissingDatabase(ctx, project, own), null);
    assert.deepEqual(calls.map((c) => c[1]), ['app', 'root']);
  });

  it('the check cannot run (denied for every user / server down) -> does not block', async () => {
    for (const mode of ['denied', 'down']) {
      const { ctx, project } = setup(ENV);
      install(() => mode);
      const r = await PJ().findMissingDatabase(ctx, project, own);
      assert.equal(r.skipped, true, mode);
      assert.equal(typeof r.warning, 'string');
      assert.ok(!r.database, 'no DB_MISSING when the check could not run');
    }
  });

  it('nothing to check: no .env database, sqlite, remote host, odd name', async () => {
    for (const env of [
      ['DB_CONNECTION=mysql', 'DB_DATABASE='],
      ['DB_CONNECTION=sqlite', 'DB_DATABASE=database.sqlite'],
      ['DB_CONNECTION=mysql', 'DB_HOST=db.example.com', 'DB_DATABASE=shop'],
      ['DB_CONNECTION=mysql', 'DB_HOST=127.0.0.1', 'DB_DATABASE=bad name;drop'],
    ]) {
      const { ctx, project } = setup(env);
      const calls = install(() => null);
      assert.equal(await PJ().findMissingDatabase(ctx, project, own), null, env.join(' '));
      assert.equal(calls.length, 0, 'no client call');
    }
  });
});
