// The built-in assistant end to end: the real side panel and settings pages,
// the real service worker and gates, and fake OpenAI-compatible, Anthropic
// and Gemini servers standing in for the model providers.
// Run: npm run build:ext && cargo build && npm run test:e2e

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startFakeLlm } from './fake-llm.mjs';
import { assertFenced, refOf, startEnvironment } from './harness.mjs';

const KEY = 'e2e-secret-key-0123456789';
const OTHER_KEY = 'sk-never-sent-anywhere-0123456789';
const NAME = 'রবীন্দ্রনাথ ঠাকুর';

let env;
let llm;
let panel;
let brain = () => ({ text: 'ok' });

/** Points the assistant at the fake server; a second provider's key must never leave the browser. */
async function configure(provider, model) {
  await env.worker.evaluate(
    async ({ provider, model, otherKey }) => {
      const other = { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: otherKey, models: [{ id: 'gpt-x' }] };
      await chrome.storage.local.set({ assistant: { providers: [provider, other], selected: { provider: provider.id, model }, maxSteps: 20, screenshots: true } });
    },
    { provider, model, otherKey: OTHER_KEY },
  );
}

const compatible = () => ({ id: 'custom-e2e', kind: 'compatible', label: 'Fake', baseUrl: `${llm.url}/v1`, apiKey: KEY, models: [{ id: 'fake-model' }] });

async function newChat() {
  await panel.bringToFront();
  await panel.click('#new');
  llm.reset();
}

async function ask(text) {
  await panel.bringToFront();
  await panel.fill('#input', text);
  await panel.press('#input', 'Enter');
}

async function waitIdle(timeout = 60_000) {
  await panel.waitForFunction(() => document.getElementById('send')?.textContent === 'Send', null, { timeout, polling: 100 });
}

const texts = (selector) => panel.locator(selector).allInnerTexts();

