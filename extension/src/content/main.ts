// Content script entry. Injected on demand (never on every page) into tabs the
// user shared with the agent; answers requests from the service worker only.

import { CommandError, Code, toErrorBody } from '../shared/protocol';
import {
  describeAt, fallbackClick, fallbackKey, fallbackType, focusInfo, focusedValue, locate, prepareType, scroll, selectOptions, waitFor,
} from './actions';
import { hideMarks, showMarks } from './overlay';
import { docId } from './registry';
import { scrollState, snapshot } from './snapshot';

declare const __BUILD_ID__: string;
declare global {
  // eslint-disable-next-line no-var
  var __uabcContent: { build: string } | undefined;
}

type Msg = { uabc: 'content'; op: string } & Record<string, unknown>;

// Re-injection after an extension update finds the old instance's marker; only
// skip registration when this exact build is already listening.
if (globalThis.__uabcContent?.build !== __BUILD_ID__) {
  globalThis.__uabcContent = { build: __BUILD_ID__ };
  chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || msg?.uabc !== 'content') return false;
    Promise.resolve()
      .then(() => run(msg))
      .then(
        (result) => sendResponse({ ok: true, result }),
        (e) => sendResponse({ ok: false, error: toErrorBody(e) }),
      );
    return true;
  });
}

function run(m: Msg): unknown {
  const p = m as never;
  if (typeof m.require_doc === 'string' && m.require_doc !== docId) {
    throw new CommandError(Code.STALE_REF, 'The page changed just before the action, so nothing was done.', 'Call browser_get_state and try again.');
  }
  switch (m.op) {
    case 'ping':
      return { doc: docId, url: location.href, ready: document.readyState, dpr: window.devicePixelRatio };
    case 'snapshot':
      return snapshot(p);
    case 'locate':
      return locate(p);
    case 'describeAt':
      return describeAt(m.x as number, m.y as number);
    case 'prepareType':
      return prepareType(p);
    case 'focusInfo':
      return focusInfo();
    case 'focusedValue':
      return focusedValue();
    case 'select':
      return selectOptions(p);
    case 'scroll':
      return scroll(p);
    case 'scrollState':
      return { doc: docId, scroll: scrollState() };
    case 'waitFor':
      return waitFor(p);
    case 'marks.show':
      return showMarks(m.max as number | undefined);
    case 'marks.hide':
      hideMarks();
      return {};
    case 'fallback.click':
      return fallbackClick(p);
    case 'fallback.type':
      return fallbackType(p);
    case 'fallback.key':
      return fallbackKey(p);
    default:
      throw new CommandError(Code.UNKNOWN_METHOD, `unknown content op ${m.op}`);
  }
}
