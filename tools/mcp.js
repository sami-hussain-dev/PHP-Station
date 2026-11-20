#!/usr/bin/env node
'use strict';
/*
 * PHP Station MCP server (stdio). AI coding tools (Claude Code, Cursor, VS Code Copilot, Codex,
 * Claude Desktop ...) start it as:
 *   node <PHP Station>\tools\mcp.js [--data DIR]
 * It talks to the running panel on 127.0.0.1 with the per-start token from <data>\panel.json, and
 * starts the panel (without a window) when it is not running. stdout carries only JSON-RPC; notes
 * go to stderr. The protocol and the tools live in lib/mcp.js.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const util = require('../lib/util');
const mcp = require('../lib/mcp');

const TOOL_DIR = path.resolve(__dirname, '..');
const VERSION = (util.readJson(path.join(TOOL_DIR, 'package.json'), {}) || {}).version || '0';

function argValue(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

const DATA_DIR = path.resolve(argValue('--data') || process.env.DEVPANEL_DATA || path.join(TOOL_DIR, 'data'));
const note = (s) => process.stderr.write(`[php-station] ${s}\n`);

async function ping(port) {
  try {
    const r = await util.httpJson({ port, urlPath: '/api/ping', timeoutMs: 1500 });
    return !!(r.status === 200 && r.json && r.json.app === 'devpanel');
  } catch { return false; }
}

let panel = null;
let starting = null;

/** panel.json of the live panel, starting one (no window) when none answers. */
async function ensurePanel() {
  if (panel && (await ping(panel.port))) return panel;
  const info = util.readJson(path.join(DATA_DIR, 'panel.json'), null);
  if (info && Number.isInteger(info.port) && typeof info.token === 'string' && (await ping(info.port))) {
    panel = info;
    return panel;
  }
  if (!starting) {
    starting = (async () => {
      note('PHP Station is not running, starting it in the background');
      const logDir = path.join(DATA_DIR, 'logs');
      util.ensureDir(logDir);
      const fd = fs.openSync(path.join(logDir, 'panel.log'), 'a');
      try {
        const child = spawn(process.execPath, [path.join(TOOL_DIR, 'server.js'), '--serve', '--data', DATA_DIR, '--no-open'],
          { cwd: TOOL_DIR, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env });
        child.on('error', () => {});
        child.unref();
      } finally { fs.closeSync(fd); }
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        await util.sleep(300);
        const pj = util.readJson(path.join(DATA_DIR, 'panel.json'), null);
        if (pj && Number.isInteger(pj.port) && typeof pj.token === 'string' && (await ping(pj.port))) return pj;
      }
      return null;
    })().finally(() => { setTimeout(() => { starting = null; }, 0); });
  }
  panel = await starting;
  if (!panel) throw new mcp.ToolError(`PHP Station could not be started. Open PHP-Station.bat, or see ${path.join(DATA_DIR, 'logs', 'panel.log')}.`);
  return panel;
}

async function api(method, urlPath, body, { allowFail = false } = {}) {
  const p = await ensurePanel();
  const r = await util.httpJson({ port: p.port, method, urlPath, token: p.token, body, timeoutMs: 120000 });
  const j = r.json;
  if (!j) throw new mcp.ToolError(`PHP Station answered ${r.status} without JSON.`);
  if (j.ok === false && !allowFail) {
    const e = new mcp.ToolError(j.code === 'PANEL_OUTDATED' ? j.error : `${j.error || j.code}${j.code ? ` (${j.code})` : ''}`);
    e.fromPanel = true;
    throw e;
  }
  return j;
}

/** A non-API page of the panel (the sandboxed mail view) as text. */
async function getText(urlPath) {
  const p = await ensurePanel();
  const r = await util.httpJson({ port: p.port, urlPath, timeoutMs: 15000 });
  return r.status === 200 ? r.text : '';
}

async function waitJob(id) {
  const end = Date.now() + 30 * 60 * 1000;
  while (Date.now() < end) {
    await util.sleep(300);
    let r;
    try { r = await api('GET', `/api/jobs/${encodeURIComponent(id)}`); } catch { continue; }
    if (r.job && r.job.status !== 'running') return r.job;
  }
  throw new mcp.ToolError('The job is still running after 30 minutes. See it in PHP Station.');
}

const handle = mcp.createServer({ api, waitJob, getText, cwd: process.cwd(), version: VERSION });

// newline-delimited JSON-RPC on stdin / stdout
let buf = '';
let pending = 0;
let ended = false;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
async function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const batch = Array.isArray(msg) ? msg : [msg];
  for (const m of batch) {
    pending++;
    try {
      const out = await handle(m);
      if (out) send(out);
    } catch (e) {
      if (m && m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e && e.message ? e.message : String(e) } });
    } finally {
      pending--;
      if (ended && pending === 0) process.exit(0);
    }
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    onLine(line);
  }
});
process.stdin.on('end', () => {
  ended = true;
  if (buf.trim()) onLine(buf);
  if (pending === 0) process.exit(0);
});
