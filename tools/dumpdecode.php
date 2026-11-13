<?php
/*
 * PHP Station: decodes dumps sent by Symfony VarDumper's ServerDumper (VAR_DUMPER_FORMAT=server).
 *
 *   php dumpdecode.php <project>\vendor
 *
 * One JSON request per stdin line {"id":1,"payload":"<base64 line from the dump server>"} ->
 * one JSON answer per stdout line {"id":1,"ok":true,"tree":{...},"text":"...","context":{...}}.
 *
 * Safety: only symfony/var-dumper's own classes are autoloaded (no project code, no composer "files"),
 * and unserialize() may only create VarDumper's Data / Stub classes, so a payload can never build any
 * other object of the project.
 */
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', 'stderr');
ini_set('memory_limit', '512M');

$vendor = isset($argv[1]) ? rtrim($argv[1], '\\/') : '';
$base = $vendor . DIRECTORY_SEPARATOR . 'symfony' . DIRECTORY_SEPARATOR . 'var-dumper';
if ($vendor === '' || !is_dir($base)) {
    fwrite(STDOUT, json_encode(['fatal' => 'NO_VAR_DUMPER']) . "\n");
    exit(2);
}
spl_autoload_register(static function ($class) use ($base) {
    $prefix = 'Symfony\\Component\\VarDumper\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) return;
    $f = $base . DIRECTORY_SEPARATOR . str_replace('\\', DIRECTORY_SEPARATOR, substr($class, strlen($prefix))) . '.php';
    if (is_file($f)) require $f;
});

/** VarDumper's own value classes: Cloner\Data, Cloner\Stub and every Caster\*Stub. */
function phpstation_allowed_classes($base)
{
    $out = ['Symfony\\Component\\VarDumper\\Cloner\\Data', 'Symfony\\Component\\VarDumper\\Cloner\\Stub'];
    foreach (glob($base . DIRECTORY_SEPARATOR . 'Caster' . DIRECTORY_SEPARATOR . '*Stub.php') ?: [] as $f) {
        $out[] = 'Symfony\\Component\\VarDumper\\Caster\\' . basename($f, '.php');
    }
    return $out;
}

/** Builds a JSON tree through VarDumper's DumperInterface (stable since Symfony 3). */
final class PhpStationTreeDumper implements Symfony\Component\VarDumper\Cloner\DumperInterface
{
    const MAX_NODES = 5000;
    const MAX_STR = 5000;
    public $root = null;
    public $nodes = 0;
    public $truncated = false;
    private $stack = [];

    private function keyOf($cursor)
    {
        if ($cursor->depth === 0 || $cursor->hashKey === null) return null;
        $key = $cursor->hashKey;
        switch ($cursor->hashType) {
            case 2: // Cursor::HASH_INDEXED (a list)
                return ['k' => $key, 'kt' => 'index'];
            case 1: // Cursor::HASH_ASSOC
                return ['k' => $key, 'kt' => is_int($key) ? 'index' : 'key'];
            case 5: // resource
                return ['k' => (string) $key, 'kt' => 'meta'];
            case 4: // object
                $key = (string) $key;
                if (!isset($key[0]) || $key[0] !== "\0") return ['k' => $key, 'kt' => 'public'];
                $p = strpos($key, "\0", 1);
                if ($p === false) return ['k' => substr($key, 1), 'kt' => 'public'];
                $scope = substr($key, 1, $p - 1);
                $name = substr($key, $p + 1);
                if ($scope === '+') return ['k' => $name, 'kt' => 'dynamic'];
                if ($scope === '~') return ['k' => $name, 'kt' => 'meta'];
                if ($scope === '*') return ['k' => $name, 'kt' => 'protected'];
                return ['k' => $name, 'kt' => 'private', 'scope' => $scope];
        }
        return ['k' => is_scalar($key) ? $key : '?', 'kt' => 'key'];
    }

    private function add(array $node, $cursor)
    {
        if ($this->nodes >= self::MAX_NODES) { $this->truncated = true; return null; }
        $this->nodes++;
        $k = $this->keyOf($cursor);
        if ($k !== null) $node = $k + $node;
        if (!empty($cursor->hardRefTo)) $node['hardRef'] = $cursor->hardRefTo;
        if ($this->stack) {
            $top = &$this->stack[count($this->stack) - 1];
            $top['c'][] = $node;
            $idx = count($top['c']) - 1;
            return [&$top['c'][$idx]];
        }
        $this->root = $node;
        return [&$this->root];
    }

