// Remote access end to end: the real `uabc relay`, the extension connecting
// out to it, and the official MCP TypeScript SDK over Streamable HTTP playing
// the cloud AI app (as Claude custom connectors or ChatGPT developer mode do).
// Run: npm run build:ext && cargo build && npm run test:e2e

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UABC_BIN, collectPrompts, refOf, startEnvironment } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let env;
let relay;
let page; // an extension page, to drive the settings like the user does
const NAME = 'কাজী নজরুল ইসলাম';

function startRelay(dataDir, ...extra) {
  const proc = spawn(UABC_BIN, ['relay', '--listen', '127.0.0.1:0', '--data-dir', dataDir, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UABC_LOG: 'debug' } });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      const m = /listening on (http:\/\/\S+)/.exec(String(d));
      if (m) resolve({ url: m[1], dataDir, stop: () => proc.kill() });
    });
    proc.on('exit', (code) => reject(new Error(`relay exited with ${code}`)));
  });
}

const ui = (op, extra = {}) => page.evaluate(([op, extra]) => chrome.runtime.sendMessage({ uabcUi: op, ...extra }), [op, extra]).then((r) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
});

async function remoteConnected() {
  for (let i = 0; i < 100; i++) {
    const st = await ui('status');
    if (st.remote.state === 'connected') return st.remote;
    await sleep(100);
  }
  throw new Error('the extension did not connect to the relay');
}

/** A cloud AI app: an MCP client on the connector URL. */
async function cloudApp(url, name = 'cloud-app') {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    client,
    async call(tool, args = {}) {
      const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180_000 });
      return { text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: res.isError === true, images: res.content.filter((c) => c.type === 'image') };
    },
    close: () => client.close(),
  };
}

