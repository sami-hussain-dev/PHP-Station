'use strict';
/*
 * Tests for the Inbox (Mail Catcher, dump() server, error viewer), the dev-tools prepend and
 * "Open from GitHub". Pure parsers plus two local loopback servers on random ports (no network,
 * no user files: everything lives in a temp folder).
 * Run: node --test tests/
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const lib = (n) => require(path.join(__dirname, '..', 'lib', n));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

after(() => {
  try { lib('procs.js').stopHelper(); } catch { /* ignore */ }
});

function fakeCtx(settings = {}) {
  const dataDir = tmp('ps-inbox-');
  return {
    dataDir, token: 'a'.repeat(64), log: () => {},
    store: { data: { settings: Object.assign({}, settings), projects: [{ id: 'shop-1', name: 'shop', path: 'C:\\Sites\\shop' }] }, save() {} },
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function smtpTalk(port, lines) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const got = [];
    let buf = '';
    let i = 0;
    s.on('data', (d) => {
      buf += d.toString();
      let at;
      while ((at = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        got.push(line);
        if (/^\d{3}-/.test(line)) continue;
        if (i < lines.length) s.write(`${lines[i++]}\r\n`); else s.end();
      }
    });
    s.on('close', () => resolve(got));
    s.on('error', reject);
  });
}

// ------------------------------------------------------------------------------------------ MIME
describe('mail catcher: MIME parsing', () => {
  const M = () => lib('mailcatch.js');

  it('decodes RFC 2047 words (B and Q, adjacent words joined)', () => {
    assert.equal(M().decodeWords('=?UTF-8?B?2KLZviDaqdinIE9UUA==?='), 'آپ کا OTP');
    assert.equal(M().decodeWords('=?iso-8859-1?Q?Caf=E9?= =?utf-8?Q?_ok?='), 'Café ok');
    assert.equal(M().decodeWords('plain text'), 'plain text');
  });

  it('parses parameters with quotes and RFC 2231 file names', () => {
    const p = M().parseParams('attachment; filename*=utf-8\'\'r%C3%A9sum%C3%A9.pdf; size=10');
    assert.equal(p.value, 'attachment');
    assert.equal(p.params.filename, 'résumé.pdf');
    const q = M().parseParams('multipart/mixed; boundary="a;b"');
    assert.equal(q.params.boundary, 'a;b');
  });

  it('splits address lists (quoted commas stay inside the name)', () => {
    const a = M().parseAddresses('"Khan, Ayesha" <ayesha@example.com>, bilal@example.com');
    assert.deepEqual(a, [{ name: 'Khan, Ayesha', address: 'ayesha@example.com' }, { name: '', address: 'bilal@example.com' }]);
  });

  it('parseMessage: text (quoted-printable), html (base64), inline cid image and attachment', () => {
    const raw = [
      'From: Shop <noreply@shop.test>', 'To: a@example.com', 'Subject: Hi', 'Content-Type: multipart/mixed; boundary=X', '',
      '--X', 'Content-Type: multipart/alternative; boundary=Y', '',
      '--Y', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Code =E2=80=94 42', '',
      '--Y', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from('<p>42 <img src="cid:logo"></p>').toString('base64'), '',
      '--Y--',
      '--X', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Disposition: inline', 'Content-Transfer-Encoding: base64', '', Buffer.from('PNG').toString('base64'),
      '--X', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF').toString('base64'),
      '--X--', '',
    ].join('\r\n');
    const m = M().parseMessage(raw);
    assert.equal(m.subject, 'Hi');
    assert.equal(m.from[0].address, 'noreply@shop.test');
    assert.equal(m.text.trim(), 'Code — 42');
    assert.match(m.html, /cid:logo/);
    assert.equal(m.attachments.length, 2);
    assert.equal(m.attachments[0].inline, true);
    assert.equal(m.attachments[1].filename, 'a.pdf');
    assert.equal(m.attachments[1].body.toString(), '%PDF');
    assert.match(M().inlineCids(m.html, m.attachments), /src="data:image\/png;base64,UE5H"/);
  });

  it('DATA end marker and dot-unstuffing', () => {
    const buf = Buffer.from('line1\r\n..dot\r\n.\r\nQUIT\r\n');
    const end = M().findDataEnd(buf);
    assert.ok(end);
    assert.equal(M().unstuff(buf.subarray(0, end.at)).toString(), 'line1\r\n.dot\r\n');
    assert.deepEqual(M().findDataEnd(Buffer.from('.\r\n')), { at: 0, len: 3 });
    assert.equal(M().findDataEnd(Buffer.from('no end yet\r\n')), null);
  });
});

