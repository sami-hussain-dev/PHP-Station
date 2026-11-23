'use strict';
/*
 * AI hub: free AI accounts first (each with the user's own free key), the user's own paid accounts when
 * they add one, and Ollama on this PC. Every provider is reached through its OpenAI-compatible
 * chat/completions API. When one account hits its limit (429), runs out of credit (402), refuses the key
 * or is down, the next one answers the same conversation, so a chat or a fix carries on.
 *
 * Keys are encrypted with Windows DPAPI (CurrentUser) before they are written to <data>\ai\accounts.json,
 * kept decrypted in memory only, never logged and never sent to the page (it sees "••••abcd").
 * A project can be set to "local AI only": then nothing of it leaves the PC (Ollama only).
 *
 * Fix with AI: the error, the file around the error line and a few app stack frames go to the AI, which
 * answers with exact search/replace edits. The user sees the diff and applies it; the files are backed
 * up first, then the fix is checked (php -l with the project's PHP, the page again when there is one).
 * A failed check puts the files back and asks the AI once more with what failed. Undo is always there.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');
const runtimes = require('./runtimes');
const projects = require('./projects');
const procs = require('./procs');
const { tr } = require('./i18n');

const { AppError } = util;
const win = path.win32;

// ------------------------------------------------------------------------------------------ providers

/** Free / local providers, listed for everyone. `prefer`: how to pick a model when none is set. */
const FREE = [
  // effort: Gemini's thinking eats the answer's token budget; "low" keeps a long fix from being cut off
  { id: 'gemini', name: 'Google Gemini', tier: 'free', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', effort: 'low', prefer: [/gemini-[\d.]+-flash$/, /flash(?!.*(image|tts|audio|live|thinking))/, /gemini/] },
  { id: 'groq', name: 'Groq', tier: 'free', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', prefer: [/llama-3\.3-70b-versatile/, /(qwen|llama|gpt-oss).*(70b|32b|120b)/, /llama|qwen|gpt-oss/] },
  { id: 'openrouter', name: 'OpenRouter (free models)', tier: 'free', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys', freeOnly: true, prefer: [/coder.*:free$/, /(deepseek|qwen|llama|gemini).*:free$/, /:free$/] },
  { id: 'mistral', name: 'Mistral', tier: 'free', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', defaultModel: 'mistral-small-latest', prefer: [/^codestral-latest$/, /^mistral-small-latest$/, /^mistral-(small|medium|large)/, /mistral/] },
  { id: 'cerebras', name: 'Cerebras', tier: 'free', base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai/', defaultModel: 'llama-3.3-70b', prefer: [/(qwen|llama|gpt-oss).*(70b|32b|120b|235b)/, /llama|qwen|gpt-oss/] },
  // GitHub lists its models in a catalog, not under the inference URL
  { id: 'github', name: 'GitHub Models', tier: 'free', base: 'https://models.github.ai/inference', modelsUrl: 'https://models.github.ai/catalog/models', keyUrl: 'https://github.com/settings/personal-access-tokens', defaultModel: 'openai/gpt-4.1-mini', prefer: [/gpt-4\.1-mini$/, /gpt.*mini/, /llama|mistral|gpt/] },
  { id: 'ollama', name: 'Ollama (this PC)', tier: 'local', base: 'http://127.0.0.1:11434/v1', keyUrl: 'https://ollama.com/download', noKey: true, prefer: [/coder/, /qwen|llama|deepseek|mistral|gemma/] },
  // no key, no login: ready the moment PHP Station starts (anonymous tier, a small reasoning model, rate limited)
  { id: 'pollinations', name: 'Pollinations (free, no login)', tier: 'free', base: 'https://text.pollinations.ai/openai', modelsUrl: 'https://text.pollinations.ai/models', keyUrl: 'https://pollinations.ai', noKey: true, anonOnly: true, defaultModel: 'openai', prefer: [/^openai-fast$/, /^openai/] },
];

/** What a key of each provider looks like (to catch it from the clipboard). */
const KEY_RE = {
  gemini: /^AIza[0-9A-Za-z_-]{30,}$/,
  groq: /^gsk_[A-Za-z0-9]{20,}$/,
  openrouter: /^sk-or-(v1-)?[A-Za-z0-9]{20,}$/,
  'openrouter-paid': /^sk-or-(v1-)?[A-Za-z0-9]{20,}$/,
  mistral: /^[A-Za-z0-9]{32}$/,
  cerebras: /^csk-[A-Za-z0-9]{20,}$/,
  github: /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})$/,
  openai: /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  deepseek: /^sk-[a-f0-9]{32}$/,
};

/** Keys already on this PC: environment variables a developer may have set for other AI tools. */
const ENV_KEYS = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  github: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
};

/** Paid templates for "Add paid account" (the user's own key and billing). */
const PAID = [
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', model: 'gpt-4.1-mini' },
  { id: 'anthropic', name: 'Anthropic (Claude)', base: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', model: 'claude-sonnet-5-5' },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', model: 'deepseek-chat' },
  { id: 'openrouter-paid', name: 'OpenRouter (paid)', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys', model: '' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', base: '', keyUrl: null, model: '' },
];

const providerOf = (pid) => FREE.find((p) => p.id === pid) || PAID.find((p) => p.id === pid) || null;

// ------------------------------------------------------------------------------------------ store

function aiDir(ctx) { return path.join(ctx.dataDir, 'ai'); }
function accountsFile(ctx) { return path.join(aiDir(ctx), 'accounts.json'); }

/** accounts.json, with every free provider present (added in catalog order when missing). */
function load(ctx) {
  if (ctx.aiStore) return ctx.aiStore;
  const st = util.readJson(accountsFile(ctx), null) || {};
  const accounts = Array.isArray(st.accounts) ? st.accounts : [];
  for (const p of FREE) {
    if (!accounts.some((a) => a.provider === p.id && a.tier !== 'paid')) {
      accounts.push({ id: p.id, provider: p.id, name: p.name, tier: p.tier, base: p.base, model: '', enabled: true, keyEnc: null, keyHint: null });
    }
  }
  ctx.aiStore = {
    accounts,
    paidFirst: st.paidFirst !== false,
    localOnly: st.localOnly && typeof st.localOnly === 'object' ? st.localOnly : {},
    usage: st.usage && typeof st.usage === 'object' ? st.usage : {},
  };
  return ctx.aiStore;
}

function save(ctx) {
  const s = load(ctx);
  util.ensureDir(aiDir(ctx));
  util.writeJsonAtomic(accountsFile(ctx), { accounts: s.accounts, paidFirst: s.paidFirst, localOnly: s.localOnly, usage: s.usage });
}

function getAccount(ctx, id) {
  const a = load(ctx).accounts.find((x) => x.id === id);
  if (!a) throw new AppError('NOT_FOUND', tr('ai.noAccount'), 404);
  return a;
}

// ------------------------------------------------------------------------------------------ keys (DPAPI)

const keyCache = new Map();

async function dpapi(op, value) {
  const script = String.raw`
Add-Type -AssemblyName System.Security
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($env:PS_AI_OP -eq 'protect') {
  $b = [Text.Encoding]::UTF8.GetBytes($env:PS_AI_VALUE)
  $o = [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b, $null, $scope))
} else {
  $b = [Convert]::FromBase64String($env:PS_AI_VALUE)
  $o = [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, $scope))
}
@{ ok = $true; v = $o } | ConvertTo-Json -Compress
`;
  // the value travels in the child's environment, never on its command line
  const r = await procs.psOneShot(script, { env: util.cleanEnv({ remove: [], set: { PS_AI_OP: op, PS_AI_VALUE: value } }), timeoutMs: 20000 });
  if (!r.json || !r.json.ok || typeof r.json.v !== 'string') throw new AppError('KEY_STORE', tr('ai.keyStoreFail'), 500);
  return r.json.v;
}

async function keyOf(ctx, a) {
  if (keyCache.has(a.id)) return keyCache.get(a.id);
  if (!a.keyEnc) return null;
  const k = await dpapi('unprotect', a.keyEnc);
  keyCache.set(a.id, k);
  return k;
}

/** Keeps only the last 4 characters for the page. PURE. */
function hintOf(key) {
  const k = String(key || '');
  return k ? `••••${k.slice(-4)}` : null;
}

async function setKey(ctx, id, key) {
  const a = getAccount(ctx, id);
  const k = String(key || '').trim();
  if (!k) { a.keyEnc = null; a.keyHint = null; keyCache.delete(id); }
  else {
    if (k.length > 500 || /[\r\n\s]/.test(k)) throw new AppError('BAD_INPUT', tr('ai.badKey'), 400);
    a.keyEnc = await dpapi('protect', k);
    a.keyHint = hintOf(k);
    keyCache.set(id, k);
  }
  delete a.state; // a new key clears "key refused", limits ...
  save(ctx);
  return view(ctx, a);
}

// ------------------------------------------------------------------------------------------ calling a provider

/** HTTP error / message -> {kind, coolMs}. PURE. */
function classifyError(status, text) {
  const t = String(text || '').toLowerCase();
  if (status === 401 || status === 403) return { kind: 'auth', coolMs: 0 };
  // OpenRouter free models: "temporarily rate-limited upstream" is that one model, not the account
  if (status === 429 && /upstream/.test(t)) return { kind: 'busy', coolMs: 60e3 };
  // keyless tiers: "Free limit reached: 1 reply every 45 seconds per IP. Retry after 40s" (sent as 402)
  const after = /retry (?:after|in) (\d+(?:\.\d+)?)\s*s/.exec(t);
  if (/free.?limit|per ip|every \d+ seconds/.test(t)) return { kind: 'rate', coolMs: after ? Math.min(Number(after[1]) * 1000, 10 * 60e3) : 60e3 };
  if (status === 402 || /insufficient.{0,20}(credit|balance|fund)|billing|payment required/.test(t)) return { kind: 'credit', coolMs: 6 * 3600e3 };
  if (status === 429 || /rate.?limit|quota|resource.?exhausted|too many requests/.test(t)) {
    const daily = /per.?day|daily|exceeded your current quota|requests per day|rpd|tokens per day/.test(t);
    return { kind: daily ? 'quota' : 'rate', coolMs: daily ? 3 * 3600e3 : 60e3 };
  }
  if ((status === 404 || status === 400) && /model/.test(t) && (status === 404 || /(not found|does not exist|unknown|invalid|not supported|decommission|no longer available|not available|deprecated|retired|discontinued|removed)/.test(t))) return { kind: 'model', coolMs: 0 };
  if (status === 400 && /context|too long|maximum.{0,20}tokens|reduce the length/.test(t)) return { kind: 'tooLong', coolMs: 0 };
  // "high demand", overloaded: the model is busy right now (often only that model)
  if (status === 503 || status === 529 || /high demand|overloaded|unavailable|try again later|capacity/.test(t)) return { kind: 'busy', coolMs: 60e3 };
  if (!status || status >= 500) return { kind: 'down', coolMs: 2 * 60e3 };
  return { kind: 'error', coolMs: 60e3 };
}

function retryAfterMs(h) {
  const v = h && (h.get ? h.get('retry-after') : h['retry-after']);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 24 * 3600e3) : null;
}

// Who made PHP Station. OpenRouter credits every request to this app (HTTP-Referer is the app's id,
// the title its name): PHP Station's usage shows on openrouter.ai/rankings and on its app page.
const APP_NAME = 'PHP Station by x8code';
const APP_URL = 'https://github.com/sami-hussain-dev/PHP-Station';

function headersFor(a, key) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (key) h.Authorization = `Bearer ${key}`;
  if (a.provider === 'openrouter' || a.provider === 'openrouter-paid') {
    h['HTTP-Referer'] = APP_URL;
    h['X-OpenRouter-Title'] = APP_NAME;
    h['X-Title'] = APP_NAME; // the older name of the same header
  }
  return h;
}