describe('remote access through the relay', { timeout: 300_000 }, () => {
  let app;
  let connector;

  before(async () => {
    env = await startEnvironment();
    relay = await startRelay(mkdtempSync(join(tmpdir(), 'uabc-relay-')));
    page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/options.html`);
  });
  after(async () => {
    await app?.close().catch(() => {});
    relay?.stop();
    if (relay) rmSync(relay.dataDir, { recursive: true, force: true });
    await env?.stop();
  });

  test('is off until the user turns it on', async () => {
    const st = await ui('status');
    assert.equal(st.remote.enabled, false);
    assert.equal(st.remote.connectorUrl, '');
    await assert.rejects(ui('remote.set', { relayUrl: 'http://relay.example.com' }), /Use https/);
  });

  test('a cloud AI app fills a form in this browser through the connector URL', async () => {
    await ui('remote.set', { enabled: true, relayUrl: relay.url });
    connector = (await remoteConnected()).connectorUrl;
    assert.match(connector, new RegExp(`^${relay.url}/mcp/[0-9a-f]{32}/[0-9a-f]{64}$`));

    app = await cloudApp(connector);
    const { tools } = await app.client.listTools();
    assert.equal(tools.length, 11);
    let r = await app.call('browser_tabs', { action: 'new', url: `${env.origins.approved}/form.html` });
    assert.equal(r.isError, false, r.text);
    r = await app.call('browser_get_state');
    assert.equal(r.isError, false, r.text);
    r = await app.call('browser_type', { ref: refOf(r.text, 'textbox', /^Full name/), text: NAME });
    assert.equal(r.isError, false, r.text);
    assert.equal(await (await env.page('form.html')).inputValue('#name'), NAME);

    r = await app.call('browser_status');
    assert.match(r.text, /^Connected to Chromium .* \(profile "unnamed", extension [\d.]+, bridge [\d.]+\)\./);
    const st = await ui('status');
    assert.ok(st.sessions.some((s) => s.via === 'remote' && s.client.name === 'cloud-app (remote)'), JSON.stringify(st.sessions));
  });

  test('new sites still need the user, and the prompt names the remote app', async () => {
    const prompts = collectPrompts(env.context);
    const pending = app.call('browser_tabs', { action: 'new', url: `${env.origins.other}/form.html` });
    const [prompt] = await prompts.waitFor(1);
    await prompt.waitForSelector('text=cloud-app (remote)');
    await prompt.click('button:has-text("Deny")');
    const r = await pending;
    prompts.stop();
    assert.equal(r.isError, true);
    assert.match(r.text, /PERMISSION_DENIED/);
  });

  test('two apps on the same URL are separate clients, each named in its own prompt', async () => {
    const second = await cloudApp(connector, 'second-app');
    const prompts = collectPrompts(env.context);
    const pending = second.call('browser_tabs', { action: 'new', url: `${env.origins.third}/form.html` });
    const [prompt] = await prompts.waitFor(1);
    await prompt.waitForSelector('text=second-app (remote)');
    await prompt.click('button:has-text("Allow this time")');
    assert.equal((await pending).isError, false);
    prompts.stop();
    // "Allow this time" was for second-app only: the first app is asked again.
    const again = collectPrompts(env.context);
    const first = app.call('browser_tabs', { action: 'new', url: `${env.origins.third}/form.html` });
    const [p2] = await again.waitFor(1);
    await p2.waitForSelector('text=cloud-app (remote)');
    await p2.click('button:has-text("Deny")');
    assert.match((await first).text, /PERMISSION_DENIED/);
    again.stop();
    await second.close();
  });

  test('Stop pauses remote apps too', async () => {
    await ui('pause');
    const r = await app.call('browser_tabs', { action: 'list' });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Error PAUSED/);
    await ui('resume');
  });

  test('a wrong or rotated connector URL gets nothing', async () => {
    const wrong = connector.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
    const res = await fetch(wrong, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(res.status, 404);

    const rotated = (await ui('remote.rotate')).connectorUrl;
    assert.notEqual(rotated, connector);
    await remoteConnected();
    await assert.rejects(cloudApp(connector, 'old-url'));
    await assert.rejects(app.call('browser_tabs', { action: 'list' }), /404|Not found/, 'an app on the old URL kept access');
    await app.close();
    app = await cloudApp(rotated, 'new-url');
    assert.equal((await app.call('browser_tabs', { action: 'list' })).isError, false);
    connector = rotated;
  });

  test('the relay keeps only hashes of the secrets', async () => {
    const r = await env.worker.evaluate(async () => (await chrome.storage.local.get('remote')).remote);
    let saved = '';
    for (let i = 0; i < 50 && !saved.includes(r.deviceId); i++) {
      await sleep(100); // the relay writes changes every 2 s
      try {
        saved = readFileSync(join(relay.dataDir, 'devices.json'), 'utf8');
      } catch {
        // not written yet
      }
    }
    assert.ok(saved.includes(r.deviceId));
    assert.ok(!saved.includes(r.deviceSecret) && !saved.includes(r.connectorSecret));
  });

  test('web pages cannot open the browser side of the relay', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${relay.url}/ws`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example' },
      });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('upgrade', () => resolve(101));
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test('a private relay needs its access code, and a new relay gets a new identity', async () => {
    const before = await env.worker.evaluate(async () => (await chrome.storage.local.get('remote')).remote);
    const priv = await startRelay(mkdtempSync(join(tmpdir(), 'uabc-relay-')), '--registration-token', 'open-sesame');
    try {
      await ui('remote.set', { relayUrl: priv.url });
      let st;
      for (let i = 0; i < 50; i++) {
        st = (await ui('status')).remote;
        if (/access code/.test(st.error)) break;
        await sleep(100);
      }
      assert.match(st.error, /access code/);
      const after = await env.worker.evaluate(async () => (await chrome.storage.local.get('remote')).remote);
      assert.notEqual(after.deviceId, before.deviceId, 'the old relay could impersonate this browser at the new one');
      assert.notEqual(after.deviceSecret, before.deviceSecret);
      await ui('remote.set', { relayUrl: priv.url, accessCode: 'open-sesame' });
      assert.match((await remoteConnected()).connectorUrl, new RegExp(`^${priv.url}/mcp/`));
    } finally {
      await ui('remote.set', { relayUrl: relay.url, accessCode: '' });
      priv.stop();
      rmSync(priv.dataDir, { recursive: true, force: true });
    }
    connector = (await remoteConnected()).connectorUrl;
    await app.close();
    app = await cloudApp(connector);
    assert.equal((await app.call('browser_tabs', { action: 'list' })).isError, false);
  });

  test('turning remote access off cuts the app off', async () => {
    await ui('remote.set', { enabled: false });
    let health;
    for (let i = 0; i < 50; i++) {
      health = await (await fetch(`${relay.url}/healthz`)).json();
      if (health.devices_online === 0) break;
      await sleep(100);
    }
    assert.equal(health.devices_online, 0);
    const r = await app.call('browser_tabs', { action: 'list' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not connected to the UABC relay/);
  });
});
