// Service worker entry: wires the native bridge, the built-in assistant's
// side panel, sessions, command handlers, the kill switch, the toolbar badge
// and the messages from UABC's own pages.

import { ASSISTANT_PORT, type FromWorker, type ToWorker } from '../assistant/backend';
import { type ClientInfo, CommandError, Code, type ErrorBody, type FromHost, toErrorBody } from '../shared/protocol';
import { normalizeGrant } from '../shared/url-policy';
import { decide, denyAll, denySession, getApproval, onApprovalsChange, pendingApprovals, type Decision } from './approvals';
import * as audit from './audit';
import * as cdp from './cdp';
import { handlers } from './commands';
import { NativeBridge } from './native';
import { RemoteBridge, connectorUrl, newDeviceCredentials, relayUrlProblem, remoteSettings, rotateConnector, updateRemote } from './remote';
import { addGrant, pausedError, removeGrant, type Session } from './policy';
import { type InputMode, type SiteMode, onSettingsChange, settings, updateSettings } from './settings';
import { share, sharedTabs, unshare } from './tabs';

// API keys of the built-in assistant live in chrome.storage.local: keep the
// whole area away from content scripts (they never need it). Settings warn if
// this browser cannot.
let storageLocked = false;
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).then(
  () => (storageLocked = true),
  () => {},
);

const sessions = new Map<string, Session>();
const inflight = new Set<string>();
/** A relay could open sessions without end; the oldest remote one goes first. */
const MAX_REMOTE_SESSIONS = 32;
/** "Allow this time" for a remote app ends after this long without a command. */
const REMOTE_IDLE_MS = 10 * 60_000;

/** Drops the sessions of a bridge that went away: "Always" must not be granted on their behalf. */
function bridgeState(via: 'native' | 'remote', state: string): void {
  if (state !== 'connected') for (const s of [...sessions.values()]) if (s.via === via) closeSession(s.id);
  void updateBadge();
}

const bridge = new NativeBridge((m) => onBridgeMessage(m, 'native'), (state) => bridgeState('native', state));
const remote = new RemoteBridge((m) => onBridgeMessage(m, 'remote'), (state) => bridgeState('remote', state));

/**
 * Client names come from the AI client (or the relay): keep them printable and
 * short, and remote ones always say "(remote)", whatever the relay claims.
 */
function clientFrom(raw: unknown, via: Session['via']): ClientInfo {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const name = clean(c.name, 60) || 'unknown client';
  return { name: via === 'remote' ? `${name.replace(/\s*\(remote\)$/i, '')} (remote)` : name, version: clean(c.version, 40) };
}

function openSession(id: string, client: ClientInfo, via: Session['via']): Session {
  if (via === 'remote') {
    const remotes = [...sessions.values()].filter((x) => x.via === 'remote').sort((a, b) => a.opened - b.opened);
    for (const old of remotes.slice(0, Math.max(0, remotes.length - MAX_REMOTE_SESSIONS + 1))) closeSession(old.id);
  }
  const s: Session = { id, client, via, opened: Date.now(), lastActive: Date.now(), grants: new Set() };
  sessions.set(id, s);
  return s;
}

function closeSession(id: string): void {
  sessions.delete(id);
  denySession(id);
}

/** Messages from the native host or the relay; both speak hop C (docs/protocol.md). */
function onBridgeMessage(m: FromHost, via: 'native' | 'remote'): void {
  // Session ids are only unique per bridge.
  const sid = (id: string) => (via === 'remote' ? `remote:${id}` : id);
  switch (m.type) {
    case 'session.open': {
      const s = openSession(sid(m.session), clientFrom(m.client, via), via);
      void audit.record({ t: Date.now(), client: s.client.name, method: 'connect', ok: true });
      void updateBadge();
      break;
    }
    case 'session.close':
      closeSession(sid(m.session));
      void updateBadge();
      break;
    case 'request':
      void handleRequest(m.id, sid(m.session), m.method, m.params ?? {}, via);
      break;
    case 'cancel':
      // Commands are short and idempotent-at-worst; a cancelled request simply
      // has nobody waiting for its answer any more.
      inflight.delete(`${via}:${m.id}`);
      break;
    default:
      break;
  }
}

/** Runs one command for an AI session, whichever way it arrived. Rejects with an ErrorBody. */
async function dispatch(session: Session, method: string, params: Record<string, unknown>): Promise<unknown> {
  // The relay also ends idle remote sessions; this holds even if a relay does not.
  const now = Date.now();
  if (session.via === 'remote' && now - session.lastActive > REMOTE_IDLE_MS) session.grants.clear();
  session.lastActive = now;
  try {
    const st = await settings();
    if (st.paused && method !== 'browser.status') throw pausedError(st.pausedReason);
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new CommandError(Code.UNKNOWN_METHOD, `Unknown method ${method}.`);
    const result = await handler(params, session, sessions);
    if (method !== 'browser.status') void audit.record({ t: Date.now(), client: session.client.name, method, ok: true, detail: audit.summarize(method, params) });
    return result;
  } catch (e) {
    const error = toErrorBody(e);
    void audit.record({ t: Date.now(), client: session.client.name, method, ok: false, code: error.code, detail: audit.summarize(method, params) });
    throw error;
  }
}

