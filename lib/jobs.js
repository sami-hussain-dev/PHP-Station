'use strict';
/*
 * Background jobs with a step log. One registry per panel process; the last 50 are kept.
 * A job function receives log(level, text) and the job object (for job.progress) and returns
 * the result. Throwing fails the job; an AppError's code and extra data land in job.result.
 */
const crypto = require('crypto');
const { tr } = require('./i18n');

const LEVELS = new Set(['info', 'ok', 'warn', 'bad']);
const MAX_JOBS = 50;
const MAX_STEPS = 3000;

const jobs = [];
const byId = new Map();
let panelLog = null;

function setLogger(fn) {
  panelLog = typeof fn === 'function' ? fn : null;
}

function newId() {
  return `j${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function trim() {
  while (jobs.length > MAX_JOBS) {
    const idx = jobs.findIndex((j) => j.status !== 'running');
    if (idx < 0) break;
    const [old] = jobs.splice(idx, 1);
    byId.delete(old.id);
  }
}

/** Starts fn in the background and returns the job id immediately. */
function createJob(type, title, fn) {
  const job = {
    id: newId(),
    type: String(type),
    title: String(title),
    status: 'running',
    steps: [],
    result: null,
    error: null,
    code: null,
    progress: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  jobs.push(job);
  byId.set(job.id, job);
  trim();
  const log = (level, text) => {
    job.steps.push({ at: new Date().toISOString(), level: LEVELS.has(level) ? level : 'info', text: String(text) });
    if (job.steps.length > MAX_STEPS) job.steps.splice(0, job.steps.length - MAX_STEPS);
  };
  if (panelLog) panelLog(`job ${job.id} start ${job.type}: ${job.title}`);
  Promise.resolve()
    .then(() => fn(log, job))
    .then(
      (result) => {
        job.result = result === undefined ? null : result;
        job.status = 'done';
      },
      (err) => {
        const e = err || new Error(tr('job.unknownError'));
        job.status = 'failed';
        job.code = e.code || 'JOB_FAILED';
        job.error = e.message || String(e);
        job.result = Object.assign({ ok: false, code: job.code, error: job.error }, e.extra && typeof e.extra === 'object' ? e.extra : {});
        log('bad', job.error);
      },
    )
    .finally(() => {
      job.endedAt = new Date().toISOString();
      if (panelLog) panelLog(`job ${job.id} ${job.status} ${job.type}${job.code ? ` (${job.code})` : ''}`);
    });
  return job.id;
}

function getJob(id) {
  return byId.get(String(id)) || null;
}

/** Newest first summaries. */
function listJobs(n = 10) {
  return jobs.slice(-n).reverse().map((j) => ({
    id: j.id, type: j.type, title: j.title, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
  }));
}

function findRunning(type, pred) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (j.status === 'running' && j.type === type && (!pred || pred(j))) return j;
  }
  return null;
}

module.exports = { createJob, getJob, listJobs, findRunning, setLogger };