// ------------------------------------------------------------------------------------------ SMTP
describe('mail catcher: SMTP session', () => {
  const M = () => lib('mailcatch.js');

  it('speaks enough SMTP for Laravel / Symfony Mailer (EHLO, AUTH PLAIN/LOGIN, no STARTTLS)', () => {
    const s = M().createSession();
    assert.match(s.feed('EHLO app').reply, /AUTH PLAIN LOGIN/);
    assert.doesNotMatch(s.feed('EHLO app').reply, /STARTTLS/);
    assert.match(s.feed(`AUTH PLAIN ${Buffer.from('\0phpstation-shop-1\0x').toString('base64')}`).reply, /^235/);
    assert.equal(s.state.user, 'phpstation-shop-1');
    const l = M().createSession();
    assert.match(l.feed('AUTH LOGIN').reply, /^334/);
    assert.match(l.feed(Buffer.from('u1').toString('base64')).reply, /^334/);
    assert.match(l.feed(Buffer.from('p').toString('base64')).reply, /^235/);
    assert.equal(l.state.user, 'u1');
    assert.match(s.feed('DATA').reply, /^503/);
    s.feed('MAIL FROM:<a@x>');
    s.feed('RCPT TO:<b@y>');
    assert.ok(s.feed('DATA').startData);
  });

  it('a connection that talks HTTP (a web page posting to the port) is closed', () => {
    const s = M().createSession();
    const r = s.feed('POST / HTTP/1.1');
    assert.equal(r.close, true);
    assert.equal(r.reply, null);
  });

  it('only real project ids are taken from the SMTP user name', () => {
    const ctx = fakeCtx();
    assert.equal(M().projectFromUser(ctx, 'phpstation-shop-1'), 'shop-1');
    assert.equal(M().projectFromUser(ctx, 'phpstation-nope'), null);
    assert.equal(M().projectFromUser(ctx, 'someone'), null);
  });

  it('end to end: a mail sent over SMTP is stored, listed, viewable only with its key, and deletable', async () => {
    const port = await freePort();
    const ctx = fakeCtx({ mailCatcher: true, mailPort: port });
    await new Promise((resolve) => M().sync(ctx, resolve));
    try {
      assert.equal(ctx.mail.listening, true);
      const data = 'From: A <a@x.test>\r\nTo: b@y.test\r\nSubject: =?UTF-8?B?2KLZvg==?=\r\n\r\nhello\r\n..dot';
      const got = await smtpTalk(port, ['EHLO t', `AUTH PLAIN ${Buffer.from('\0phpstation-shop-1\0p').toString('base64')}`, 'MAIL FROM:<a@x.test>', 'RCPT TO:<b@y.test>', 'RCPT TO:<hidden@z.test>', 'DATA', `${data}\r\n.`, 'QUIT']);
      assert.ok(got.some((l) => /^250 2\.0\.0 Ok: queued/.test(l)), got.join('|'));
      const ls = M().list(ctx, {});
      assert.equal(ls.items.length, 1);
      const e = ls.items[0];
      assert.equal(e.subject, 'آپ');
      assert.equal(e.project, 'shop-1');
      assert.deepEqual(e.bcc, ['hidden@z.test']);
      const d = M().detail(ctx, e.id);
      assert.equal(d.text, 'hello\r\n.dot\r\n');
      assert.ok(M().keyOk(ctx, e.id, M().viewKey(ctx, e.id)));
      assert.ok(!M().keyOk(ctx, e.id, '0'.repeat(32)));
      const http = await smtpTalk(port, ['GET / HTTP/1.1']);
      assert.equal(http.length, 1); // only the greeting, then closed
      assert.equal(M().remove(ctx, [e.id]).removed, 1);
      assert.equal(M().list(ctx, {}).items.length, 0);
    } finally {
      M().stop(ctx);
    }
  });
});

