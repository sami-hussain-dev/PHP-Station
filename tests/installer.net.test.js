'use strict';
/*
 * Live check of the installer's sources (runs ONLY with DEVPANEL_NET_TESTS=1):
 *   set DEVPANEL_NET_TESTS=1 && node --test tests/installer.net.test.js
 * Uses the production (strict) fetcher. Fetches only the small index/checksum documents
 * (releases.json, MariaDB REST JSON, getcomposer versions + .sha256sum, nodejs index.json +
 * SHASUMS256.txt, cacert.pem.sha256) and sends HEAD requests for the chosen download URLs
 * (redirects only to allowed hosts). No binary is downloaded, nothing is installed or run.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('./helpers');

const ENABLED = process.env.DEVPANEL_NET_TESTS === '1';
const lib = (m) => require(path.join(__dirname, '..', 'lib', m));
const SHA = /^[0-9a-f]{64}$/;

describe('installer sources (live, index documents + HEAD only)', { skip: ENABLED ? false : 'DEVPANEL_NET_TESTS=1 set nahi (network check skip)', timeout: 5 * 60 * 1000 }, () => {
  let tmp;
  let ctx;
  const I = () => lib('installer.js');

  before(() => {
    tmp = H.makeTempDir('dp-net-');
    ctx = {
      toolDir: path.join(tmp, 'tool'),
      dataDir: path.join(tmp, 'data'),
      log: () => {},
      runtimes: { scanning: false, jobId: null, cache: { scannedAt: null, php: [], composer: [], db: [] } },
      store: { data: { settings: {}, projects: [], runs: {}, dbRuns: {}, dbServers: {} }, save() {} },
    };
  });
  after(async () => {
    try { await H.removeDir(tmp); } catch { /* ignore */ }
  });

  const headOk = async (url) => {
    const h = await I().STRICT.head(url);
    assert.ok(h.size > 1024 * 1024, `${url}: size ${h.size}`);
    I().checkUrl(h.url); // the final URL after redirects is on an allowed host
    return h;
  };

  it('PHP: releases.json -> x64 NTS builds with sha256; zip URLs resolve (HEAD)', async () => {
    const cat = await I().getCatalog(ctx, 'php');
    assert.ok(cat.items.length >= 3, JSON.stringify(cat.items.map((x) => x.version)));
    for (const it2 of cat.items) {
      assert.match(it2.version, /^\d+\.\d+\.\d+$/);
      assert.match(it2.file, /-nts-Win32-v[cs]\d+-x64\.zip$/);
      assert.match(String(it2.sha256), SHA, it2.file);
      assert.ok(it2.sizeMB > 5, `${it2.file} ${it2.sizeMB}`);
    }
    for (const it2 of cat.items.slice(0, 2)) {
      const h = await headOk(it2.url);
      assert.ok(Math.abs(h.size / (1024 * 1024) - it2.sizeMB) < 1, `${it2.file}: HEAD ${h.size} vs ${it2.sizeMB} MB`);
    }
  });

  it('MariaDB: stable majors -> winx64.zip on archive.mariadb.org with sha256 (HEAD)', async () => {
    const cat = await I().getCatalog(ctx, 'mariadb');
    assert.ok(cat.items.length >= 2, JSON.stringify(cat.items));
    for (const it2 of cat.items) {
      assert.match(it2.file, /^mariadb-\d+\.\d+\.\d+-winx64\.zip$/);
      assert.match(String(it2.sha256), SHA, it2.file);
      assert.ok(it2.url.startsWith('https://archive.mariadb.org/'), it2.url);
      assert.ok(it2.sizeMB > 20, `${it2.file} ${it2.sizeMB}`);
    }
    assert.ok(cat.items.some((x) => x.lts), 'an LTS release');
    await headOk(cat.items[0].url);
  });

  it('Composer: stable 2.x with .sha256sum; phar URL resolves (HEAD)', async () => {
    const cat = await I().getCatalog(ctx, 'composer');
    assert.ok(cat.items.length >= 1);
    for (const it2 of cat.items) {
      assert.match(it2.version, /^2\.\d+\.\d+$/);
      assert.match(String(it2.sha256), SHA, it2.version);
    }
    await headOk(cat.items[0].url);
  });

  it('Node (bootstrap, as tools\\get-node.ps1 does it): latest LTS win-x64 zip + SHASUMS256 (HEAD)', async () => {
    const node = I().parseNodeIndex(await I().STRICT.getJson(I().SOURCES.nodeIndex));
    assert.ok(node, 'no LTS');
    const sha = I().shaFor(await I().STRICT.getText(I().SOURCES.nodeShasums(node.version), { maxBytes: 64 * 1024 }), node.file);
    assert.match(String(sha), SHA);
    await headOk(node.url);
  });

  it('cacert.pem: sha256 document + HEAD', async () => {
    const sha = I().shaFor(await I().STRICT.getText(I().SOURCES.cacertSha, { maxBytes: 4096 }), 'cacert.pem');
    assert.match(String(sha), SHA);
    const h = await I().STRICT.head(I().SOURCES.cacert);
    assert.ok(h.size > 100 * 1024, String(h.size));
  });
});
