'use strict';
// AI hub (lib/ai.js): routing between accounts, auto-switch on limits, Fix with AI (propose, apply,
// check, retry, undo). Every AI here is a fake OpenAI-compatible server on 127.0.0.1: no real key, no
// real account, nothing leaves the PC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ai = require('../lib/ai');
require('../lib/i18n').setLang('en');

const XAMPP_PHP = 'D:\\Xampp 8.2.12\\php\\php.exe';
const hasPhp = fs.existsSync(XAMPP_PHP);

/** A fake chat/completions server: `plan` is a list of answers, one per request. */
function fakeAi(plan) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'tiny-model' }, { id: 'fake-coder-7b' }] }));
        return;
      }
      const step = plan.length > 1 ? plan.shift() : plan[0];
      if (step.status && step.status !== 200) {
        res.writeHead(step.status, Object.assign({ 'Content-Type': 'application/json' }, step.headers || {}));
        res.end(JSON.stringify({ error: { message: step.message || 'error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content } }], usage: { total_tokens: 42 } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: `http://127.0.0.1:${srv.address().port}/v1` })));
}

function makeCtx(accounts, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-'));
  fs.mkdirSync(path.join(dataDir, 'ai'), { recursive: true });
  // every free provider switched off, so only the fake accounts answer
  const off = ai.FREE.map((p) => ({ id: p.id, provider: p.id, name: p.name, tier: p.tier, base: p.base, model: '', enabled: false }));
  fs.writeFileSync(path.join(dataDir, 'ai', 'accounts.json'), JSON.stringify({ accounts: [...accounts, ...off] }));
  return Object.assign({ dataDir, store: { data: { settings: { lang: 'en' }, projects: [], runs: {} } }, runtimes: { scanning: false, cache: { scannedAt: null, php: [], composer: [], db: [] } } }, extra);
}
const acct = (id, base, tier = 'paid', model = 'fake-coder-7b') => ({ id, provider: 'custom', name: id, tier, base, model, enabled: true, noKey: true });

// ------------------------------------------------------------------------------------------ pure parts

test('AI: errors are classified so the router knows whether to wait or move on', () => {
  assert.strictEqual(ai.classifyError(429, 'Rate limit reached for requests').kind, 'rate');
  assert.strictEqual(ai.classifyError(429, 'You exceeded your current quota, requests per day').kind, 'quota');
  assert.strictEqual(ai.classifyError(429, 'RESOURCE_EXHAUSTED: quota').kind, 'rate');
  assert.strictEqual(ai.classifyError(401, 'invalid api key').kind, 'auth');
  assert.strictEqual(ai.classifyError(402, '').kind, 'credit');
  assert.strictEqual(ai.classifyError(404, 'The model `x` does not exist').kind, 'model');
  assert.strictEqual(ai.classifyError(400, 'maximum context length is 8192 tokens').kind, 'tooLong');
  assert.strictEqual(ai.classifyError(503, 'overloaded').kind, 'busy');
  assert.strictEqual(ai.classifyError(500, 'internal error').kind, 'down');
  assert.strictEqual(ai.classifyError(0, '').kind, 'down');
});

test('AI: a model is picked from the provider preferences', () => {
  assert.strictEqual(ai.pickModel(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-image'], ai.FREE.find((p) => p.id === 'gemini').prefer), 'gemini-2.5-flash');
  assert.strictEqual(ai.pickModel(['meta/llama:free', 'qwen/qwen-coder:free'], ai.FREE.find((p) => p.id === 'openrouter').prefer), 'qwen/qwen-coder:free');
  assert.strictEqual(ai.pickModel([], [/x/]), null);
});

test('AI: order is paid first (or not), then free, then local; cooling, refused and keyless accounts wait', () => {
  const now = 1000;
  const store = { paidFirst: true, accounts: [
    { id: 'g', provider: 'gemini', tier: 'free', keyEnc: 'x', enabled: true },
    { id: 'o', provider: 'ollama', tier: 'local', enabled: true },
    { id: 'p', provider: 'openai', tier: 'paid', keyEnc: 'x', enabled: true },
    { id: 'q', provider: 'groq', tier: 'free', keyEnc: 'x', enabled: true, state: { kind: 'rate', until: 2000 } },
    { id: 'r', provider: 'mistral', tier: 'free', keyEnc: 'x', enabled: true, state: { kind: 'auth' } },
    { id: 's', provider: 'cerebras', tier: 'free', keyEnc: null, enabled: true },
    { id: 't', provider: 'github', tier: 'free', keyEnc: 'x', enabled: false },
  ] };
  assert.deepStrictEqual(ai.order(store, { now }).map((a) => a.id), ['p', 'g', 'o']);
  assert.deepStrictEqual(ai.order(Object.assign({}, store, { paidFirst: false }), { now }).map((a) => a.id), ['g', 'p', 'o']);
  assert.deepStrictEqual(ai.order(store, { now: 3000 }).map((a) => a.id), ['p', 'g', 'q', 'o']);
  assert.deepStrictEqual(ai.order(store, { now, localOnly: true }).map((a) => a.id), ['o']);
});

test('AI: long chats keep the system prompt and the newest messages', () => {
  const msgs = [{ role: 'system', content: 'S' }, ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}`.padEnd(100, '.') }))];
  const fit = ai.fitMessages(msgs, 350);
  assert.strictEqual(fit[0].content, 'S');
  assert.match(fit[1].content, /7 older messages/);
  assert.deepStrictEqual(fit.slice(2).map((m) => m.content[0]), ['7', '8', '9']);
  assert.strictEqual(ai.fitMessages(msgs, 1e6).length, 11);
});

test('AI: JSON is found in fenced and chatty answers', () => {
  assert.deepStrictEqual(ai.extractJson('Sure!\n```json\n{"a": "x}y", "b": [1]}\n```\nDone'), { a: 'x}y', b: [1] });
  assert.deepStrictEqual(ai.extractJson('Here: {"explanation": "q \\"x\\" {", "edits": []} thanks'), { explanation: 'q "x" {', edits: [] });
  assert.strictEqual(ai.extractJson('no json'), null);
  // seen live (Pollinations gpt-oss): the last "}" left out
  assert.deepStrictEqual(ai.extractJson('{"explanation":"x","edits":[{"file":"a.php","search":"s","replace":"r"}]'), { explanation: 'x', edits: [{ file: 'a.php', search: 's', replace: 'r' }] });
  assert.strictEqual(ai.extractJson('{"a": "unclosed string'), null);
  assert.strictEqual(ai.extractJson('{"a": [1}'), null);
});

test('AI: edits must stay inside the project, away from vendor and .env, and match exactly once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-proj-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'vendor'));
  fs.writeFileSync(path.join(root, 'app', 'A.php'), '<?php\n$a = 1;\n$a = 1;\n$b = 2;\r\n');
  fs.writeFileSync(path.join(root, 'vendor', 'V.php'), '<?php');
  fs.writeFileSync(path.join(root, '.env'), 'APP_KEY=x');
  assert.ok(ai.safeProjectFile(root, 'app\\A.php'));
  assert.ok(ai.safeProjectFile(root, path.join(root, 'app', 'A.php')));
  for (const bad of ['vendor/V.php', '.env', '..\\x.php', 'C:\\Windows\\win.ini', 'app/missing.php']) assert.strictEqual(ai.safeProjectFile(root, bad), null, bad);
  assert.throws(() => ai.validateEdits(root, { edits: [{ file: 'app/A.php', search: '$a = 1;', replace: 'x' }] }), /found 2 times/);
  assert.throws(() => ai.validateEdits(root, { edits: [{ file: '.env', search: 'APP', replace: 'x' }] }), /not allowed/);
  const ok = ai.validateEdits(root, { edits: [{ file: 'app/A.php', search: '$b = 2;', replace: '$b = 3;' }] });
  assert.deepStrictEqual(ok, [{ file: 'app\\A.php', search: '$b = 2;', replace: '$b = 3;' }]);
  assert.deepStrictEqual(ai.diffOf(ok)[0].lines, ['-$b = 2;', '+$b = 3;']);
  assert.strictEqual(ai.hintOf('sk-abcdefgh1234'), '••••1234');
});

// ------------------------------------------------------------------------------------------ routing

test('AI: when the first account hits its limit, the next one answers the same conversation', async () => {
  const one = await fakeAi([{ status: 429, message: 'You exceeded your current quota (requests per day)' }]);
  const two = await fakeAi([{ content: 'Hello from two' }]);
  try {
    const ctx = makeCtx([acct('one', one.base), acct('two', two.base)]);
    const r = await ai.complete(ctx, [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(r.text, 'Hello from two');
    assert.strictEqual(r.by.id, 'two');
    assert.deepStrictEqual(r.switched.map((x) => [x.id, x.kind]), [['one', 'quota']]);
    assert.deepStrictEqual(two.seen[0].body.messages, [{ role: 'user', content: 'hi' }]);
    // "one" now waits (a few hours for a daily quota) and is skipped
    const v = ai.overview(ctx).accounts.find((a) => a.id === 'one');
    assert.strictEqual(v.status, 'quota');
    assert.ok(v.until);
    await ai.complete(ctx, [{ role: 'user', content: 'again' }]);
    assert.strictEqual(one.seen.length, 1);
    assert.strictEqual(ai.overview(ctx).accounts.find((a) => a.id === 'two').usage.requests, 2);
  } finally { one.srv.close(); two.srv.close(); }
});

test('AI: an empty model is picked from /models; a refused answer moves on; none left -> NO_AI', async () => {
  const one = await fakeAi([{ content: 'not json at all' }]);
  const two = await fakeAi([{ content: '{"ok": 1}' }]);
  try {
    const ctx = makeCtx([acct('one', one.base, 'paid', ''), acct('two', two.base)]);
    const r = await ai.complete(ctx, [{ role: 'user', content: 'x' }], { accept: (t) => { const j = ai.extractJson(t); if (!j) throw new Error('not JSON'); return j; } });
    assert.deepStrictEqual(r.value, { ok: 1 });
    assert.strictEqual(one.seen[0].url, '/v1/models');
    assert.strictEqual(one.seen[1].body.model, 'fake-coder-7b');
    assert.strictEqual(r.switched[0].kind, 'badAnswer');
    const ctx2 = makeCtx([]);
    await assert.rejects(ai.complete(ctx2, [{ role: 'user', content: 'x' }]), (e) => e.code === 'NO_AI');
  } finally { one.srv.close(); two.srv.close(); }
});

test('AI: a "local AI only" project never reaches a cloud account', async () => {
  const cloud = await fakeAi([{ content: 'cloud' }]);
  try {
    const ctx = makeCtx([acct('cloud', cloud.base)]);
    ctx.store.data.projects.push({ id: 'p1', name: 'p1', path: os.tmpdir() });
    ai.settings(ctx, { localOnly: { p1: true } });
    await assert.rejects(ai.complete(ctx, [{ role: 'user', content: 'x' }], { projectId: 'p1' }), (e) => e.code === 'NO_AI');
    assert.strictEqual(cloud.seen.length, 0);
  } finally { cloud.srv.close(); }
});

test('AI: a key is stored encrypted (DPAPI) and only its last 4 characters reach the page', { skip: process.platform !== 'win32' }, async () => {
  const srv = await fakeAi([{ content: 'OK' }]);
  try {
    const ctx = makeCtx([Object.assign(acct('k', srv.base), { noKey: false })]);
    const v = await ai.setKey(ctx, 'k', 'sk-test-SECRET-9876');
    assert.strictEqual(v.keyHint, '••••9876');
    const file = fs.readFileSync(path.join(ctx.dataDir, 'ai', 'accounts.json'), 'utf8');
    assert.ok(!file.includes('SECRET'));
    assert.ok(!JSON.stringify(ai.overview(ctx)).includes('SECRET'));
    const t = await ai.test(ctx, 'k');
    assert.strictEqual(t.ok, true);
    assert.strictEqual(srv.seen[0].auth, 'Bearer sk-test-SECRET-9876');
  } finally { srv.srv.close(); }
});

test('AI: chats are saved and continue on the next account', async () => {
  const one = await fakeAi([{ content: 'first answer' }, { status: 429, message: 'rate limit' }]);
  const two = await fakeAi([{ content: 'second answer' }]);
  try {
    const ctx = makeCtx([acct('one', one.base), acct('two', two.base)]);
    const { chat } = ai.newChat(ctx, {});
    await ai.sendChat(ctx, chat.id, 'How do I add a column?');
    const r = await ai.sendChat(ctx, chat.id, 'And an index?');
    assert.strictEqual(r.reply.by.id, 'two');
    assert.deepStrictEqual(r.reply.switched, [{ name: 'one', kind: 'rate' }]);
    // the second account received the whole conversation
    assert.deepStrictEqual(two.seen[0].body.messages.slice(1).map((m) => m.content), ['How do I add a column?', 'first answer', 'And an index?']);
    const list = ai.listChats(ctx).chats;
    assert.strictEqual(list[0].count, 4);
    assert.strictEqual(list[0].title, 'How do I add a column?');
  } finally { one.srv.close(); two.srv.close(); }
});

// ------------------------------------------------------------------------------------------ Fix with AI

test('AI fix: propose -> apply (backup) -> failed check is put back -> second try passes -> undo', { skip: !hasPhp }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-fix-'));
  fs.mkdirSync(path.join(root, 'app'));
  const original = '<?php\nfunction total(array $items)\n{\n    return array_sum($items) + $missing;\n}\n';
  fs.writeFileSync(path.join(root, 'app', 'Cart.php'), original);
  const bad = { explanation: 'first try', edits: [{ file: 'app/Cart.php', search: '    return array_sum($items) + $missing;', replace: '    return array_sum($items) +;' }] };
  const good = { explanation: '$missing is never set', edits: [{ file: 'app/Cart.php', search: '    return array_sum($items) + $missing;', replace: '    return array_sum($items);' }] };
  const srv = await fakeAi([{ content: `\`\`\`json\n${JSON.stringify(bad)}\n\`\`\`` }, { content: JSON.stringify(good) }]);
  try {
    const ctx = makeCtx([acct('fake', srv.base)]);
    ctx.runtimes.cache.php.push({ ok: true, version: '8.5.9', path: XAMPP_PHP, label: 'PHP 8.5.9' });
    ctx.store.data.projects.push({ id: 'cart', name: 'cart', path: root, phpVersion: '8.5.9', phpPath: XAMPP_PHP });
    const logs = [];
    const log = (k, t) => logs.push(`${k}: ${t}`);
    const p = await ai.proposeJob(ctx, 'cart', { source: 'error', message: 'Undefined variable $missing', file: path.join(root, 'app', 'Cart.php'), line: 4 }, log);
    assert.strictEqual(p.diff[0].file, 'app\\Cart.php');
    assert.strictEqual(fs.readFileSync(path.join(root, 'app', 'Cart.php'), 'utf8'), original, 'nothing is written by propose');
    // the AI saw the file and the error line
    const sent = srv.seen[0].body.messages[1].content;
    assert.match(sent, /Undefined variable \$missing/);
    assert.match(sent, /4 > {5}return array_sum/);
    const r = await ai.applyJob(ctx, p.fixId, log);
    assert.strictEqual(r.ok, true, logs.join('\n'));
    assert.match(r.report, /OK php -l/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'app', 'Cart.php'), 'utf8'), original.replace(' + $missing', ''));
    assert.ok(logs.some((l) => /back as they were/.test(l)), 'the broken first try was put back');
    ai.undoFix(ctx, p.fixId);
    assert.strictEqual(fs.readFileSync(path.join(root, 'app', 'Cart.php'), 'utf8'), original);
  } finally { srv.srv.close(); }
});

test('AI fix: files outside the project are never sent', async () => {
  const srv = await fakeAi([{ content: '{}' }]);
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-out-'));
    const ctx = makeCtx([acct('fake', srv.base)]);
    ctx.store.data.projects.push({ id: 'x', name: 'x', path: root, phpVersion: '8.5.9' });
    await assert.rejects(ai.proposeJob(ctx, 'x', { message: 'boom', file: 'C:\\Windows\\win.ini', line: 1 }, () => {}), (e) => e.code === 'AI_NO_FILE');
    assert.strictEqual(srv.seen.length, 0);
  } finally { srv.srv.close(); }
});