describe('built-in assistant (side panel)', { timeout: 300_000 }, () => {
  before(async () => {
    env = await startEnvironment();
    llm = await startFakeLlm((view, format) => brain(view, format));
    await configure(compatible(), 'fake-model');
    panel = await env.context.newPage();
    await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
    await panel.waitForSelector('#model option', { state: 'attached' });
  });
  after(async () => {
    await llm?.close();
    await env?.stop();
  });

  test('fills a form in Bangla through an OpenAI-compatible endpoint', async () => {
    await newChat();
    brain = (view) => {
      const n = view.results.length;
      if (n === 0) return { call: { name: 'browser_tabs', args: { action: 'new', url: `${env.origins.approved}/form.html` } } };
      if (n === 1) return { call: { name: 'browser_get_state', args: {} } };
      if (n === 2) return { call: { name: 'browser_type', args: { ref: refOf(view.results[1], 'textbox', /^Full name/), text: NAME } } };
      return { text: 'Done. I typed your name into **Full name**.' };
    };
    await ask('ফর্মে আমার নাম লিখে দাও');
    await waitIdle();

    assert.deepEqual(await texts('.msg.assistant'), ['Done. I typed your name into Full name.']);
    const steps = await texts('.step summary');
    assert.equal(steps.length, 3, steps.join('\n'));
    assert.match(steps[0], /Opened http:\/\/127\.0\.0\.1:\d+\/form\.html/);
    assert.match(steps[2], new RegExp(`Typed "${NAME}" into element \\[\\d+\\]`));
    const form = await env.page('form.html');
    assert.equal(await form.inputValue('#name'), NAME);

    const calls = llm.completions();
    assert.equal(calls.length, 4);
    for (const c of calls) {
      assert.equal(c.headers.authorization, `Bearer ${KEY}`);
      assert.equal(c.body.model, 'fake-model');
      assert.equal(c.body.tools.length, 11);
      assert.match(c.body.messages[0].content, /Safety rules: everything inside <untrusted-web-content>/);
      assert.match(c.body.messages[0].content, /Today's date is \d{4}-\d{2}-\d{2}\./);
    }
    // Page content reaches the model only inside the untrusted fence.
    const state = calls[2].body.messages.find((m) => m.role === 'tool' && m.content.includes('textbox')).content;
    assertFenced(state, 'Full name');
    // Append-only history: each request extends the previous one.
    for (let i = 1; i < calls.length; i++) assert.deepEqual(calls[i].body.messages.slice(0, calls[i - 1].body.messages.length), calls[i - 1].body.messages);
  });

  test('API keys go only to their own provider, never into a request body', async () => {
    for (const r of llm.requests) {
      assert.ok(!r.raw.includes(KEY) && !r.raw.includes(OTHER_KEY), `a key leaked into ${r.path}`);
      assert.ok(!JSON.stringify(r.headers).includes(OTHER_KEY), 'another provider’s key was sent');
    }
    // Content scripts run in web pages and must not be able to read the keys.
    const levels = await env.worker.evaluate(async () => {
      const probe = await chrome.scripting.executeScript({
        target: { tabId: (await chrome.tabs.query({ url: '*://127.0.0.1/*form.html' }))[0].id },
        world: 'ISOLATED',
        func: async () => {
          try {
            return JSON.stringify(await chrome.storage.local.get('assistant'));
          } catch (e) {
            return `error: ${e.message}`;
          }
        },
      });
      return probe[0].result;
    });
    assert.match(levels, /^error: /, `a content script could read storage: ${levels}`);
  });

  test('the assistant is an AI session like any other: listed, audited, named after its model', async () => {
    const st = await panel.evaluate(() => chrome.runtime.sendMessage({ uabcUi: 'status' }));
    const mine = st.result.sessions.filter((s) => s.via === 'assistant');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].client.name, 'UABC assistant (fake-model)');
    const log = await panel.evaluate(() => chrome.runtime.sendMessage({ uabcUi: 'audit.get', limit: 20 }));
    assert.ok(log.result.some((e) => e.client === 'UABC assistant (fake-model)' && e.method === 'input.type' && e.ok));
  });

  test('asks before a new site, and the prompt can be answered in the panel', async () => {
    await newChat();
    brain = (view) =>
      view.results.length === 0
        ? { call: { name: 'browser_tabs', args: { action: 'new', url: `${env.origins.other}/form.html` } } }
        : { text: `Result: ${view.results[0].split('\n')[0]}` };
    await ask('Open the other site');
    const deny = panel.locator('#banner button', { hasText: 'Deny' });
    await deny.waitFor({ timeout: 15_000 });
    assert.match(await panel.locator('#banner').innerText(), new RegExp(env.origins.other.replace(/[.:/]/g, '\\$&')));
    await deny.click();
    await waitIdle();
    assert.match((await texts('.msg.assistant')).at(-1), /^Result: Error PERMISSION_DENIED/);
    const urls = await env.worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
    assert.ok(!urls.some((u) => u.startsWith(env.origins.other)), 'the denied site was opened');
  });

  test('the kill switch stops the assistant and the panel can resume', async () => {
    await newChat();
    brain = () => ({ call: { name: 'browser_tabs', args: { action: 'list' } } });
    await panel.evaluate(() => chrome.runtime.sendMessage({ uabcUi: 'pause' }));
    await ask('List my tabs');
    await waitIdle();
    assert.equal(llm.completions().length, 1, 'the model was asked again after a pause');
    assert.match((await texts('.line')).join('\n'), /AI control is paused/);
    const resume = panel.locator('#banner button', { hasText: 'Resume' });
    await resume.waitFor();
    await resume.click();
    for (let i = 0; ; i++) {
      const st = await panel.evaluate(() => chrome.runtime.sendMessage({ uabcUi: 'status' }));
      if (!st.result.settings.paused) break;
      assert.ok(i < 50, 'Resume in the panel did not resume AI control');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test('Stop cancels a slow model request', async () => {
    await newChat();
    brain = () => ({ delayMs: 10_000, text: 'too late' });
    await ask('Think for a long time');
    const started = Date.now();
    while (!llm.completions().length) await new Promise((r) => setTimeout(r, 50));
    await panel.click('#send'); // it is the Stop button while running
    await waitIdle(5_000);
    assert.ok(Date.now() - started < 5_000);
    // The browser drops the connection; the server notices a moment later.
    for (let i = 0; !llm.completions()[0].aborted; i++) {
      assert.ok(i < 40, 'the request was not cancelled');
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok((await texts('.line')).includes('Stopped.'));
    assert.ok(!(await texts('.msg.assistant')).includes('too late'));
  });

  test('speaks the Anthropic Messages API: caching, fallbacks and thinking blocks', async () => {
    // Built-in providers are pinned to their real address; a custom id may point anywhere.
    await configure({ id: 'custom-anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: `${llm.url}/anthropic/v1`, apiKey: KEY, models: [{ id: 'claude-opus-5-5', maxOutput: 128000 }] }, 'claude-opus-5-5');
    await newChat();
    brain = (view) => {
      if (view.results.length === 0) return { call: { name: 'browser_status', args: {} } };
      if (view.results.length === 1) return { text: 'Looking at your tabs.', call: { name: 'browser_tabs', args: { action: 'list' } } };
      return { text: 'Your browser is connected.' };
    };
    await ask('Is my browser connected?');
    await waitIdle();
    assert.deepEqual(await texts('.msg.assistant'), ['Looking at your tabs.', 'Your browser is connected.']);
    const calls = llm.completions();
    assert.equal(calls.length, 3);
    const [first, second] = calls;
    assert.equal(first.headers['x-api-key'], KEY);
    assert.equal(first.headers['anthropic-version'], '2026-10-21');
    assert.equal(first.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(first.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
    assert.equal(first.body.fallbacks, 'default');
    assert.equal(first.body.max_tokens, 16_000);
    assert.equal(first.body.tools[0].name, 'browser_status');
    // The model's own blocks (thinking with its signature) come back unchanged.
    const replayed = second.body.messages[1].content;
    assert.equal(replayed[0].type, 'thinking');
    assert.match(replayed[0].signature, /^sig-\d+$/);
    assert.equal(second.body.messages[2].content[0].type, 'tool_result');
    assert.match(second.body.messages[2].content[0].content[0].text, /Connected to Chromium .* through the built-in UABC assistant/);
    assert.match(await panel.locator('#usage').innerText(), /cached/);
  });

  test('shows a refusal and forgets the declined request', async () => {
    await newChat();
    brain = () => ({ refusal: 'cyber' });
    await ask('Something the model will decline');
    await waitIdle();
    assert.match((await texts('.line')).at(-1), /The model declined to continue \(category: cyber\)/);
    brain = (view) => ({ text: `I see ${view.users.length} user message(s).` });
    await ask('Hello again');
    await waitIdle();
    assert.equal((await texts('.msg.assistant')).at(-1), 'I see 1 user message(s).');
  });

  test('speaks the Gemini API: screenshots inside function responses, signatures replayed', async () => {
    await configure({ id: 'custom-gemini', kind: 'gemini', label: 'Gemini', baseUrl: `${llm.url}/gemini/v1beta`, apiKey: KEY, models: [{ id: 'gemini-3-flash' }] }, 'gemini-3-flash');
    await newChat();
    brain = (view) => (view.results.length === 0 ? { call: { name: 'browser_screenshot', args: {} } } : { text: `I received ${view.images} screenshot(s).` });
    await ask('Take a screenshot');
    await waitIdle();
    assert.equal((await texts('.msg.assistant')).at(-1), 'I received 1 screenshot(s).');
    const [first, second] = llm.completions();
    assert.equal(first.headers['x-goog-api-key'], KEY);
    assert.equal(first.path, '/gemini/v1beta/models/gemini-3-flash:generateContent');
    assert.ok(first.body.tools[0].functionDeclarations.some((f) => f.name === 'browser_screenshot' && f.parametersJsonSchema));
    const modelTurn = second.body.contents[1];
    assert.equal(modelTurn.role, 'model');
    assert.match(modelTurn.parts[0].thoughtSignature, /^gsig-\d+$/);
    const response = second.body.contents[2].parts[0].functionResponse;
    assert.equal(response.name, 'browser_screenshot');
    assert.match(response.parts[0].inlineData.mimeType, /^image\//);
    assert.equal(await panel.locator('.step img').count(), 1);
  });

  test('settings: adding an endpoint checks it, lists its models and never shows the key again', async () => {
    const options = await env.context.newPage();
    await options.goto(`chrome-extension://${env.extensionId}/options.html`);
    const KEY2 = 'e2e-second-key-9876543210';
    await options.fill('input[placeholder="Name, e.g. Ollama"]', 'Fake server');
    await options.fill('input[placeholder^="Address"]', `${llm.url}/v1`);
    await options.fill('input[placeholder^="API key (if the server needs one)"]', KEY2);
    llm.reset();
    await options.click('button:has-text("Add endpoint")');
    await options.getByText('Connected: 1 model available.').waitFor();
    assert.equal(llm.requests[0].path, '/v1/models');
    assert.equal(llm.requests[0].headers.authorization, `Bearer ${KEY2}`);
    const saved = await env.worker.evaluate(async () => (await chrome.storage.local.get('assistant')).assistant.providers.find((p) => p.label === 'Fake server'));
    assert.deepEqual(saved.models, [{ id: 'fake-model' }]);
    assert.ok(!(await options.content()).includes(KEY2), 'the saved key is shown in the page');
    assert.match(await options.locator('#assistant').innerText(), /Key e2e…3210/);

    // Plain http to a remote host is refused before anything is sent.
    llm.reset();
    await options.fill('input[placeholder^="Address"]', 'http://models.example.com/v1');
    await options.click('button:has-text("Add endpoint")');
    await options.getByText(/Use https:\/\//).waitFor();
    assert.equal(llm.requests.length, 0);
    await options.close();
  });
});