async function handleRequest(id: number, sessionId: string, method: string, params: Record<string, unknown>, via: 'native' | 'remote'): Promise<void> {
  const session = sessions.get(sessionId) ?? openSession(sessionId, clientFrom(null, via), via);
  const reply = via === 'remote' ? remote : bridge;
  inflight.add(`${via}:${id}`);
  try {
    reply.send({ type: 'response', id, ok: true, result: await dispatch(session, method, params) });
  } catch (error) {
    reply.send({ type: 'response', id, ok: false, error: error as ErrorBody });
  } finally {
    inflight.delete(`${via}:${id}`);
  }
}

// ----- built-in assistant (side panel) --------------------------------------------

// Each open assistant panel is one AI session, gated exactly like an MCP client.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ASSISTANT_PORT) return;
  // Only UABC's own pages; content scripts run inside web pages.
  const ownPage = port.sender?.id === chrome.runtime.id && (port.sender?.url ?? '').startsWith(chrome.runtime.getURL(''));
  if (!ownPage) {
    port.disconnect();
    return;
  }
  const session = openSession(`assistant-${crypto.randomUUID().slice(0, 8)}`, { name: 'UABC assistant' }, 'assistant');
  const post = (m: FromWorker) => {
    try {
      port.postMessage(m);
    } catch {
      // panel closed meanwhile
    }
  };
  post({ type: 'hello', session: session.id });
  void audit.record({ t: Date.now(), client: session.client.name, method: 'connect', ok: true });
  void updateBadge();
  port.onMessage.addListener((m: ToWorker) => {
    if (m?.type === 'call' && typeof m.id === 'number' && typeof m.method === 'string') {
      const params = m.params && typeof m.params === 'object' ? m.params : {};
      dispatch(session, m.method, params).then(
        (result) => post({ type: 'result', id: m.id, ok: true, result }),
        (error: ErrorBody) => post({ type: 'result', id: m.id, ok: false, error }),
      );
    } else if (m?.type === 'client' && typeof m.name === 'string' && m.name.trim()) {
      session.client = clientFrom({ name: m.name }, 'assistant');
      void updateBadge();
    }
    // 'ping' only keeps this worker alive; 'cancel' needs nothing (commands are short).
  });
  port.onDisconnect.addListener(() => {
    closeSession(session.id);
    void updateBadge();
  });
});

// ----- kill switch -------------------------------------------------------------

async function pause(reason: string): Promise<void> {
  cdp.block(pausedError(reason)); // first, synchronously: in-flight actions stop at their next step
  await updateSettings({ paused: true, pausedReason: reason });
  denyAll();
  await cdp.detachAll();
}

async function resume(): Promise<void> {
  await updateSettings({ paused: false, pausedReason: undefined });
}

// Keep the CDP gate in sync however the flag changes (UI, shortcut, storage).
function syncCdpGate(paused: boolean, reason?: string): void {
  cdp.block(paused ? pausedError(reason) : null);
  if (paused) void cdp.detachAll();
}
onSettingsChange((s) => syncCdpGate(s.paused, s.pausedReason));
void settings().then((s) => syncCdpGate(s.paused, s.pausedReason));