// ------------------------------------------------------------------------------------------ models that are gone

test('AI: "no longer available" is a model problem; the suggested model and newest versions are picked', () => {
  const msg = '404 [{ "error": { "code": 404, "message": "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features." } }]';
  assert.strictEqual(ai.classifyError(404, msg).kind, 'model');
  assert.strictEqual(ai.suggestedModel(msg), 'gemini-3.8-flash');
  assert.strictEqual(ai.suggestedModel('The model `llama3-70b` has been decommissioned'), null);
  const gemini = ai.FREE.find((p) => p.id === 'gemini').prefer;
  assert.strictEqual(ai.pickModel(['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-image'], gemini), 'gemini-3.8-flash');
  assert.strictEqual(ai.pickModel(['gemini-2.5-flash', 'gemini-3.8-flash'], gemini, ['gemini-3.8-flash']), 'gemini-2.5-flash');
});

test('AI: when the saved model is gone, the account moves to the suggested one and still answers', async () => {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const model = JSON.parse(b || '{}').model;
      if (model === 'gemini-2.5-flash') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features.' } }]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `answered by ${model}` } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const ctx = makeCtx([acct('g', `http://127.0.0.1:${srv.address().port}/v1`, 'free', 'gemini-2.5-flash')]);
    const logs = [];
    const r = await ai.complete(ctx, [{ role: 'user', content: 'hi' }], { log: (k, t) => logs.push(t) });
    assert.strictEqual(r.text, 'answered by gemini-3.8-flash');
    assert.deepStrictEqual(r.switched, []);
    assert.ok(logs.some((l) => /gemini-2\.5-flash.*gone.*gemini-3\.8-flash/.test(l)), logs.join('\n'));
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'ai', 'accounts.json'), 'utf8')).accounts.find((a) => a.id === 'g');
    assert.strictEqual(saved.model, 'gemini-3.8-flash');
    assert.deepStrictEqual(saved.badModels, ['gemini-2.5-flash']);
  } finally { srv.close(); }
});

