// Types of the built-in assistant: provider settings and a provider-neutral
// conversation that each adapter translates to its own wire format.

import type { ToolSpec } from '../shared/tools';

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'compatible';

export interface ModelInfo {
  id: string;
  name?: string;
  /** Accepts images (screenshots). Undefined: unknown, assume yes. */
  vision?: boolean;
  /** Maximum output tokens, when the catalog says. */
  maxOutput?: number;
}

export interface ProviderConfig {
  /** 'openai', 'anthropic', 'gemini', 'openrouter', or 'custom-…' for OpenAI-compatible endpoints. */
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  /** Stored in chrome.storage.local (trusted extension contexts only); sent only to `baseUrl`. */
  apiKey: string;
  /** Cached model catalog plus models the user added by hand. */
  models: ModelInfo[];
  modelsFetchedAt?: number;
}

export interface AssistantConfig {
  providers: ProviderConfig[];
  selected?: { provider: string; model: string };
  /** Model calls per user message before the assistant stops and asks to continue. */
  maxSteps: number;
  /** Offer browser_screenshot and send its images to the model. */
  screenshots: boolean;
}

// ----- provider-neutral conversation ------------------------------------------

export interface ToolCall {
  /** Provider-issued id; generated ids start with "uabc_". */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Set when the model's arguments were not valid JSON (the call is not run). */
  badArgs?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  text: string;
  isError: boolean;
  image?: { mime: string; data: string };
}

/**
 * Assistant turns keep the provider's own content (`raw`) and are replayed
 * byte for byte to that provider: thinking blocks, thought signatures and
 * tool-call ids must come back unchanged, and an unchanged prefix keeps
 * prompt caches warm. Another provider gets the neutral text and calls.
 */
export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[]; raw: { kind: ProviderKind; content: unknown } }
  | { role: 'tool'; results: ToolResult[] };

export interface CompletionRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: ChatMessage[];
  maxOutput?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface Completion {
  text: string;
  calls: ToolCall[];
  raw: { kind: ProviderKind; content: unknown };
  /** False when the reply has nothing worth replaying (no text, no calls, no blocks). */
  hasContent: boolean;
  stop: StopReason;
  /** Why the provider declined or stopped early, in its own words. */
  detail?: string;
  /** When set, the reply was unusable; send this to the model once and let it try again. */
  retry?: string;
  usage?: { input?: number; output?: number; cached?: number };
  /** The model that actually answered (differs after a server-side fallback). */
  model?: string;
}

export interface Provider {
  complete(cfg: ProviderConfig, req: CompletionRequest): Promise<Completion>;
  listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>;
}

/** Ids for tool calls that arrive without one. */
export function newCallId(): string {
  return `uabc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}