cdp.onUserCancel(() => void pause('debugging was cancelled from the browser banner'));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-pause') void settings().then((s) => (s.paused ? resume() : pause('keyboard shortcut')));
  // Called right away: opening the side panel needs the shortcut's user gesture.
  if (command === 'open-assistant' && tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// ----- badge --------------------------------------------------------------------

async function updateBadge(): Promise<void> {
  const s = await settings();
  let text = '';
  let color = '#5f6368';
  let title = 'UABC: AI browser control';
  // A missing bridge is no error: the built-in assistant works without it.
  if (s.paused) {
    [text, color, title] = ['II', '#e37400', 'UABC: AI control paused'];
  } else if (pendingApprovals().length) {
    [text, color, title] = ['?', '#d93025', 'UABC: an AI client is waiting for your approval'];
  } else if (sessions.size) {
    const names = [...new Set([...sessions.values()].map((x) => x.client.name))].join(', ');
    [text, color, title] = ['ON', '#188038', `UABC: connected to ${names}`];
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

onApprovalsChange(() => void updateBadge());
onSettingsChange(() => void updateBadge());

// ----- messages from UABC's own pages (popup, settings, approval prompt) ------

type UiMessage = { uabcUi: string } & Record<string, unknown>;

async function status() {
  const s = await settings();
  return {
    bridge: { state: bridge.state, error: bridge.lastError, host: bridge.host },
    remote: await remoteStatus(),
    storageLocked,
    extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version },
    settings: { label: s.label, mode: s.mode, inputMode: s.inputMode, paused: s.paused, pausedReason: s.pausedReason, instanceId: s.instanceId },
    grants: s.grants,
    sessions: [...sessions.values()].map((x) => ({ id: x.id, client: x.client, via: x.via, opened: x.opened, currentTab: x.currentTab, grants: [...x.grants] })),
    tabs: (await sharedTabs()).map((t) => ({ id: t.id, title: t.title, url: t.url })),
    approvals: pendingApprovals(),
  };
}

async function remoteStatus() {
  const r = await remoteSettings();
  return {
    enabled: r.enabled,
    relayUrl: r.relayUrl,
    accessCode: r.accessCode,
    state: remote.state,
    error: remote.lastError,
    connectorUrl: r.enabled && r.relayUrl ? connectorUrl(r) : '',
  };
}

async function handleUi(m: UiMessage): Promise<unknown> {
  switch (m.uabcUi) {
    case 'status':
      return status();
    case 'pause':
      return pause('paused by the user');
    case 'resume':
      return resume();
    case 'share':
      return share(m.tabId as number);
    case 'unshare':
      return unshare(m.tabId as number);
    case 'approval.get':
      return getApproval(m.id as string) ?? null;
    case 'approval.decide':
      if (!['deny', 'session', 'always'].includes(m.decision as string)) throw new Error('bad decision');
      return decide(m.id as string, m.decision as Decision);
    case 'grant.add': {
      const origin = normalizeGrant(String(m.origin ?? ''));
      if (!origin) throw new CommandError(Code.INVALID_PARAMS, 'Enter a web address such as example.com or https://*.example.com');
      return addGrant(origin, 'you');
    }
    case 'grant.remove':
      return removeGrant(String(m.origin));
    case 'settings.set': {
      const patch: Parameters<typeof updateSettings>[0] = {};
      if (typeof m.label === 'string') patch.label = m.label.trim().slice(0, 40);
      if (m.mode === 'ask' || m.mode === 'listed' || m.mode === 'all') patch.mode = m.mode as SiteMode;
      if (m.inputMode === 'trusted' || m.inputMode === 'basic') patch.inputMode = m.inputMode as InputMode;
      await updateSettings(patch);
      if (patch.inputMode === 'basic') await cdp.detachAll();
      if (patch.label !== undefined) await bridge.restart();
      return status();
    }
    case 'audit.get':
      return audit.recent(typeof m.limit === 'number' ? m.limit : 50);
    case 'audit.clear':
      return audit.clear();
    case 'reconnect':
      return bridge.restart();
    case 'remote.set': {
      const patch: Parameters<typeof updateRemote>[0] = {};
      if (typeof m.relayUrl === 'string') {
        const url = m.relayUrl.trim().replace(/\/+$/, '');
        const problem = url ? relayUrlProblem(url) : null;
        if (problem) throw new CommandError(Code.INVALID_PARAMS, problem);
        // A device identity is never shown to two relays: one could impersonate it at the other.
        if (url !== (await remoteSettings()).relayUrl) Object.assign(patch, newDeviceCredentials());
        patch.relayUrl = url;
      }
      if (typeof m.accessCode === 'string') patch.accessCode = m.accessCode.trim().slice(0, 200);
      if (typeof m.enabled === 'boolean') patch.enabled = m.enabled;
      await updateRemote(patch);
      await remote.restart();
      return remoteStatus();
    }
    case 'remote.rotate':
      await rotateConnector();
      await remote.restart();
      return remoteStatus();
    default:
      throw new Error(`unknown UI message ${m.uabcUi}`);
  }
}

chrome.runtime.onMessage.addListener((m: UiMessage, sender, sendResponse) => {
  if (typeof m?.uabcUi !== 'string') return false;
  // Only UABC's own extension pages may drive these; content scripts run inside
  // web pages and must never be able to approve sites or resume the agent.
  const ownPage = sender.id === chrome.runtime.id && (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
  if (!ownPage) return false;
  handleUi(m).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: toErrorBody(e) }),
  );
  return true;
});

// ----- lifecycle ------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) void chrome.runtime.openOptionsPage();
});

// The native port keeps this worker alive while connected; the alarm brings it
// back to retry after `uabc install` was run with the browser already open.
chrome.alarms.create('uabc-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'uabc-reconnect') return;
  if (!bridge.connected) void bridge.connect();
  if (remote.state !== 'connected') void remote.connect();
});

void bridge.connect();
void remote.connect();
void updateBadge();
