// Assistant settings in chrome.storage.local under "assistant". Only UABC's
// own pages (settings and side panel) read and write them; the service worker
// restricts chrome.storage.local to trusted extension contexts at startup, so
// content scripts running inside web pages cannot read the API keys.

import { baseUrlProblem } from './http';
import { PRESETS } from './providers';
import type { AssistantConfig, ModelInfo, ProviderConfig, ProviderKind } from './types';

const KEY = 'assistant';
const KINDS: ProviderKind[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'compatible'];
export const DEFAULT_MAX_STEPS = 40;

function cleanModels(v: unknown): ModelInfo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is ModelInfo => !!m && typeof (m as ModelInfo).id === 'string' && (m as ModelInfo).id !== '')
    .map((m) => ({
      id: m.id,
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
      ...(typeof m.maxOutput === 'number' ? { maxOutput: m.maxOutput } : {}),
    }));
}

function cleanProvider(v: any): ProviderConfig | null {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !KINDS.includes(v.kind)) return null;
  const preset = PRESETS.find((p) => p.id === v.id);
  if (preset && preset.kind !== v.kind) return null;
  return {
    id: v.id,
    kind: v.kind,
    label: typeof v.label === 'string' && v.label ? v.label : (preset?.label ?? v.id),
    // Built-in providers always use their own address, whatever is stored.
    baseUrl: preset ? preset.baseUrl : typeof v.baseUrl === 'string' ? v.baseUrl : '',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    models: cleanModels(v.models),
    ...(typeof v.modelsFetchedAt === 'number' ? { modelsFetchedAt: v.modelsFetchedAt } : {}),
  };
}

export function normalize(v: any): AssistantConfig {
  const providers = (Array.isArray(v?.providers) ? v.providers : []).map(cleanProvider).filter((p: ProviderConfig | null): p is ProviderConfig => p !== null);
  const sel = v?.selected;
  const steps = Number(v?.maxSteps);
  return {
    providers,
    ...(sel && typeof sel.provider === 'string' && typeof sel.model === 'string' && sel.model ? { selected: { provider: sel.provider, model: sel.model } } : {}),
    maxSteps: Number.isFinite(steps) ? Math.min(200, Math.max(5, Math.round(steps))) : DEFAULT_MAX_STEPS,
    screenshots: v?.screenshots !== false,
  };
}

export async function loadConfig(): Promise<AssistantConfig> {
  return normalize((await chrome.storage.local.get(KEY))[KEY]);
}

export async function saveConfig(config: AssistantConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: normalize(config) });
}

export async function updateConfig(change: (c: AssistantConfig) => void): Promise<AssistantConfig> {
  const config = await loadConfig();
  change(config);
  await saveConfig(config);
  return config;
}

export function onConfigChange(fn: (c: AssistantConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) fn(normalize(changes[KEY]!.newValue));
  });
}

/** A provider the assistant can call: it has a key, or is a keyless local endpoint. */
export function usable(p: ProviderConfig): boolean {
  return !baseUrlProblem(p.baseUrl) && (p.apiKey !== '' || p.kind === 'compatible');
}

export interface Selection {
  provider: ProviderConfig;
  model: string;
  info?: ModelInfo;
}

export function currentSelection(config: AssistantConfig): Selection | null {
  const sel = config.selected;
  const provider = sel && config.providers.find((p) => p.id === sel.provider && usable(p));
  if (!provider || !sel) return null;
  return { provider, model: sel.model, info: provider.models.find((m) => m.id === sel.model) };
}

/** "sk-…abcd": enough to recognise a key, never a meaningful part of it. */
export function maskKey(key: string): string {
  if (!key) return '';
  return key.length < 16 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}
