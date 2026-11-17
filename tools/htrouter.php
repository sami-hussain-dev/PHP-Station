<?php
/*
 * PHP Station .htaccess router: the `php -S` router of fastserve workers when a project's .htaccess
 * is applied (tools\fastserve.js --htaccess). fastserve has already worked out the rules; for a
 * rewrite to a PHP script it sends the ORIGINAL URL plus the internal X-PS-Ht header
 * (base64 of "token \n /script.php \n query \n status"). This file then runs that script the way
 * Apache + mod_php would: REQUEST_URI stays as the browser sent it, SCRIPT_NAME / PHP_SELF /
 * SCRIPT_FILENAME / QUERY_STRING / $_GET describe the rewritten target.
 * Without the header (no rule applied) it returns false and `php -S` serves the request as usual.
 * The token is random per fastserve run (env PS_HT_TOKEN), so nothing else can steer this router.
 */
$__ps_ht = isset($_SERVER['HTTP_X_PS_HT']) ? $_SERVER['HTTP_X_PS_HT'] : null;
unset($_SERVER['HTTP_X_PS_HT']);
if ($__ps_ht === null) {
    unset($__ps_ht);
    return false;
}
$__ps_parts = explode("\n", (string) base64_decode($__ps_ht, true), 4);
$__ps_token = (string) getenv('PS_HT_TOKEN');
if (count($__ps_parts) !== 4 || $__ps_token === '' || !hash_equals($__ps_token, $__ps_parts[0])) {
    http_response_code(403);
    echo 'PHP Station: bad internal header';
    return true;
}
$__ps_root = realpath($_SERVER['DOCUMENT_ROOT']);
$__ps_file = realpath($__ps_root . str_replace('/', DIRECTORY_SEPARATOR, $__ps_parts[1]));
if ($__ps_file === false || !is_file($__ps_file) || strncasecmp($__ps_file, $__ps_root . DIRECTORY_SEPARATOR, strlen($__ps_root) + 1) !== 0) {
    http_response_code(404);
    echo '<h1>404 Not Found</h1>';
    return true;
}
$_SERVER['SCRIPT_NAME'] = $__ps_parts[1];
$_SERVER['PHP_SELF'] = $__ps_parts[1];
$_SERVER['SCRIPT_FILENAME'] = $__ps_file;
$_SERVER['QUERY_STRING'] = $__ps_parts[2];
$_GET = array();
parse_str($__ps_parts[2], $_GET);
$_REQUEST = array_merge($_GET, $_POST);
if ((int) $__ps_parts[3] > 0) {
    http_response_code((int) $__ps_parts[3]);
}
chdir(dirname($__ps_file));
// the script runs in the global scope (WordPress and friends rely on that)
$__ps_run = $__ps_file;
unset($__ps_ht, $__ps_parts, $__ps_token, $__ps_root, $__ps_file);
require $__ps_run;
return true;
