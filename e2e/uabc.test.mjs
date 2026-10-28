// Run: npm run build:ext && cargo build && npm run test:e2e
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertFenced, collectPrompts, refOf, startEnvironment } from './harness.mjs';

let env;
let state; // last browser_get_state text

const get = async (args = {}) => {
  const r = await env.call('browser_get_state', args);
  assert.equal(r.isError, false, r.text);
  state = r.text;
  return r.text;
};

describe('UABC end to end', { timeout: 240_000 }, () => {
  before(async () => {
    env = await startEnvironment();
  });
  after(async () => {
    await env?.stop();
  });

  test('exposes the browser tools with safety annotations', async () => {
    const { tools } = await env.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'browser_click', 'browser_get_state', 'browser_navigate', 'browser_press_key', 'browser_screenshot',
      'browser_scroll', 'browser_select_option', 'browser_status', 'browser_tabs', 'browser_type', 'browser_wait_for',
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.browser_click.annotations.destructiveHint, true);
    assert.equal(byName.browser_get_state.annotations.readOnlyHint, true);
    assert.ok(env.client.getInstructions().includes('untrusted-web-content'));
  });

  test('reports the connected browser', async () => {
    const r = await env.call('browser_status');
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Connected to Chromium/);
    assert.match(r.text, /Shared tabs: none/);
    assert.match(r.text, /Site access: the user is asked/);
  });

  test('opens a tab on an approved site inside the UABC tab group', async () => {
    const r = await env.call('browser_tabs', { action: 'new', url: `${env.origins.approved}/form.html` });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Now working in tab \d+/);
    const grouped = await env.worker.evaluate(async () => {
      const [group] = await chrome.tabGroups.query({ title: 'UABC' });
      return group ? (await chrome.tabs.query({ groupId: group.id })).map((t) => t.url) : [];
    });
    assert.equal(grouped.length, 1);
    assert.match(grouped[0], /form\.html/);
  });

  test('describes the page as refs with roles, names, values and states', async () => {
    const text = await get();
    assert.match(text, /<untrusted-web-content origin="http:\/\/127\.0\.0\.1:\d+">/);
    for (const line of [
      /\[\d+\] textbox "Full name" value="" required/,
      /\[\d+\] combobox "Country" value="Choose…" options: Choose… \| Bangladesh \| India \| Nepal/,
      /\[\d+\] textbox "Password" value="\(hidden\)" password/,
      /\[\d+\] textbox "Card number" value="" sensitive/,
      /\[\d+\] checkbox "I agree to the terms" unchecked/,
      /\[\d+\] clickable "Fancy button"/,
      /\[\d+\] button "Send message"/,
    ]) {
      assert.match(text, line);
    }
    assert.doesNotMatch(text, /hunter2/, 'password values must never reach the model');
  });

  test('types Bangla and other Unicode with trusted input', async () => {
    const name = 'সত্যজিৎ রায়';
    let r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Full name/), text: name });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Field value now: "সত্যজিৎ রায়"/);
    assertFenced(r.text, 'Field value now');
    r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Email/), text: 'satyajit@example.com' });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^About you/), text: 'লাইন ১\nLine 2 🚀' });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Notes/), text: 'নোট: rich text' });
    assert.equal(r.isError, false, r.text);
    const page = await env.page('form.html');
    assert.equal(await page.inputValue('#name'), name);
    assert.equal(await page.inputValue('#bio'), 'লাইন ১\nLine 2 🚀');
    assert.equal(await page.locator('#notes').innerText(), 'নোট: rich text');
    // clear=true (default) replaces instead of appending
    r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Email/), text: 'info@example.com' });
    assert.equal(await page.inputValue('#email'), 'info@example.com');
  });

  test('refuses password and payment fields, including via key presses', async () => {
    let r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Password/), text: 'guess' });
    assert.equal(r.isError, true);
    assert.match(r.text, /SENSITIVE_FIELD/);
    r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Card number/), text: '4111111111111111' });
    assert.match(r.text, /SENSITIVE_FIELD/);
    r = await env.call('browser_click', { ref: refOf(state, 'textbox', /^Password/) });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_press_key', { keys: 'x' });
    assert.match(r.text, /SENSITIVE_FIELD/);
    r = await env.call('browser_press_key', { keys: 'Control+V' });
    assert.match(r.text, /SENSITIVE_FIELD/);
    r = await env.call('browser_press_key', { keys: 'Tab' });
    assert.equal(r.isError, false, 'navigation keys stay allowed');
    assert.equal(await (await env.page('form.html')).inputValue('#password'), 'hunter2');
  });

  test('selects options, ticks checkboxes and clicks with real (trusted) events', async () => {
    let r = await env.call('browser_select_option', { ref: refOf(state, 'combobox', /^Country/), values: ['Bangladesh'] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Selected:[\s\S]*Bangladesh/);
    r = await env.call('browser_select_option', { ref: refOf(state, 'combobox', /^Country/), values: ['Atlantis'] });
    assert.equal(r.isError, true);
    assert.match(r.text, /Available: Choose…, Bangladesh, India, Nepal/);
    r = await env.call('browser_click', { ref: refOf(state, 'checkbox', /^I agree/) });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_click', { ref: refOf(state, 'clickable', /^Fancy/) });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_click', { ref: refOf(state, 'button', /^Send message/) });
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /navigated/);
    const page = await env.page('form.html');
    const result = JSON.parse(await page.locator('#result').innerText());
    assert.equal(result.name, 'সত্যজিৎ রায়');
    assert.equal(result.country, 'bd');
    assert.equal(result.agree, true);
    assert.equal(result.notes, 'নোট: rich text');
    assert.equal(result.password, 'hunter2');
    assert.ok(result.clicks.length >= 3);
    assert.ok(result.clicks.every((c) => c.trusted), `all clicks must be trusted: ${JSON.stringify(result.clicks)}`);
    assert.equal(await page.locator('#fancy').innerText(), 'Fancy clicked');
  });

  test('takes screenshots with numbered marks and cleans up the overlay', async () => {
    const r = await env.call('browser_screenshot', { marks: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, 'image/jpeg');
    const bytes = Buffer.from(r.images[0].data, 'base64');
    assert.ok(bytes.length > 5_000, 'a real image');
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.match(r.text, /with \d+ numbered element badges/);
    assert.equal(await (await env.page('form.html')).locator('uabc-marks').count(), 0);
  });

  test('does not type into cross-origin frames it cannot inspect', async () => {
    const widget = `${env.origins.third}/widget.html`;
    let r = await env.call('browser_navigate', { url: `${env.origins.approved}/embed.html?widget=${encodeURIComponent(widget)}` });
    assert.equal(r.isError, false, r.text);
    await get();
    assert.match(state, /cross-origin frame/);
    const frame = await (await env.page('embed.html')).locator('#pay').boundingBox();
    r = await env.call('browser_click', { x: frame.x + 200, y: frame.y + 30 });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_press_key', { keys: '4' });
    assert.equal(r.isError, true);
    assert.match(r.text, /SENSITIVE_FIELD/);
    assert.match(r.text, /embedded frame/);
  });

  test('refuses to click through overlays and names the blocker', async () => {
    let r = await env.call('browser_navigate', { url: `${env.origins.approved}/obscured.html` });
    assert.equal(r.isError, false, r.text);
    await get();
    assert.match(state, /A dialog is open \("Cookie consent"\)/);
    r = await env.call('browser_click', { ref: refOf(state, 'button', /^Buy now/) });
    assert.equal(r.isError, true);
    assert.match(r.text, /OBSCURED/);
    assert.match(r.text, /Cookie consent/);
    r = await env.call('browser_click', { ref: refOf(state, 'button', /^Accept/) });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_click', { ref: refOf(state, 'button', /^Buy now/) });
    assert.equal(r.isError, false, r.text);
    assert.equal(await (await env.page('obscured.html')).locator('#status').innerText(), 'Bought!');
  });

  test('scrolls, waits for text and reads page text', async () => {
    await env.call('browser_navigate', { url: `${env.origins.approved}/long.html` });
    await get();
    assert.match(state, /more element\(s\) below/);
    assert.doesNotMatch(state, /Bottom button/);
    let r = await env.call('browser_scroll', { direction: 'down', amount: 5000 });
    assert.match(r.text, /Reached the bottom/);
    await get();
    assert.match(state, /button "Bottom button"/);
    r = await env.call('browser_scroll', { direction: 'up', amount: 5000 });
    await get();
    r = await env.call('browser_click', { ref: refOf(state, 'button', /^Load more/) });
    r = await env.call('browser_wait_for', { text: 'Results loaded', timeout_ms: 5000 });
    assert.match(r.text, /Condition met/);
    const t = await get({ include_text: true });
    assert.match(t, /Visible text:[\s\S]*Results loaded: 42 items/);
  });

  test('detects navigation and rejects stale refs from the previous page', async () => {
    const oldRef = refOf(state, 'button', /^Load more/);
    let r = await env.call('browser_click', { ref: refOf(state, 'link', /^Go to the contact form/) });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /navigated to a new page[\s\S]*URL: .*form\.html/);
    r = await env.call('browser_click', { ref: oldRef });
    assert.equal(r.isError, true);
    assert.match(r.text, /STALE_REF/);
    await get();
    assert.match(state, /textbox "Full name"/);
  });

  test('tabs opened by a shared tab join the workspace', async () => {
    await env.call('browser_navigate', { url: `${env.origins.approved}/long.html` });
    await get();
    const r = await env.call('browser_click', { ref: refOf(state, 'link', /^Open the form in a new tab/) });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /A new tab opened/);
    const list = await env.call('browser_tabs', { action: 'list' });
    assert.match(list.text, /2 shared tab\(s\)/);
    assert.match(list.text, /popup=1/);
  });

  test('tabs outside the UABC group are invisible and untouchable', async () => {
    // The user's own tab (no agent action opened it).
    const id = await env.worker.evaluate(async (url) => (await chrome.tabs.create({ url, active: false })).id, `${env.origins.approved}/form.html?private=1`);
    const list = await env.call('browser_tabs', { action: 'list' });
    assert.doesNotMatch(list.text, /private=1/);
    for (const [tool, args] of [['browser_get_state', {}], ['browser_click', { x: 10, y: 10 }], ['browser_tabs', { action: 'select' }], ['browser_tabs', { action: 'close' }]]) {
      const r = await env.call(tool, { ...args, tab_id: id });
      assert.equal(r.isError, true, tool);
      assert.match(r.text, /TAB_NOT_SHARED/, tool);
    }
    await env.worker.evaluate((tabId) => chrome.tabs.remove(tabId), id);
  });

  test('a tab the user opens from an agent tab stays private', async () => {
    await new Promise((r) => setTimeout(r, 5_500)); // no agent action on the opener for > 5 s
    const page = await env.context.newPage(); // CDP sets the active (agent) tab as opener
    await page.goto(`${env.origins.approved}/form.html?mine=1`);
    const list = await env.call('browser_tabs', { action: 'list' });
    assert.doesNotMatch(list.text, /mine=1/);
    await page.close();
  });

  test('asks the user before using a new site (allow)', async () => {
    const prompt = env.context.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html') });
    const pending = env.call('browser_navigate', { url: `${env.origins.other}/form.html` });
    const popup = await prompt;
    await popup.getByText(env.origins.other, { exact: true }).waitFor();
    await popup.getByText('uabc-e2e', { exact: true }).waitFor();
    await popup.getByRole('button', { name: 'Allow this time' }).click();
    const r = await pending;
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /form\.html/);
    await get();
    assert.match(state, /textbox "Full name"/);
  });

  test('asks the user before using a new site (deny)', async () => {
    const prompt = env.context.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html') });
    const pending = env.call('browser_navigate', { url: `${env.origins.third}/form.html` });
    const popup = await prompt;
    await popup.getByRole('button', { name: 'Deny' }).click();
    const r = await pending;
    assert.equal(r.isError, true);
    assert.match(r.text, /PERMISSION_DENIED/);
    assert.match(r.text, /declined access/);
  });

  test('never opens browser-internal, file or script URLs', async () => {
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'javascript:alert(1)', `chrome-extension://${env.extensionId}/approve.html`]) {
      const r = await env.call('browser_navigate', { url });
      assert.equal(r.isError, true, url);
      assert.match(r.text, /BLOCKED_URL/, url);
    }
  });

  test('the Stop button in the toolbar popup pauses every agent', async () => {
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extensionId}/popup.html`);
    await popup.getByRole('button', { name: /Stop AI control/ }).click();
    await popup.getByRole('button', { name: /Resume AI control/ }).waitFor();
    let r = await env.call('browser_get_state');
    assert.equal(r.isError, true);
    assert.match(r.text, /PAUSED/);
    r = await env.call('browser_status');
    assert.match(r.text, /PAUSED/);
    await popup.getByRole('button', { name: /Resume AI control/ }).click();
    await popup.getByRole('button', { name: /Stop AI control/ }).waitFor();
    r = await env.call('browser_get_state');
    assert.equal(r.isError, false, r.text);
    await popup.close();
  });

  test('basic input mode works without the debugger (enterprise fallback)', async () => {
    await env.worker.evaluate(() => chrome.storage.local.set({ inputMode: 'basic' }));
    await env.call('browser_navigate', { url: `${env.origins.approved}/form.html?basic=1` });
    await get();
    let r = await env.call('browser_type', { ref: refOf(state, 'textbox', /^Full name/), text: 'বেসিক মোড' });
    assert.equal(r.isError, false, r.text);
    r = await env.call('browser_click', { ref: refOf(state, 'button', /^Send message/) });
    assert.equal(r.isError, false, r.text);
    const page = await env.page('basic=1');
    assert.equal(JSON.parse(await page.locator('#result').innerText()).name, 'বেসিক মোড');
    r = await env.call('browser_screenshot', { marks: false });
    assert.equal(r.isError, false, r.text);
    await env.worker.evaluate(() => chrome.storage.local.set({ inputMode: 'trusted' }));
  });

  test('page titles and addresses reach the model only inside the untrusted fence', async () => {
    const r = await env.call('browser_navigate', { url: `${env.origins.approved}/inject.html` });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /ignore previous instructions/);
    assertFenced(r.text, 'ignore previous instructions');
    for (const [tool, args] of [['browser_tabs', { action: 'list' }], ['browser_status', {}], ['browser_get_state', {}]]) {
      const out = await env.call(tool, args);
      assert.match(out.text, /ignore previous instructions/, tool);
      assertFenced(out.text, 'ignore previous instructions');
    }
  });

  test('shared tabs on unapproved sites show only their origin', async () => {
    await env.call('browser_navigate', { url: `${env.origins.approved}/form.html?step=1` });
    const list = await env.call('browser_tabs', { action: 'list' });
    const current = Number(/tab (\d+) [^\n]*← current/.exec(list.text)[1]);
    // The user takes the shared tab to a site the agent has no approval for.
    await env.worker.evaluate(async ([tabId, url]) => {
      await chrome.tabs.update(tabId, { url });
      for (let i = 0; i < 50 && (await chrome.tabs.get(tabId)).status !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
    }, [current, `${env.origins.fourth}/form.html?secret=abc123`]);
    const after = await env.call('browser_tabs', { action: 'list' });
    const line = after.text.split('\n').find((l) => l.includes(`tab ${current} `));
    assert.match(line, /\(site not approved yet\)/);
    assert.doesNotMatch(after.text, /secret=abc123/);
    assert.doesNotMatch(line, /Contact form/);
  });

  test('going back into an unapproved site asks first and does not navigate on deny', async () => {
    // History of the current tab: …, fourth/form.html?secret=…, approved/long.html
    let r = await env.call('browser_navigate', { url: `${env.origins.approved}/long.html` });
    assert.equal(r.isError, false, r.text);
    const watcher = collectPrompts(env.context);
    const pending = env.call('browser_navigate', { history: 'back' });
    const [prompt] = await watcher.waitFor(1);
    watcher.stop();
    await prompt.getByText(env.origins.fourth, { exact: true }).waitFor();
    await prompt.getByRole('button', { name: 'Deny' }).click();
    r = await pending;
    assert.equal(r.isError, true);
    assert.match(r.text, /PERMISSION_DENIED/);
    const url = await env.worker.evaluate(async () => {
      const [group] = await chrome.tabGroups.query({ title: 'UABC' });
      return (await chrome.tabs.query({ groupId: group.id, active: true }))[0]?.url ?? '';
    });
    assert.match(url, /long\.html/, 'the tab must not have gone back');
  });

  test('a redirect into an unapproved site asks first and parks the tab on deny', async () => {
    const target = `${env.origins.fourth}/form.html?via=redirect`;
    const watcher = collectPrompts(env.context);
    const pending = env.call('browser_navigate', { url: `${env.origins.approved}/redirect?to=${encodeURIComponent(target)}` });
    const [prompt] = await watcher.waitFor(1);
    watcher.stop();
    await prompt.getByText(env.origins.fourth, { exact: true }).waitFor();
    await prompt.getByRole('button', { name: 'Deny' }).click();
    const r = await pending;
    assert.equal(r.isError, true);
    assert.match(r.text, /PERMISSION_DENIED/);
    const state = await env.call('browser_get_state');
    assert.match(state.text, /This tab is empty/);
  });

  test('each AI client gets its own site prompt; one approval never covers another client', async () => {
    const second = await env.connect('second-client');
    try {
      let r = await second.call('browser_tabs', { action: 'new', url: `${env.origins.approved}/form.html?client=2` });
      assert.equal(r.isError, false, r.text);
      const watcher = collectPrompts(env.context);
      const mine = env.call('browser_navigate', { url: `${env.origins.fifth}/form.html?who=main` });
      const theirs = second.call('browser_navigate', { url: `${env.origins.fifth}/form.html?who=second` });
      const prompts = await watcher.waitFor(2);
      watcher.stop();
      const names = await Promise.all(prompts.map((p) => p.locator('.lead strong').innerText()));
      assert.deepEqual([...names].sort(), ['second-client', 'uabc-e2e']);
      const forMain = prompts[names.indexOf('uabc-e2e')];
      const forSecond = prompts[names.indexOf('second-client')];
      await forMain.getByRole('button', { name: 'Allow this time' }).click();
      r = await mine;
      assert.equal(r.isError, false, r.text);
      await forSecond.getByRole('button', { name: 'Deny' }).click();
      r = await theirs;
      assert.equal(r.isError, true);
      assert.match(r.text, /PERMISSION_DENIED/);
    } finally {
      await second.close();
    }
  });

  test('Stop interrupts an action that is already running', async () => {
    await env.call('browser_navigate', { url: `${env.origins.approved}/long.html` });
    const waiting = env.call('browser_wait_for', { text: 'this text never appears', timeout_ms: 30_000 });
    await new Promise((r) => setTimeout(r, 800));
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extensionId}/popup.html`);
    const stoppedAt = Date.now();
    await popup.getByRole('button', { name: /Stop AI control/ }).click();
    const r = await waiting;
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /PAUSED/);
    assert.ok(Date.now() - stoppedAt < 5_000, 'the running wait must end promptly');
    await popup.getByRole('button', { name: /Resume AI control/ }).click();
    await popup.getByRole('button', { name: /Stop AI control/ }).waitFor();
    await popup.close();
  });

  test('Stop while a site prompt is open fails the call without moving the tab', async () => {
    const target = `${env.origins.fourth}/form.html?via=redirect2`;
    const watcher = collectPrompts(env.context);
    const pending = env.call('browser_navigate', { url: `${env.origins.approved}/redirect?to=${encodeURIComponent(target)}` });
    await watcher.waitFor(1);
    watcher.stop();
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extensionId}/popup.html`);
    await popup.getByRole('button', { name: /Stop AI control/ }).click();
    const r = await pending;
    assert.equal(r.isError, true);
    assert.match(r.text, /PAUSED/);
    const stillThere = await env.worker.evaluate(async () => (await chrome.tabs.query({})).some((t) => t.url?.includes('via=redirect2')));
    assert.ok(stillThere, 'a pause must not navigate the tab away');
    await popup.getByRole('button', { name: /Resume AI control/ }).click();
    await popup.getByRole('button', { name: /Stop AI control/ }).waitFor();
    await popup.close();
  });

  test('keeps an audit log of agent actions', async () => {
    const log = await env.worker.evaluate(async () => (await chrome.storage.local.get('audit')).audit ?? []);
    assert.ok(log.length > 20);
    assert.ok(log.some((e) => e.method === 'input.type' && e.client === 'uabc-e2e'));
    assert.ok(log.some((e) => e.code === 'SENSITIVE_FIELD'));
    assert.ok(log.some((e) => e.code === 'PERMISSION_DENIED'));
  });
});
