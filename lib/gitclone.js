'use strict';
/*
 * Open from GitHub: paste a repository link -> PHP Station clones it into a projects folder, then
 * the team-file plan (lib/teamfile.js) takes over: right PHP, Composer, MariaDB, .env, key,
 * database, migrations, storage link. With a phpstation.json in the repository its settings win;
 * without one, sensible Laravel defaults are used.
 *
 *  - Uses the Git that is already installed (PATH, Git for Windows, Laragon's bundled git).
 *    Private repositories work through the normal Git credential manager (its sign-in window).
 *  - Only https:// and ssh (git@host:owner/repo) links; anything that could be read as an option or
 *    a local/"ext::" transport is refused, and the URL is passed after "--".
 *  - Never writes into an existing non-empty folder.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Link -> {url, name, host, owner, repo}. Accepts https://host/owner/repo(.git), git@host:owner/repo(.git),
 * ssh://git@host/owner/repo and "owner/repo" (GitHub). Returns null when not acceptable. PURE.
 */
function parseRepoUrl(input) {
  let s = String(input || '').trim();
  if (!s || s.length > 300 || /[\s"'`<>|;&$\\^%]/.test(s) || s.startsWith('-') || /::/.test(s)) return null;
  s = s.replace(/\/+$/, '');
  let m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s);
  if (m && !m[1].includes('.')) {
    if (m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
    return { url: `https://github.com/${m[1]}/${m[2]}.git`, host: 'github.com', owner: m[1], repo: m[2], name: m[2] };
  }
  m = /^https:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)\/((?:[A-Za-z0-9_.~-]+\/)*?)([A-Za-z0-9_.~-]+?)(?:\.git)?(?:\/(?:tree|blob|-)\/.*)?$/.exec(s);
  if (m) {
    const parts = m[2].split('/').filter(Boolean);
    if (!parts.length || parts.some((x) => x === '..' || x === '.')) return null;
    // a GitHub/GitLab page link (…/tree/main/src) -> the repository itself
    const base = `https://${m[1]}/${m[2]}${m[3]}`;
    return { url: /\.git$/.test(base) ? base : `${base}.git`, host: m[1].toLowerCase(), owner: parts.join('/'), repo: m[3], name: m[3] };
  }
  m = /^(?:ssh:\/\/)?([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+)(?::\d{1,5})?[:/]((?:[A-Za-z0-9_.~-]+\/)+)([A-Za-z0-9_.~-]+?)(?:\.git)?$/.exec(s);
  if (m) {
    const parts = m[3].split('/').filter(Boolean);
    if (parts.some((x) => x === '..' || x === '.')) return null;
    return { url: s, host: m[2].toLowerCase(), owner: parts.join('/'), repo: m[4], name: m[4] };
  }
  return null;
}

/** A folder name from a repository name (Windows-safe). PURE. */
function folderName(name) {
  const n = String(name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  return NAME_RE.test(n) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n) ? n : 'project';
}

/** git executable: PATH, Git for Windows, Laragon's bundled git. */
function findGit(ctx) {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  const dirs = String(process.env.PATH || '').split(path.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const extra = process.platform === 'win32' ? [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd'),
    ...((ctx && ctx.store.data.settings.runtimeRoots) || []).filter((r) => /laragon/i.test(r)).map((r) => win.join(r, 'bin', 'git', 'cmd')),
  ] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const d of [...dirs, ...extra]) {
    const f = path.join(d, exe);
    if (d && util.existsFile(f)) return f;
  }
  return null;
}

/** Default parent folder: the first projects folder (htdocs / www), else <user>\Projects. */
function defaultParent(ctx) {
  const roots = (ctx.store.data.settings.projectRoots || []).filter((r) => util.existsDir(r));
  if (roots.length) return roots[0];
  return path.join(process.env.USERPROFILE || process.env.HOME || 'C:\\', 'Projects');
}

/** GET /api/clone/info -> {git, parent} */
function info(ctx) {
  return { git: findGit(ctx), parent: defaultParent(ctx) };
}

/** Validates a clone request -> {repo, dest, parent, name}. Throws AppError. */
function check(ctx, { url, parent, name } = {}) {
  const repo = parseRepoUrl(url);
  if (!repo) throw new AppError('BAD_REPO_URL', tr('clone.badUrl'), 400);
  const par = util.checkUserPath(parent || defaultParent(ctx), { kind: 'dir', mustExist: false, label: tr('clone.parent') });
  if (util.existsFile(par)) throw new AppError('NOT_A_FOLDER', tr('path.notFolder', { path: par }));
  const folder = folderName(name || repo.name);
  if (name && folder !== name) throw new AppError('BAD_NAME', tr('clone.badName'), 400);
  const dest = win.join(par, folder);
  if (util.existsDir(dest) && util.listDirNames(dest).length + util.listFileNames(dest).length > 0) {
    throw new AppError('DEST_EXISTS', tr('clone.exists', { path: dest }), 409, { path: dest });
  }
  if (util.existsFile(dest)) throw new AppError('DEST_EXISTS', tr('clone.exists', { path: dest }), 409, { path: dest });
  return { repo, parent: par, name: folder, dest };
}

/** Background job: git clone --progress -- <url> <dest>. Result {path}. */
async function cloneJob(ctx, req, log, job) {
  const git = findGit(ctx);
  if (!git) throw new AppError('NO_GIT', tr('clone.noGit'), 409);
  util.ensureDir(req.parent);
  log('info', tr('clone.cloning', { url: req.repo.url, path: req.dest }));
  job.progress = { stage: 'clone', done: 0, total: 100 };
  let last = '';
  const onStderr = (d) => {
    // git progress lines end with \r; keep the newest one per phase
    for (const part of d.toString('utf8').split(/[\r\n]+/)) {
      const x = part.trim();
      if (!x) continue;
      const m = /^(Receiving objects|Resolving deltas|Updating files|remote: Compressing objects|remote: Counting objects):\s+(\d+)%/.exec(x);
      if (m) {
        const phase = m[1];
        const pct = Number(m[2]);
        job.progress = { stage: 'clone', done: phase === 'Receiving objects' ? Math.round(pct * 0.8) : phase === 'Resolving deltas' ? 80 + Math.round(pct * 0.1) : phase === 'Updating files' ? 90 + Math.round(pct * 0.1) : 0, total: 100, text: x.slice(0, 120) };
        if (phase !== last && pct === 100) { log('ok', x.slice(0, 200)); last = phase; }
        continue;
      }
      if (/^(Cloning into|fatal:|error:|warning:|remote: (Enumerating|Total))/.test(x)) log(/^(fatal|error)/.test(x) ? 'bad' : 'info', x.slice(0, 400));
    }
  };
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' });
  const r = await util.run(git, ['clone', '--progress', '--', req.repo.url, req.dest], { cwd: req.parent, env, timeoutMs: 30 * 60 * 1000, onStderr });
  if (r.code !== 0) {
    const tail = String(r.stderr || r.error || '').trim().split(/\r?\n/).filter((l) => /fatal|error|denied|not found|could not/i.test(l)).slice(-3).join(' ');
    const auth = /authentication|could not read username|permission denied|403|repository not found/i.test(r.stderr || '');
    throw new AppError(auth ? 'CLONE_AUTH' : 'CLONE_FAILED', auth ? tr('clone.authFail') : tr('clone.failed', { error: tail || r.error || `exit ${r.code}` }), 409);
  }
  job.progress = { stage: 'done', done: 100, total: 100 };
  log('ok', tr('clone.done', { path: req.dest }));
  return { path: req.dest, name: req.name };
}

module.exports = { parseRepoUrl, folderName, findGit, defaultParent, info, check, cloneJob };