class ProviderError extends Error {
  constructor(kind, message, coolMs) { super(message); this.kind = kind; this.coolMs = coolMs; }
}

async function httpCall(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
  } catch (e) {
    const c0 = e.cause || {};
    const code = c0.code || (Array.isArray(c0.errors) && c0.errors[0] && c0.errors[0].code) || '';
    // nothing listens on this PC (Ollama not started / not installed)
    if (code === 'ECONNREFUSED' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(url)) throw new ProviderError('notRunning', code, 60e3);
    throw new ProviderError('down', e.name === 'AbortError' ? 'timeout' : code || e.message, 2 * 60e3);
  } finally { clearTimeout(timer); }
}

/** GET {base}/models (or the provider's catalog) -> ids (free ones only for OpenRouter's free account). */
async function listModels(ctx, a) {
  const key = await keyOf(ctx, a);
  const tmpl = providerOf(a.provider) || {};
  const res = await httpCall(tmpl.modelsUrl && a.base === tmpl.base ? tmpl.modelsUrl : `${a.base.replace(/\/+$/, '')}/models`, { headers: headersFor(a, key) }, 20000);
  const text = await res.text();
  if (!res.ok) { const c = classifyError(res.status, text); throw new ProviderError(c.kind, `${res.status} ${text.slice(0, 200)}`, c.coolMs); }
  let j;
  try { j = JSON.parse(text); } catch { throw new ProviderError('error', 'models: not JSON', 0); }
  const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : [];
  const p = providerOf(a.provider) || {};
  return list.filter((m) => !p.freeOnly || FREE_MODEL.test(m && m.id))
    .filter((m) => !p.anonOnly || !m || typeof m !== 'object' || !m.tier || m.tier === 'anonymous')
    .map((m) => String((m && (m.id || m.name)) || '').replace(/^models\//, '')).filter(Boolean).sort();
}

/** Numbers in a model id, for "newest first" ("gemini-3.8-flash" -> [3, 8]). PURE. */
function versionKey(id) { return (String(id).match(/\d+(?:\.\d+)*/g) || []).join('.').split('.').map(Number).filter(Number.isFinite); }
function newerFirst(a, b) {
  const x = versionKey(a); const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; }
  return a.localeCompare(b);
}

/**
 * The model to use: the best match of the provider's preferences, newest version first, never one
 * the provider has refused (`avoid`). Model lists keep old models that new users may not call. PURE.
 */
// models that do not chat (images, speech, embeddings, moderation ...)
const NOT_CHAT = /(embed|tts|audio|image|imagen|veo|whisper|transcrib|speech|guard|moderation|rerank|realtime|live|aqa|dall-e|sora|ocr|vision-only|computer-use)/i;

/** OpenRouter's free models end in ":free" (price 0); every other model costs credit. */
const FREE_MODEL = /:free$/;

function pickModel(ids, prefer, avoid = []) {
  const ok = (ids || []).filter((x) => !avoid.includes(x) && !NOT_CHAT.test(x));
  for (const re of prefer || []) {
    const m = ok.filter((x) => re.test(x)).sort(newerFirst)[0];
    if (m) return m;
  }
  return ok.slice().sort(newerFirst)[0] || null;
}

/** The model a "this model is gone" message points to ("... use models/gemini-3.8-flash ..."). PURE. */
function suggestedModel(text) {
  const m = /(?:use|switch to|migrate to|replaced by|instead use|try)\s+[`'"]?(?:models\/)?([A-Za-z0-9][\w.:/-]*\w)/i.exec(String(text || ''));
  return m && /\d|[-/:]/.test(m[1]) ? m[1] : null;
}

async function ensureModel(ctx, a) {
  if (a.model) return a.model;
  const tmpl = providerOf(a.provider) || {};
  let m = null;
  try {
    m = pickModel(await listModels(ctx, a), tmpl.prefer, a.badModels || []);
  } catch (e) {
    // a refused key / limit is the real answer; a missing model list is not: use the known default
    if (!(e instanceof ProviderError) || ['auth', 'credit', 'quota', 'rate', 'notRunning'].includes(e.kind) || !tmpl.defaultModel) throw e;
  }
  if (!m && tmpl.defaultModel && !(a.badModels || []).includes(tmpl.defaultModel)) m = tmpl.defaultModel;
  if (!m) throw new ProviderError('model', tr('ai.noModel'), 0);
  a.model = m;
  save(ctx);
  return m;
}

/**
 * The request body. Reasoning models (OpenAI o-series, gpt-5 ...) take max_completion_tokens and only
 * their default temperature; `compat` remembers what an account's model refused before. PURE.
 */
function requestBody(model, messages, { maxTokens, temperature, compat = {}, effort = null }) {
  const reasoning = /^(o\d|gpt-5)/i.test(String(model).replace(/^openai\//i, ''));
  const body = { model, messages, stream: false };
  if (compat.maxCompletion || reasoning) body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
  if (!(compat.noTemp || reasoning)) body.temperature = temperature;
  if (effort && !compat.noEffort) body.reasoning_effort = effort;
  return body;
}

/** A 400 that names a parameter the model does not take -> the compat flag to set, or null. PURE. */
function paramFix(status, text) {
  if (status !== 400 && status !== 422) return null;
  const t = String(text || '').toLowerCase();
  if (/max_tokens/.test(t) && /(not supported|unsupported|max_completion_tokens)/.test(t)) return 'maxCompletion';
  if (/temperature/.test(t) && /(not supported|unsupported|only the default|does not support)/.test(t)) return 'noTemp';
  if (/reasoning_effort|reasoning effort|thinking_?(level|budget|config)/.test(t)) return 'noEffort';
  return null;
}

/** One chat/completions call. Throws ProviderError. */
async function callAccount(ctx, a, messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = 120000, model: useModel = null } = {}) {
  const key = await keyOf(ctx, a);
  const tmpl = providerOf(a.provider) || {};
  // the free OpenRouter account never sends a paid model (one typed by hand or named in an error):
  // it is dropped and a ":free" one is picked instead, so a key with credit on it is never charged
  if (tmpl.freeOnly && a.model && !FREE_MODEL.test(a.model)) { a.model = ''; save(ctx); }
  const model = useModel && (!tmpl.freeOnly || FREE_MODEL.test(useModel)) ? useModel : await ensureModel(ctx, a);
  if (tmpl.freeOnly && !FREE_MODEL.test(model)) throw new ProviderError('model', tr('ai.noModel'), 0);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await httpCall(`${a.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: headersFor(a, key),
      body: JSON.stringify(requestBody(model, messages, { maxTokens, temperature, compat: a.compat || {}, effort: a.base === tmpl.base ? tmpl.effort : null })),
    }, timeoutMs);
    const text = await res.text();
    if (!res.ok) {
      const fix = paramFix(res.status, text);
      if (fix && !(a.compat && a.compat[fix])) { a.compat = Object.assign({}, a.compat, { [fix]: true }); save(ctx); continue; }
      const c = classifyError(res.status, text);
      throw new ProviderError(c.kind, `${res.status} ${text.replace(/\s+/g, ' ').slice(0, 300)}`, retryAfterMs(res.headers) || c.coolMs);
    }
    let j;
    try { j = JSON.parse(text); } catch { throw new ProviderError('error', 'answer is not JSON', 30e3); }
    // some gateways (OpenRouter) answer 200 with the provider's error inside
    const inner = j.error || (j.choices && j.choices[0] && j.choices[0].error);
    if (inner) {
      const code = Number(inner.code) || Number(inner.status) || 500;
      const c = classifyError(code, JSON.stringify(inner));
      throw new ProviderError(c.kind, `${code} ${JSON.stringify(inner).slice(0, 300)}`, c.coolMs);
    }
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    const content = msg ? (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((x) => x.text || '').join('') : '') : '';
    if (!content.trim()) throw new ProviderError('empty', `empty answer${j.choices && j.choices[0] && j.choices[0].finish_reason ? ` (${j.choices[0].finish_reason})` : ''}`, 30e3);
    return { content, model, usage: j.usage || null, cut: !!(j.choices && j.choices[0] && j.choices[0].finish_reason === 'length') };
  }
  throw new ProviderError('error', 'the model refused the request parameters', 60e3);
}

