// Service worker → content script calls. The content script is injected on
// demand, only into shared tabs, and only into the top frame.

import { CommandError, Code, type Reply } from '../shared/protocol';
import { pausedError } from './policy';
import { settings } from './settings';

function mapError(e: unknown): CommandError {
  const msg = (e as Error)?.message ?? String(e);
  if (/Cannot access|cannot be scripted|extensions gallery|Missing host permission/i.test(msg)) {
    return new CommandError(
      Code.PERMISSION_DENIED,
      'The browser does not let UABC access this page.',
      'If the user limited UABC\'s site access in chrome://extensions, they must allow this site there.',
    );
  }
  if (/No tab with id/i.test(msg)) return new CommandError(Code.NO_TAB, 'The tab was closed.');
  if (/message port closed|Receiving end does not exist|Frame with ID 0 was removed|document.*unloaded/i.test(msg)) {
    return new CommandError(Code.TIMEOUT, 'The page navigated or reloaded while UABC was working on it.', 'Call browser_get_state and retry.');
  }
  return new CommandError(Code.INTERNAL, msg);
}

const isNoReceiver = (e: unknown) => /Receiving end does not exist|Could not establish connection/i.test((e as Error)?.message ?? '');

/**
 * Sends one operation to the content script of the tab's current document.
 * `inject: false` refuses to inject into a document we have not talked to yet
 * (used right before acting, so a navigation cannot redirect the action).
 * Every call checks the pause flag, except clean-up operations.
 */
export async function toContent<T>(
  tabId: number,
  op: string,
  params: object = {},
  opts: { inject?: boolean; whilePaused?: boolean } = {},
): Promise<T> {
  const st = await settings();
  if (st.paused && !opts.whilePaused) throw pausedError(st.pausedReason);
  const msg = { uabc: 'content', op, ...params };
  let reply: Reply<T> | undefined;
  try {
    reply = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    if (!isNoReceiver(e) || opts.inject === false) throw mapError(e);
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
      reply = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    } catch (e2) {
      throw mapError(e2);
    }
  }
  if (!reply) throw new CommandError(Code.INTERNAL, 'The page script did not answer.');
  if (!reply.ok) throw new CommandError(reply.error.code as Code, reply.error.message, reply.error.hint);
  return reply.result;
}
