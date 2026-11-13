'use strict';
/*
 * Dev tools glue: one small PHP auto_prepend_file used by every project PHP Station starts (and by
 * its php shim, so `php artisan queue:work` mails are caught too).
 *
 *  - The prepend reads <data>\devtools\live.json, which ONLY the running panel writes (with a
 *    heartbeat). Panel closed or crashed -> the file is missing or stale -> the prepend does nothing,
 *    and the app sends mail / shows dumps exactly as configured in its .env.
 *  - Mail: MAIL_MAILER/MAIL_HOST/MAIL_PORT... for this request (putenv + $_ENV + $_SERVER, so Laravel's
 *    immutable dotenv keeps them) -> the Mail Catcher. PHP's mail(): SMTP/smtp_port (Windows).
 *  - dump()/dd(): VAR_DUMPER_FORMAT=server -> Symfony's ServerDumper sends them to the Dumps server
 *    (lib/dumps.js) instead of printing into the page. Web requests only; CLI dumps stay in the terminal.
 *  - The .env file is never touched.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');

const HEARTBEAT_MS = 30000;
const STALE_S = 120;

function dir(ctx) { return path.join(ctx.dataDir, 'devtools'); }
function liveFile(ctx) { return path.join(dir(ctx), 'live.json'); }

const PREPEND_PHP = `<?php
// PHP Station dev tools (auto_prepend_file). Catches mail and dump() while the PHP Station panel runs.
// It reads live.json next to this file; when the panel is closed it does nothing. The .env is never changed.
(static function () {
    $f = __DIR__ . DIRECTORY_SEPARATOR . 'live.json';
    $c = is_file($f) ? json_decode((string) @file_get_contents($f), true) : null;
    $live = is_array($c) && isset($c['t']) && abs(time() - (int) $c['t']) < ${STALE_S};
    $keys = ['MAIL_MAILER', 'MAIL_DRIVER', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_ENCRYPTION', 'MAIL_SCHEME', 'MAIL_USERNAME', 'MAIL_PASSWORD', 'MAIL_URL'];
    if ($live && !empty($c['mail'])) {
        $port = (string) (int) $c['mail'];
        $p = getenv('PHPSTATION_PROJECT');
        $v = ['smtp', 'smtp', '127.0.0.1', $port, 'null', 'smtp', 'phpstation-' . ($p !== false && $p !== '' ? $p : 'app'), 'phpstation', 'null'];
        foreach ($keys as $i => $k) { putenv($k . '=' . $v[$i]); $_ENV[$k] = $v[$i]; $_SERVER[$k] = $v[$i]; }
        putenv('PHPSTATION_MAIL_SET=1');
        @ini_set('SMTP', '127.0.0.1');
        @ini_set('smtp_port', $port);
        if ((string) ini_get('sendmail_from') === '') @ini_set('sendmail_from', 'app@phpstation.test');
    } elseif (getenv('PHPSTATION_MAIL_SET') === '1') {
        // the catcher was switched off while this PHP process kept running: undo what an earlier request set
        foreach ($keys as $k) { putenv($k); unset($_ENV[$k], $_SERVER[$k]); }
        putenv('PHPSTATION_MAIL_SET');
    }
    if ($live && !empty($c['dumps']) && PHP_SAPI !== 'cli' && !isset($_SERVER['VAR_DUMPER_FORMAT'])) {
        $_SERVER['VAR_DUMPER_FORMAT'] = 'server';
        $_SERVER['VAR_DUMPER_SERVER'] = '127.0.0.1:' . (int) $c['dumps'];
    }
})();
`;

/** <data>\devtools\prepend.php (rewritten when its content differs). */
function prependFile(ctx) {
  const f = path.join(dir(ctx), 'prepend.php');
  if (util.readText(f, null) !== PREPEND_PHP) {
    util.ensureDir(dir(ctx));
    fs.writeFileSync(f, PREPEND_PHP);
  }
  return f;
}

/** What the prepend should do now. PURE. */
function liveContent({ mailPort = 0, dumpPort = 0, pid = 0, now = Date.now() } = {}) {
  return { t: Math.floor(now / 1000), pid, mail: mailPort || 0, dumps: dumpPort || 0 };
}

function writeLive(ctx) {
  const mail = ctx.mail && ctx.mail.listening ? ctx.mail.port : 0;
  const dumps = ctx.dumps && ctx.dumps.listening ? ctx.dumps.port : 0;
  try {
    util.ensureDir(dir(ctx));
    util.writeJsonAtomic(liveFile(ctx), liveContent({ mailPort: mail, dumpPort: dumps, pid: process.pid }));
  } catch (e) { ctx.log(`devtools live.json: ${e.message}`); }
}

function removeLive(ctx) {
  try {
    const cur = util.readJson(liveFile(ctx), null);
    if (!cur || cur.pid === process.pid) fs.unlinkSync(liveFile(ctx));
  } catch { /* already gone */ }
}

/** Keeps live.json fresh while the panel runs. */
function startHeartbeat(ctx) {
  prependFile(ctx);
  writeLive(ctx);
  const t = setInterval(() => writeLive(ctx), HEARTBEAT_MS);
  if (t.unref) t.unref();
  return t;
}

/** php -d arguments that add the prepend (a project's own auto_prepend_file is chained by the share prepend only). */
function phpArgs(ctx) {
  return ['-d', `auto_prepend_file=${prependFile(ctx)}`];
}

module.exports = { PREPEND_PHP, STALE_S, prependFile, liveContent, writeLive, removeLive, startHeartbeat, phpArgs, liveFile };
