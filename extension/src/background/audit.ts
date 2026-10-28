// Local audit log of everything agents did (last 500 actions), shown in the
// popup and the settings page. Never leaves the machine.

export interface AuditEntry {
  t: number;
  client: string;
  method: string;
  ok: boolean;
  detail?: string;
  code?: string;
}

const MAX = 500;
let buffer: AuditEntry[] | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<AuditEntry[]> {
  buffer ??= ((await chrome.storage.local.get('audit')).audit as AuditEntry[] | undefined) ?? [];
  return buffer;
}

export async function record(entry: AuditEntry): Promise<void> {
  const log = await load();
  log.push(entry);
  if (log.length > MAX) log.splice(0, log.length - MAX);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void chrome.storage.local.set({ audit: log }), 300);
}

export async function recent(n = 50): Promise<AuditEntry[]> {
  return (await load()).slice(-n).reverse();
}

export async function clear(): Promise<void> {
  buffer = [];
  await chrome.storage.local.set({ audit: [] });
}

/** One-line description of a request, without page content or long text. */
export function summarize(method: string, p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof p.url === 'string') parts.push(p.url.slice(0, 120));
  if (typeof p.history === 'string') parts.push(p.history);
  if (p.ref !== undefined) parts.push(`[${p.ref}]`);
  if (typeof p.selector === 'string') parts.push(p.selector.slice(0, 60));
  if (p.x !== undefined) parts.push(`@${p.x},${p.y}`);
  if (typeof p.text === 'string') parts.push(`"${p.text.slice(0, 40)}${p.text.length > 40 ? '…' : ''}"`);
  if (typeof p.keys === 'string') parts.push(p.keys);
  if (Array.isArray(p.values)) parts.push(p.values.join(', ').slice(0, 60));
  if (typeof p.direction === 'string') parts.push(p.direction);
  if (p.tab_id !== undefined) parts.push(`tab ${p.tab_id}`);
  return parts.join(' ') || method;
}
