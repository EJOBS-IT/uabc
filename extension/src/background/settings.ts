// Persistent user settings (chrome.storage.local). The service worker is the
// only writer; UI pages change settings by messaging the service worker.

export type SiteMode = 'ask' | 'listed' | 'all';
export type InputMode = 'trusted' | 'basic';

export interface Grant {
  origin: string;
  added: number;
  by?: string;
}

export interface Settings {
  instanceId: string;
  label: string;
  mode: SiteMode;
  inputMode: InputMode;
  paused: boolean;
  pausedReason?: string;
  grants: Grant[];
}

const KEYS = ['instanceId', 'label', 'mode', 'inputMode', 'paused', 'pausedReason', 'grants'] as const;
let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

function newInstanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

let loading: Promise<Settings> | null = null;

/** Memoizes the load itself: concurrent first calls must not mint two instance ids. */
export function settings(): Promise<Settings> {
  loading ??= load();
  return loading;
}

async function load(): Promise<Settings> {
  const stored = (await chrome.storage.local.get([...KEYS])) as Partial<Settings>;
  const s: Settings = {
    instanceId: stored.instanceId ?? newInstanceId(),
    label: stored.label ?? '',
    mode: stored.mode ?? 'ask',
    inputMode: stored.inputMode ?? 'trusted',
    paused: stored.paused ?? false,
    pausedReason: stored.pausedReason,
    grants: stored.grants ?? [],
  };
  if (!stored.instanceId) await chrome.storage.local.set({ instanceId: s.instanceId });
  cache = s;
  return s;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const s = await settings();
  Object.assign(s, patch);
  await chrome.storage.local.set(patch);
  for (const l of listeners) l(s);
  return s;
}

export function onSettingsChange(fn: (s: Settings) => void): void {
  listeners.add(fn);
}

// Keep the cache honest if storage is changed elsewhere (devtools, tests, sync).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !cache) return;
  let touched = false;
  for (const key of KEYS) {
    if (key in changes) {
      (cache as unknown as Record<string, unknown>)[key] = changes[key]!.newValue;
      touched = true;
    }
  }
  if (touched) for (const l of listeners) l(cache);
});