// ------------------------------------------------------------------------------------------ provider quirks

/** A fake provider whose behaviour is a function of the request: (req, body) -> {status, json} */
function fakeProvider(fn) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      seen.push({ url: req.url, body, headers: req.headers });
      const r = fn(req, body, seen) || { status: 404, json: { error: { message: 'no' } } };
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: `http://127.0.0.1:${srv.address().port}/v1` })));
}
const okReply = (content) => ({ status: 200, json: { choices: [{ message: { content } }] } });

test('AI: 503 "high demand" waits, retries, then tries another model of the same provider', async () => {
  const p = await fakeProvider((req, body) => {
    if (req.url.endsWith('/models')) return { status: 200, json: { data: [{ id: 'gemini-3.8-flash' }, { id: 'gemini-3.8-flash-lite' }, { id: 'gemini-3.8-flash-image' }] } };
    if (body.model === 'gemini-3.8-flash') return { status: 503, json: [{ error: { code: 503, message: 'This model is currently experiencing high demand. Please try again later.', status: 'UNAVAILABLE' } }] };
    return okReply(`from ${body.model}`);
  });
  try {
    const ctx = makeCtx([acct('g', p.base, 'free', 'gemini-3.8-flash')]);
    const logs = [];
    const r = await ai.complete(ctx, [{ role: 'user', content: 'x' }], { log: (k, t) => logs.push(t) });
    assert.strictEqual(r.text, 'from gemini-3.8-flash-lite');
    assert.strictEqual(r.by.model, 'gemini-3.8-flash-lite');
    assert.ok(logs.some((l) => /busy right now/.test(l)) && logs.some((l) => /still busy/.test(l)), logs.join('\n'));
    // the account keeps its own model for next time
    assert.strictEqual(ai.overview(ctx).accounts.find((a) => a.id === 'g').model, 'gemini-3.8-flash');
    assert.strictEqual(ai.classifyError(503, 'overloaded').kind, 'busy');
  } finally { p.srv.close(); }
});

