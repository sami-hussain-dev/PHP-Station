'use strict';
/*
 * Persistent panel state in <data>\state.json (atomic writes, pretty JSON) and settings
 * defaults/validation.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const i18n = require('./i18n');

const { AppError } = util;
const { tr } = i18n;
const win = path.win32;

// 'light'/'dark' are accepted for older saved settings; the UI offers black, silver and auto.
const THEMES = ['black', 'silver', 'auto', 'light', 'dark'];
const TOOL_DIR = path.resolve(__dirname, '..');

// Defaults never depend on this machine: dumps go to <tool>\backups (saved settings are kept).
const DEFAULT_SETTINGS = Object.freeze({
  panelPort: 7070,
  webPortRange: [8000, 8999],
  dbPortRange: [3310, 3399],
  projectRoots: null,
  runtimeRoots: null,
  extraPaths: [],
  dumpDir: path.join(TOOL_DIR, 'backups'),
  dbBindLocal: true,
  autoStartDb: true, // project start starts its DB server (or uses one already serving that datadir) without asking
  dbEnvOverride: true, // .env DB_PORT differs from the server really used -> DB_PORT in the PHP process env
  wizardDone: false, // the first-run Setup Wizard was finished or skipped
  shutdownGuard: true, // PHPStationGuard.exe stops DB servers cleanly on Windows shutdown / sign-out
  snapshotOnStart: 'daily', // copy of a stopped datadir before PHP Station starts it: daily | always | off
  snapshotKeep: 7, // automatic snapshots kept per server (manual / pre-repair ones are never removed)
  snapshotMaxMB: 4096, // bigger datadirs are not copied automatically (a dump still runs)
  dailyDump: true, // mariadb-dump of every database of a running server once a day
  dumpKeep: 7, // automatic dumps kept per server
  theme: 'black',
  lang: i18n.DEFAULT_LANG,
});

/** Top-level xampp/laragon/wamp folders on every drive, C:\composer and PATH folders with php.exe. */
function computeRuntimeRoots() {
  const roots = [];
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    let entries;
    try {
      entries = fs.readdirSync(drive, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!/xampp|laragon|wamp/i.test(e.name)) continue;
      const full = drive + e.name;
      if (e.isDirectory() || (e.isSymbolicLink() && util.existsDir(full))) roots.push(full);
    }
  }
  if (util.existsDir('C:\\composer')) roots.push('C:\\composer');
  for (const raw of String(process.env.PATH || '').split(';')) {
    const d = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !/^[A-Za-z]:\\/.test(util.toWinPath(d))) continue;
    if (util.existsFile(win.join(util.toWinPath(d), 'php.exe'))) roots.push(util.cleanPath(d));
  }
  return dedupePaths(roots);
}

function computeProjectRoots(runtimeRoots) {
  const out = [];
  for (const r of runtimeRoots || []) {
    for (const sub of ['htdocs', 'www']) {
      const p = win.join(r, sub);
      if (util.existsDir(p)) out.push(util.cleanPath(p));
    }
  }
  return dedupePaths(out);
}

