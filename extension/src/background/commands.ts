// Command handlers for the methods in docs/protocol.md.
//
// Order of checks for every page-level command:
//   1. resolve the tab (must be in the UABC group) and pass the site gate,
//      which may ask the user, *before* taking the per-tab lock;
//   2. on acquiring the lock, re-check pause and that the tab still shows an
//      allowed site (before anything is injected or read): `enterPage`;
//   3. pin every content-script call to that document (`require_doc`);
//   4. right before input is dispatched, re-check document and origin:
//      `beforeInput`.

import { parseChord } from '../shared/keys';
import { type ActionPoint, CommandError, Code, type Snapshot } from '../shared/protocol';
import { classifyUrl } from '../shared/url-policy';
import { pendingApprovals } from './approvals';
import * as cdp from './cdp';
import { toContent } from './content';
import { ensureSiteAccess, isAllowed, originOnly, pausedError, type Session } from './policy';
import { settings } from './settings';
import { isShared, markAgentActivity, openTab, sharedTabs, tabsOpenedBy } from './tabs';

type Params = Record<string, unknown>;
export type Handler = (p: Params, s: Session, sessions: Map<string, Session>) => Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isMac = /Mac/i.test(navigator.userAgent);
const PAGE_PURPOSE = 'read and interact with this site';

function invalid(message: string): CommandError {
  return new CommandError(Code.INVALID_PARAMS, message);
}

async function assertNotPaused(): Promise<void> {
  const st = await settings();
  if (st.paused) throw pausedError(st.pausedReason);
}

function notApproved(url: string | undefined, outcome = 'so nothing was done'): CommandError {
  return new CommandError(
    Code.PERMISSION_DENIED,
    `The tab now shows ${originOnly(url ?? '')}, which is not approved, ${outcome}.`,
    'Call browser_get_state (the user will be asked about the site) and retry.',
    true,
  );
}

const urlOf = (tab: chrome.tabs.Tab) => tab.url || tab.pendingUrl;

/** Tab metadata as an agent may see it: pages of unapproved sites show only their origin. */
async function tabInfo(tab: chrome.tabs.Tab, s: Session) {
  const url = urlOf(tab) ?? '';
  const base = { id: tab.id, active: tab.active, current: tab.id === s.currentTab };
  return (await isAllowed(s, url))
    ? { ...base, url, title: tab.title ?? '', approved: true }
    : { ...base, url: originOnly(url), title: '', approved: false };
}

async function tabFor(s: Session, tabId: unknown): Promise<chrome.tabs.Tab> {
  let id = typeof tabId === 'number' ? tabId : s.currentTab;
  if (id === undefined) {
    const shared = await sharedTabs();
    if (shared.length === 1) id = shared[0]!.id;
  }
  if (id === undefined) {
    throw new CommandError(Code.NO_TAB, 'No tab is selected.', 'Use browser_tabs with action "new" (or "select").');
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    if (s.currentTab === id) s.currentTab = undefined;
    throw new CommandError(Code.NO_TAB, `Tab ${id} no longer exists.`, 'Use browser_tabs to list or open tabs.');
  }
  if (!(await isShared(tab))) {
    throw new CommandError(
      Code.TAB_NOT_SHARED,
      `Tab ${id} is not shared with AI agents.`,
      'Only tabs in the "UABC" tab group are available. Ask the user to drag the tab into that group, or open a new tab.',
    );
  }
  return tab;
}

/** Site gate for the page currently loaded in `tab` (may ask the user). */
function pageAccess(s: Session, tab: chrome.tabs.Tab): Promise<string> {
  return ensureSiteAccess(s, urlOf(tab), PAGE_PURPOSE);
}

/**
 * After a navigation the *agent* started, the page that actually loaded must
 * be allowed too. Only an explicit refusal parks the tab on about:blank; a
 * pause or an unanswered prompt just fails. Call it outside any tab lock: it
 * may wait for the user.
 */
