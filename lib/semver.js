'use strict';
/*
 * Composer-style version constraints, enough for PHP and Laravel versions. PURE (no I/O).
 *
 *   normalizeVersion("v13.40.0") -> [13, 40, 0]
 *   satisfies("8.5.9", "^7.3|^8.0") -> true      (null when the constraint can't be parsed)
 *   compare("8.2.12", "8.10.0") -> -1
 */

/** [major, minor, patch] from "8.5.9", "v13.40.0", "8.2", "8", "8.2.12-dev"; null if not a version. */
function normalizeVersion(v) {
  if (Array.isArray(v)) {
    if (!v.length || v.some((x) => !Number.isFinite(Number(x)))) return null;
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  }
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const m = /^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  return [Number(m[1]), m[2] !== undefined ? Number(m[2]) : 0, m[3] !== undefined ? Number(m[3]) : 0];
}

function cmp3(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** -1 / 0 / 1; an unparseable version sorts before every real version. */
function compare(a, b) {
  const x = normalizeVersion(a);
  const y = normalizeVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  return cmp3(x, y);
}

/**
 * Parses one version spec such as "8", "8.2", "8.2.12", "8.*", "8.2.x", "v8.2", "8.2.12.0",
 * "8.2.0-RC1", "8.2@dev". Returns {nums:[...explicit numbers], count, wildcard} or null.
 */
function parseSpec(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/@[A-Za-z]+$/, '');
  const m = /^[vV]?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-_.+]?[A-Za-z][A-Za-z0-9.+-]*)?$/.exec(s);
  if (!m) {
    if (/^[xX*]$/.test(s)) return { nums: [], count: 0, wildcard: true };
    return null;
  }
  const nums = [];
  let wildcard = false;
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part === undefined) break;
    if (/^[xX*]$/.test(part)) { wildcard = true; break; }
    nums.push(Number(part));
  }
  return { nums, count: nums.length, wildcard };
}

function full(nums) {
  return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
}

/** Increments position idx (0 = major, 1 = minor, 2 = patch) and zeroes the less significant parts. */
function bump(nums, idx) {
  const r = full(nums);
  const i = Math.max(0, Math.min(2, idx));
  r[i] += 1;
  for (let j = i + 1; j < 3; j++) r[j] = 0;
  return r;
}

function range(nums) {
  if (!nums.length) return [];
  return [{ op: '>=', v: full(nums) }, { op: '<', v: bump(nums, Math.min(nums.length, 3) - 1) }];
}

/** A bare version: exact when it has 3+ parts, otherwise a prefix match ("8.2" = >=8.2.0 <8.3.0). */
function exactOrPrefix(spec) {
  if (spec.wildcard) return range(spec.nums);
  if (spec.count >= 3) return [{ op: '==', v: full(spec.nums) }];
  return range(spec.nums);
}

function caret(spec) {
  if (spec.wildcard) return range(spec.nums);
  const n = spec.nums;
  let pos;
  if (n[0] !== 0 || n.length < 2) pos = 0;
  else if (n[1] !== 0 || n.length < 3) pos = 1;
  else pos = 2;
  return [{ op: '>=', v: full(n) }, { op: '<', v: bump(n, pos) }];
}

function tilde(spec) {
  if (spec.wildcard) return range(spec.nums);
  const n = spec.nums;
  const position = Math.min(spec.count, 4);
  const high = Math.max(1, position - 1);
  return [{ op: '>=', v: full(n) }, { op: '<', v: bump(n, high - 1) }];
}

function hyphen(a, b) {
  const sa = parseSpec(a);
  const sb = parseSpec(b);
  if (!sa || !sb || sa.wildcard || sb.wildcard || !sa.count || !sb.count) return null;
  const lower = { op: '>=', v: full(sa.nums) };
  const upper = sb.count >= 3
    ? { op: '<=', v: full(sb.nums) }
    : { op: '<', v: bump(sb.nums, sb.count - 1) };
  return [lower, upper];
}