function dedupePaths(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = util.normPath(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(util.cleanPath(p));
  }
  return out;
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * v1.1: portConfirmed (the port is asked once before the first run). Projects that already
 * ran keep their port without asking; the others are asked on their first start.
 */
function migrateProjects(projects) {
  for (const p of projects) {
    if (typeof p.portConfirmed !== 'boolean') p.portConfirmed = !!p.lastStartedAt;
  }
  return projects;
}

/** Loads (or creates) <data>\state.json and returns {file, data, save()}. */
function loadState(dataDir) {
  const file = path.join(dataDir, 'state.json');
  let data = util.readJson(file, null);
  if (!isObj(data)) data = {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, isObj(data.settings) ? data.settings : {});
  if (!Array.isArray(settings.runtimeRoots)) settings.runtimeRoots = computeRuntimeRoots();
  if (!Array.isArray(settings.projectRoots)) settings.projectRoots = computeProjectRoots(settings.runtimeRoots);
  if (!Array.isArray(settings.extraPaths)) settings.extraPaths = [];
  if (!THEMES.includes(settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
  if (!i18n.isLang(settings.lang)) settings.lang = DEFAULT_SETTINGS.lang;
  const projects = Array.isArray(data.projects) ? data.projects.filter((p) => isObj(p) && p.id && p.path) : [];
  migrateProjects(projects);
  const state = {
    schema: 1,
    settings,
    projects,
    runs: isObj(data.runs) ? data.runs : {},
    dbServers: isObj(data.dbServers) ? data.dbServers : {},
    dbRuns: isObj(data.dbRuns) ? data.dbRuns : {},
    pma: isObj(data.pma) ? data.pma : null,
    backupState: isObj(data.backupState) ? data.backupState : {},
    shortcuts: isObj(data.shortcuts) ? data.shortcuts : null,
  };
  const store = {
    file,
    data: state,
    save() {
      util.writeJsonAtomic(file, store.data);
    },
  };
  store.save();
  return store;
}

function checkRange(v, name) {
  if (!Array.isArray(v) || v.length !== 2) throw new AppError('BAD_SETTINGS', tr('set.rangeList', { name }));
  const a = Number(v[0]);
  const b = Number(v[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1024 || b > 65535 || a > b) {
    throw new AppError('BAD_SETTINGS', tr('set.rangeBad', { name }));
  }
  if (b - a > 20000) throw new AppError('BAD_SETTINGS', tr('set.rangeTooBig', { name }));
  return [a, b];
}

function checkDirList(v, name) {
  if (!Array.isArray(v)) throw new AppError('BAD_SETTINGS', tr('set.dirList', { name }));
  if (v.length > 50) throw new AppError('BAD_SETTINGS', tr('set.dirListMax', { name }));
  return dedupePaths(v.map((p) => util.checkUserPath(p, { kind: 'dir', label: name })));
}

/** Validates a partial settings object and returns the merged settings (throws AppError). */
function validateSettings(partial, current) {
  if (!isObj(partial)) throw new AppError('BAD_SETTINGS', tr('set.notObject'));
  const next = Object.assign({}, current);
  for (const [key, val] of Object.entries(partial)) {
    switch (key) {
      case 'panelPort': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new AppError('BAD_SETTINGS', tr('set.panelPort'));
        next.panelPort = n;
        break;
      }
      case 'webPortRange':
        next.webPortRange = checkRange(val, tr('label.webPortRange'));
        break;
      case 'dbPortRange':
        next.dbPortRange = checkRange(val, tr('label.dbPortRange'));
        break;
      case 'projectRoots':
        next.projectRoots = checkDirList(val, tr('label.projectFolder'));
        break;
      case 'runtimeRoots':
        next.runtimeRoots = checkDirList(val, tr('label.runtimeFolder'));
        break;
      case 'extraPaths': {
        if (!Array.isArray(val) || val.length > 100) throw new AppError('BAD_SETTINGS', tr('set.extraPaths'));
        next.extraPaths = dedupePaths(val.map((p) => util.checkUserPath(p, { kind: 'file', label: tr('label.path') })));
        break;
      }
      case 'dumpDir': {
        const p = util.checkUserPath(val, { mustExist: false, label: tr('label.dumpFolder') });
        if (util.existsFile(p)) throw new AppError('BAD_SETTINGS', tr('set.dumpDirIsFile', { path: p }));
        next.dumpDir = p;
        break;
      }
      case 'dbBindLocal':
        if (typeof val !== 'boolean') throw new AppError('BAD_SETTINGS', tr('set.dbBindLocal'));
        next.dbBindLocal = val;
        break;
      case 'snapshotOnStart':
        if (!['daily', 'always', 'off'].includes(val)) throw new AppError('BAD_SETTINGS', tr('set.snapshotOnStart'));
        next.snapshotOnStart = val;
        break;
      case 'snapshotKeep':
      case 'dumpKeep':
      case 'snapshotMaxMB': {
        const n = Number(val);
        const [lo, hi] = key === 'snapshotMaxMB' ? [100, 1024 * 1024] : [1, 100];
        if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError('BAD_SETTINGS', tr('set.numberRange', { key, lo, hi }));
        next[key] = n;
        break;
      }
      case 'shutdownGuard':
      case 'dailyDump':
      case 'autoStartDb':
      case 'dbEnvOverride':
      case 'wizardDone':
        if (typeof val !== 'boolean') throw new AppError('BAD_SETTINGS', tr('set.boolean', { key }));
        next[key] = val;
        break;
      case 'theme':
        if (!THEMES.includes(val)) throw new AppError('BAD_SETTINGS', tr('set.theme'));
        next.theme = val;
        break;
      case 'lang':
        if (!i18n.isLang(val)) throw new AppError('BAD_INPUT', tr('set.lang'), 400);
        next.lang = val;
        break;
      default:
        throw new AppError('BAD_SETTINGS', tr('set.unknown', { key: String(key).slice(0, 40) }));
    }
  }
  return next;
}

module.exports = { DEFAULT_SETTINGS, loadState, validateSettings, computeRuntimeRoots, computeProjectRoots, dedupePaths, migrateProjects };