async function gateCommitted(s: Session, tabId: number, purpose: string): Promise<void> {
  const url = urlOf(await chrome.tabs.get(tabId));
  if (await isAllowed(s, url)) return;
  try {
    await ensureSiteAccess(s, url, purpose);
  } catch (e) {
    const refused = e instanceof CommandError && e.code === Code.PERMISSION_DENIED;
    if (refused && !(await settings()).paused) await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
    throw e;
  }
}

const locks = new Map<number, Promise<unknown>>();
function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(tabId) ?? Promise.resolve())
    .catch(() => {})
    .then(assertNotPaused) // a call queued behind another must not run after Stop
    .then(() => markAgentActivity(tabId))
    .then(fn)
    .finally(() => markAgentActivity(tabId));
  locks.set(tabId, run);
  void run.finally(() => locks.get(tabId) === run && locks.delete(tabId)).catch(() => {});
  return run;
}

async function waitForLoad(tabId: number, timeoutMs: number): Promise<'complete' | 'loading'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new CommandError(Code.NO_TAB, 'The tab was closed.');
    if (tab.status === 'complete') return 'complete';
    await sleep(100);
  }
  return 'loading';
}

/**
 * Checks that the tab shows the same document (when we know which one) on an
 * allowed site. Returns the current document id. Without `expectedDoc` it may
 * inject the content script, so callers check the tab's URL first (`enterPage`).
 */
async function beforeInput(s: Session, tabId: number, expectedDoc?: string): Promise<string> {
  const now = await toContent<{ doc: string; url: string }>(tabId, 'ping', {}, { inject: expectedDoc === undefined }).catch((e) => {
    if (e instanceof CommandError && e.code === Code.PAUSED) throw e;
    return null;
  });
  if (!now || (expectedDoc !== undefined && now.doc !== expectedDoc)) {
    throw new CommandError(Code.STALE_REF, 'The page changed just before the action, so nothing was done.', 'Call browser_get_state and try again.');
  }
  if (!(await isAllowed(s, now.url))) throw notApproved(now.url);
  return now.doc;
}

/** First step inside a tab lock: allowed site (checked before injecting anything), current document. */
async function enterPage(s: Session, tabId: number): Promise<string> {
  const url = urlOf(await chrome.tabs.get(tabId));
  if (!(await isAllowed(s, url))) throw notApproved(url);
  return beforeInput(s, tabId);
}