test('AI: reasoning models get max_completion_tokens; a refused parameter is learned and retried', async () => {
  assert.deepStrictEqual(Object.keys(ai.requestBody('gpt-5-mini', [], { maxTokens: 10, temperature: 0.2 })).sort(), ['max_completion_tokens', 'messages', 'model', 'stream']);
  assert.deepStrictEqual(Object.keys(ai.requestBody('llama-3.3-70b', [], { maxTokens: 10, temperature: 0.2 })).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.strictEqual(ai.paramFix(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), 'maxCompletion');
  assert.strictEqual(ai.paramFix(400, "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."), 'noTemp');
  const p = await fakeProvider((req, body) => {
    if ('max_tokens' in body) return { status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } };
    if ('temperature' in body) return { status: 400, json: { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported." } } };
    return okReply('fine');
  });
  try {
    const ctx = makeCtx([acct('o', p.base, 'paid', 'some-new-model')]);
    const r = await ai.complete(ctx, [{ role: 'user', content: 'x' }]);
    assert.strictEqual(r.text, 'fine');
    assert.strictEqual(p.seen.length, 3);
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'ai', 'accounts.json'), 'utf8')).accounts.find((a) => a.id === 'o');
    assert.deepStrictEqual(saved.compat, { maxCompletion: true, noTemp: true });
    await ai.complete(ctx, [{ role: 'user', content: 'y' }]);
    assert.strictEqual(p.seen.length, 4, 'learned: no more refused requests');
  } finally { p.srv.close(); }
});

