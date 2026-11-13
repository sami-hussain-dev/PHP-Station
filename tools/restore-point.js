#!/usr/bin/env node
'use strict';
/*
 * Called by a project's php.bat shim (only inside PHP Station terminals) right before
 * `php artisan migrate*` / `php artisan db:*`:
 *   node tools\restore-point.js <dataDir> <projectId> <artisan command>
 * Asks the running panel for a restore point of the project's database and waits for it.
 * It never blocks the artisan command: any problem is printed and the command still runs.
 * Exit code is always 0.
 */
const path = require('path');
const util = require('../lib/util');

const [dataDir, projectId, command] = process.argv.slice(2);
const en = (() => {
  const st = util.readJson(path.join(String(dataDir || ''), 'state.json'), null);
  return !!(st && st.settings && st.settings.lang === 'en');
})();
const say = (roman, english) => console.log(`  PHP Station: ${en ? english : roman}`);

async function main() {
  if (!dataDir || !projectId || !/^[A-Za-z0-9._-]{1,80}$/.test(projectId)) return;
  const info = util.readJson(path.join(dataDir, 'panel.json'), null);
  if (!info || !Number.isInteger(info.port) || typeof info.token !== 'string') {
    say('panel band hai, is liye restore point nahi bana (command phir bhi chalegi).',
      'the panel is not running, so no restore point was made (the command still runs).');
    return;
  }
  const req = (method, urlPath, body, timeoutMs = 8000) => util.httpJson({ port: info.port, method, urlPath, token: info.token, body, timeoutMs });
  let r;
  try {
    r = await req('POST', `/api/projects/${encodeURIComponent(projectId)}/restore-point`, { reason: 'artisan', command: String(command || '').slice(0, 120) });
  } catch {
    say('panel se raabta nahi hua — restore point nahi bana.', 'could not reach the panel — no restore point was made.');
    return;
  }
  const j = r.json || {};
  if (j.skipped) return; // read-only command or turned off in Settings
  if (r.status !== 200 || !j.jobId) {
    say(`restore point nahi bana: ${j.error || r.status}`, `no restore point: ${j.error || r.status}`);
    return;
  }
  process.stdout.write(`  PHP Station: ${en ? 'saving a restore point of the database' : 'database ka restore point ban raha hai'} `);
  const end = Date.now() + 30 * 60 * 1000;
  while (Date.now() < end) {
    await util.sleep(600);
    let s;
    try { s = await req('GET', `/api/jobs/${encodeURIComponent(j.jobId)}`); } catch { continue; }
    const job = s.json && s.json.job;
    if (!job) continue;
    if (job.status === 'running') { process.stdout.write('.'); continue; }
    process.stdout.write('\n');
    if (job.status === 'done' && job.result && job.result.point) {
      const p = job.result.point;
      say(`restore point tayyar (${p.tables} tables, ${util.fmtMB(p.sizeBytes || 0)}). Ghalti ho to card par "Time Machine" dabayein.`,
        `restore point saved (${p.tables} tables, ${util.fmtMB(p.sizeBytes || 0)}). If something goes wrong, press "Time Machine" on the project card.`);
    } else if (job.status === 'done') {
      // skipped inside the job (nothing to protect)
    } else {
      say(`restore point nahi bana: ${job.error || '?'}`, `no restore point: ${job.error || '?'}`);
    }
    return;
  }
  process.stdout.write('\n');
  say('restore point me bohat der lag rahi hai — command chala rahe hain.', 'the restore point is taking too long — running the command now.');
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