/** After an input: wait for a navigation the input may have started, then report. */
async function settle(s: Session, tabId: number, beforeDoc: string | undefined, beforeUrl: string, startedAt: number) {
  let loading = false;
  for (const until = Date.now() + 500; Date.now() < until; await sleep(60)) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'loading') {
      loading = !!t;
      break;
    }
  }
  if (loading) await waitForLoad(tabId, 20_000);
  else await sleep(120);
  const tab = await chrome.tabs.get(tabId);
  let navigated: boolean;
  if (beforeDoc) {
    const now = await toContent<{ doc: string }>(tabId, 'ping', {}, { inject: false, whilePaused: true }).catch(() => null);
    navigated = !now || now.doc !== beforeDoc;
  } else {
    navigated = tab.url !== beforeUrl;
  }
  const opened = tabsOpenedBy(tabId, startedAt);
  const info = await tabInfo(tab, s);
  const notes = [
    ...(opened.length ? [`A new tab opened (tab ${opened.join(', ')}). Use browser_tabs action "select" to work in it.`] : []),
    ...(navigated && !info.approved ? ['The new page is on a site that is not approved yet; reading it will ask the user.'] : []),
  ];
  return { tab_id: tabId, navigated, url: info.url, title: info.title, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

const target = (p: Params) => ({ ref: p.ref, selector: p.selector, expect_doc: p.expect_doc });
const pinned = { inject: false } as const;

function modifierMask(mods: unknown): number {
  const bits: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
  return (Array.isArray(mods) ? mods : []).reduce((m: number, k) => m | (bits[String(k).toLowerCase()] ?? 0), 0);
}

async function basicMode(): Promise<boolean> {
  return (await settings()).inputMode === 'basic';
}

/**
 * Where back/forward would go, from the tab's history. Unknown (undefined) in
 * basic mode or where the debugger is refused; the post-load gate covers that.
 */
async function historyTarget(tabId: number, direction: 'back' | 'forward'): Promise<string | undefined> {
  if (await basicMode()) return undefined;
  let h: { currentIndex: number; entries: Array<{ url: string }> };
  try {
    h = await cdp.send(tabId, 'Page.getNavigationHistory');
  } catch (e) {
    if (e instanceof CommandError && e.code === Code.CDP_UNAVAILABLE) return undefined;
    throw e;
  }
  const entry = h.entries[h.currentIndex + (direction === 'back' ? -1 : 1)];
  if (!entry) throw invalid(`There is no page to go ${direction} to.`);
  return entry.url;
}

export const handlers: Record<string, Handler> = {
  async 'browser.status'(_p, s, sessions) {
    const st = await settings();
    const tabs = await sharedTabs();
    return {
      paused: st.paused,
      paused_reason: st.pausedReason,
      mode: st.mode,
      input_mode: st.inputMode,
      extension_version: chrome.runtime.getManifest().version,
      // Other clients' names and tabs are none of this client's business.
      sessions: sessions.size,
      tabs: await Promise.all(tabs.map((t) => tabInfo(t, s))),
      current_tab: s.currentTab,
      grants: [...st.grants.map((g) => g.origin), ...s.grants],
      pending_approvals: pendingApprovals().filter((a) => a.session === s.id).length,
    };
  },

  async 'tabs.list'(_p, s) {
    return { tabs: await Promise.all((await sharedTabs()).map((t) => tabInfo(t, s))) };
  },

  async 'tabs.open'(p, s) {
    const url = typeof p.url === 'string' && p.url ? p.url : 'about:blank';
    await ensureSiteAccess(s, url, `open ${url}`);
    await assertNotPaused();
    const tab = await openTab(url, p.background !== true);
    s.currentTab = tab.id;
    if (url !== 'about:blank') {
      await waitForLoad(tab.id!, 30_000);
      await gateCommitted(s, tab.id!, `continue to this site (the tab was redirected from ${originOnly(url)})`);
    }
    return { tab: await tabInfo(await chrome.tabs.get(tab.id!), s) };
  },

  async 'tabs.select'(p, s) {
    if (typeof p.tab_id !== 'number') throw invalid('`tab_id` is required.');
    const tab = await tabFor(s, p.tab_id);
    s.currentTab = tab.id;
    return { tab: await tabInfo(tab, s) };
  },

  async 'tabs.close'(p, s) {
    const tab = await tabFor(s, p.tab_id);
    await chrome.tabs.remove(tab.id!);
    if (s.currentTab === tab.id) s.currentTab = undefined;
    return { closed: tab.id };
  },

  async 'page.navigate'(p, s) {
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    // Gate the destination before the request is sent, wherever we can know it.
    if (typeof p.url === 'string') {
      await ensureSiteAccess(s, p.url, `open ${p.url}`);
    } else if (p.history === 'back' || p.history === 'forward') {
      const dest = await historyTarget(tabId, p.history);
      if (dest) await ensureSiteAccess(s, dest, `go ${p.history} to ${dest}`);
    } else if (p.history === 'reload') {
      await ensureSiteAccess(s, urlOf(tab), `reload ${originOnly(urlOf(tab) ?? '')}`);
    } else {
      throw invalid('Pass `url` or `history` (back, forward, reload).');
    }
    const status = await withTabLock(tabId, async () => {
      await assertNotPaused();
      if (typeof p.url === 'string') {
        await chrome.tabs.update(tabId, { url: p.url });
      } else if (p.history === 'back' || p.history === 'forward') {
        try {
          await (p.history === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
        } catch {
          throw invalid(`There is no page to go ${p.history} to.`);
        }
      } else {
        await chrome.tabs.reload(tabId);
      }
      await sleep(80);
      return waitForLoad(tabId, 30_000);
    });
    // Redirects (and history moves we could not look up) are only known once loaded.
    await gateCommitted(s, tabId, 'continue to this site (the tab was redirected or moved through its history)');
    const info = await tabInfo(await chrome.tabs.get(tabId), s);
    return { tab_id: tabId, url: info.url, title: info.title, status };
  },

  async 'page.snapshot'(p, s) {
    const tab = await tabFor(s, p.tab_id);
    const origin = await pageAccess(s, tab);
    if (origin === 'blank') {
      return {
        tab_id: tab.id, doc: '', url: tab.url || 'about:blank', title: '', viewport: { w: 0, h: 0, dpr: 1 },
        scroll: { x: 0, y: 0, max_x: 0, max_y: 0 }, elements: [], counts: { total: 0, shown: 0, above: 0, below: 0, truncated: false },
        notes: ['This tab is empty. Use browser_navigate to load a page.'],
      };
    }
    const snap = await toContent<Snapshot>(tab.id!, 'snapshot', {
      mode: p.mode, max_elements: p.max_elements, include_text: p.include_text, max_text: p.max_text,
    });
    // The page may have navigated between the gate and the read: nothing is
    // returned unless the page that was read is allowed too.
    const now = classifyUrl(snap.url);
    if (now.kind !== 'web' || now.origin !== origin) await ensureSiteAccess(s, snap.url, PAGE_PURPOSE);
    return { tab_id: tab.id, ...snap };
  },

  async 'page.screenshot'(p, s) {
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    await pageAccess(s, tab);
    const format = p.format === 'png' ? 'png' : 'jpeg';
    const quality = typeof p.quality === 'number' ? p.quality : 70;
    return withTabLock(tabId, async () => {
      // Re-read the tab: it may have moved or lost focus while we waited for the lock.
      let t = await chrome.tabs.get(tabId);
      const blank = classifyUrl(urlOf(t)).kind === 'blank';
      const doc = blank ? undefined : await enterPage(s, tabId);
      if (!t.active) {
        // Hidden tabs are not painted: bring the tab to the front of its window.
        await assertNotPaused();
        await chrome.tabs.update(tabId, { active: true });
        await sleep(200);
        t = await chrome.tabs.get(tabId);
      }
      let marks = 0;
      let dpr = 1;
      if (doc) {
        dpr = (await toContent<{ dpr?: number }>(tabId, 'ping', { require_doc: doc }, pinned)).dpr ?? 1;
        if (p.marks !== false) marks = (await toContent<{ marks: number }>(tabId, 'marks.show', { require_doc: doc }, pinned)).marks;
      }
      try {
        let data: string;
        if (await basicMode()) {
          // captureVisibleTab captures whatever is visible in the window: make sure that is this tab.
          const visible = async () => (await chrome.tabs.query({ active: true, windowId: t.windowId }))[0]?.id === tabId;
          if (!(await visible())) {
            throw new CommandError(Code.TIMEOUT, 'The tab is not the visible tab of its window, so basic mode cannot capture it.', 'Retry; the user may have switched tabs in that window.');
          }
          const url = await chrome.tabs.captureVisibleTab(t.windowId, { format, quality });
          if (!(await visible())) {
            throw new CommandError(Code.TIMEOUT, 'The visible tab changed during the capture, so the image was discarded.', 'Retry.');
          }
          data = url.slice(url.indexOf(',') + 1);
        } else {
          data = (await cdp.screenshot(tabId, { format, quality, fullPage: p.full_page === true, dpr })).data;
        }
        return { tab_id: tabId, ...(marks ? { doc } : {}), mime: `image/${format}`, data, marks };
      } finally {
        if (marks) await toContent(tabId, 'marks.hide', {}, { inject: false, whilePaused: true }).catch(() => {});
      }
    });
  },

  async 'input.click'(p, s) {
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    await pageAccess(s, tab);
    return withTabLock(tabId, async () => {
      const startedAt = Date.now();
      const doc0 = await enterPage(s, tabId);
      const byPoint = typeof p.x === 'number' && typeof p.y === 'number';
      const at: ActionPoint = byPoint
        ? { ...(await toContent<{ doc: string; description: string }>(tabId, 'describeAt', { x: p.x, y: p.y, require_doc: doc0 }, pinned)), x: p.x as number, y: p.y as number }
        : await toContent<ActionPoint>(tabId, 'locate', { ...target(p), require_doc: doc0 }, pinned);
      const doc = await beforeInput(s, tabId, at.doc);
      if (await basicMode()) {
        await toContent(tabId, 'fallback.click', { ...(byPoint ? { x: p.x, y: p.y } : target(p)), require_doc: doc }, pinned);
      } else {
        const button = p.button === 'right' || p.button === 'middle' ? p.button : 'left';
        const count = typeof p.click_count === 'number' ? Math.min(Math.max(p.click_count, 1), 3) : 1;
        await cdp.click(tabId, at.x, at.y, button, count, modifierMask(p.modifiers));
      }
      return { ...(await settle(s, tabId, doc, tab.url ?? '', startedAt)), clicked: at.description };
    });
  },

  async 'input.type'(p, s) {
    if (typeof p.text !== 'string') throw invalid('`text` must be a string.');
    const text = p.text;
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    await pageAccess(s, tab);
    return withTabLock(tabId, async () => {
      const startedAt = Date.now();
      const clear = p.clear !== false;
      const doc0 = await enterPage(s, tabId);
      let doc: string;
      if (await basicMode()) {
        doc = doc0;
        await toContent(tabId, 'fallback.type', { ...target(p), text, clear, submit: p.submit === true, require_doc: doc }, pinned);
      } else {
        doc = (await toContent<ActionPoint>(tabId, 'prepareType', { ...target(p), clear, require_doc: doc0 }, pinned)).doc;
        await beforeInput(s, tabId, doc);
        if (text) await cdp.insertText(tabId, text);
        else if (clear) await cdp.press(tabId, parseChord('Backspace'));
      }
      const { value } = await toContent<{ value?: string }>(tabId, 'focusedValue', { require_doc: doc }, pinned).catch(() => ({}) as { value?: string });
      if (p.submit === true && !(await basicMode())) {
        await beforeInput(s, tabId, doc);
        await cdp.press(tabId, parseChord('Enter'));
      }
      return { ...(await settle(s, tabId, doc, tab.url ?? '', startedAt)), ...(value !== undefined ? { value } : {}) };
    });
  },

  async 'input.key'(p, s) {
    if (typeof p.keys !== 'string') throw invalid('`keys` must be a string such as "Enter" or "Control+A".');
    let chord;
    try {
      chord = parseChord(p.keys, isMac);
    } catch (e) {
      throw invalid((e as Error).message);
    }
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    await pageAccess(s, tab);
    return withTabLock(tabId, async () => {
      const startedAt = Date.now();
      const doc0 = await enterPage(s, tabId);
      const focus = await toContent<{ doc: string; sensitive: boolean; opaqueFrame: boolean; singleLine: boolean }>(tabId, 'focusInfo', { require_doc: doc0 }, pinned);
      const pastes = (chord.mask & (2 | 4)) !== 0 && chord.key.code === 'KeyV';
      // Plain Enter submits a single-line field without adding to it (e.g. after the user typed a password).
      const plainEnter = chord.key.key === 'Enter' && chord.mask === 0 && focus.singleLine && !focus.opaqueFrame;
      const entersText = (!!chord.key.text && !plainEnter) || pastes;
      if (focus.sensitive && entersText) {
        throw new CommandError(Code.SENSITIVE_FIELD, 'The focused field is a password, one-time-code or payment field; UABC does not type into it.', 'Ask the user to fill it in.');
      }
      if (focus.opaqueFrame && entersText) {
        throw new CommandError(
          Code.SENSITIVE_FIELD,
          'Keyboard focus is inside an embedded frame from another site (for example a payment or login widget) that UABC cannot inspect, so it does not type there.',
          'Ask the user to fill in that part of the page.',
        );
      }
      const doc = await beforeInput(s, tabId, focus.doc);
      if (await basicMode()) await toContent(tabId, 'fallback.key', { keys: p.keys, require_doc: doc }, pinned);
      else await cdp.press(tabId, chord);
      return settle(s, tabId, doc, tab.url ?? '', startedAt);
    });
  },

  async 'input.select'(p, s) {
    if (!Array.isArray(p.values)) throw invalid('`values` must be a list of option labels or values.');
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    await pageAccess(s, tab);
    return withTabLock(tabId, async () => {
      const startedAt = Date.now();
      const doc = await enterPage(s, tabId);
      const r = await toContent<{ doc: string; selected: string[] }>(tabId, 'select', { ...target(p), values: p.values, require_doc: doc }, pinned);
      return { ...(await settle(s, tabId, r.doc, tab.url ?? '', startedAt)), selected: r.selected };
    });
  },

  async 'page.scroll'(p, s) {
    if (!['up', 'down', 'left', 'right'].includes(p.direction as string)) throw invalid('`direction` must be up, down, left or right.');
    const tab = await tabFor(s, p.tab_id);
    await pageAccess(s, tab);
    return withTabLock(tab.id!, async () => {
      const doc = await enterPage(s, tab.id!);
      return {
        tab_id: tab.id,
        ...(await toContent<object>(tab.id!, 'scroll', { ...target(p), direction: p.direction, amount: p.amount, require_doc: doc }, pinned)),
      };
    });
  },

  async 'page.wait_for'(p, s) {
    const tab = await tabFor(s, p.tab_id);
    const tabId = tab.id!;
    await pageAccess(s, tab);
    const started = Date.now();
    const timeout = Math.min(60_000, Math.max(0, typeof p.timeout_ms === 'number' ? p.timeout_ms : 5000));
    const deadline = started + timeout;
    if (!p.text && !p.text_gone) {
      // A plain delay, in short steps so Stop takes effect immediately.
      for (const until = started + Math.min(timeout, 10_000); Date.now() < until; ) {
        await assertNotPaused();
        await sleep(Math.min(250, until - Date.now()));
      }
      return { tab_id: tabId, found: null, elapsed_ms: Date.now() - started };
    }
    // Poll in ≤1 s steps. Stop takes effect between steps. If the page moves to
    // a site that is not allowed (the page or the user did it, not the agent),
    // stop reading and report instead of prompting.
    for (;;) {
      await assertNotPaused();
      const url = urlOf(await chrome.tabs.get(tabId));
      if (!(await isAllowed(s, url))) throw notApproved(url, 'so UABC stopped reading it');
      const step = Math.min(1000, Math.max(0, deadline - Date.now()));
      try {
        const r = await toContent<{ found: boolean | null; url?: string }>(tabId, 'waitFor', { text: p.text, text_gone: p.text_gone, timeout_ms: step });
        const after = urlOf(await chrome.tabs.get(tabId));
        if (!(await isAllowed(s, after))) throw notApproved(after, 'so UABC stopped reading it');
        if (r.found || Date.now() >= deadline) return { tab_id: tabId, found: !!r.found, elapsed_ms: Date.now() - started };
      } catch (e) {
        if (!(e instanceof CommandError) || e.code !== Code.TIMEOUT || Date.now() >= deadline) throw e;
        await waitForLoad(tabId, Math.max(0, deadline - Date.now()));
      }
    }
  },
};