test('AI: an error inside a 200 answer (OpenRouter) moves on like any other', async () => {
  const one = await fakeProvider(() => ({ status: 200, json: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } } }));
  const two = await fakeProvider(() => okReply('two'));
  try {
    const ctx = makeCtx([acct('one', one.base), acct('two', two.base)]);
    const r = await ai.complete(ctx, [{ role: 'user', content: 'x' }]);
    assert.strictEqual(r.text, 'two');
    assert.strictEqual(r.switched[0].kind, 'quota');
  } finally { one.srv.close(); two.srv.close(); }
});

test('AI: without a model list the known default model is used; non-chat models are never picked', async () => {
  const p = await fakeProvider((req, body) => (req.url.endsWith('/models') ? { status: 404, json: { error: 'no list' } } : okReply(`from ${body.model}`)));
  try {
    const ctx = makeCtx([{ id: 'gh', provider: 'mistral', name: 'Mistral', tier: 'free', base: p.base, model: '', enabled: true, noKey: true }]);
    const r = await ai.complete(ctx, [{ role: 'user', content: 'x' }]);
    assert.strictEqual(r.text, 'from mistral-small-latest');
  } finally { p.srv.close(); }
  assert.strictEqual(ai.pickModel(['text-embedding-004', 'gemini-embedding-001', 'whisper-large-v3', 'llama-guard-4', 'gemini-3.8-flash-tts'], [/./]), null);
  assert.strictEqual(ai.FREE.find((x) => x.id === 'github').modelsUrl, 'https://models.github.ai/catalog/models');
});