// ------------------------------------------------------------------------------------------ router

const TIER_RANK = { paid: 0, free: 1, local: 2 };

/** Accounts in the order they are tried. PURE (status from `now`). */
function order(store, { localOnly = false, now = Date.now() } = {}) {
  const list = store.accounts.filter((a) => a.enabled !== false && (!localOnly || a.tier === 'local'));
  const rank = (a) => (a.tier === 'paid' ? (store.paidFirst ? 0 : 1.5) : TIER_RANK[a.tier] || 1);
  return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a)
    .filter((a) => (a.keyEnc || providerOf(a.provider) && providerOf(a.provider).noKey || a.noKey) && !(a.state && a.state.until && a.state.until > now) && !(a.state && a.state.kind === 'auth'));
}

function usageAdd(store, a, usage) {
  const day = new Date().toISOString().slice(0, 10);
  const u = store.usage[a.id] && store.usage[a.id].day === day ? store.usage[a.id] : { day, requests: 0, tokens: 0 };
  u.requests++;
  u.tokens += usage && Number(usage.total_tokens) ? Number(usage.total_tokens) : 0;
  store.usage[a.id] = u;
}

/** Keeps the system prompt and the newest messages that fit `budget` characters. PURE. */
function fitMessages(messages, budget) {
  const sys = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  let used = sys.reduce((n, m) => n + m.content.length, 0);
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const len = rest[i].content.length;
    if (kept.length && used + len > budget) break;
    kept.unshift(rest[i]);
    used += len;
  }
  const dropped = rest.length - kept.length;
  const note = dropped ? [{ role: 'system', content: `(${dropped} older messages of this conversation are left out to fit.)` }] : [];
  return [...sys, ...note, ...kept];
}

const BUSY_WAIT_MS = 2500;
const RATE_WAIT_MAX_MS = 65e3;

/**
 * One call, with the provider-side problems that do not need another provider handled here:
 *  - the model is gone ("no longer available to new users"): move to the model it suggests (else the
 *    newest one it lists), remember the old one as refused, ask again;
 *  - the model is busy (503 "high demand"): wait a moment and ask again; still busy -> ask once with
 *    another model of the same provider (the account keeps its own model for next time).
 */
async function callWithModelRetry(ctx, a, messages, opts, log = () => {}) {
  try {
    return await callAccount(ctx, a, messages, opts);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.kind === 'model') {
      if ((opts.modelTries || 0) >= 2) throw e; // every model refused: let the next provider answer
      const gone = a.model;
      if (gone) a.badModels = [...new Set([...(a.badModels || []), gone])].slice(-20);
      const next = suggestedModel(e.message);
      a.model = next && !(a.badModels || []).includes(next) ? next : '';
      save(ctx);
      log('info', tr('ai.modelSwitch', { name: a.name, old: gone || '?', model: a.model || '…' }));
      return callWithModelRetry(ctx, a, messages, Object.assign({}, opts, { modelTries: (opts.modelTries || 0) + 1 }), log); // a busy new model still gets its retries
    }
    if (e.kind !== 'busy' || opts.noBusyRetry) throw e;
    const busyModel = a.model;
    log('info', tr('ai.busyWait', { name: a.name, model: busyModel || '…' }));
    await new Promise((r) => setTimeout(r, opts.busyWaitMs != null ? opts.busyWaitMs : BUSY_WAIT_MS));
    try {
      return await callAccount(ctx, a, messages, opts);
    } catch (e2) {
      if (!(e2 instanceof ProviderError) || e2.kind !== 'busy') throw e2;
      let alt = null;
      try {
        const tmpl = providerOf(a.provider);
        alt = pickModel(await listModels(ctx, a), tmpl && tmpl.prefer, [...(a.badModels || []), busyModel]);
      } catch { /* no list: give up on this provider */ }
      if (!alt) throw e2;
      log('info', tr('ai.busyOther', { name: a.name, model: alt }));
      return callAccount(ctx, a, messages, Object.assign({}, opts, { model: alt }));
    }
  }
}

