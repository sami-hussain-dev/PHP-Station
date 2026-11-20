'use strict';
/*
 * PHP Station for AI coding agents (Model Context Protocol, stdio transport).
 *
 * tools/mcp.js reads JSON-RPC messages from stdin and answers through createServer() below. Every
 * tool talks to the running panel's own HTTP API (127.0.0.1, per-start token from panel.json), so an
 * agent can do exactly what the panel can and nothing more: read the Inbox (mail, dumps, errors), see
 * and undo database writes with the DB Time Machine, save restore points, start and stop projects.
 *
 * This file is PURE apart from the injected `call(method, path, body)` and `waitJob(id)`, so the
 * protocol and the tools are tested without a panel (tests/mcp.test.js).
 */

const path = require('path');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'PHP Station runs this Windows PC\'s local PHP / Laravel projects, each on its own PHP version, Composer and MariaDB server.',
  'Use it to see what the app really did: caught emails (OTP codes, password-reset links), dump() output, grouped laravel.log errors, every INSERT / UPDATE / DELETE on the project database.',
  'Before you run anything that can destroy data (migrate:fresh, db:wipe, a big UPDATE or DELETE, an import), call create_restore_point. If something went wrong, list_restore_points + restore_database, or db_history + undo_db_action for a single write.',
  'Emails never leave the PC: everything the app sends lands in list_mail / read_mail.',
  'The `project` argument takes a project id, name or folder; leave it out to use the project of the current folder.',
].join('\n');

// ------------------------------------------------------------------------------------------ tool list

const P_ARG = { type: 'string', description: 'Project id, name or folder. Optional: defaults to the project that contains the current folder, or the only running project.' };