// ------------------------------------------------------------------------------------------ dumps
describe('dump() server', () => {
  const D = () => lib('dumps.js');

  it('finds the source file in a ServerDumper payload (the context comes after the data)', () => {
    const file = 'C:\\Sites\\shop\\app\\X.php';
    const ser = `a:2:{i:0;O:4:"Data":1:{s:4:"file";s:6:"fake.p";}i:1;a:2:{s:9:"timestamp";d:1;s:6:"source";a:3:{s:4:"name";s:5:"X.php";s:4:"file";s:${file.length}:"${file}";s:4:"line";i:9;}}}`;
    assert.equal(D().sourceFileOf(Buffer.from(ser, 'latin1').toString('base64')), file);
    assert.equal(D().sourceFileOf(Buffer.from('a:0:{}').toString('base64')), null);
  });

  it('maps a file to the registered project with the longest matching path', () => {
    const list = [{ id: 'a', path: 'C:\\Sites\\shop' }, { id: 'b', path: 'C:\\Sites\\shop\\admin' }, { id: 'c', path: 'C:\\Sites\\shopping' }];
    assert.equal(D().projectForFile(list, 'C:/Sites/shop/admin/x.php').id, 'b');
    assert.equal(D().projectForFile(list, 'c:\\sites\\shop\\app\\y.php').id, 'a');
    assert.equal(D().projectForFile(list, 'C:\\Other\\z.php'), null);
  });

  it('closes a connection whose first line is not base64 (HTTP from a web page)', async () => {
    const port = await freePort();
    const ctx = fakeCtx({ catchDumps: true, dumpPort: port });
    await new Promise((resolve) => D().sync(ctx, resolve));
    try {
      const closed = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write('POST / HTTP/1.1\r\nHost: x\r\n\r\n'));
        s.on('close', () => resolve(true));
        s.on('error', () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      assert.equal(closed, true);
      assert.equal(D().list(ctx, {}).items.length, 0);
    } finally {
      D().stop(ctx);
    }
  });

  it('the decoder only allows VarDumper classes and loads no project code', () => {
    const php = fs.readFileSync(path.join(__dirname, '..', 'tools', 'dumpdecode.php'), 'utf8');
    assert.match(php, /'allowed_classes' => \$allowed/);
    assert.doesNotMatch(php, /vendor[\\/]autoload\.php/);
    assert.match(php, /Symfony\\\\Component\\\\VarDumper\\\\/);
  });
});