/**
 * Asks the accounts in order until one answers (and `accept(text)` does not throw). Returns
 * {text, value, by, switched[]}. Throws NO_AI with every reason when none could.
 */
/** The follow-up that asks the same AI again when its answer could not be used. PURE. */
function retryNote(reason, cut) {
  return [
    `Your answer could not be used: ${reason}.`,
    cut ? 'It was cut off: keep "explanation" to one sentence and the edits small.' : '',
    'Answer again with ONE JSON object and nothing else, exactly in the format asked.',
    'Copy every "search" text character for character from the FILE blocks (no line numbers, same indentation), several whole lines, unique in the file.',
  ].filter(Boolean).join(' ');
}

/**
 * Asks the accounts in order until one answers (and `accept(text)` does not throw). An answer that
 * `accept` refuses is sent back to the same AI once with the reason (models often fix their own
 * slip), before the next account is asked. Returns {text, value, by, switched[]}. Throws NO_AI with
 * every reason when none could.
 */
async function complete(ctx, messages, { projectId = null, accept = null, maxTokens = 2048, log = () => {}, answerTries = 2, rateWaitMaxMs = RATE_WAIT_MAX_MS } = {}) {
  const store = load(ctx);
  const localOnly = !!(projectId && store.localOnly[projectId]);
  const tried = [];
  const short = (e) => e instanceof ProviderError && e.kind === 'rate' && e.coolMs > 0 && e.coolMs <= rateWaitMaxMs;
  const pause = async (a, e) => {
    log('info', tr('ai.rateWait', { name: a.name, s: Math.ceil(e.coolMs / 1000) }));
    await new Promise((r) => setTimeout(r, e.coolMs + 1000));
  };
  const queue = order(store, { localOnly });
  let waited = false;
  for (let qi = 0; qi < queue.length; qi++) {
    const a = queue[qi];
    const budget = a.tier === 'local' ? 24000 : 90000;
    log('info', tr('ai.asking', { name: a.name, model: a.model || '…' }));
    let msgs = fitMessages(messages, budget);
    try {
      for (let round = 1; ; round++) {
        let r;
        try {
          r = await callWithModelRetry(ctx, a, msgs, { maxTokens }, log);
        } catch (e) {
          // a second round is a conversation with this AI already: a short "wait N s" is waited out
          if (round > 1 && short(e)) { await pause(a, e); r = await callWithModelRetry(ctx, a, msgs, { maxTokens }, log); } else throw e;
        }
        usageAdd(store, a, r.usage);
        let value;
        try {
          value = accept ? accept(r.content) : undefined;
        } catch (e) {
          const reason = `${r.cut ? 'cut off before the end, ' : ''}${String(e.message || e)}`;
          if (round >= answerTries) throw new Error(reason);
          log('info', tr('ai.askAgain', { name: a.name, reason: reason.slice(0, 160) }));
          msgs = [...msgs, { role: 'assistant', content: r.content.slice(0, 8000) }, { role: 'user', content: retryNote(reason, r.cut) }];
          continue;
        }
        delete a.state;
        save(ctx);
        return { text: r.content, value, by: { id: a.id, provider: a.provider, name: a.name, model: r.model, tier: a.tier }, switched: tried };
      }
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : 'badAnswer';
      if (kind === 'model' && a.model) { a.model = ''; } // the saved model is gone: pick again next time
      if (e instanceof ProviderError) {
        a.state = { kind, at: Date.now(), until: e.coolMs ? Date.now() + e.coolMs : null, message: String(e.message).slice(0, 200) };
      }
      save(ctx);
      tried.push({ id: a.id, name: a.name, kind, message: String(e.message).slice(0, 160) });
      log('warn', `${tr(`ai.why.${kind}`, { name: a.name })}${kind === 'badAnswer' ? ` (${String(e.message).slice(0, 160)})` : ''}`);
      // nobody else answered and this one only asked for a short wait: wait once, then ask it again
      if (qi === queue.length - 1 && !waited) {
        const soon = tried.map((x) => ({ x, acc: queue.find((q) => q.id === x.id) }))
          .filter((y) => y.acc && y.x.kind === 'rate' && y.acc.state && y.acc.state.until && y.acc.state.until - y.acc.state.at <= rateWaitMaxMs)
          .sort((p, q) => p.acc.state.until - q.acc.state.until)[0];
        if (soon) {
          waited = true;
          await pause(soon.acc, { coolMs: Math.max(0, soon.acc.state.until - Date.now()) });
          delete soon.acc.state;
          tried.splice(tried.indexOf(soon.x), 1);
          queue.push(soon.acc);
        }
      }
    }
  }
  if (!tried.length) throw new AppError('NO_AI', localOnly ? tr('ai.noLocal') : tr('ai.noAccounts'), 409, { tried });
  const why = tried.map((x) => `${x.name}: ${tr(`ai.short.${x.kind}`)}${x.kind === 'badAnswer' ? ` (${x.message.slice(0, 100)})` : ''}`).join(' · ');
  const cloud = store.accounts.filter((x) => x.enabled !== false && x.tier !== 'local' && x.keyEnc).length;
  const tip = cloud < 3 && !localOnly ? ` ${tr('ai.addMore')}` : '';
  throw new AppError('NO_AI', `${tr('ai.allFailed', { n: tried.length })} ${why}.${tip}`, 503, { tried });
}

// ------------------------------------------------------------------------------------------ views / settings

function view(ctx, a, now = Date.now()) {
  const p = providerOf(a.provider) || {};
  const st = a.state || null;
  let status = 'ready';
  if (!a.keyEnc && !p.noKey && !a.noKey) status = 'noKey';
  else if (a.enabled === false) status = 'off';
  else if (st && st.kind === 'auth') status = 'auth';
  else if (st && st.until && st.until > now) status = st.kind === 'quota' || st.kind === 'credit' ? st.kind : 'cooling';
  const u = load(ctx).usage[a.id];
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: a.id, provider: a.provider, name: a.name, tier: a.tier, base: a.base, model: a.model || '', enabled: a.enabled !== false,
    keyHint: a.keyHint || null, noKey: !!(p.noKey || a.noKey), keyUrl: p.keyUrl || null, status,
    until: st && st.until && st.until > now ? new Date(st.until).toISOString() : null, lastError: st ? st.message : null,
    usage: u && u.day === today ? { requests: u.requests, tokens: u.tokens } : { requests: 0, tokens: 0 },
    removable: a.tier === 'paid',
    canCatch: !p.noKey && !a.noKey && !!KEY_RE[a.provider],
    login: a.provider === 'openrouter' ? 'openrouter' : null,
  };
}

function overview(ctx) {
  const s = load(ctx);
  const next = order(s)[0];
  return {
    accounts: s.accounts.map((a) => view(ctx, a)),
    paidFirst: s.paidFirst, localOnly: s.localOnly,
    next: next ? { id: next.id, provider: next.provider, name: next.name, tier: next.tier } : null,
    paidTemplates: PAID.map((p) => ({ id: p.id, name: p.name, base: p.base, model: p.model, keyUrl: p.keyUrl })),
  };
}

function checkBase(base) {
  let u;
  try { u = new URL(String(base || '').trim()); } catch { throw new AppError('BAD_INPUT', tr('ai.badBase'), 400); }
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AppError('BAD_INPUT', tr('ai.badBase'), 400);
  return u.toString().replace(/\/+$/, '');
}

