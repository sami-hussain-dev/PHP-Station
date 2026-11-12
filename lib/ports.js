'use strict';
/*
 * Port helpers: pickPort is PURE; isPortOpen / waitForPort touch the network (127.0.0.1 only).
 */
const net = require('net');

function toSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v.map(Number));
  return new Set();
}

/**
 * preferred when it is inside [from, to] and neither reserved nor busy; otherwise the lowest
 * free port in the range; null when every port is taken.
 */
function pickPort({ from, to, preferred, reserved, busy } = {}) {
  const lo = Number(from);
  const hi = Number(to);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65535 || lo > hi) return null;
  const r = toSet(reserved);
  const b = toSet(busy);
  const free = (p) => !r.has(p) && !b.has(p);
  const pref = Number(preferred);
  if (Number.isInteger(pref) && pref >= lo && pref <= hi && free(pref)) return pref;
  for (let p = lo; p <= hi; p++) if (free(p)) return p;
  return null;
}

/** Resolves true when something accepts a TCP connection on host:port. */
function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const sock = net.connect({ port: Number(port), host });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * Polls until the port accepts connections (true), or until timeoutMs passes or isAlive()
 * (sync or async) reports that the process died (false).
 */
async function waitForPort(port, { timeoutMs = 15000, intervalMs = 250, isAlive = null, host = '127.0.0.1' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortOpen(port, host, 600)) return true;
    if (isAlive) {
      let alive = true;
      try { alive = await isAlive(); } catch { alive = true; }
      if (!alive) return false;
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Polls until nothing accepts connections on the port; true when closed within timeoutMs. */
async function waitForPortClosed(port, { timeoutMs = 5000, intervalMs = 200, host = '127.0.0.1' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isPortOpen(port, host, 400))) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { pickPort, isPortOpen, waitForPort, waitForPortClosed };