// ------------------------------------------------------------------------------------------ errors
describe('error viewer (laravel.log)', () => {
  const L = () => lib('devlogs.js');
  const SAMPLE = [
    '[2026-11-13 09:12:44] local.ERROR: Undefined array key "city" {"userId":5,"exception":"[object] (ErrorException(code: 0): Undefined array key \\"city\\" at C:\\\\Sites\\\\shop\\\\app\\\\Http\\\\Controllers\\\\CheckoutController.php:88)',
    '[stacktrace]',
    '#0 C:\\\\Sites\\\\shop\\\\vendor\\\\laravel\\\\framework\\\\src\\\\Illuminate\\\\Foundation\\\\Bootstrap\\\\HandleExceptions.php(256): handleError(2)',
    '#1 C:\\\\Sites\\\\shop\\\\app\\\\Http\\\\Controllers\\\\CheckoutController.php(88): x()',
    '#2 {main}',
    '"} ',
    '[2026-11-13 09:20:00] local.WARNING: Slow gateway {"ms":4120} ',
    '[2026-11-13 09:30:01] local.ERROR: Undefined array key "city" {"userId":9,"exception":"[object] (ErrorException(code: 0): Undefined array key \\"city\\" at C:\\\\Sites\\\\shop\\\\app\\\\Http\\\\Controllers\\\\CheckoutController.php:88)',
    '[stacktrace]',
    '#0 {main}',
    '"} ',
    '',
  ].join('\n');

  it('parses entries: level, message, exception, file:line (JSON-escaped paths) and frames', () => {
    const e = L().parseLaravelLog(SAMPLE);
    assert.equal(e.length, 3);
    assert.equal(e[0].level, 'ERROR');
    assert.equal(e[0].message, 'Undefined array key "city"');
    assert.equal(e[0].exception.class, 'ErrorException');
    assert.equal(e[0].exception.message, 'Undefined array key "city"');
    assert.equal(e[0].exception.file, 'C:\\Sites\\shop\\app\\Http\\Controllers\\CheckoutController.php');
    assert.equal(e[0].where.line, 88);
    assert.equal(e[0].frames.length, 3);
    assert.equal(e[0].frames[0].vendor, true);
    assert.equal(e[0].frames[1].vendor, false);
    assert.equal(e[1].level, 'WARNING');
    assert.equal(e[1].message, 'Slow gateway');
    assert.ok(e[1].offset > e[0].offset);
  });

  it('groups repeats of the same error (other user ids, same place)', () => {
    const g = L().groupEntries(L().parseLaravelLog(SAMPLE).reverse());
    assert.equal(g.length, 2);
    assert.equal(g.find((x) => x.last.level === 'ERROR').count, 2);
  });

  it('parses PHP errors of the built-in server log', () => {
    const e = L().parsePhpLog('[Fri Nov 13 10:00:00 2026] PHP Warning:  Undefined variable $x in C:\\Sites\\shop\\index.php on line 12\n[Fri Nov 13 10:00:01 2026] 127.0.0.1:5000 [200]: GET /\n');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'WARNING');
    assert.equal(e[0].where.file, 'C:\\Sites\\shop\\index.php');
    assert.equal(e[0].where.line, 12);
  });

  it('log times become sortable numbers', () => {
    assert.ok(L().timeOf('2026-11-13 10:00:00') > L().timeOf('2026-11-13 09:00:00'));
    assert.equal(L().timeOf('nope'), null);
  });
});

// ------------------------------------------------------------------------------------------ prepend + shim
describe('dev tools prepend', () => {
  const T = () => lib('devtools.js');

  it('acts only while the panel heartbeat is fresh and never touches .env', () => {
    const php = T().PREPEND_PHP.replace(/\/\/.*$/gm, '');
    assert.match(php, /abs\(time\(\) - \(int\) \$c\['t'\]\) < \d+/);
    assert.doesNotMatch(php, /\.env/);
    assert.doesNotMatch(php, /file_put_contents|fwrite|unlink/);
    assert.match(php, /PHP_SAPI !== 'cli'/); // CLI dumps stay in the terminal
    assert.match(php, /PHPSTATION_MAIL_SET/); // switching off undoes putenv in long-running workers
  });

  it('live.json content', () => {
    assert.deepEqual(lib('devtools.js').liveContent({ mailPort: 1025, dumpPort: 0, pid: 7, now: 5000 }), { t: 5, pid: 7, mail: 1025, dumps: 0 });
  });

  it('php.bat adds the prepend and the project id', () => {
    const P = lib('projects.js');
    const php = { path: 'C:\\php\\php.exe' };
    const bat = P.buildPhpBat(php, { id: 'shop-1' }, null, 'C:\\PS\\data\\devtools\\prepend.php');
    assert.match(bat, /set "PHPSTATION_PROJECT=shop-1"/);
    assert.match(bat, /-d "auto_prepend_file=C:\\PS\\data\\devtools\\prepend\.php" %\*/);
    assert.equal(P.buildPhpBat(php, { id: 'shop-1' }, null), '@"C:\\php\\php.exe" %*\r\n');
    assert.doesNotMatch(P.buildPhpBat(php, { id: 'bad id&x' }, null, 'C:\\p.php'), /PHPSTATION_PROJECT/);
  });

  it('the share prepend chains the dev tools prepend', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'share.js'), 'utf8'), /devtools' \. DIRECTORY_SEPARATOR \. 'prepend\.php'/);
  });
});