async function addPaid(ctx, body) {
  const t = PAID.find((p) => p.id === body.template);
  if (!t) throw new AppError('BAD_INPUT', tr('ai.noAccount'), 400);
  const s = load(ctx);
  const a = {
    id: `paid-${util.randomHex(4)}`, provider: t.id, name: util.cleanText(body.name || t.name, 60) || t.name, tier: 'paid',
    base: checkBase(t.id === 'custom' ? body.base : t.base), model: util.cleanText(body.model || t.model || '', 120), enabled: true, keyEnc: null, keyHint: null,
  };
  if (t.id === 'custom' && /^http:/.test(a.base)) a.noKey = !body.key;
  s.accounts.push(a);
  save(ctx);
  if (body.key) await setKey(ctx, a.id, body.key);
  return view(ctx, a);
}

function update(ctx, id, body) {
  const s = load(ctx);
  const a = getAccount(ctx, id);
  if (typeof body.enabled === 'boolean') a.enabled = body.enabled;
  if (typeof body.model === 'string') {
    a.model = util.cleanText(body.model, 120);
    if (a.state && a.state.kind === 'model') delete a.state;
    if (a.model && a.badModels) a.badModels = a.badModels.filter((m) => m !== a.model); // the user chose it again
  }
  if (body.move === 'up' || body.move === 'down') {
    const i = s.accounts.indexOf(a);
    const j = body.move === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < s.accounts.length) [s.accounts[i], s.accounts[j]] = [s.accounts[j], s.accounts[i]];
  }
  if (body.resetState) delete a.state;
  save(ctx);
  return view(ctx, a);
}

function remove(ctx, id) {
  const s = load(ctx);
  const a = getAccount(ctx, id);
  if (a.tier !== 'paid') throw new AppError('BAD_INPUT', tr('ai.cannotRemove'), 400);
  s.accounts = s.accounts.filter((x) => x !== a);
  delete s.usage[a.id];
  keyCache.delete(a.id);
  save(ctx);
  return {};
}

function settings(ctx, body) {
  const s = load(ctx);
  if (typeof body.paidFirst === 'boolean') s.paidFirst = body.paidFirst;
  if (body.localOnly && typeof body.localOnly === 'object') {
    for (const [pid, on] of Object.entries(body.localOnly)) {
      projects.getProject(ctx, pid);
      if (on) s.localOnly[pid] = true; else delete s.localOnly[pid];
    }
  }
  save(ctx);
  return overview(ctx);
}

async function test(ctx, id) {
  const a = getAccount(ctx, id);
  const started = Date.now();
  try {
    const r = await callWithModelRetry(ctx, a, [{ role: 'user', content: 'Reply with the single word: OK' }], { maxTokens: 1024, timeoutMs: 60000 });
    delete a.state;
    save(ctx);
    return { ok: true, model: r.model, ms: Date.now() - started, reply: r.content.trim().slice(0, 60) };
  } catch (e) {
    if (e instanceof ProviderError) { a.state = { kind: e.kind, at: Date.now(), until: e.coolMs ? Date.now() + e.coolMs : null, message: String(e.message).slice(0, 200) }; save(ctx); }
    return { ok: false, kind: e.kind || 'error', error: String(e.message).slice(0, 300) };
  }
}

async function models(ctx, id) {
  const a = getAccount(ctx, id);
  try { return { models: await listModels(ctx, a) }; } catch (e) { throw new AppError('AI_MODELS', tr('ai.modelsFail', { message: String(e.message).slice(0, 200) }), 502); }
}

// ------------------------------------------------------------------------------------------ chats

function chatsDir(ctx) { return path.join(aiDir(ctx), 'chats'); }
const CHAT_ID = /^c-[0-9a-f]{12}$/;
function chatFile(ctx, id) {
  if (!CHAT_ID.test(String(id))) throw new AppError('BAD_INPUT', tr('ai.noChat'), 400);
  return path.join(chatsDir(ctx), `${id}.json`);
}

function listChats(ctx) {
  const out = [];
  for (const f of util.listFileNames(chatsDir(ctx))) {
    if (!/^c-[0-9a-f]{12}\.json$/.test(f)) continue;
    const c = util.readJson(path.join(chatsDir(ctx), f), null);
    if (c) out.push({ id: c.id, title: c.title, projectId: c.projectId || null, updatedAt: c.updatedAt, count: (c.messages || []).length });
  }
  return { chats: out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
}

function getChat(ctx, id) {
  const c = util.readJson(chatFile(ctx, id), null);
  if (!c) throw new AppError('NOT_FOUND', tr('ai.noChat'), 404);
  return c;
}

function newChat(ctx, body) {
  const projectId = body.projectId ? projects.getProject(ctx, String(body.projectId)).id : null;
  const c = { id: `c-${crypto.randomBytes(6).toString('hex')}`, title: util.cleanText(body.title || '', 80) || tr('ai.newChatTitle'), projectId, createdAt: util.nowIso(), updatedAt: util.nowIso(), messages: [] };
  util.ensureDir(chatsDir(ctx));
  util.writeJsonAtomic(chatFile(ctx, c.id), c);
  return { chat: c };
}

function deleteChat(ctx, id) {
  try { fs.unlinkSync(chatFile(ctx, id)); } catch { /* gone */ }
  return {};
}

function chatSystem(ctx, c) {
  const lang = ctx.store.data.settings.lang || 'roman';
  const speak = lang === 'en' ? 'English' : lang === 'ur' ? 'Urdu (Nastaliq script)' : 'Roman Urdu (Urdu in Latin letters), as the user writes';
  let proj = '';
  if (c.projectId) {
    try {
      const p = projects.getProject(ctx, c.projectId);
      const inf = projects.inspectProject(p.path);
      proj = `\nThe conversation is about the project "${p.name}" (PHP ${p.phpVersion}${inf.isLaravel ? `, Laravel ${projects.laravelVersionOf(inf) || ''}` : ''}).`;
    } catch { /* removed */ }
  }
  return { role: 'system', content: `You are the coding assistant inside PHP Station, a local PHP / Laravel workbench on Windows. Help with PHP, Laravel, MySQL/MariaDB, JavaScript and the developer's projects. Give working code, short and exact. Answer in ${speak}.${proj}` };
}

async function sendChat(ctx, id, text) {
  const c = getChat(ctx, id);
  const t = String(text || '').trim();
  if (!t) throw new AppError('BAD_INPUT', tr('ai.emptyMessage'), 400);
  if (t.length > 40000) throw new AppError('BAD_INPUT', tr('ai.tooLongMessage'), 400);
  c.messages.push({ role: 'user', content: t, at: util.nowIso() });
  if (c.messages.length === 1) c.title = util.cleanText(t.replace(/\s+/g, ' '), 60);
  const msgs = [chatSystem(ctx, c), ...c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content }))];
  let r;
  try {
    r = await complete(ctx, msgs, { projectId: c.projectId, maxTokens: 4096 });
  } catch (e) {
    c.messages.pop(); // the question stays in the box for another try
    throw e;
  }
  const reply = { role: 'assistant', content: r.text, at: util.nowIso(), by: r.by };
  if (r.switched.length) reply.switched = r.switched.map((x) => ({ name: x.name, kind: x.kind }));
  c.messages.push(reply);
  c.updatedAt = util.nowIso();
  util.writeJsonAtomic(chatFile(ctx, c.id), c);
  return { chat: c, reply };
}

// ------------------------------------------------------------------------------------------ Fix with AI

const FIX_ID = /^f-[0-9a-f]{12}$/;
function fixesDir(ctx) { return path.join(aiDir(ctx), 'fixes'); }
function fixFile(ctx, id) {
  if (!FIX_ID.test(String(id))) throw new AppError('BAD_INPUT', tr('ai.noFix'), 400);
  return path.join(fixesDir(ctx), id, 'fix.json');
}

/** A path the AI may read or change: inside the project, not vendor / node_modules / .git / storage / .env. */
function safeProjectFile(root, file) {
  if (!file) return null;
  const abs = win.isAbsolute(String(file)) ? win.normalize(String(file)) : win.join(root, String(file));
  if (!util.isInside(abs, root) || util.samePath(abs, root)) return null;
  const rel = win.relative(root, abs);
  if (/^(vendor|node_modules|\.git|storage|bootstrap\\cache)(\\|$)/i.test(rel) || /(^|\\)\.env(\.|$)/i.test(rel)) return null;
  if (!util.existsFile(abs)) return null;
  return { abs, rel };
}