test('AI: Ollama not running on this PC is told apart from a provider being down', async () => {
  const port = await new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => r(n)); }); });
  const ctx = makeCtx([{ id: 'ol', provider: 'custom', name: 'Ollama', tier: 'local', base: `http://127.0.0.1:${port}/v1`, model: 'qwen', enabled: true, noKey: true }]);
  await assert.rejects(ai.complete(ctx, [{ role: 'user', content: 'x' }]), (e) => e.code === 'NO_AI' && e.extra.tried[0].kind === 'notRunning');
});

// ------------------------------------------------------------------------------------------ 1.8: a fix that lands, AI without copy-paste

test('AI fix: a search with line numbers or other spaces still finds its one place in the file', () => {
  const eol = '\n';
  const text = 'class A {\n    public function x()\n    {\n        return $a\n    }\n}\n';
  // copied from the numbered view
  const r1 = ai.locate(text, '   4 >         return $a', '   4 >         return $a;', eol);
  assert.deepStrictEqual(r1, { search: '        return $a', replace: '        return $a;' });
  // other indentation: the file's own text is used and the replacement is moved to the file's indentation
  const r2 = ai.locate(text, '  public function x()\n  {\n      return $a', '  public function x()\n  {\n      return $a;', eol);
  assert.strictEqual(r2.search, '    public function x()\n    {\n        return $a');
  assert.strictEqual(r2.replace, '    public function x()\n    {\n        return $a;');
  // still unique, still refused when not there
  assert.throws(() => ai.locate('a\n  b\na\n  b\n', 'a\nb', 'x', eol), /found 2 times/);
  assert.throws(() => ai.locate(text, 'nothing like it', 'x', eol), /found 0 times/);
  assert.strictEqual(ai.stripLineNumbers('  10   $x = 1;\n  11 >  $y'), '$x = 1;\n $y');
  assert.strictEqual(ai.stripLineNumbers('$x = 1;\n  11 >  $y'), '$x = 1;\n  11 >  $y');
});