// ------------------------------------------------------------------------------------------ settings
describe('Inbox settings', () => {
  const S = () => lib('state.js');
  it('defaults and validation', () => {
    const d = S().DEFAULT_SETTINGS;
    assert.equal(d.mailCatcher, true);
    assert.equal(d.mailPort, 1025);
    assert.equal(d.catchDumps, true);
    assert.equal(d.dumpPort, 9912);
    assert.equal(d.editor, 'vscode');
    const next = S().validateSettings({ mailPort: 2525, editor: 'phpstorm', catchDumps: false }, d);
    assert.equal(next.mailPort, 2525);
    assert.equal(next.editor, 'phpstorm');
    assert.equal(next.catchDumps, false);
    assert.throws(() => S().validateSettings({ mailPort: 25 }, d));
    assert.throws(() => S().validateSettings({ editor: 'notepad; calc' }, d));
    assert.throws(() => S().validateSettings({ mailCatcher: 'yes' }, d));
  });
});

// ------------------------------------------------------------------------------------------ open from GitHub
describe('open from GitHub', () => {
  const G = () => lib('gitclone.js');

  it('accepts GitHub/GitLab/ssh links and owner/repo', () => {
    assert.equal(G().parseRepoUrl('laravel/laravel').url, 'https://github.com/laravel/laravel.git');
    assert.equal(G().parseRepoUrl('https://github.com/laravel/laravel').url, 'https://github.com/laravel/laravel.git');
    assert.equal(G().parseRepoUrl('https://github.com/a/b/tree/main/src').url, 'https://github.com/a/b.git');
    assert.equal(G().parseRepoUrl('https://gitlab.com/grp/sub/proj').owner, 'grp/sub');
    assert.equal(G().parseRepoUrl('git@github.com:a/b.git').name, 'b');
  });

  it('refuses option-like, local, ext:: and credential links', () => {
    for (const bad of ['-oProxyCommand=x', 'ext::sh -c x', 'file:///c/x', 'https://user:tok@github.com/a/b', 'https://github.com/a', 'a/..', 'https://github.com/../x', 'C:\\repo', '"x"/y', 'a/b;calc']) {
      assert.equal(G().parseRepoUrl(bad), null, bad);
    }
  });

  it('folder names are Windows-safe', () => {
    assert.equal(G().folderName('my repo!'), 'my-repo');
    assert.equal(G().folderName('con'), 'project');
    assert.equal(G().folderName('..'), 'project');
  });

  it('without phpstation.json: the database comes from .env.example', () => {
    const T = lib('teamfile.js');
    assert.deepEqual(T.implicitFile('x', 'DB_CONNECTION=mysql\nDB_DATABASE=shop_db\n').database, { engine: 'mariadb', version: null, name: 'shop_db' });
    assert.equal(T.implicitFile('x', 'DB_CONNECTION=sqlite\n').database, null);
    assert.equal(T.implicitFile('x', 'DB_CONNECTION=mysql\nDB_DATABASE=bad name;\n').database.name, null);
  });
});