function numbered(lines, from, to, mark) {
  const out = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(`${String(i).padStart(4)}${i === mark ? ' >' : '  '} ${lines[i - 1]}`);
  return out.join('\n');
}

/** The prompt for one error. PURE apart from reading the files. */
function buildFixPrompt(p, info, err) {
  const files = [];
  const main = safeProjectFile(p.path, err.file);
  const add = (f, line, whole) => {
    const text = util.readText(f.abs, '') || '';
    const lines = text.split(/\r?\n/);
    const body = whole || lines.length <= 260 ? text : lines.slice(Math.max(0, (line || 1) - 80), (line || 1) + 80).join('\n');
    files.push({ rel: f.rel, line, whole: whole || lines.length <= 260, body, view: line ? numbered(lines, (line || 1) - 6, (line || 1) + 6, line) : null });
  };
  if (main) add(main, err.line, false);
  for (const fr of (err.frames || []).slice(0, 6)) {
    if (files.length >= 3) break;
    const f = safeProjectFile(p.path, fr.file);
    if (f && !files.some((x) => x.rel === f.rel)) add(f, fr.line, false);
  }
  const sys = [
    'You fix exactly one bug in a PHP project. Change as little as possible and keep the code style.',
    'Answer with ONE JSON object and nothing else:',
    '{"explanation": "<one or two sentences: the cause and the fix>", "edits": [{"file": "<path relative to the project, as given>", "search": "<exact text copied from the file, several whole lines, unique in the file>", "replace": "<the new text>"}]}',
    'Rules: "search" must be copied character for character from the FILE blocks (not from the numbered view) and must appear exactly once. At most 5 edits. Never touch vendor/, .env or storage/. If you cannot fix it safely, answer {"explanation": "<why>", "edits": []}.',
  ].join('\n');
  const parts = [`Project: ${p.name} (PHP ${p.phpVersion}${info.isLaravel ? ', Laravel' : ''})`, `Problem (${err.source || 'error'}): ${err.message}`];
  if (err.file) parts.push(`Reported at: ${main ? main.rel : err.file}${err.line ? `:${err.line}` : ''}`);
  if (err.extra) parts.push(String(err.extra).slice(0, 1500));
  for (const f of files) {
    if (f.view) parts.push(`Around line ${f.line} of ${f.rel}:\n${f.view}`);
    parts.push(`FILE ${f.rel}${f.whole ? '' : ' (excerpt)'}:\n<<<\n${f.body}\n>>>`);
  }
  if (err.feedback) parts.push(`Your previous fix did not pass the check:\n${String(err.feedback).slice(0, 2000)}\nTry again from the current file contents above.`);
  return { messages: [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n\n') }], files: files.map((f) => f.rel) };
}

/** First JSON object in a model answer (fenced or not). PURE. */
function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const cands = [fence ? fence[1] : null, s];
  for (const c of cands) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start < 0) continue;
    const stack = []; let inStr = false; let esc = false; let bad = false;
    for (let i = start; i < c.length && !bad; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== (ch === '}' ? '{' : '[')) { bad = true; break; }
        if (!stack.length) { try { return JSON.parse(c.slice(start, i + 1)); } catch { bad = true; } }
      }
    }
    // the model stopped before its last brackets ({"edits": [{...}] without the final "}"): close them
    if (!bad && !inStr && stack.length && stack.length <= 3) {
      const tail = c.slice(start).replace(/[\s`]+$/, '');
      const closers = stack.slice().reverse().map((b) => (b === '{' ? '}' : ']')).join('');
      try { return JSON.parse(tail + closers); } catch { /* not repairable */ }
    }
  }
  return null;
}

/** "  42 >  code" / "  42    code" (the numbered view) -> "code", when every line has the prefix. PURE. */
function stripLineNumbers(s) {
  const lines = s.split(/\r?\n/);
  const re = /^ *\d+ [ >] /;
  const full = lines.filter((l) => l.trim());
  if (!full.length || !full.every((l) => re.test(l))) return s;
  return lines.map((l) => l.replace(re, '')).join('\n');
}

/**
 * Where `search` is in `text`. Exact first; then, as models slip, without line numbers copied from the
 * numbered view, then whole lines compared without the spaces at their ends and inside. A loose match
 * must still be unique; it returns the file's own text, and the replacement moved to the file's
 * indentation. -> {search, replace} | throws with the count. PURE.
 */
function locate(text, search, replace, eol) {
  const count = (s) => (s ? text.split(s).length - 1 : 0);
  const n = count(search);
  if (n === 1) return { search, replace };
  if (n > 1) throw new Error(`the search text was found ${n} times`);
  const unnumbered = stripLineNumbers(search).replace(/\r?\n/g, eol);
  if (unnumbered !== search && count(unnumbered) === 1) return { search: unnumbered, replace: stripLineNumbers(replace).replace(/\r?\n/g, eol) };
  const norm = (l) => l.trim().replace(/\s+/g, ' ');
  const want = unnumbered.split(eol);
  while (want.length && !want[0].trim()) want.shift();
  while (want.length && !want[want.length - 1].trim()) want.pop();
  if (!want.length) throw new Error('the search text was found 0 times');
  const have = text.split(eol);
  const hits = [];
  for (let i = 0; i + want.length <= have.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) ok = norm(have[i + k]) === norm(want[k]);
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) throw new Error(`the search text was found ${hits.length} times`);
  const found = have.slice(hits[0], hits[0] + want.length);
  const theirs = (/^\s*/.exec(want[0]) || [''])[0];
  const ours = (/^\s*/.exec(found[0]) || [''])[0];
  const rep = (unnumbered !== search ? stripLineNumbers(replace).replace(/\r?\n/g, eol) : replace).split(eol)
    .map((l) => (theirs !== ours && l.startsWith(theirs) ? ours + l.slice(theirs.length) : l)).join(eol);
  return { search: found.join(eol), replace: rep };
}

/** Checks the edits against the files; returns them normalised. Throws with a reason. PURE apart from reads. */
function validateEdits(root, raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.edits)) throw new Error('no edits array');
  if (raw.edits.length > 5) throw new Error('too many edits');
  const contents = new Map();
  const out = [];
  for (const e of raw.edits) {
    const f = safeProjectFile(root, e && e.file);
    if (!f) throw new Error(`file not allowed: ${e && e.file}`);
    if (typeof e.search !== 'string' || !e.search.trim() || typeof e.replace !== 'string') throw new Error('edit without search/replace');
    if (e.search.length > 8000 || e.replace.length > 12000) throw new Error('edit too large');
    if (!contents.has(f.abs)) contents.set(f.abs, util.readText(f.abs, '') || '');
    const text = contents.get(f.abs);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let hit;
    try { hit = locate(text, e.search.replace(/\r?\n/g, eol), e.replace.replace(/\r?\n/g, eol), eol); } catch (x) { throw new Error(`${f.rel}: ${x.message}`); }
    const { search, replace } = hit;
    if (search === replace) throw new Error(`${f.rel}: the edit changes nothing`);
    contents.set(f.abs, text.replace(search, () => replace));
    out.push({ file: f.rel, search, replace });
  }
  return out;
}

/** A small unified-style diff of the edits for the page. PURE. */
function diffOf(edits) {
  return edits.map((e) => ({
    file: e.file,
    lines: [...e.search.split(/\r?\n/).map((l) => `-${l}`), ...e.replace.split(/\r?\n/).map((l) => `+${l}`)],
  }));
}

function saveFix(ctx, fix) {
  const f = fixFile(ctx, fix.id);
  util.ensureDir(path.dirname(f));
  util.writeJsonAtomic(f, fix);
}

function loadFix(ctx, id) {
  const fix = util.readJson(fixFile(ctx, id), null);
  if (!fix) throw new AppError('NOT_FOUND', tr('ai.noFix'), 404);
  return fix;
}

function cleanErr(body) {
  const frames = Array.isArray(body.frames) ? body.frames.slice(0, 10).map((f) => ({ file: String(f.file || ''), line: Number(f.line) || null })) : [];
  return {
    source: util.cleanText(body.source || 'error', 30), message: String(body.message || '').slice(0, 3000),
    file: body.file ? String(body.file) : null, line: Number(body.line) || null, frames,
    url: typeof body.url === 'string' && /^\/[^\s]*$/.test(body.url) ? body.url.slice(0, 500) : null,
    phpPath: body.phpPath ? String(body.phpPath) : null, extra: body.extra ? String(body.extra).slice(0, 1500) : null,
  };
}

/** Job: ask the AI for a fix; the result is the proposal (nothing is written yet). */
async function proposeJob(ctx, projectId, body, log) {
  const p = projects.getProject(ctx, projectId);
  const err = cleanErr(body);
  if (!err.message) throw new AppError('BAD_INPUT', tr('ai.noError'), 400);
  const info = projects.inspectProject(p.path);
  const pr = buildFixPrompt(p, info, err);
  if (!pr.files.length) throw new AppError('AI_NO_FILE', tr('ai.noFile'), 409);
  log('info', tr('ai.reading', { files: pr.files.join(', ') }));
  const r = await complete(ctx, pr.messages, {
    projectId: p.id, maxTokens: 8192, log,
    accept: (text) => {
      const j = extractJson(text);
      if (!j) throw new Error('not JSON');
      return { explanation: String(j.explanation || '').slice(0, 1500), edits: validateEdits(p.path, j) };
    },
  });
  const fix = {
    id: `f-${crypto.randomBytes(6).toString('hex')}`, projectId: p.id, createdAt: util.nowIso(), err,
    explanation: r.value.explanation, edits: r.value.edits, by: r.by, switched: r.switched, status: 'proposed', attempts: [],
  };
  saveFix(ctx, fix);
  log(fix.edits.length ? 'ok' : 'warn', fix.edits.length ? tr('ai.proposed', { name: r.by.name, n: fix.edits.length }) : tr('ai.noEdits', { name: r.by.name }));
  return { fixId: fix.id, explanation: fix.explanation, diff: diffOf(fix.edits), by: fix.by, switched: fix.switched };
}

function applyEdits(root, edits) {
  const byFile = new Map();
  for (const e of edits) {
    const abs = win.join(root, e.file);
    const text = byFile.has(abs) ? byFile.get(abs) : (util.readText(abs, '') || '');
    if (text.split(e.search).length - 1 !== 1) throw new Error(`${e.file}: the code changed since the fix was made`);
    byFile.set(abs, text.replace(e.search, () => e.replace));
  }
  for (const [abs, text] of byFile) util.writeFileAtomic(abs, text);
}

function backupFiles(ctx, fix, root) {
  const dir = path.join(fixesDir(ctx), fix.id, 'backup');
  for (const e of fix.edits) {
    const dest = path.join(dir, e.file);
    if (util.existsFile(dest)) continue;
    util.ensureDir(path.dirname(dest));
    fs.copyFileSync(win.join(root, e.file), dest);
  }
  return dir;
}

function restoreFiles(ctx, fix, root) {
  const dir = path.join(fixesDir(ctx), fix.id, 'backup');
  for (const file of [...new Set(fix.edits.map((e) => e.file))]) {
    const src = path.join(dir, file);
    if (util.existsFile(src)) fs.copyFileSync(src, win.join(root, file));
  }
}

/** php -l of the changed files, then the page again (when the error came from one). -> {ok, report} */
async function verify(ctx, p, fix, log) {
  const php = (fix.err.phpPath && runtimes.getCache(ctx).php.find((r) => r.ok && util.samePath(r.path, fix.err.phpPath))) || projects.resolveProjectPhp(ctx, p);
  const lines = [];
  let ok = true;
  if (php) {
    const inv = runtimes.phpInvocation(php);
    for (const file of [...new Set(fix.edits.map((e) => e.file))]) {
      const r = await util.run(inv.file, [...inv.preArgs, '-d', 'error_reporting=-1', '-d', 'display_errors=stderr', '-l', win.join(p.path, file)], { env: util.cleanEnv(), cwd: p.path, timeoutMs: 30000 });
      const out = `${r.stdout}\n${r.stderr}`;
      const bad = r.code !== 0 || (fix.err.source === 'deprecation' && /Deprecated:/i.test(out));
      if (bad) ok = false;
      const msg = (out.split(/\r?\n/).find((l) => /error|deprecated/i.test(l)) || '').trim();
      lines.push(`${bad ? 'FAIL' : 'OK'} php -l ${file} (PHP ${php.version})${bad ? `: ${msg}` : ''}`);
      log(bad ? 'bad' : 'ok', tr(bad ? 'ai.lintBad' : 'ai.lintOk', { file, version: php.version }));
    }
  }
  const run = ctx.store.data.runs && ctx.store.data.runs[p.id];
  if (ok && fix.err.url && run && run.port) {
    const lab = require('./upgradelab');
    const r = await lab.fetchPage(run.port, fix.err.url, null);
    const marks = lab.pageMarkers(r.body).filter((m) => !/deprecat/i.test(m.level) || fix.err.source === 'deprecation');
    const bad = r.status === 0 || r.status >= 500 || marks.length > 0;
    if (bad) ok = false;
    lines.push(`${bad ? 'FAIL' : 'OK'} GET ${fix.err.url} -> ${r.status}${marks[0] ? ` ${marks[0].level}: ${marks[0].message}` : ''}`);
    log(bad ? 'bad' : 'ok', tr(bad ? 'ai.pageBad' : 'ai.pageOk', { url: fix.err.url, status: r.status }));
  }
  return { ok, report: lines.join('\n') };
}

/** Job: back up, apply, check; on a failed check put the files back and ask once more. */
async function applyJob(ctx, fixId, log) {
  let fix = loadFix(ctx, fixId);
  const p = projects.getProject(ctx, fix.projectId);
  if (fix.status === 'applied') throw new AppError('BAD_INPUT', tr('ai.alreadyApplied'), 409);
  if (!fix.edits.length) throw new AppError('BAD_INPUT', tr('ai.noEditsShort'), 409);
  for (let attempt = 1; attempt <= 2; attempt++) {
    backupFiles(ctx, fix, p.path);
    applyEdits(p.path, fix.edits);
    log('info', tr('ai.applied', { n: fix.edits.length }));
    const v = await verify(ctx, p, fix, log);
    fix.attempts.push({ at: util.nowIso(), ok: v.ok, report: v.report, by: fix.by });
    if (v.ok) {
      fix.status = 'applied';
      saveFix(ctx, fix);
      log('ok', tr('ai.fixed'));
      return { fixId: fix.id, ok: true, report: v.report, diff: diffOf(fix.edits), explanation: fix.explanation, by: fix.by };
    }
    restoreFiles(ctx, fix, p.path);
    log('warn', tr('ai.restored'));
    if (attempt === 2) break;
    // one more try, with what failed
    log('info', tr('ai.retry'));
    const info = projects.inspectProject(p.path);
    const pr = buildFixPrompt(p, info, Object.assign({}, fix.err, { feedback: v.report }));
    let r;
    try {
      r = await complete(ctx, pr.messages, {
        projectId: p.id, maxTokens: 8192, log,
        accept: (text) => { const j = extractJson(text); if (!j) throw new Error('not JSON'); return { explanation: String(j.explanation || '').slice(0, 1500), edits: validateEdits(p.path, j) }; },
      });
    } catch (e) { log('warn', e.message); break; }
    if (!r.value.edits.length) break;
    fix = Object.assign(fix, { edits: r.value.edits, explanation: r.value.explanation, by: r.by });
    saveFix(ctx, fix);
  }
  fix.status = 'failed';
  saveFix(ctx, fix);
  const last = fix.attempts[fix.attempts.length - 1];
  return { fixId: fix.id, ok: false, report: last ? last.report : '', diff: diffOf(fix.edits), explanation: fix.explanation, by: fix.by };
}

function undoFix(ctx, fixId) {
  const fix = loadFix(ctx, fixId);
  if (fix.status !== 'applied') throw new AppError('BAD_INPUT', tr('ai.notApplied'), 409);
  const p = projects.getProject(ctx, fix.projectId);
  restoreFiles(ctx, fix, p.path);
  fix.status = 'undone';
  fix.undoneAt = util.nowIso();
  saveFix(ctx, fix);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------ connect without copy-paste

/** Saves a key that came from a login / the clipboard / this PC, switches the account on and tries it once. */
async function connectWith(ctx, id, key) {
  const a = getAccount(ctx, id);
  await setKey(ctx, id, key);
  a.enabled = true;
  save(ctx);
  const t = await test(ctx, id);
  return { account: view(ctx, a), test: t };
}

// OpenRouter login (OAuth PKCE): one login in the browser, the key comes back by itself. Its free
// models (":free") are many: DeepSeek, Qwen coder, Llama, Gemma ... one account, many models.
const OR_AUTH = 'https://openrouter.ai/auth';
const OR_EXCHANGE = 'https://openrouter.ai/api/v1/auth/keys';
const oauthPending = new Map(); // state -> {verifier, at}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function startOpenRouterLogin(ctx) {
  for (const [s, v] of oauthPending) if (Date.now() - v.at > 15 * 60e3) oauthPending.delete(s);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  oauthPending.set(state, { verifier, at: Date.now() });
  // OpenRouter documents localhost callbacks on any port
  const cb = `http://localhost:${ctx.port}/oauth/openrouter`;
  const q = new URLSearchParams({ callback_url: cb, code_challenge: challenge, code_challenge_method: 'S256', state, key_label: APP_NAME });
  return { url: `${ctx.openrouterAuth || OR_AUTH}?${q}` };
}

/** The browser comes back to /oauth/openrouter?code=..&state=..: swap the code for a key. */
async function finishOpenRouterLogin(ctx, { code, state }) {
  let st = state && oauthPending.get(String(state));
  // OpenRouter echoes `state`; without it, only a single waiting login is taken
  if (!st && !state && oauthPending.size === 1) { const [only] = oauthPending.entries(); state = only[0]; st = only[1]; }
  if (!st || Date.now() - st.at > 15 * 60e3) throw new AppError('OAUTH', tr('ai.loginExpired'), 400);
  if (!code || !/^[\w.-]{4,512}$/.test(String(code))) throw new AppError('OAUTH', tr('ai.loginNoCode'), 400);
  oauthPending.delete(String(state));
  const res = await httpCall(ctx.openrouterExchange || OR_EXCHANGE, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: String(code), code_verifier: st.verifier, code_challenge_method: 'S256' }),
  }, 30000).catch((e) => { throw new AppError('OAUTH', tr('ai.loginFail', { message: e.message }), 502); });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* below */ }
  if (!res.ok || !j || typeof j.key !== 'string' || !j.key) throw new AppError('OAUTH', tr('ai.loginFail', { message: `${res.status} ${text.slice(0, 160)}` }), 502);
  return connectWith(ctx, 'openrouter', j.key);
}