test('AI: an unusable answer goes back to the same AI once with the reason, before the next AI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ai-proj-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'A.php'), '<?php\n$x = [1,2,3]\necho count($x);\n');
  const answers = ['{"explanation": "x", "edits": [{"file": "app/A.php", "search": "$x = [1,2]", "replace": "$x = [1,2];"}]}',
    '{"explanation": "missing ;", "edits": [{"file": "app/A.php", "search": "$x = [1,2,3]", "replace": "$x = [1,2,3];"}]}'];
  const p = await fakeProvider(() => okReply(answers.shift()));
  try {
    const ctx = makeCtx([acct('one', p.base, 'free')]);
    const logs = [];
    const r = await ai.complete(ctx, [{ role: 'user', content: 'fix' }], { log: (k, t) => logs.push(t), accept: (t) => ai.validateEdits(root, ai.extractJson(t)) });
    assert.strictEqual(r.by.id, 'one');
    assert.deepStrictEqual(r.switched, []);
    assert.strictEqual(r.value[0].replace, '$x = [1,2,3];');
    const second = p.seen[1].body.messages;
    assert.strictEqual(second[second.length - 2].role, 'assistant');
    assert.match(second[second.length - 1].content, /could not be used: .*found 0 times/);
    assert.ok(logs.some((l) => /asking the same AI again/.test(l)), logs.join('\n'));
  } finally { p.srv.close(); }
});

test('AI: Pollinations answers with no key and no login; Gemini thinks "low"; a refused effort is learned', async () => {
  const pol = ai.FREE.find((x) => x.id === 'pollinations');
  assert.ok(pol && pol.noKey && pol.tier === 'free');
  const store = { paidFirst: true, accounts: [
    { id: 'pollinations', provider: 'pollinations', tier: 'free', enabled: true },
    { id: 'gemini', provider: 'gemini', tier: 'free', enabled: true },
  ] };
  assert.deepStrictEqual(ai.order(store).map((a) => a.id), ['pollinations'], 'ready with no key at all');
  assert.strictEqual(ai.requestBody('gemini-3.8-flash', [], { maxTokens: 10, temperature: 0.2, effort: 'low' }).reasoning_effort, 'low');
  assert.ok(!('reasoning_effort' in ai.requestBody('x', [], { maxTokens: 10, temperature: 0.2, effort: 'low', compat: { noEffort: true } })));
  assert.strictEqual(ai.paramFix(400, 'Invalid value for reasoning_effort'), 'noEffort');
  assert.strictEqual(ai.classifyError(429, 'qwen/qwen3-coder:free is temporarily rate-limited upstream').kind, 'busy');
  // only the anonymous models of its list are picked
  const p = await fakeProvider((req) => (req.url.endsWith('/models') ? { status: 200, json: [{ name: 'openai-large', tier: 'seed' }, { name: 'openai-fast', tier: 'anonymous' }] } : okReply('hi')));
  try {
    const ctx = makeCtx([{ id: 'pollinations', provider: 'pollinations', name: 'P', tier: 'free', base: p.base, model: '', enabled: true }]);
    const r = await ai.complete(ctx, [{ role: 'user', content: 'x' }]);
    assert.strictEqual(r.by.model, 'openai-fast');
  } finally { p.srv.close(); }
});

