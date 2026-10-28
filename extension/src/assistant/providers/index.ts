// Provider registry and the presets offered in settings.

import type { Provider, ProviderKind } from '../types';
import { anthropicProvider } from './anthropic';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';

export function providerFor(kind: ProviderKind): Provider {
  switch (kind) {
    case 'anthropic':
      return anthropicProvider;
    case 'gemini':
      return geminiProvider;
    default:
      return openaiProvider;
  }
}

export interface Preset {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  keyUrl: string;
  /** Pre-selected after the first catalog load, when the catalog has it. */
  suggested?: string;
}

/** Built-in providers. Their addresses are fixed so a key can only ever go to its own provider. */
export const PRESETS: Preset[] = [
  { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    suggested: 'claude-opus-5-5',
  },
  {
    id: 'gemini',
    kind: 'gemini',
    label: 'Google Gemini (AI Studio key)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter (hundreds of models)', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys' },
];

/** Starting points for "OpenAI-compatible endpoint"; the user can edit the address. */
export const COMPATIBLE_PRESETS: Array<{ label: string; baseUrl: string; needsKey: boolean }> = [
  { label: 'Ollama (this computer)', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  { label: 'LM Studio (this computer)', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', needsKey: true },
];