// Catch the key from the clipboard: the page opens the provider's key page, the user only clicks its
// "Copy" button. Only text shaped like that provider's key is taken; nothing else is read or kept.
let catching = null; // {id, stopFile}

async function catchKey(ctx, id, { seconds = 180 } = {}) {
  const a = getAccount(ctx, id);
  const re = KEY_RE[a.provider];
  if (!re) throw new AppError('BAD_INPUT', tr('ai.noCatch'), 400);
  if (catching) stopCatch();
  const stopFile = path.join(aiDir(ctx), `.stop-catch-${util.randomHex(4)}`);
  util.ensureDir(aiDir(ctx));
  catching = { id, stopFile };
  const script = String.raw`
$re = $env:PS_AI_RE
$end = (Get-Date).AddSeconds([int]$env:PS_AI_SECS)
while ((Get-Date) -lt $end) {
  if (Test-Path -LiteralPath $env:PS_AI_STOP) { break }
  try { $c = Get-Clipboard -Raw -ErrorAction Stop } catch { $c = $null }
  if ($c) { $c = $c.Trim(); if ($c -cmatch $re) { @{ ok = $true; v = $c } | ConvertTo-Json -Compress; exit } }
  Start-Sleep -Milliseconds 700
}
@{ ok = $false } | ConvertTo-Json -Compress
`;
  let r;
  try {
    r = await procs.psOneShot(script, { sta: true, timeoutMs: (seconds + 15) * 1000, env: util.cleanEnv({ remove: [], set: { PS_AI_RE: re.source, PS_AI_SECS: String(seconds), PS_AI_STOP: stopFile } }) });
  } finally {
    try { fs.unlinkSync(stopFile); } catch { /* none */ }
    if (catching && catching.stopFile === stopFile) catching = null;
  }
  if (!r.json || !r.json.ok || typeof r.json.v !== 'string' || !re.test(r.json.v)) return { caught: false };
  return Object.assign({ caught: true }, await connectWith(ctx, id, r.json.v));
}