/** One AND part (no spaces): "^8.2", "~8.1.0", ">=7.2", "!=8.0.1", "8.*", "8.2", "*". */
function parsePart(part) {
  const p = part.trim();
  if (!p) return null;
  if (/^[xX*](@[A-Za-z]+)?$/.test(p)) return [];
  let m = /^\^(.+)$/.exec(p);
  if (m) {
    const s = parseSpec(m[1]);
    return s && (s.count || s.wildcard) ? caret(s) : null;
  }
  m = /^~(.+)$/.exec(p);
  if (m) {
    if (m[1].startsWith('>')) return null;
    const s = parseSpec(m[1]);
    return s && (s.count || s.wildcard) ? tilde(s) : null;
  }
  m = /^(>=|<=|<>|!=|==|=|>|<)(.+)$/.exec(p);
  if (m) {
    const op = m[1];
    const s = parseSpec(m[2]);
    if (!s || (!s.count && !s.wildcard)) return null;
    if (op === '=' || op === '==') return exactOrPrefix(s);
    if (op === '!=' || op === '<>') return [{ op: 'not', inner: exactOrPrefix(s) }];
    if (s.wildcard) {
      // ">=8.*" -> ">=8.0.0", "<8.*" -> "<8.0.0", ">8.*" -> ">=9.0.0", "<=8.*" -> "<9.0.0"
      if (!s.count) return op === '>=' || op === '<=' ? [] : null;
      if (op === '>=') return [{ op: '>=', v: full(s.nums) }];
      if (op === '<') return [{ op: '<', v: full(s.nums) }];
      if (op === '>') return [{ op: '>=', v: bump(s.nums, s.count - 1) }];
      return [{ op: '<', v: bump(s.nums, s.count - 1) }];
    }
    return [{ op, v: full(s.nums) }];
  }
  const s = parseSpec(p);
  if (!s || (!s.count && !s.wildcard)) return null;
  return exactOrPrefix(s);
}

function parseAndGroup(text) {
  const comps = [];
  let bad = false;
  // Hyphen ranges "A - B" (spaces around the dash, as in Composer).
  let s = text.replace(/(\S+)\s+-\s+(\S+)/g, (all, a, b) => {
    const r = hyphen(a, b);
    if (!r) bad = true;
    else comps.push(...r);
    return ' ';
  });
  if (bad) return null;
  // Glue operators to their version: ">= 7.2" -> ">=7.2".
  s = s.replace(/(>=|<=|<>|!=|==|=|>|<|\^|~)\s+/g, '$1');
  const parts = s.split(/[\s,]+/).filter(Boolean);
  if (!parts.length && !comps.length) return null;
  for (const part of parts) {
    const r = parsePart(part);
    if (!r) return null;
    comps.push(...r);
  }
  return comps;
}

/** Parses a full constraint into OR groups of AND comparators, or null. */
function parseConstraint(constraint) {
  if (typeof constraint !== 'string') return null;
  const c = constraint.trim();
  if (!c) return null;
  const groups = [];
  for (const orPart of c.split(/\s*\|\|?\s*/)) {
    if (!orPart.trim()) return null;
    const g = parseAndGroup(orPart.trim());
    if (!g) return null;
    groups.push(g);
  }
  return groups.length ? groups : null;
}

function test(comp, v) {
  switch (comp.op) {
    case '>=': return cmp3(v, comp.v) >= 0;
    case '>': return cmp3(v, comp.v) > 0;
    case '<=': return cmp3(v, comp.v) <= 0;
    case '<': return cmp3(v, comp.v) < 0;
    case '==': return cmp3(v, comp.v) === 0;
    case 'not': return !comp.inner.every((c) => test(c, v));
    default: return false;
  }
}

/** true | false, or null when the version or the constraint can't be parsed. */
function satisfies(version, constraint) {
  const v = normalizeVersion(version);
  if (!v) return null;
  const groups = parseConstraint(constraint);
  if (!groups) return null;
  return groups.some((and) => and.every((c) => test(c, v)));
}

/** First integer in a string such as "^8.75", "v13.38.0", "11.x-dev"; null if none. */
function majorOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  const m = /(\d+)/.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : null;
}

module.exports = { normalizeVersion, satisfies, compare, majorOf, parseConstraint };
