// Helpers for UABC's extension pages. Anything that may come from a web page
// (titles, URLs, client names) is rendered with textContent, never innerHTML.

export async function ui<T = unknown>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ uabcUi: op, ...extra });
  if (!reply?.ok) throw new Error(reply?.error?.message ?? 'The UABC service worker did not answer.');
  return reply.result as T;
}

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | ((e: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (typeof v === 'string') el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(t).toLocaleTimeString();
}

export interface Status {
  bridge: { state: string; error: string; host?: { version: string; pid: number; endpoint?: string } };
  remote: { enabled: boolean; relayUrl: string; accessCode: string; state: string; error: string; connectorUrl: string };
  /** Content scripts cannot read extension storage (where API keys are kept). */
  storageLocked: boolean;
  extension: { id: string; version: string };
  settings: { label: string; mode: string; inputMode: string; paused: boolean; pausedReason?: string; instanceId: string };
  grants: Array<{ origin: string; added: number; by?: string }>;
  sessions: Array<{ id: string; client: { name: string; version?: string }; via: 'native' | 'remote' | 'assistant'; opened: number; currentTab?: number; grants: string[] }>;
  tabs: Array<{ id: number; title?: string; url?: string }>;
  approvals: Array<{ id: string; session: string; origin: string; client: string; remote: boolean; purpose: string; expires: number }>;
}

export interface AuditEntry {
  t: number;
  client: string;
  method: string;
  ok: boolean;
  detail?: string;
  code?: string;
}

export const METHOD_LABELS: Record<string, string> = {
  connect: 'connected',
  'tabs.open': 'opened tab',
  'tabs.select': 'selected tab',
  'tabs.close': 'closed tab',
  'tabs.list': 'listed tabs',
  'page.navigate': 'navigated',
  'page.snapshot': 'read page',
  'page.screenshot': 'screenshot',
  'input.click': 'clicked',
  'input.type': 'typed',
  'input.key': 'pressed',
  'input.select': 'selected',
  'page.scroll': 'scrolled',
  'page.wait_for': 'waited',
};
