#!/usr/bin/env node
'use strict';
/*
 * Called by a project's php.bat shim (only inside PHP Station terminals) right before
 * `php artisan migrate*` / `php artisan db:*`:
 *   node tools\restore-point.js <dataDir> <projectId> artisan <command> [args...]
 *   node tools\restore-point.js <dataDir> <projectId> <command>          (shims of older versions)
 * Asks the running panel for a restore point of the project's database and waits for it. The panel
 * answers at once when none is needed (nothing to migrate, nothing changed since the last point).
 * It never blocks the artisan command: any problem is printed and the command still runs.
 * Exit code is always 0.
 */
const path = require('path');
const util = require('../lib/util');

const [dataDir, projectId, ...rest] = process.argv.slice(2);
const viaArtisan = String(rest[0] || '').toLowerCase() === 'artisan';
const command = String((viaArtisan ? rest[1] : rest[0]) || '');
const args = viaArtisan ? rest.slice(2) : [];

const en = (() => {
  const st = util.readJson(path.join(String(dataDir || ''), 'state.json'), null);
  return !!(st && st.settings && st.settings.lang === 'en');
})();
const say = (roman, english) => console.log(`  PHP Station: ${en ? english : roman}`);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
};

async function main() {
  if (!dataDir || !projectId || !/^[A-Za-z0-9._-]{1,80}$/.test(projectId) || !command) return;
  const started = Date.now();
  const info = util.readJson(path.join(dataDir, 'panel.json'), null);
  if (!info || !Number.isInteger(info.port) || typeof info.token !== 'string') {
    say('panel band hai, is liye restore point nahi bana (command phir bhi chalegi).',
      'the panel is not running, so no restore point was made (the command still runs).');
    return;
  }
  const req = (method, urlPath, body, timeoutMs = 8000) => util.httpJson({ port: info.port, method, urlPath, token: info.token, body, timeoutMs });
  let r;
  try {
    r = await req('POST', `/api/projects/${encodeURIComponent(projectId)}/restore-point`, { reason: 'artisan', command, args }, 40000);
  } catch {
    say('panel se raabta nahi hua, restore point nahi bana.', 'could not reach the panel, no restore point was made.');
    return;
  }
  const j = r.json || {};
  // read-only command, nothing to migrate, empty database or turned off in Settings: say nothing
  if (j.skipped) return;
  if (j.marker) {
    say(`restore point foran ban gaya (${clock(j.marker.createdAt)}). Ghalti ho to card par "Time Machine" dabayein.`,
      `restore point saved instantly (${clock(j.marker.createdAt)}). If something goes wrong, press "Time Machine" on the project card.`);
    return;
  }
  if (j.reused) {
    say(`database pichhle restore point (${clock(j.reused.createdAt)}) ke baad nahi badla, wahi kaafi hai.`,
      `the database has not changed since the restore point of ${clock(j.reused.createdAt)}, so that one still covers it.`);
    return;
  }
  if (r.status !== 200 || !j.jobId) {
    say(`restore point nahi bana: ${j.error || r.status}`, `no restore point: ${j.error || r.status}`);
    return;
  }
  let shown = false;
  let lastDot = Date.now();
  const end = Date.now() + 30 * 60 * 1000;
  while (Date.now() < end) {
    await util.sleep(100);
    let s;
    try { s = await req('GET', `/api/jobs/${encodeURIComponent(j.jobId)}`); } catch { continue; }
    const job = s.json && s.json.job;
    if (!job) continue;
    if (job.status === 'running') {
      // short dumps finish without any progress line
      if (!shown && Date.now() - started > 1500) {
        process.stdout.write(`  PHP Station: ${en ? 'saving a restore point of the database' : 'database ka restore point ban raha hai'} `);
        shown = true;
      } else if (shown && Date.now() - lastDot > 1000) {
        process.stdout.write('.');
        lastDot = Date.now();
      }
      continue;
    }
    if (shown) process.stdout.write('\n');
    const res = job.result || {};
    if (job.status === 'done' && res.point) {
      const p = res.point;
      say(`restore point tayyar (${p.tables} tables, ${util.fmtMB(p.sizeBytes || 0)}, ${secs(Date.now() - started)}). Ghalti ho to card par "Time Machine" dabayein.`,
        `restore point saved (${p.tables} tables, ${util.fmtMB(p.sizeBytes || 0)}, ${secs(Date.now() - started)}). If something goes wrong, press "Time Machine" on the project card.`);
    } else if (job.status === 'done') {
      // skipped or reused inside the job: nothing to add
    } else {
      say(`restore point nahi bana: ${job.error || '?'}`, `no restore point: ${job.error || '?'}`);
    }
    return;
  }
  if (shown) process.stdout.write('\n');
  say('restore point me bohat der lag rahi hai, command chala rahe hain.', 'the restore point is taking too long, running the command now.');
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
