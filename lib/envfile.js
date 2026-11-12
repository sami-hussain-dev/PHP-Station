'use strict';
/*
 * Laravel .env parsing and minimal editing. PURE (no I/O).
 * setEnvValues only replaces the lines it has to and keeps everything else byte-identical.
 */

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/;

function unquote(rest) {
  const v = rest.replace(/^\s+/, '');
  if (v.startsWith('"')) {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (c === '\\' && i + 1 < v.length) {
        const n = v[i + 1];
        if (n === '"' || n === '\\') { out += n; i++; continue; }
        if (n === 'n') { out += '\n'; i++; continue; }
        if (n === 'r') { out += '\r'; i++; continue; }
        if (n === 't') { out += '\t'; i++; continue; }
        out += c;
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  // Unquoted: an inline comment starts at " #".
  return v.replace(/\s+#.*$/, '').trim();
}

/** {KEY: value} from .env text (KEY=value, export KEY=..., quotes, inline " #" comments, CRLF). */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).replace(/^﻿/, '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

function formatValue(v) {
  const s = v == null ? '' : String(v);
  if (s === '') return '';
  if (/^[A-Za-z0-9_.:\/@+\-,]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns new text with the first "KEY=" line of each key replaced (keeping an "export " prefix
 * and the line ending of that line); keys that are missing are appended at the end.
 */
function setEnvValues(text, updates) {
  const src = String(text == null ? '' : text);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split('\n');
  const missing = [];
  for (const [key, value] of Object.entries(updates || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    const re = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegex(key)}\\s*=`);
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      const hasCr = lines[i].endsWith('\r');
      const body = hasCr ? lines[i].slice(0, -1) : lines[i];
      const m = re.exec(body);
      if (!m) continue;
      lines[i] = `${m[1]}${key}=${formatValue(value)}${hasCr ? '\r' : ''}`;
      done = true;
      break;
    }
    if (!done) missing.push(`${key}=${formatValue(value)}`);
  }
  let out = lines.join('\n');
  if (missing.length) {
    if (out.length && !out.endsWith('\n')) out += eol;
    out += missing.map((l) => l + eol).join('');
  }
  return out;
}

module.exports = { parseEnv, setEnvValues };