test('AI: OpenRouter login (PKCE) gives the key back by itself; a forged or reused login is refused', { skip: process.platform !== 'win32' }, async () => {
  const crypto = require('crypto');
  let challenge = null;
  const key = `sk-or-v1-${'a'.repeat(64)}`;
  const p = await fakeProvider((req, body) => {
    if (req.url === '/v1/auth/keys') {
      const ok = body.code === 'good-code' && crypto.createHash('sha256').update(body.code_verifier).digest('base64url') === challenge && body.code_challenge_method === 'S256';
      return ok ? { status: 200, json: { key } } : { status: 403, json: { error: 'Invalid code or code_verifier' } };
    }
    if (req.url.endsWith('/models')) return { status: 200, json: { data: [{ id: 'qwen/qwen3-coder:free' }] } };
    return okReply('OK');
  });
  try {
    const ctx = makeCtx([{ id: 'openrouter', provider: 'openrouter', name: 'OpenRouter', tier: 'free', base: p.base, model: '', enabled: false }]);
    ctx.port = 7999;
    ctx.openrouterExchange = `${p.base}/auth/keys`;
    const u = new URL(ai.startOpenRouterLogin(ctx).url);
    assert.strictEqual(u.origin + u.pathname, 'https://openrouter.ai/auth');
    assert.strictEqual(u.searchParams.get('callback_url'), 'http://localhost:7999/oauth/openrouter');
    assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(u.searchParams.get('key_label'), 'PHP Station by x8code');
    challenge = u.searchParams.get('code_challenge');
    const state = u.searchParams.get('state');
    await assert.rejects(ai.finishOpenRouterLogin(ctx, { code: 'good-code', state: 'forged' }), (e) => e.code === 'OAUTH');
    const r = await ai.finishOpenRouterLogin(ctx, { code: 'good-code', state });
    assert.strictEqual(r.account.status, 'ready');
    assert.strictEqual(r.account.enabled, true);
    assert.strictEqual(r.account.keyHint, '••••aaaa');
    assert.ok(r.test.ok, JSON.stringify(r.test));
    assert.ok(p.seen.some((s) => s.url.endsWith('/chat/completions')));
    // the same state works once only; the key never reaches the page
    await assert.rejects(ai.finishOpenRouterLogin(ctx, { code: 'good-code', state }), (e) => e.code === 'OAUTH');
    assert.ok(!JSON.stringify(ai.overview(ctx)).includes('a'.repeat(64)));
    // never a paid model on the free account: one typed by hand is dropped, a ":free" one is sent
    ai.update(ctx, 'openrouter', { model: 'anthropic/claude-opus-4' });
    const before = p.seen.length;
    await ai.complete(ctx, [{ role: 'user', content: 'hi' }]);
    const sent = p.seen.slice(before).filter((s) => s.url.endsWith('/chat/completions')).map((s) => s.body.model);
    assert.deepStrictEqual(sent, ['qwen/qwen3-coder:free']);
    // every request is credited to PHP Station on OpenRouter (rankings + app page)
    const chat = p.seen.filter((s) => s.url.endsWith('/chat/completions')).pop();
    assert.strictEqual(chat.headers['http-referer'], 'https://github.com/sami-hussain-dev/PHP-Station');
    assert.strictEqual(chat.headers['x-openrouter-title'], 'PHP Station by x8code');
  } finally { p.srv.close(); }
});

test('AI: keys already on this PC are found (env, GitHub CLI); only key-shaped values; hints only', async () => {
  const ctx = makeCtx([]);
  const env = { GROQ_API_KEY: `gsk_${'b'.repeat(40)}`, GEMINI_API_KEY: 'not-a-key', CEREBRAS_API_KEY: '' };
  const found = await ai.findKeys(ctx, { env, ghToken: `gho_${'c'.repeat(36)}` });
  assert.deepStrictEqual(found.map((f) => [f.id, f.source, f.hint]), [['groq', '%GROQ_API_KEY%', '••••bbbb'], ['github', 'GitHub CLI (gh auth login)', '••••cccc']]);
  assert.ok(ai.KEY_RE.gemini.test(`AIza${'x'.repeat(35)}`));
  assert.ok(!ai.KEY_RE.groq.test('gsk_short'));
  const view = ai.overview(ctx).accounts;
  assert.strictEqual(view.find((a) => a.id === 'gemini').canCatch, true);
  assert.strictEqual(view.find((a) => a.id === 'pollinations').canCatch, false);
  assert.strictEqual(view.find((a) => a.id === 'openrouter').login, 'openrouter');
});
