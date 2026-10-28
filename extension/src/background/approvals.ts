// Site-access prompts. Each prompt is a small extension window, outside the
// agent's tab group, so an agent can neither see nor click it.
//
// Prompts are per (AI session, origin): a prompt only ever answers for the
// client it names. Concurrent requests from the *same* session for the same
// origin share one prompt; another client asking for the same site gets its
// own prompt naming it. "Always allow" is a site-wide grant by definition (the
// prompt says so), so it also answers other sessions' prompts for that origin.

import { CommandError, Code } from '../shared/protocol';

export type Decision = 'deny' | 'session' | 'always';
export const APPROVAL_TIMEOUT_MS = 120_000;

export interface PendingApproval {
  id: string;
  session: string;
  origin: string;
  client: string;
  /** A cloud app through the relay ("this time" then means until it is idle for 10 minutes). */
  remote: boolean;
  purpose: string;
  created: number;
  expires: number;
}

interface Entry extends PendingApproval {
  windowId?: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (d: Decision | 'timeout') => void;
}

const entries = new Map<string, Entry>();
const byKey = new Map<string, Promise<Decision | 'timeout'>>();
let changed: () => void = () => {};

export function onApprovalsChange(fn: () => void): void {
  changed = fn;
}

export function pendingApprovals(): PendingApproval[] {
  return [...entries.values()].map(({ id, session, origin, client, remote, purpose, created, expires }) => ({ id, session, origin, client, remote, purpose, created, expires }));
}

export function getApproval(id: string): PendingApproval | undefined {
  return pendingApprovals().find((a) => a.id === id);
}

export async function requestApproval(session: string, origin: string, client: string, purpose: string, remote = false): Promise<Decision> {
  const key = `${session} ${origin}`;
  let promise = byKey.get(key);
  if (!promise) {
    promise = new Promise<Decision | 'timeout'>((resolve) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      const entry: Entry = {
        id, session, origin, client, remote, purpose, created: now, expires: now + APPROVAL_TIMEOUT_MS, resolve,
        timer: setTimeout(() => finish(id, 'timeout'), APPROVAL_TIMEOUT_MS),
      };
      entries.set(id, entry);
      changed();
      chrome.windows
        .create({ url: chrome.runtime.getURL(`approve.html?id=${id}`), type: 'popup', width: 460, height: 460, focused: true })
        .then((w) => {
          if (entries.has(id)) entry.windowId = w?.id;
          else if (w?.id !== undefined) void chrome.windows.remove(w.id).catch(() => {});
        })
        .catch(() => {
          // No window could be opened (e.g. no display); the toolbar popup still lists the request.
        });
    });
    byKey.set(key, promise);
    void promise.finally(() => byKey.delete(key));
  }
  const decision = await promise;
  if (decision === 'timeout') {
    throw new CommandError(
      Code.APPROVAL_TIMEOUT,
      `The user did not answer the request to access ${origin} within ${APPROVAL_TIMEOUT_MS / 1000}s.`,
      'Tell the user you are waiting for them to approve the site in the browser, then retry.',
      true,
    );
  }
  return decision;
}

export function decide(id: string, decision: Decision): boolean {
  const entry = entries.get(id);
  if (!entry) return false;
  finish(id, decision);
  if (decision === 'always') {
    for (const other of [...entries.values()]) if (other.origin === entry.origin) finish(other.id, 'always');
  }
  return true;
}

export function denyAll(): void {
  for (const id of [...entries.keys()]) finish(id, 'deny');
}

/** Drops prompts of an AI client that disconnected. */
export function denySession(session: string): void {
  for (const entry of [...entries.values()]) if (entry.session === session) finish(entry.id, 'deny');
}

function finish(id: string, decision: Decision | 'timeout'): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  clearTimeout(entry.timer);
  if (entry.windowId !== undefined) void chrome.windows.remove(entry.windowId).catch(() => {});
  entry.resolve(decision);
  changed();
}

// Closing the prompt window counts as "deny".
chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of entries.values()) if (entry.windowId === windowId) finish(entry.id, 'deny');
});
