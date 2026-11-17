'use strict';
/*
 * Unit tests for the 1.3 features (PURE parts only — no servers, no network, no user files):
 * shift from XAMPP/Laragon (vhost / ini parsing), phpstation.json validation, DB Time Machine
 * (which artisan commands are protected, the php.bat shim), the live share link (cloudflared
 * release parsing, tunnel URL) and the new settings.
 * Run: node --test tests/
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = (n) => require(path.join(__dirname, '..', 'lib', n));

after(() => {
  try { lib('procs.js').stopHelper(); } catch { /* ignore */ }
});

// ------------------------------------------------------------------------------------------ importer
describe('importer (shift from XAMPP / Laragon)', () => {
  const I = () => lib('importer.js');

  it('parseIni: sections and keys are lower-cased, quotes removed, comments skipped', () => {
    const ini = I().parseIni('[preferences]\nDataDir=C:\\laragon\\data\n; comment\n[Apache]\nDocumentRoot="D:/laragon/www"\nPort=85\n[php]\nVersion=php-8.3.16-Win32-vs16-x64\n');
    assert.equal(ini.apache.documentroot, 'D:/laragon/www');
    assert.equal(ini.apache.port, '85');
    assert.equal(ini.php.version, 'php-8.3.16-Win32-vs16-x64');
    assert.equal(ini.preferences.datadir, 'C:\\laragon\\data');
  });

  it('parseVhosts: Apache blocks (Laragon auto + XAMPP), commented blocks ignored', () => {
    const text = [
      '# <VirtualHost *:80>',
      '#   DocumentRoot "C:/xampp/htdocs/old"',
      '# </VirtualHost>',
      '<VirtualHost *:85> ',
      '    DocumentRoot "D:/laragon/www/shop/public"',
      '    ServerName shop.test',
      '    ServerAlias *.shop.test www.shop.test',
      '</VirtualHost>',
      '<VirtualHost _default_:82>',
      '    <Directory "C:/laragon/www">',
      '    </Directory>',
      '</VirtualHost>',
      '<VirtualHost *:80>',
      '  DocumentRoot C:/xampp/htdocs/blog',
      '  ServerName blog.local:80',
      '</VirtualHost>',
    ].join('\r\n');
    const v = I().parseVhosts(text);
    assert.equal(v.length, 2, JSON.stringify(v));
    assert.deepEqual(v[0], { docroot: 'D:/laragon/www/shop/public', serverName: 'shop.test', aliases: ['*.shop.test', 'www.shop.test'] });
    assert.equal(v[1].docroot, 'C:/xampp/htdocs/blog');
    assert.equal(v[1].serverName, 'blog.local');
  });

  it('parseVhosts: nginx server blocks', () => {
    const v = I().parseVhosts('server {\n  listen 80;\n  server_name api.test www.api.test;\n  root "D:/laragon/www/api/public";\n  location / { try_files $uri /index.php; }\n}\n');
    assert.equal(v.length, 1);
    assert.equal(v[0].docroot, 'D:/laragon/www/api/public');
    assert.equal(v[0].serverName, 'api.test');
    assert.equal(v[0].nginx, true);
  });

  it('projectDirFromDocroot: a Laravel public\\ folder maps to the project folder', () => {
    const exists = (f) => /shop\\artisan$/i.test(f);
    assert.equal(I().projectDirFromDocroot('D:/laragon/www/shop/public', exists), 'D:\\laragon\\www\\shop');
    assert.equal(I().projectDirFromDocroot('C:/xampp/htdocs/plain', () => false), 'C:\\xampp\\htdocs\\plain');
    // "public" without artisan/composer.json next to it stays as it is
    assert.equal(I().projectDirFromDocroot('C:/sites/public', () => false), 'C:\\sites\\public');
    assert.equal(I().projectDirFromDocroot('', () => false), null);
  });

  it('stackKind / webRoots / stackPhpExe on fixture folders (read-only)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-imp-'));
    try {
      const lar = path.join(root, 'laragon');
      fs.mkdirSync(path.join(lar, 'usr'), { recursive: true });
      fs.mkdirSync(path.join(lar, 'www', 'shop'), { recursive: true });
      fs.mkdirSync(path.join(lar, 'bin', 'php', 'php-8.3.1-Win32'), { recursive: true });
      fs.writeFileSync(path.join(lar, 'bin', 'php', 'php-8.3.1-Win32', 'php.exe'), '');
      fs.writeFileSync(path.join(lar, 'usr', 'laragon.ini'), '[apache]\r\nDocumentRoot=' + path.join(lar, 'www') + '\r\n');
      assert.equal(I().stackKind(lar), 'Laragon');
      assert.deepEqual(I().webRoots('Laragon', lar).map((p) => p.toLowerCase()), [path.join(lar, 'www').toLowerCase()]);
      assert.equal(I().stackPhpExe('Laragon', lar).toLowerCase(), path.join(lar, 'bin', 'php', 'php-8.3.1-Win32', 'php.exe').toLowerCase());
      const xa = path.join(root, 'xampp');
      fs.mkdirSync(path.join(xa, 'htdocs'), { recursive: true });
      assert.equal(I().stackKind(xa), 'XAMPP');
      assert.equal(I().stackPhpExe('XAMPP', xa), null);
      assert.equal(I().stackKind(path.join(root, 'nothing')), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------ phpstation.json
describe('teamfile (phpstation.json)', () => {
  const T = () => lib('teamfile.js');

  it('validate: a full file', () => {
    const { file, errors } = T().validate({
      name: 'Shop', php: '8.2', extensions: ['intl', 'ext-GD', 'intl'],
      database: { engine: 'MariaDB', version: '10.11', name: 'shop_db' },
      setup: ['env', 'composer-install', 'key', 'migrate', 'migrate'], port: 8123,
    });
    assert.deepEqual(errors, []);
    assert.equal(file.name, 'Shop');
    assert.equal(file.php, '8.2');
    assert.deepEqual(file.extensions, ['intl', 'gd']);
    assert.deepEqual(file.database, { engine: 'mariadb', version: '10.11', name: 'shop_db' });
    assert.deepEqual(file.setup, ['env', 'composer-install', 'key', 'migrate']);
    assert.equal(file.port, 8123);
  });

  it('validate: versions given as numbers or full versions become branches', () => {
    const { file, errors } = T().validate({ php: 8.3, database: { version: '10.11.9' } });
    assert.deepEqual(errors, []);
    assert.equal(file.php, '8.3');
    assert.equal(file.database.version, '10.11');
    assert.equal(file.database.engine, 'mariadb');
  });

  it('validate: bad values are reported and dropped, never thrown', () => {
    const { file, errors } = T().validate({
      php: 'latest', extensions: ['ok_one', 'bad ext!'], database: { engine: 'postgres', name: 'x;drop' },
      setup: ['migrate', 'rm -rf'], port: 80,
    });
    assert.equal(file.php, null);
    assert.deepEqual(file.extensions, ['ok_one']);
    assert.equal(file.database.name, null);
    assert.deepEqual(file.setup, ['migrate']);
    assert.equal(file.port, null);
    for (const e of ['php', 'database.engine', 'database.name', 'port']) assert.ok(errors.includes(e), e);
    assert.ok(errors.some((e) => e.startsWith('extensions:')));
    assert.ok(errors.some((e) => e.startsWith('setup:')));
    assert.deepEqual(T().validate(null).errors, ['root']);
    assert.deepEqual(T().validate([1]).errors, ['root']);
  });

  it('read: missing file, bad JSON and a BOM', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-team-'));
    try {
      assert.deepEqual(T().read(dir), { exists: false, file: null, errors: [] });
      fs.writeFileSync(path.join(dir, 'phpstation.json'), '{ nope');
      assert.deepEqual(T().read(dir).errors, ['json']);
      fs.writeFileSync(path.join(dir, 'phpstation.json'), '\uFEFF{"php":"8.4"}');
      assert.equal(T().read(dir).file.php, '8.4');
      assert.equal(T().exists(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------ DB Time Machine
describe('timemachine', () => {
  const TM = () => lib('timemachine.js');

  it('isWritingCommand: migrate / db:* are protected, read-only ones are not', () => {
    for (const c of ['migrate', 'migrate:fresh', 'migrate:refresh', 'migrate:reset', 'migrate:rollback', 'MIGRATE:FRESH', 'db:seed', 'db:wipe']) {
      assert.equal(TM().isWritingCommand(c), true, c);
    }
    for (const c of ['migrate:status', 'db:show', 'db:table', 'db:monitor', 'db', 'tinker', 'route:list', '', null]) {
      assert.equal(TM().isWritingCommand(c), false, String(c));
    }
  });

  it('restore point names', () => {
    const re = TM().NAME_RE;
    for (const n of ['20261112-143005_manual', '20261112-143005_artisan', '20261112-143005-2_pre-undo', '20261112-143005_auto']) assert.ok(re.test(n), n);
    for (const n of ['20261112-143005_other', '..\\x_manual', '20261112-143005_manual\\..', '2026111-143005_manual']) assert.ok(!re.test(n), n);
  });
});

describe('timemachine quick checks', () => {
  const TM = () => lib('timemachine.js');

  it('isPlainMigrate: only `migrate` with output / safety flags can skip the restore point', () => {
    assert.equal(TM().isPlainMigrate('migrate', []), true);
    assert.equal(TM().isPlainMigrate('MIGRATE', ['--force', '-n', '--step']), true);
    for (const [c, a] of [['migrate', ['--seed']], ['migrate', ['--path=x']], ['migrate', ['--database=other']], ['migrate:fresh', []], ['db:seed', []], ['migrate', ['--pretend', 'x']]]) {
      assert.equal(TM().isPlainMigrate(c, a), false, `${c} ${a.join(' ')}`);
    }
  });

  it('migrationName drops every ".php" like Laravel', () => {
    assert.equal(TM().migrationName('2014_10_12_000000_create_users_table.php'), '2014_10_12_000000_create_users_table');
    assert.equal(TM().migrationName(path.join('app', 'database', 'migrations', '2025_10_09_x_table.php.php')), '2025_10_09_x_table');
  });

  it('pendingMigrations compares files with the migrations that ran (null when it cannot tell)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mig-'));
    try {
      fs.mkdirSync(path.join(dir, 'database', 'migrations'), { recursive: true });
      for (const n of ['2020_01_01_000000_a.php', '2020_01_02_000000_b.php.php']) fs.writeFileSync(path.join(dir, 'database', 'migrations', n), '<?php');
      fs.writeFileSync(path.join(dir, 'database', 'migrations', 'README.md'), '');
      assert.equal(TM().pendingMigrations(dir, new Set(['2020_01_01_000000_a', '2020_01_02_000000_b'])), 0);
      assert.equal(TM().pendingMigrations(dir, new Set(['2020_01_01_000000_a'])), 1);
      assert.equal(TM().pendingMigrations(dir, null), null, 'no migrations table');
      // a package whose service provider loads its own migrations
      const pkg = path.join(dir, 'vendor', 'acme', 'tools');
      fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
      fs.mkdirSync(path.join(pkg, 'database', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'src', 'ToolsServiceProvider.php'), '<?php $this->loadMigrationsFrom(__DIR__."/../database/migrations");');
      fs.writeFileSync(path.join(pkg, 'database', 'migrations', '2021_01_01_000000_c.php'), '<?php');
      fs.mkdirSync(path.join(dir, 'vendor', 'composer'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'vendor', 'composer', 'installed.json'), JSON.stringify({ packages: [{
        name: 'acme/tools', autoload: { 'psr-4': { 'Acme\\Tools\\': 'src/' } }, extra: { laravel: { providers: ['Acme\\Tools\\ToolsServiceProvider'] } },
      }] }));
      assert.equal(TM().pendingMigrations(dir, new Set(['2020_01_01_000000_a', '2020_01_02_000000_b'])), 1, 'package migration pending');
      // modules that load migrations from elsewhere: can't tell
      fs.mkdirSync(path.join(dir, 'Modules'));
      assert.equal(TM().pendingMigrations(dir, new Set(['2020_01_01_000000_a', '2020_01_02_000000_b', '2021_01_01_000000_c'])), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('fingerprintOf: the same write counters give the same signature, any write changes it', () => {
    const base = [['COM_INSERT', '5'], ['COM_ALTER_TABLE', '2'], ['INNODB_ROWS_UPDATED', '9'], ['UPTIME', '100']];
    const a = TM().fingerprintOf(base, 1000000);
    const b = TM().fingerprintOf(base.map(([k, v]) => [k.toLowerCase(), k === 'UPTIME' ? '160' : v]), 1060000);
    assert.equal(a.sig, b.sig);
    assert.equal(a.boot, b.boot);
    assert.notEqual(TM().fingerprintOf([['COM_INSERT', '6'], ['COM_ALTER_TABLE', '2'], ['INNODB_ROWS_UPDATED', '9'], ['UPTIME', '100']], 1000000).sig, a.sig);
    assert.equal(TM().fingerprintOf([['UPTIME', '1']]), null, 'no counters, no reuse');
  });
});

describe('dbimport (Import database)', () => {
  const DI = () => lib('dbimport.js');

  it('parseClientError reads the code, the line and the message', () => {
    assert.deepEqual(DI().parseClientError("mysql: [Warning] x\nERROR 1273 (HY000) at line 25: Unknown collation: 'utf8mb4_0900_ai_ci'\n"),
      { code: 1273, line: 25, message: "Unknown collation: 'utf8mb4_0900_ai_ci'" });
    assert.deepEqual(DI().parseClientError('ERROR 2006 (HY000) at line 9: MySQL server has gone away'), { code: 2006, line: 9, message: 'MySQL server has gone away' });
    assert.equal(DI().parseClientError('all good'), null);
  });

  it('fixesFor maps server errors to one-click fixes, without the ones already on', () => {
    assert.deepEqual(DI().fixesFor({ code: 1273, message: 'Unknown collation' }), ['collation']);
    assert.deepEqual(DI().fixesFor({ code: 1193, message: "Unknown system variable 'GTID_PURGED'" }), ['gtid']);
    assert.deepEqual(DI().fixesFor({ code: 1067, message: "Invalid default value for 'x'" }), ['sqlmode']);
    assert.deepEqual(DI().fixesFor({ code: 1050, message: 'Table exists' }, ['replace']), []);
    assert.deepEqual(DI().fixesFor({ code: 1366, message: 'Incorrect string value' }, [], { invalidUtf8: true }), ['latin1']);
    assert.deepEqual(DI().fixesFor({ code: 1064, message: "near 'ENCRYPTION='N''" }), ['mysql8']);
    assert.deepEqual(DI().fixesFor({ code: 1227, message: 'need SUPER for SET @@GLOBAL.GTID_PURGED' }), ['gtid']);
    assert.deepEqual(DI().fixesFor({ code: 9999, message: '?' }), []);
  });

  it('nearestCollation picks what the server has', () => {
    const maria = new Set(['utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8mb4_bin', 'utf8_unicode_ci', 'utf8_bin', 'latin1_swedish_ci', 'latin1_general_ci']);
    assert.equal(DI().nearestCollation('utf8mb4_0900_ai_ci', maria), 'utf8mb4_unicode_ci');
    assert.equal(DI().nearestCollation('utf8mb4_0900_bin', maria), 'utf8mb4_bin');
    assert.equal(DI().nearestCollation('utf8mb3_general_ci', maria), 'utf8_unicode_ci');
    assert.equal(DI().nearestCollation('latin1_german2_ci', maria), 'latin1_general_ci');
  });

  it('the line fixer drops and rewrites only what its fixes cover', () => {
    const fix = DI().makeLineFixer(['stripdb', 'gtid', 'definer', 'mysql8', 'collation', 'charset', 'sqlmode'],
      { collations: { utf8mb4_0900_ai_ci: 'utf8mb4_unicode_ci' } });
    assert.equal(fix('USE `shop`;\n'), null);
    assert.equal(fix('/*!40000 DROP DATABASE IF EXISTS `shop`*/;\n'), null);
    assert.equal(fix("SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'a:1-5,\n"), null);
    assert.equal(fix("b:1-9';\n"), null, 'the rest of a multi-line GTID statement');
    assert.equal(fix('CREATE TABLE t (a int);\n'), 'CREATE TABLE t (a int);\n');
    assert.equal(fix('/*!50013 DEFINER=`admin`@`%` SQL SECURITY DEFINER */\n'), '/*!50013 SQL SECURITY DEFINER */\n');
    assert.equal(fix(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci /*!80016 DEFAULT ENCRYPTION='N' */;\n"),
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ;\n');
    assert.equal(fix('`a` varchar(5) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin\n'), '`a` varchar(5) CHARACTER SET utf8 COLLATE utf8_bin\n');
    assert.equal(fix("/*!50003 SET sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION' */ ;\n"),
      "/*!50003 SET sql_mode = 'ONLY_FULL_GROUP_BY,NO_ENGINE_SUBSTITUTION' */ ;\n");
    const none = DI().makeLineFixer([]);
    assert.equal(none('USE `shop`;\n'), 'USE `shop`;\n');
  });

  it('originalLine undoes the prelude and the dropped lines', () => {
    assert.equal(DI().originalLine(10, 4, []), 6);
    assert.equal(DI().originalLine(10, 4, [2, 3]), 8);
    assert.equal(DI().originalLine(10, 4, [2, 3, 50]), 8);
    assert.equal(DI().originalLine(3, 4, []), null, 'inside the prelude');
  });

  it('encodingOf spots UTF-16 with and without a BOM', () => {
    assert.equal(DI().encodingOf(Buffer.from([0xff, 0xfe, 0x2d, 0x00])), 'utf16le');
    assert.equal(DI().encodingOf(Buffer.from('-- MySQL dump', 'utf16le')), 'utf16le');
    assert.equal(DI().encodingOf(Buffer.from('-- MySQL dump 10.13 with plenty of plain text', 'utf8')), 'utf8');
  });
});

describe('htaccess (Apache rules without Apache)', () => {
  const HT = () => lib('htaccess.js');
  // a fake docroot: url-style paths -> 'file' | 'dir'; .htaccess texts by folder
  const site = (files, conf) => {
    const root = path.join(os.tmpdir(), 'ps-ht-site');
    const norm = (p) => path.relative(root, p).split(path.sep).join('/');
    return {
      root,
      io: {
        kind: (p) => { const r = norm(p); if (r === '') return 'dir'; return files[r] || null; },
        read: (p) => { const r = norm(p); return r.endsWith('.htaccess') ? (conf[r.slice(0, -'.htaccess'.length)] ?? null) : null; },
      },
    };
  };
  const ev = (s, url, method = 'GET') => HT().evaluate(s.root, { method, url, headers: { host: 'localhost:8000' } }, s.io, new Map());
  const front = 'RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^(.*)$ index.php?url=$1 [QSA,L]\n';

  it('front controller: unknown paths go to index.php, real files are served as they are', () => {
    const s = site({ 'index.php': 'file', 'css': 'dir', 'css/app.css': 'file' }, { '': front });
    assert.deepEqual(ev(s, '/blog/post-1?x=2'), { action: 'serve', path: '/index.php', query: 'url=blog/post-1&x=2', headers: [], rewritten: true });
    assert.equal(ev(s, '/css/app.css').action, 'pass');
    assert.equal(ev(s, '/index.php').action, 'pass');
  });

  it('WordPress rules', () => {
    const wp = '<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n</IfModule>\n';
    const s = site({ 'index.php': 'file', 'wp-admin': 'dir', 'wp-admin/index.php': 'file' }, { '': wp });
    const r = ev(s, '/2026/11/hello-world/');
    assert.equal(r.action, 'serve');
    assert.equal(r.path, '/index.php');
    assert.equal(ev(s, '/wp-admin/').path, '/wp-admin/index.php');
    assert.equal(ev(s, '/wp-admin').action, 'redirect', 'folder without slash');
  });

  it('back-references, [R=301], [F], [G], Redirect and RedirectMatch', () => {
    const conf = 'RewriteEngine On\nRewriteRule ^product/([0-9]+)$ product.php?id=$1 [L]\nRewriteRule ^old$ /new [R=301,L]\nRewriteRule ^secret - [F]\nRewriteRule ^gone$ - [G]\n'
      + 'Redirect 302 /moved /product/7\nRedirectMatch 301 ^/blog/(.*)$ /news/$1\n';
    const s = site({ 'product.php': 'file' }, { '': conf });
    assert.deepEqual(ev(s, '/product/42'), { action: 'serve', path: '/product.php', query: 'id=42', headers: [], rewritten: true });
    assert.deepEqual(ev(s, '/old?a=1'), { action: 'redirect', status: 301, location: '/new?a=1', headers: [] });
    assert.equal(ev(s, '/secret/x').status, 403);
    assert.equal(ev(s, '/gone').status, 410);
    assert.equal(ev(s, '/moved/x').location, '/product/7/x');
    assert.equal(ev(s, '/blog/a-b').location, '/news/a-b');
  });

  it('access rules: deny a folder, <FilesMatch>, .ht* never served, ErrorDocument', () => {
    const s = site({ 'private': 'dir', 'private/a.txt': 'file', '.env': 'file', 'x.ini': 'file', 'ok.txt': 'file', '404.php': 'file' },
      { '': '<FilesMatch "^\\.env|\\.ini$">\n  Require all denied\n</FilesMatch>\nErrorDocument 403 /404.php\n', 'private/': 'Deny from all\n' });
    const d = ev(s, '/private/a.txt');
    assert.equal(d.status, 403);
    assert.equal(d.errorDoc, '/404.php');
    assert.equal(ev(s, '/.env').status, 403);
    assert.equal(ev(s, '/x.ini').status, 403);
    assert.equal(ev(s, '/.htaccess').status, 403);
    assert.equal(ev(s, '/ok.txt').action, 'pass');
    assert.equal(ev(s, '/missing.txt').status, 404);
  });

  it('a sub-folder .htaccess with its own rules, DirectoryIndex, a growing [QSA] query does not loop', () => {
    const s = site({ 'shop': 'dir', 'shop/index.php': 'file', 'blog': 'dir', 'blog/home.php': 'file' },
      { 'shop/': 'RewriteEngine On\nRewriteRule ^(.*)$ index.php?p=$1 [QSA,L]\n', 'blog/': 'DirectoryIndex home.php\n' });
    const r = ev(s, '/shop/cart/9');
    assert.equal(r.action, 'serve');
    assert.equal(r.path, '/shop/index.php');
    assert.equal(ev(s, '/blog/').path, '/blog/home.php');
  });

  it('PATH_INFO: /index.php/extra counts index.php as the file', () => {
    const s = site({ 'index.php': 'file' }, { '': front });
    assert.equal(ev(s, '/index.php/extra/path').action, 'pass');
  });

  it('analyze lists the lines that do nothing here; harmless ones are not listed', () => {
    const a = HT().analyze('Options -Indexes\nphp_value upload_max_filesize 64M\nRewriteEngine On\nRewriteRule ^a$ b.php [L]\nSetEnv APP_ENV dev\n<Limit GET>\nRequire all denied\n</Limit>\nHeader set X-A "1"\n');
    assert.equal(a.rewrite, 1);
    assert.equal(a.headers, 1);
    assert.deepEqual(a.unsupported.map((u) => u.line), [2, 5, 6]);
  });

  it('splitArgs keeps quoted arguments together', () => {
    assert.deepEqual(HT().splitArgs('Header set X-Frame-Options "SAMEORIGIN, x"'), ['Header', 'set', 'X-Frame-Options', 'SAMEORIGIN, x']);
    assert.deepEqual(HT().splitArgs("ErrorDocument 404 '/not found.php'"), ['ErrorDocument', '404', '/not found.php']);
  });
});

describe('doctor', () => {
  const D = () => lib('doctor.js');

  it('setMyIni changes only the [mysqld] section and keeps line endings', () => {
    const src = '[client]\r\nport=3306\r\n[mysqld]\r\nport=3306\r\nmax_allowed_packet=1M\r\n#innodb_buffer_pool_size=8M\r\n[mysqldump]\r\nmax_allowed_packet=16M\r\n';
    const out = D().setMyIni(src, { innodb_buffer_pool_size: '512M', max_allowed_packet: '256M' });
    assert.equal(out, '[client]\r\nport=3306\r\n[mysqld]\r\ninnodb_buffer_pool_size = 512M\r\nport=3306\r\nmax_allowed_packet = 256M\r\n#innodb_buffer_pool_size=8M\r\n[mysqldump]\r\nmax_allowed_packet=16M\r\n');
    assert.match(D().setMyIni('[client]\nport=1\n', { max_allowed_packet: '64M' }), /\[mysqld\]\nmax_allowed_packet = 64M$/);
  });

  it('tunedPool: 1/8 of the RAM, 256 MB to 1 GB, in 128 MB steps', () => {
    const MB = 1024 * 1024;
    assert.equal(D().tunedPool(2048 * MB), 256 * MB);
    assert.equal(D().tunedPool(6 * 1024 * MB), 768 * MB);
    assert.equal(D().tunedPool(64 * 1024 * MB), 1024 * MB);
  });

  it('mask hides the user, the PC and private folders', () => {
    const out = D().mask('C:\\Users\\sami\\x on PC-7 by sami, D:\\work\\shop\\a.php', { home: 'C:\\Users\\sami', user: 'sami', pc: 'PC-7', paths: ['D:\\work\\shop'] });
    assert.equal(out, '%USERPROFILE%\\x on <pc> by <user>, <path>\\a.php');
  });

  it('size reads as MB or GB', () => {
    assert.equal(D().size(300 * 1024 * 1024), '300 MB');
    assert.equal(D().size(5 * 1024 * 1024 * 1024), '5.0 GB');
  });
});

describe('projects.buildPhpBat (DB Time Machine hook)', () => {
  const P = () => lib('projects.js');
  const php = { path: 'C:\\php\\8.3\\php.exe', iniRelocated: false };
  const project = { id: 'shop-a1b2' };

  it('without a hook: the plain one-line shim', () => {
    assert.equal(P().buildPhpBat(php, project, null), '@"C:\\php\\8.3\\php.exe" %*\r\n');
  });

  it('with a hook: restore point only for artisan migrate* / db:*, then PHP with the same arguments', () => {
    const bat = P().buildPhpBat(php, project, { node: 'C:\\node\\node.exe', script: 'D:\\tools\\ps\\tools\\restore-point.js', dataDir: 'D:\\tools\\ps\\data' });
    const lines = bat.split('\r\n');
    assert.equal(lines[0], '@echo off');
    assert.ok(lines.includes('if /i not "%~1"=="artisan" goto ps_run'));
    assert.ok(lines.includes('if /i "%PS_ARTISAN:~0,7%"=="migrate" goto ps_point'));
    assert.ok(lines.includes('if /i "%PS_ARTISAN:~0,3%"=="db:" goto ps_point'));
    assert.ok(lines.includes('"C:\\node\\node.exe" "D:\\tools\\ps\\tools\\restore-point.js" "D:\\tools\\ps\\data" "shop-a1b2" %*'));
    // the last command is PHP, so its exit code is the shim's exit code
    assert.equal(lines.filter(Boolean).pop(), '"C:\\php\\8.3\\php.exe" %*');
  });

  it('a hook with unsafe paths falls back to the plain shim', () => {
    const bat = P().buildPhpBat(php, project, { node: 'C:\\a&b\\node.exe', script: 'D:\\x.js', dataDir: 'D:\\d' });
    assert.equal(bat, '@"C:\\php\\8.3\\php.exe" %*\r\n');
  });
});

// ------------------------------------------------------------------------------------------ live share link
describe('share + cloudflared release', () => {
  const S = () => lib('share.js');
  const IN = () => lib('installer.js');
  const release = (over = {}) => Object.assign({
    tag_name: '2026.11.0',
    body: 'notes\ncloudflared-windows-amd64.exe: d5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a\n',
    assets: [
      { name: 'cloudflared-windows-386.exe', size: 1, browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-windows-386.exe' },
      { name: 'cloudflared-windows-amd64.exe', size: 55397592, digest: 'sha256:D5C1D82031DA6253DCDCFF64C944CD0FE063016EDEB2E4FD088075FC9BD52D0A', browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-windows-amd64.exe' },
    ],
  }, over);

  it('parseCloudflaredRelease: the Windows x64 exe with its SHA-256', () => {
    const items = IN().parseCloudflaredRelease(release());
    assert.equal(items.length, 1);
    assert.equal(items[0].version, '2026.11.0');
    assert.equal(items[0].sha256, 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a');
    assert.equal(items[0].url, 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-windows-amd64.exe');
    assert.equal(items[0].sizeMB, 52.83);
  });

  it('parseCloudflaredRelease: release notes checksum when there is no digest', () => {
    const r = release();
    delete r.assets[1].digest;
    assert.equal(IN().parseCloudflaredRelease(r)[0].sha256, 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a');
  });

  it('parseCloudflaredRelease: a download URL outside the official release path is refused', () => {
    const r = release();
    r.assets[1].browser_download_url = 'https://evil.example/cloudflared-windows-amd64.exe';
    assert.deepEqual(IN().parseCloudflaredRelease(r), []);
    assert.deepEqual(IN().parseCloudflaredRelease(release({ tag_name: 'nightly' })), []);
    assert.deepEqual(IN().parseCloudflaredRelease(null), []);
  });

  it('the installer only reaches GitHub for cloudflared through allowed hosts', () => {
    const hosts = IN().ALLOWED_HOSTS;
    for (const h of ['api.github.com', 'github.com', 'release-assets.githubusercontent.com']) assert.ok(hosts.includes(h), h);
    assert.ok(IN().KINDS.includes('cloudflared'));
    assert.throws(() => IN().checkUrl('https://gist.github.io/x'), /gist\.github\.io/);
  });

  it('parseTunnelUrl: finds the trycloudflare.com link in the cloudflared log', () => {
    const log = '2026-11-12T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n'
      + '2026-11-12T10:00:00Z INF |  https://Bright-Moon-Tree-42.trycloudflare.com                                             |\n';
    assert.equal(S().parseTunnelUrl(log), 'https://bright-moon-tree-42.trycloudflare.com');
    // the API host cloudflared prints in its errors is never a link
    assert.equal(S().parseTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"'), null);
    assert.equal(S().parseTunnelUrl('https://x.trycloudflare.com.evil.example'), null);
    assert.equal(S().parseTunnelUrl('no url yet'), null);
  });

  it('tunnelState: failure, created and connected', () => {
    const fail = S().tunnelState('INF Requesting new quick Tunnel on trycloudflare.com...\nfailed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded');
    assert.equal(fail.url, null);
    assert.match(fail.failed, /context deadline exceeded/);
    const made = S().tunnelState('|  https://bright-moon-42.trycloudflare.com  |');
    assert.deepEqual(made, { url: 'https://bright-moon-42.trycloudflare.com', registered: false, failed: null });
    assert.equal(S().tunnelState('|  https://bright-moon-42.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0').registered, true);
  });

  it('the HTTPS prepend only trusts the tunnel header from 127.0.0.1 / ::1', () => {
    const php = S().PREPEND_PHP;
    assert.match(php, /HTTP_X_FORWARDED_PROTO/);
    assert.match(php, /'127\.0\.0\.1', '::1'/);
    assert.match(php, /\$_SERVER\['HTTPS'\] = 'on'/);
  });
});

// ------------------------------------------------------------------------------------------ settings
describe('settings for the Time Machine', () => {
  const ST = () => lib('state.js');
  it('defaults and validation', () => {
    assert.equal(ST().DEFAULT_SETTINGS.pointBeforeArtisan, true);
    assert.equal(ST().DEFAULT_SETTINGS.pointKeep, 20);
    const cur = Object.assign({}, ST().DEFAULT_SETTINGS);
    assert.equal(ST().validateSettings({ pointKeep: 50, pointBeforeArtisan: false }, cur).pointKeep, 50);
    assert.throws(() => ST().validateSettings({ pointKeep: 0 }, cur));
    assert.throws(() => ST().validateSettings({ pointKeep: 201 }, cur));
    assert.throws(() => ST().validateSettings({ pointBeforeArtisan: 'yes' }, cur));
  });
});

// ------------------------------------------------------------------------------------------ fast server
describe('fast server (tools/fastserve.js)', () => {
  const FS = () => require(path.join(__dirname, '..', 'tools', 'fastserve.js'));
  const P = () => lib('projects.js');

  it('staticFile: files inside the docroot only, never PHP or dot-files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fast-'));
    try {
      fs.mkdirSync(path.join(root, 'css'));
      fs.mkdirSync(path.join(root, '.well-known'));
      fs.writeFileSync(path.join(root, 'css', 'app.css'), 'body{}');
      fs.writeFileSync(path.join(root, 'index.php'), '<?php');
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(root, '.well-known', 'x.txt'), 'ok');
      fs.writeFileSync(path.join(root, 'a b.txt'), 'ok');
      const sf = (u) => FS().staticFile(root, u);
      assert.equal(sf('/css/app.css?v=3').size, 6);
      assert.equal(sf('/a%20b.txt').size, 2);
      assert.equal(sf('/.well-known/x.txt').size, 2);
      for (const u of ['/index.php', '/INDEX.PHP', '/.env', '/css/', '/', '/../secret.txt', '/css/..%2f..%2fx', '/missing.js', '/%E0%A4%A', '/css']) {
        assert.equal(sf(u), null, u);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parseArgs + fastServeArgs round trip (php args as base64 JSON)', () => {
    const pre = ['-c', 'C:\php ini\php.ini', '-d', 'auto_prepend_file=D:\data\share\https.php'];
    const argv = P().fastServeArgs({ script: 'x.js', port: 8000, docroot: 'D:\app\public', php: 'C:\php\php.exe', router: 'D:\app\server.php', workers: 4, pre });
    const a = FS().parseArgs(argv.slice(1));
    assert.deepEqual(a, { port: 8000, docroot: 'D:\app\public', php: 'C:\php\php.exe', router: 'D:\app\server.php', workers: 4, pre, htaccess: false, htrouter: null });
    assert.equal(FS().parseArgs(['--workers', '99']).workers, 16);
    // .htaccess: only without a project router, and then the .htaccess router runs the scripts
    const ht = FS().parseArgs(P().fastServeArgs({ script: 'x.js', port: 8000, docroot: 'D:\app', php: 'C:\php.exe', router: null, workers: 1, htrouter: 'D:\ps\htrouter.php' }).slice(1));
    assert.equal(ht.htaccess, true);
    assert.equal(ht.router, 'D:\ps\htrouter.php');
    const lara = FS().parseArgs(P().fastServeArgs({ script: 'x.js', port: 8000, docroot: 'D:\app', php: 'C:\php.exe', router: 'D:\app\server.php', workers: 1, htrouter: 'D:\ps\htrouter.php' }).slice(1));
    assert.equal(lara.htaccess, false);
    assert.equal(lara.router, 'D:\app\server.php');
    assert.deepEqual(FS().applyHeaderRules({ a: '1', b: '2' }, [{ action: 'set', name: 'A', value: 'x' }, { action: 'unset', name: 'b' }, { action: 'append', name: 'a', value: 'y' }]), { a: 'x, y' });
    assert.equal(P().phpWorkersOf({}), 4);
    assert.equal(P().phpWorkersOf({ phpWorkers: 1 }), 1);
    assert.equal(P().phpWorkersOf({ phpWorkers: 0 }), 4);
  });

  it('ownServerMatches: php -S or the fast server on that port, nothing else', () => {
    const m = P().ownServerMatches;
    assert.ok(m({ name: 'php.exe', cmd: '"C:/php/php.exe" -S 127.0.0.1:8000 -t D:/app/public' }, 8000));
    assert.ok(m({ name: 'node.exe', cmd: '"C:/node/node.exe" "D:/ps/tools/fastserve.js" --port 8000 --docroot D:/app' }, 8000));
    assert.ok(!m({ name: 'node.exe', cmd: '"C:/node/node.exe" "D:/ps/tools/fastserve.js" --port 8001 --docroot D:/app' }, 8000));
    assert.ok(!m({ name: 'node.exe', cmd: '"C:/node/node.exe" other.js --port 8000' }, 8000));
  });

  it('workers of the fast server are not shown as outside php -S servers', () => {
    const procs = lib('procs.js');
    const list = [
      { pid: 10, ppid: 1, name: 'node.exe', cmd: '"C:/node.exe" "D:/ps/tools/fastserve.js" --port 8000' },
      { pid: 11, ppid: 10, name: 'php.exe', cmd: '"C:/php/php.exe" -S 127.0.0.1:51000 -t D:/app/public' },
      { pid: 20, ppid: 1, name: 'php.exe', cmd: '"C:/php/php.exe" -S 127.0.0.1:9000 -t D:/other/public' },
    ];
    const ext = procs.deriveExternalPhpServers(list, [{ pid: 11, port: 51000 }, { pid: 20, port: 9000 }]);
    assert.deepEqual(ext.map((e) => e.pid), [20]);
  });
});

// ------------------------------------------------------------------------------------------ every action (binlog)
describe('dbhistory (binlog timeline)', () => {
  const H = () => lib('dbhistory.js');
  const SAMPLE = [
    '# at 501',
    '#261113 13:53:52 server id 1  end_log_pos 543 CRC32 0x8be5fc36 \tGTID 0-1-2 ddl thread_id=7',
    '# at 543',
    '#261113 13:53:52 server id 1  end_log_pos 690 CRC32 0xd8a5342d \tQuery\tthread_id=7\texec_time=0\terror_code=0\txid=5',
    'SET TIMESTAMP=1794560032/*!*/;',
    'CREATE TABLE tm_items (id INT PRIMARY KEY, name VARCHAR(50), note TEXT)',
    '/*!*/;',
    '# at 1023',
    '#261113 13:53:52 server id 1  end_log_pos 1065 CRC32 0xb863b65a \tGTID 0-1-4 trans thread_id=7',
    'START TRANSACTION',
    '# at 1065',
    '#261113 13:53:52 server id 1  end_log_pos 0 CRC32 0x7c1b2497 \tAnnotate_rows:',
    "#Q> UPDATE tm_items SET name='Green chai' WHERE id=1",
    '# at 1119',
    '#261113 13:53:52 server id 1  end_log_pos 0 CRC32 0x59c385ab \tTable_map: `shop`.`tm_items` mapped to number 22',
    '# at 1175',
    '#261113 13:53:52 server id 1  end_log_pos 0 CRC32 0xeee82ff3 \tUpdate_rows: table id 22 flags: STMT_END_F',
    '### UPDATE `shop`.`tm_items`',
    '### WHERE',
    '###   @1=1 /* INT meta=0 nullable=0 is_null=0 */',
    "###   @2='Chai' /* VARSTRING(200) meta=200 nullable=1 is_null=0 */",
    "###   @3='it's hot' /* BLOB/TEXT meta=2 nullable=1 is_null=0 */",
    '### SET',
    '###   @1=1 /* INT meta=0 nullable=0 is_null=0 */',
    "###   @2='Green chai' /* VARSTRING(200) meta=200 nullable=1 is_null=0 */",
    "###   @3='it's hot' /* BLOB/TEXT meta=2 nullable=1 is_null=0 */",
    '# Number of rows: 1',
    '# at 1272',
    '#261113 13:53:52 server id 1  end_log_pos 1303 CRC32 0x06149d3f \tXid = 7',
    'COMMIT/*!*/;',
    '# at 1303',
    '#261113 13:53:52 server id 1  end_log_pos 1345 CRC32 0xc9ac15b7 \tGTID 0-1-5 trans thread_id=7',
    'START TRANSACTION',
    '# at 1345',
    '#261113 13:53:52 server id 1  end_log_pos 0 CRC32 0x7098c319 \tAnnotate_rows:',
    '#Q> DELETE FROM tm_items WHERE id=2',
    '# at 1399',
    '#261113 13:53:52 server id 1  end_log_pos 0 CRC32 0x59c385ab \tTable_map: `shop`.`tm_items` mapped to number 22',
    '# at 1455',
    '#261113 13:53:52 server id 1  end_log_pos 0 CRC32 0x2c2d83b1 \tDelete_rows: table id 22 flags: STMT_END_F',
    '### DELETE FROM `shop`.`tm_items`',
    '### WHERE',
    '###   @1=2 /* INT meta=0 nullable=0 is_null=0 */',
    "###   @2='رجب, دعوت' /* VARSTRING(200) meta=200 nullable=1 is_null=0 */",
    '###   @3=NULL /* BLOB/TEXT meta=2 nullable=1 is_null=1 */',
    '# at 1499',
    '#261113 13:53:52 server id 1  end_log_pos 1530 CRC32 0x67609f03 \tXid = 8',
    'COMMIT/*!*/;',
  ].join('\n');

  it('parseBinlog: DDL, UPDATE (before/after) and DELETE with positions, SQL and values', () => {
    const tx = H().parseBinlog(SAMPLE, 'binlog.000001');
    assert.equal(tx.length, 3);
    assert.deepEqual([tx[0].ddl, tx[0].start, tx[0].end], [true, 501, 690]);
    assert.match(tx[0].query, /^CREATE TABLE tm_items/);
    const up = tx[1];
    assert.deepEqual([up.start, up.end, up.time], [1023, 1303, '2026-11-13 13:53:52']);
    assert.equal(up.query, "UPDATE tm_items SET name='Green chai' WHERE id=1");
    assert.equal(up.rows[0].op, 'UPDATE');
    assert.deepEqual(up.rows[0].before.map((c) => c.value), ['1', 'Chai', "it's hot"]);
    assert.deepEqual(up.rows[0].after.map((c) => c.value), ['1', 'Green chai', "it's hot"]);
    const del = tx[2];
    assert.deepEqual([del.start, del.end], [1303, 1530]);
    assert.equal(del.rows[0].before[1].value, 'رجب, دعوت');
    assert.equal(del.rows[0].before[2].isNull, true);
    assert.equal(del.rows[0].before[2].value, null);
  });

  it('forDatabase keeps only rows of that database; an undo replay is marked', () => {
    const other = SAMPLE.split('`shop`').join('`other`');
    assert.equal(H().forDatabase(H().parseBinlog(other, 'b.000001'), 'shop').filter((x) => !x.ddl).length, 0);
    const undo = H().parseBinlog(SAMPLE.replace("#Q> DELETE FROM tm_items WHERE id=2", "#Q> BINLOG '\n#Q> IND2ahM='"), 'b.000001');
    assert.equal(undo[2].isUndo, true);
    assert.equal(undo[2].query, null);
  });

  it('conflictsOf: a later change to the same row is reported', () => {
    const tx = H().parseBinlog(SAMPLE, 'binlog.000001');
    assert.deepEqual(H().conflictsOf(tx[1], [tx[2]]), []);
    const later = { time: 'x', rows: [{ op: 'UPDATE', table: 'tm_items', before: [{ value: '1' }], after: [{ value: '1' }] }] };
    assert.equal(H().conflictsOf(tx[1], [later]).length, 1);
  });

  it('action ids are validated', () => {
    assert.deepEqual(H().parseActionId('binlog.000001:1303:1530'), { file: 'binlog.000001', start: 1303, end: 1530 });
    for (const bad of ['', 'binlog.000001:1530:1303', '../x.000001:1:2', 'binlog.000001:1:2;drop', 'binlog:1:2']) assert.throws(() => H().parseActionId(bad), bad);
  });

  it('historyArgs: only MariaDB 10.2+, only when the setting is on, logs in the backup folder', () => {
    const D = lib('dbservers.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-hist-'));
    try {
      const ctx = { store: { data: { settings: { dumpDir: dir, dbHistory: true, historyDays: 5 } } } };
      const a = D.historyArgs(ctx, { id: 'db-x', kind: 'mariadb', version: '10.4.32' });
      assert.ok(a.includes('--binlog-format=ROW') && a.includes('--expire-logs-days=5') && a.includes('--binlog-row-image=FULL'));
      assert.ok(a[0].startsWith('--log-bin=') && a[0].includes('devpanel-backups/binlog/db-x/binlog'), a[0]);
      assert.deepEqual(D.historyArgs(ctx, { id: 'm', kind: 'mysql', version: '8.0.30' }), []);
      assert.deepEqual(D.historyArgs(ctx, { id: 'o', kind: 'mariadb', version: '10.1.38' }), []);
      ctx.store.data.settings.dbHistory = false;
      assert.deepEqual(D.historyArgs(ctx, { id: 'db-x', kind: 'mariadb', version: '11.4.2' }), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dbhistory filters for busy days', () => {
  const H = () => lib('dbhistory.js');
  const tx = (op, table, id, extra = {}) => Object.assign({ ddl: false, time: '2026-11-13 14:00:00', query: `${op} ... ${table}`, rows: [{ op, table, before: op === 'INSERT' ? [] : [{ col: 1, value: String(id) }], after: op === 'DELETE' ? [] : [{ col: 1, value: String(id) }, { col: 2, value: 'customer ' + id }] }] }, extra);
  const list = [tx('INSERT', 'orders', 1), tx('INSERT', 'orders', 42), tx('UPDATE', 'orders', 42), tx('DELETE', 'events', 21, { time: '2026-11-13 15:30:00' }),
    { ddl: true, time: '2026-11-13 13:00:00', query: 'CREATE TABLE orders (id INT)', rows: [] }];

  it('matches: by op, table and search (also "id=42" style)', () => {
    const m = (f) => list.filter((x) => H().matches(x, f)).length;
    assert.equal(m({}), 5);
    assert.equal(m({ op: 'DELETE' }), 1);
    assert.equal(m({ op: 'DDL' }), 1);
    assert.equal(m({ table: 'orders' }), 4);
    assert.equal(m({ q: 'id=42' }), 2);
    assert.equal(m({ q: 'customer 1' }), 1);
    assert.equal(m({ q: 'nothing like this' }), 0);
  });

  it('statsOf: counts per kind and the time window', () => {
    assert.deepEqual(H().statsOf(list), { total: 5, INSERT: 2, UPDATE: 1, DELETE: 1, DDL: 1, from: '2026-11-13 13:00:00', to: '2026-11-13 15:30:00' });
  });
});
