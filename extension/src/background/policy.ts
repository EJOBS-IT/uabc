// The gate every page access goes through (ADR-0004). Runs in the extension,
// the one component the user controls, never in the host or the AI client.

import { CommandError, Code, type ClientInfo } from '../shared/protocol';
import { classifyUrl, grantMatches } from '../shared/url-policy';
import { requestApproval } from './approvals';
import { settings, updateSettings } from './settings';

export interface Session {
  id: string;
  client: ClientInfo;
  /** How the AI client reaches the browser: the native bridge (local MCP), a relay (remote MCP) or the side panel. */
  via: 'native' | 'remote' | 'assistant';
  opened: number;
  /** Last command; remote sessions' "allow this time" grants lapse when idle. */
  lastActive: number;
  currentTab?: number;
  /** "Allow this time" grants: valid until this AI client disconnects. */
  grants: Set<string>;
}

export function pausedError(reason?: string): CommandError {
  return new CommandError(
    Code.PAUSED,
    `The user has paused AI control of the browser${reason ? ` (${reason})` : ''}.`,
    'Tell the user; they can resume it from the UABC toolbar button or with Alt+Shift+K.',
  );
}

export async function isAllowed(session: Session, url: string | undefined): Promise<boolean> {
  const v = classifyUrl(url);
  if (v.kind === 'blank') return true;
  if (v.kind === 'blocked') return false;
  const s = await settings();
  return s.mode === 'all' || session.grants.has(v.origin) || s.grants.some((g) => grantMatches(g.origin, v.origin));
}

/**
 * Resolves when `session` may read and act on `url`; asks the user if needed.
 * Returns the origin, or 'blank' for about:blank-like pages.
 */
export async function ensureSiteAccess(session: Session, url: string | undefined, purpose: string): Promise<string> {
  const v = classifyUrl(url);
  if (v.kind === 'blank') return 'blank';
  if (v.kind === 'blocked') {
    throw new CommandError(Code.BLOCKED_URL, `UABC cannot open or read this page: ${v.reason}.`, 'Use a regular http(s) web address.', true);
  }
  const s = await settings();
  if (s.paused) throw pausedError(s.pausedReason);
  if (await isAllowed(session, url)) return v.origin;
  if (s.mode === 'listed') {
    throw new CommandError(
      Code.PERMISSION_DENIED,
      `${v.origin} is not on the user's list of approved sites.`,
      'Ask the user to add it under "Approved sites" in UABC settings.',
      true,
    );
  }
  const decision = await requestApproval(session.id, v.origin, session.client.name, purpose, session.via === 'remote');
  if ((await settings()).paused) throw pausedError();
  if (decision === 'deny') {
    throw new CommandError(Code.PERMISSION_DENIED, `The user declined access to ${v.origin}.`, 'Do not retry; ask the user how they want to proceed.', true);
  }
  if (decision === 'always') await addGrant(v.origin, session.client.name);
  else session.grants.add(v.origin);
  return v.origin;
}

/** Scheme and host only, e.g. for listing a tab whose site is not approved yet. */
export function originOnly(url: string): string {
  try {
    const u = new URL(url);
    return u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

// Grant changes are read-modify-write on storage: run them one at a time so a
// removal can never be undone by a concurrent addition.
let grantQueue: Promise<unknown> = Promise.resolve();
function serially(fn: () => Promise<void>): Promise<void> {
  const run = grantQueue.then(fn, fn);
  grantQueue = run.catch(() => {});
  return run;
}

export function addGrant(origin: string, by?: string): Promise<void> {
  return serially(async () => {
    const s = await settings();
    if (s.grants.some((g) => g.origin === origin)) return;
    await updateSettings({ grants: [...s.grants, { origin, added: Date.now(), by }] });
  });
}

export function removeGrant(origin: string): Promise<void> {
  return serially(async () => {
    const s = await settings();
    await updateSettings({ grants: s.grants.filter((g) => g.origin !== origin) });
  });
}