    public function dumpScalar($cursor, $type, $value): void
    {
        if (is_float($value) && (is_nan($value) || is_infinite($value))) $value = (string) $value;
        $this->add(['t' => (string) $type, 'v' => $value], $cursor);
    }

    public function dumpString($cursor, $str, $bin, $cut): void
    {
        $len = strlen($str) + (int) $cut;
        $shown = strlen($str) > self::MAX_STR ? substr($str, 0, self::MAX_STR) : $str;
        $node = ['t' => 'string', 'v' => $shown, 'len' => $len];
        if ($bin) $node['bin'] = true;
        if ($cut > 0 || strlen($str) > self::MAX_STR) $node['cut'] = $len - strlen($shown);
        $this->add($node, $cursor);
    }

    public function enterHash($cursor, $type, $class, $hasChild): void
    {
        $t = $type === 4 ? 'object' : ($type === 5 ? 'resource' : 'array');
        $node = ['t' => $t, 'c' => []];
        if ($t === 'array') $node['n'] = (int) $class;
        else $node['cls'] = (string) $class;
        if (!empty($cursor->softRefHandle)) $node['id'] = $cursor->softRefHandle;
        if (!empty($cursor->softRefTo)) $node['ref'] = $cursor->softRefTo;
        if ($type === 2) $node['list'] = true;
        $ref = $this->add($node, $cursor);
        if ($ref === null) { $dummy = ['c' => []]; $this->stack[] = &$dummy; unset($dummy); return; }
        $this->stack[] = &$ref[0];
    }

    public function leaveHash($cursor, $type, $class, $hasChild, $cut): void
    {
        $n = count($this->stack) - 1;
        if ($n < 0) return;
        if ($cut > 0) $this->stack[$n]['cut'] = (int) $cut;
        if (empty($this->stack[$n]['c'])) unset($this->stack[$n]['c']);
        array_pop($this->stack);
    }
}

$allowed = phpstation_allowed_classes($base);
$flags = (defined('JSON_INVALID_UTF8_SUBSTITUTE') ? JSON_INVALID_UTF8_SUBSTITUTE : 0) | (defined('JSON_PARTIAL_OUTPUT_ON_ERROR') ? JSON_PARTIAL_OUTPUT_ON_ERROR : 0) | JSON_UNESCAPED_SLASHES;

function phpstation_plain($v, $depth = 0)
{
    if ($depth > 4) return null;
    if (is_scalar($v) || $v === null) return is_string($v) && strlen($v) > 4000 ? substr($v, 0, 4000) : $v;
    if (is_array($v)) {
        $o = [];
        foreach (array_slice($v, 0, 50, true) as $k => $x) {
            if ($k === 'file_excerpt') continue;
            $o[$k] = phpstation_plain($x, $depth + 1);
        }
        return $o;
    }
    return null; // Data objects in the context (e.g. a controller) are left out
}

fwrite(STDOUT, json_encode(['ready' => true, 'pid' => getmypid()]) . "\n");
while (($line = fgets(STDIN)) !== false) {
    $req = json_decode($line, true);
    if (!is_array($req) || !isset($req['id'], $req['payload'])) continue;
    $out = ['id' => $req['id']];
    try {
        $raw = base64_decode((string) $req['payload'], true);
        $val = $raw === false ? false : @unserialize($raw, ['allowed_classes' => $allowed]);
        if (!is_array($val) || !isset($val[0]) || !($val[0] instanceof Symfony\Component\VarDumper\Cloner\Data)) {
            throw new RuntimeException('not a VarDumper payload');
        }
        $data = $val[0];
        $context = isset($val[1]) && is_array($val[1]) ? $val[1] : [];
        $tree = new PhpStationTreeDumper();
        $data->dump($tree);
        $cli = new Symfony\Component\VarDumper\Dumper\CliDumper(null, null, 0);
        $cli->setColors(false);
        $text = (string) $cli->dump($data, true);
        if (strlen($text) > 200000) $text = substr($text, 0, 200000) . "\n…";
        $label = null;
        if (method_exists($data, 'getContext')) {
            $dc = $data->getContext();
            if (isset($dc['label']) && is_scalar($dc['label'])) $label = (string) $dc['label'];
        }
        $out += ['ok' => true, 'tree' => $tree->root, 'truncated' => $tree->truncated, 'text' => $text, 'label' => $label, 'context' => phpstation_plain($context)];
    } catch (Throwable $e) {
        $out += ['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()];
    }
    $json = json_encode($out, $flags);
    if ($json === false) $json = json_encode(['id' => $req['id'], 'ok' => false, 'error' => 'json']);
    fwrite(STDOUT, $json . "\n");
}
