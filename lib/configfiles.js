'use strict';
/*
 * Config & log files of a project, one click away: .env, the php.ini and my.ini it really runs with,
 * laravel.log, the DB server's error log, .htaccess, composer.json and the Windows hosts file.
 *
 *  - The browser never sends a path: it sends a key from list(), and the path is looked up again here.
 *  - php.ini: the PHP folder's own php.ini is opened, also when PHP Station runs a relocated copy
 *    (data\php-ini), because that copy is rebuilt from the original whenever the original changes.
 *  - Opened with the editor from Settings (VS Code, Cursor, PhpStorm, Sublime Text) when it is
 *    installed, else with Notepad. "folder" shows the file selected in Explorer.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const util = require('./util');
const projects = require('./projects');
const dbservers = require('./dbservers');
const { tr } = require('./i18n');

const { AppError } = util;
const KEYS = Object.freeze(['env', 'phpIni', 'myIni', 'laravelLog', 'dbErrorLog', 'htaccess', 'composerJson', 'hosts']);
const HOWS = Object.freeze(['editor', 'notepad', 'folder']);

function firstExisting(list) {
  return list.find((f) => f && util.existsFile(f)) || null;
}

/** The files of a project: [{key, path, exists}]. */
function list(ctx, projectId) {
  const p = projects.getProject(ctx, projectId);
  const out = [];
  const add = (key, file, extra = {}) => out.push(Object.assign({ key, path: file || null, exists: !!(file && util.existsFile(file)) }, extra));
  add('env', path.join(p.path, '.env'));
  let php = null;
  try { php = projects.resolveProjectPhp(ctx, p); } catch { php = null; }
  const phpDir = php && (php.dir || (php.path ? path.dirname(php.path) : null));
  add('phpIni', phpDir ? path.join(phpDir, 'php.ini') : null, { relocated: !!(php && php.iniRelocated), version: php ? php.version : null });
  let db = null;
  try { db = projects.dbEntryFor(ctx, p); } catch { db = null; }
  add('myIni', db ? db.defaultsFile : null, { server: db ? db.label : null });
  add('laravelLog', path.join(p.path, 'storage', 'logs', 'laravel.log'));
  let elog = null;
  try { elog = db ? dbservers.errorLogPath(db) : null; } catch { elog = null; }
  add('dbErrorLog', elog);
  add('htaccess', firstExisting([path.join(p.path, 'public', '.htaccess'), path.join(p.path, '.htaccess')]) || path.join(p.path, 'public', '.htaccess'));
  add('composerJson', path.join(p.path, 'composer.json'));
  add('hosts', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts'));
  return { items: out, editor: (ctx.store.data.settings.editor || 'vscode') };
}

/** Where the editor from Settings is installed (null when it isn't). */
function editorExe(editor) {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = {
    vscode: [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')],
    cursor: [path.join(local, 'Programs', 'cursor', 'Cursor.exe'), path.join(local, 'Programs', 'Cursor', 'Cursor.exe')],
    sublime: [path.join(pf, 'Sublime Text', 'sublime_text.exe'), path.join(pf, 'Sublime Text 3', 'sublime_text.exe')],
    phpstorm: [],
  }[editor] || [];
  if (editor === 'phpstorm') {
    for (const root of [path.join(pf, 'JetBrains'), path.join(pf86, 'JetBrains'), path.join(local, 'Programs')]) {
      for (const d of util.listDirNames(root).filter((n) => /phpstorm/i.test(n)).sort().reverse()) {
        candidates.push(path.join(root, d, 'bin', 'phpstorm64.exe'));
      }
    }
  }
  return firstExisting(candidates);
}

function launch(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

/** Opens one file of list() by its key. -> {ok, with: 'vscode' | 'notepad' | 'folder' | ...}. */
function open(ctx, projectId, key, how = 'editor') {
  if (!KEYS.includes(key)) throw new AppError('BAD_INPUT', tr('cf.badKey'), 400);
  if (!HOWS.includes(how)) throw new AppError('BAD_INPUT', tr('cf.badKey'), 400);
  const item = list(ctx, projectId).items.find((x) => x.key === key);
  if (!item || !item.path) throw new AppError('NOT_FOUND', tr('cf.none'), 404);
  if (!item.exists) {
    // .env and .htaccess may simply not be there yet: show the folder instead of failing
    const dir = path.dirname(item.path);
    if (how !== 'folder' && util.existsDir(dir) && (key === 'env' || key === 'htaccess')) {
      launch('explorer.exe', [dir]);
      return { ok: true, with: 'folder', missing: true };
    }
    throw new AppError('NOT_FOUND', tr('cf.missing', { path: item.path }), 404);
  }
  if (how === 'folder') {
    launch('explorer.exe', [`/select,${item.path}`]);
    return { ok: true, with: 'folder' };
  }
  const editor = ctx.store.data.settings.editor || 'vscode';
  const exe = how === 'editor' && editor !== 'none' ? editorExe(editor) : null;
  if (exe) {
    launch(exe, [item.path]);
    return { ok: true, with: editor };
  }
  launch(path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe'), [item.path]);
  return { ok: true, with: 'notepad' };
}

module.exports = { KEYS, list, open, editorExe };