function stopCatch() {
  if (catching) { try { fs.writeFileSync(catching.stopFile, '1'); } catch { /* gone */ } }
  return {};
}

/** Keys already on this PC (environment variables, the GitHub CLI login) for accounts without one. */
async function findKeys(ctx, { env = process.env, ghToken = null } = {}) {
  const s = load(ctx);
  const out = [];
  for (const a of s.accounts) {
    if (a.tier === 'paid' || a.keyEnc || !ENV_KEYS[a.provider]) continue;
    for (const name of ENV_KEYS[a.provider]) {
      const v = String(env[name] || '').trim();
      if (v && KEY_RE[a.provider].test(v)) { out.push({ id: a.id, name: a.name, source: `%${name}%`, hint: hintOf(v), key: v }); break; }
    }
  }
  const gh = s.accounts.find((a) => a.provider === 'github' && a.tier !== 'paid');
  if (gh && !gh.keyEnc && !out.some((x) => x.id === gh.id)) {
    const tok = ghToken != null ? ghToken : await ghCliToken();
    if (tok && KEY_RE.github.test(tok)) out.push({ id: gh.id, name: gh.name, source: 'GitHub CLI (gh auth login)', hint: hintOf(tok), key: tok });
  }
  return out;
}

async function ghCliToken() {
  const cands = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')];
  let exe = cands.find((c) => util.existsFile(c));
  if (!exe) {
    const w = await util.run('where.exe', ['gh'], { timeoutMs: 5000 });
    exe = (w.code === 0 && w.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l))) || null;
  }
  if (!exe) return null;
  const r = await util.run(exe, ['auth', 'token'], { timeoutMs: 10000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The page lists what was found (hints only); importing saves and tries each. */
async function foundKeys(ctx) {
  return { found: (await findKeys(ctx)).map(({ key, ...rest }) => rest) };
}

async function importFound(ctx, ids) {
  const want = Array.isArray(ids) ? ids.map(String) : null;
  const done = [];
  for (const f of await findKeys(ctx)) {
    if (want && !want.includes(f.id)) continue;
    done.push(Object.assign({ id: f.id, name: f.name }, await connectWith(ctx, f.id, f.key)));
  }
  return { imported: done };
}

module.exports = {
  // pure
  FREE, PAID, KEY_RE, classifyError, pickModel, suggestedModel, requestBody, paramFix, order, fitMessages, extractJson, validateEdits, locate, stripLineNumbers, retryNote, diffOf, hintOf, buildFixPrompt, safeProjectFile,
  // manager
  load, overview, setKey, addPaid, update, remove, settings, test, models, complete,
  startOpenRouterLogin, finishOpenRouterLogin, catchKey, stopCatch, findKeys, foundKeys, importFound,
  listChats, getChat, newChat, deleteChat, sendChat,
  proposeJob, applyJob, undoFix,
  ProviderError,
};