const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'All projects in PHP Station: status, local URL, PHP version, Laravel version, database server and the count of new errors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'project_errors',
    title: 'Errors from laravel.log',
    description: 'Errors of a project from storage/logs/*.log and the PHP server log, grouped (the same error 500 times is one row with its count), newest first, with the app file:line and the app stack frames (vendor frames left out).',
    inputSchema: {
      type: 'object',
      properties: {
        project: P_ARG,
        level: { type: 'string', enum: ['errors', 'warnings', 'all'], description: 'Default: errors.' },
        search: { type: 'string', description: 'Only entries whose message, exception or file contains this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'project_log',
    title: 'PHP server log',
    description: 'The last lines of the PHP server log of a project (start lines, fatal errors, warnings printed by php -S).',
    inputSchema: { type: 'object', properties: { project: P_ARG, lines: { type: 'integer', minimum: 10, maximum: 500, description: 'Default 80.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_mail',
    title: 'Caught emails',
    description: 'Emails the projects sent, caught by PHP Station\'s Mail Catcher (nothing is ever delivered). Newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only mail of this project (id, name or folder). Leave out for all projects.' },
        search: { type: 'string', description: 'Text in the subject, sender or recipients.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_mail',
    title: 'Read one email',
    description: 'One caught email: subject, sender, recipients, the text body, every link in it and the numbers that look like one-time codes (OTP). Use it to finish a sign-up, password reset or 2FA flow while testing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Mail id from list_mail.' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_dumps',
    title: 'dump() output',
    description: 'dump() / dd() output of web requests, with the file:line that called it and the URL. Newest first.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Only dumps of this project. Leave out for all projects.' }, limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 5.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'db_history',
    title: 'Database writes',
    description: 'Every INSERT / UPDATE / DELETE on the project database, newest first, with its SQL and old / new values. Each action has an id for undo_db_action. Needs a MariaDB server started by PHP Station.',
    inputSchema: {
      type: 'object',
      properties: {
        project: P_ARG,
        table: { type: 'string', description: 'Only this table.' },
        op: { type: 'string', enum: ['INSERT', 'UPDATE', 'DELETE'] },
        search: { type: 'string', description: 'For example id=21, or any value.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'undo_db_action',
    title: 'Undo one database write',
    description: 'Reverses ONE action from db_history (a deleted row comes back, an update gets its old values) and leaves everything else as it is. The undo is recorded too, so it can be undone.',
    inputSchema: { type: 'object', properties: { project: P_ARG, id: { type: 'string', description: 'Action id from db_history.' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_restore_points',
    title: 'Restore points',
    description: 'Saved copies of the project database (made by hand, or automatically before php artisan migrate / db:*), newest first.',
    inputSchema: { type: 'object', properties: { project: P_ARG }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_restore_point',
    title: 'Save a restore point',
    description: 'Saves the whole project database now, so it can be brought back with restore_database. Call it before anything that can destroy data.',
    inputSchema: { type: 'object', properties: { project: P_ARG }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'restore_database',
    title: 'Go back to a restore point',
    description: 'Replaces the project database with a restore point. The current state is saved as a new restore point first and the point is test-imported before the real database is touched, so this can be undone.',
    inputSchema: { type: 'object', properties: { project: P_ARG, point: { type: 'string', description: 'Restore point name from list_restore_points.' } }, required: ['point'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'start_project',
    title: 'Start a project',
    description: 'Starts the project on its own PHP version (and its database server when it is stopped). Returns the local URL.',
    inputSchema: { type: 'object', properties: { project: P_ARG }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'stop_project',
    title: 'Stop a project',
    description: 'Stops the project\'s PHP server. Its database server keeps running.',
    inputSchema: { type: 'object', properties: { project: P_ARG }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'doctor',
    title: 'Health check',
    description: 'PHP Station\'s health check: broken PHP installs, project and database server problems, slow database settings, disk space. Each finding comes with its fix.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ------------------------------------------------------------------------------------------ helpers (PURE)

class ToolError extends Error {}

/** Shortens long strings and arrays so one answer never floods the agent's context. PURE. */
function trim(v, { str = 2000, arr = 50, depth = 6 } = {}) {
  if (typeof v === 'string') return v.length > str ? `${v.slice(0, str)}… (${v.length - str} more characters)` : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth <= 0) return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  if (Array.isArray(v)) {
    const out = v.slice(0, arr).map((x) => trim(x, { str, arr, depth: depth - 1 }));
    if (v.length > arr) out.push(`… ${v.length - arr} more`);
    return out;
  }
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || x === null || x === '') continue;
    o[k] = trim(x, { str, arr, depth: depth - 1 });
  }
  return o;
}

function normDir(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * The project an argument names: id, name (case-insensitive), folder, or a unique part of the name.
 * Without an argument: the project whose folder holds `cwd` (deepest wins), else the only running one.
 * PURE.
 */
function resolveProject(projects, arg, cwd) {
  const list = Array.isArray(projects) ? projects : [];
  const names = () => list.map((p) => `${p.name} (${p.id})`).join(', ') || 'none';
  if (arg !== undefined && arg !== null && String(arg).trim() !== '') {
    const a = String(arg).trim();
    const al = a.toLowerCase();
    const exact = list.find((p) => p.id === a) || list.find((p) => String(p.name).toLowerCase() === al)
      || list.find((p) => /[\\/:]/.test(a) && normDir(p.path) === normDir(a));
    if (exact) return exact;
    const part = list.filter((p) => String(p.name).toLowerCase().includes(al));
    if (part.length === 1) return part[0];
    throw new ToolError(part.length ? `"${a}" matches more than one project: ${part.map((p) => p.name).join(', ')}.` : `No project "${a}". Projects: ${names()}.`);
  }
  if (cwd) {
    const c = normDir(cwd);
    const inside = list.filter((p) => p.path && (c === normDir(p.path) || c.startsWith(`${normDir(p.path)}\\`) || c.startsWith(`${normDir(p.path)}/`)));
    inside.sort((x, y) => normDir(y.path).length - normDir(x.path).length);
    if (inside.length) return inside[0];
  }
  const running = list.filter((p) => p.status === 'running');
  if (running.length === 1) return running[0];
  throw new ToolError(`Say which project (argument "project"). Projects: ${names()}.`);
}

/** Links and one-time-code-like numbers in a mail. PURE. */
function mailExtras(subject, text) {
  const body = `${subject || ''}\n${text || ''}`;
  const links = [...new Set((body.match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 30);
  const noLinks = body.replace(/https?:\/\/\S+/g, ' ');
  const codes = [...new Set(noLinks.match(/(?<![\d.,:/-])\d{4,8}(?![\d.,:/-])/g) || [])]
    .filter((n) => !/^(19|20)\d{2}$/.test(n)) // years
    .slice(0, 10);
  return { links, codes };
}

/** Readable text of an HTML mail. PURE. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function projectSummary(p) {
  return trim({
    id: p.id, name: p.name, folder: p.path, status: p.status, url: p.url,
    php: p.phpVersion, laravel: p.info && p.info.laravel, database: p.info && p.info.env && p.info.env.database,
    dbServer: p.db ? `${p.db.label} on port ${p.db.port} (${p.db.status})` : null,
    newErrors: p.newErrors || 0, liveLink: p.share && p.share.url,
  });
}

function errorGroup(g) {
  const e = g.entry || {};
  return trim({
    count: g.count, new: g.newCount || 0, last: g.lastTime, level: e.level,
    message: e.message, exception: e.exception ? `${e.exception.class}: ${e.exception.message}` : null,
    at: e.where ? `${e.where.file}${e.where.line ? `:${e.where.line}` : ''}` : null,
    appFrames: (e.frames || []).filter((f) => f && f.file && !f.vendor).slice(0, 8).map((f) => `${f.file}${f.line ? `:${f.line}` : ''} ${f.call || ''}`.trim()),
  }, { str: 1500 });
}

// ------------------------------------------------------------------------------------------ tools

/**
 * Tool implementations. `api(method, path, body)` resolves to the panel's JSON (throws ToolError on
 * {ok:false}); `waitJob(id)` resolves to the finished job.
 */
function makeTools({ api, waitJob, cwd, getText = null }) {
  const enc = encodeURIComponent;
  const projectsNow = async () => ((await api('GET', '/api/state')).projects || []);
  const pick = async (arg) => resolveProject(await projectsNow(), arg, cwd);
  const jobResult = async (jobId) => {
    const job = await waitJob(jobId);
    if (job.status !== 'done') throw new ToolError(`Failed: ${job.error || job.status}`);
    return job.result || {};
  };

  return {
    async list_projects() {
      return { projects: (await projectsNow()).map(projectSummary) };
    },
    async project_errors(a) {
      const p = await pick(a.project);
      const q = new URLSearchParams({ level: a.level || 'errors' });
      if (a.search) q.set('q', String(a.search));
      const r = await api('GET', `/api/projects/${enc(p.id)}/errors?${q}`);
      const groups = (r.groups || []).slice(0, a.limit || 10).map(errorGroup);
      return { project: p.name, counts: r.counts, groups, note: groups.length ? null : 'No errors in the logs.' };
    },
    async project_log(a) {
      const p = await pick(a.project);
      const r = await api('GET', `/api/projects/${enc(p.id)}/log?lines=${Math.min(500, Math.max(10, a.lines || 80))}`);
      return { project: p.name, log: trim(r.text || '', { str: 20000 }) };
    },
    async list_mail(a) {
      const q = new URLSearchParams({ limit: String(a.limit || 10) });
      if (a.project) q.set('project', (await pick(a.project)).id);
      if (a.search) q.set('q', String(a.search));
      const r = await api('GET', `/api/mail?${q}`);
      return {
        total: r.total,
        mail: (r.items || []).map((m) => trim({ id: m.id, at: m.at || m.date, project: m.project, subject: m.subject, from: m.from, to: m.to, preview: m.preview, attachments: m.attachments }, { str: 300 })),
      };
    },
    async read_mail(a) {
      const r = await api('GET', `/api/mail/${enc(String(a.id))}`);
      const m = r.mail || {};
      let text = r.text;
      let hrefs = [];
      if (!text && r.htmlUrl && getText) {
        // HTML-only mail: read the same sandboxed view the panel shows, as text
        const html = await getText(r.htmlUrl);
        hrefs = (html.match(/href\s*=\s*["']([^"']+)["']/gi) || []).map((x) => x.replace(/^href\s*=\s*["']|["']$/gi, '').replace(/&amp;/g, '&'));
        text = htmlToText(html);
      }
      const ex = mailExtras(m.subject, `${text || ''}\n${hrefs.join('\n')}`);
      return trim({
        id: m.id, subject: m.subject, from: m.from, to: m.to, date: r.date, project: m.project,
        text, links: ex.links, possibleCodes: ex.codes,
        attachments: (r.attachments || []).map((x) => `${x.filename || 'file'} (${x.type}, ${x.size} bytes)`),
      }, { str: 20000 });
    },
    async list_dumps(a) {
      const q = new URLSearchParams();
      if (a.project) q.set('project', (await pick(a.project)).id);
      const r = await api('GET', `/api/inbox/dumps?${q}`);
      const items = (r.items || []).slice().sort((x, y) => (y.id || 0) - (x.id || 0)).slice(0, a.limit || 5);
      return { dumps: items.map((d) => trim({ at: d.at, project: d.project, from: d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : null, url: d.uri, cli: d.cli, value: d.text || d.error }, { str: 6000 })) };
    },
    async db_history(a) {
      const p = await pick(a.project);
      const q = new URLSearchParams({ limit: String(a.limit || 20) });
      if (a.table) q.set('table', String(a.table));
      if (a.op) q.set('op', String(a.op));
      if (a.search) q.set('q', String(a.search));
      const r = await api('GET', `/api/projects/${enc(p.id)}/history?${q}`);
      if (r.on === false) return { project: p.name, on: false, note: 'Action history is off for this database. Turn it on in PHP Station: Time Machine > Every action.' };
      return trim({ project: p.name, busy: r.busy, actions: r.actions, tables: r.tables }, { str: 1500, arr: 100 });
    },
    async undo_db_action(a) {
      const p = await pick(a.project);
      const r = await api('POST', `/api/projects/${enc(p.id)}/history/undo`, { id: String(a.id), confirm: true });
      return { project: p.name, undone: String(a.id), result: trim(await jobResult(r.jobId)) };
    },
    async list_restore_points(a) {
      const p = await pick(a.project);
      const r = await api('GET', `/api/projects/${enc(p.id)}/points`);
      return trim({ project: p.name, points: r.points }, { str: 500 });
    },
    async create_restore_point(a) {
      const p = await pick(a.project);
      const r = await api('POST', `/api/projects/${enc(p.id)}/restore-point`, { reason: 'manual' });
      if (!r.jobId) return trim({ project: p.name, result: r });
      const res = await jobResult(r.jobId);
      return trim({ project: p.name, saved: res.point || res, how: 'Bring it back with restore_database and this point name.' });
    },
    async restore_database(a) {
      const p = await pick(a.project);
      const r = await api('POST', `/api/projects/${enc(p.id)}/undo`, { name: String(a.point), confirm: true });
      return { project: p.name, restoredTo: String(a.point), result: trim(await jobResult(r.jobId)) };
    },
    async start_project(a) {
      const p = await pick(a.project);
      let r = await api('POST', `/api/projects/${enc(p.id)}/start`, { startDb: true }, { allowFail: true });
      // first run ever: the panel asks for the port once; take the port it suggests
      if (r.ok === false && r.code === 'PORT_CONFIRM' && r.suggestedPort) {
        r = await api('POST', `/api/projects/${enc(p.id)}/start`, { startDb: true, port: r.suggestedPort }, { allowFail: true });
      }
      if (r.ok === false) throw new ToolError(`${r.error || r.code}${r.code === 'DB_MISSING' ? ' Create the database in PHP Station (it offers it on the project card), then start again.' : ''}`);
      return trim({ project: p.name, url: r.url, alreadyRunning: r.alreadyRunning, note: r.dbNote || r.dbCheckWarning });
    },
    async stop_project(a) {
      const p = await pick(a.project);
      await api('POST', `/api/projects/${enc(p.id)}/stop`);
      return { project: p.name, stopped: true, wasRunning: p.status === 'running' };
    },
    async doctor() {
      return trim(await api('GET', '/api/doctor'), { str: 800, arr: 40 });
    },
  };
}

// ------------------------------------------------------------------------------------------ JSON-RPC

/**
 * Returns handle(message) -> response object or null (notifications). `deps`:
 * {api, waitJob, cwd, version}.
 */
function createServer(deps) {
  const impl = makeTools(deps);
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fail(null, -32600, 'Invalid Request');
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (!isRequest) return null; // notifications/initialized, notifications/cancelled ...
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (method === 'initialize') {
      const asked = String(params.protocolVersion || '');
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'php-station', title: 'PHP Station', version: deps.version || '0' },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = String(params.name || '');
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const out = await impl[name](args);
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        const text = e instanceof ToolError || (e && e.fromPanel) ? e.message : `PHP Station error: ${e && e.message ? e.message : e}`;
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    return fail(id, -32601, `Method not found: ${method}`);
  };
}

/** Config snippets for the AI tools (shown in Settings > AI agents). PURE. */
function clientConfigs({ node, script }) {
  const server = { command: node, args: [script] };
  return {
    claudeCode: `claude mcp add php-station --scope user -- "${node}" "${script}"`,
    cursor: JSON.stringify({ mcpServers: { 'php-station': server } }, null, 2),
    vscode: JSON.stringify({ servers: { 'php-station': Object.assign({ type: 'stdio' }, server) } }, null, 2),
    claudeDesktop: JSON.stringify({ mcpServers: { 'php-station': server } }, null, 2),
    codex: `[mcp_servers.php-station]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(script)}]`,
  };
}

module.exports = { TOOLS, PROTOCOLS, ToolError, createServer, resolveProject, mailExtras, htmlToText, trim, clientConfigs };
