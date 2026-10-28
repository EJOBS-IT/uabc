// Anthropic Messages API (https://api.anthropic.com/v1/messages).
//
// - Assistant turns are replayed exactly as returned: thinking blocks must come
//   back unchanged, and an untouched prefix keeps the prompt cache warm.
// - Top-level `cache_control` caches the conversation up to its last block on
//   every step of the agent loop.
// - Models with server-side refusal fallbacks get `fallbacks: "default"`.

import type { ToolSpec } from '../../shared/tools';
import { joinUrl, requestJson } from '../http';
import type { ChatMessage, Completion, CompletionRequest, ModelInfo, Provider, ProviderConfig, StopReason, ToolCall } from '../types';

export const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models that accept `fallbacks: "default"` (Claude Haiku 5.5, for one, has no fallback). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
/** Non-streaming requests stay at this size so responses arrive well within HTTP timeouts. */
const MAX_TOKENS = 16_000;

function headers(cfg: ProviderConfig, beta?: string): Record<string, string> {
  return {
    'x-api-key': cfg.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // The extension calls the API from its own pages; Anthropic requires this opt-in for browser origins.
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(beta ? { 'anthropic-beta': beta } : {}),
  };
}

/** tool_use ids must match ^[a-zA-Z0-9_-]+$; ids from other providers may not. */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'call';

export function toolDefs(tools: ToolSpec[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

function assistantContent(m: Extract<ChatMessage, { role: 'assistant' }>): unknown[] {
  if (m.raw.kind === 'anthropic' && Array.isArray(m.raw.content)) return m.raw.content;
  const content: unknown[] = [];
  if (m.text) content.push({ type: 'text', text: m.text });
  for (const c of m.calls) content.push({ type: 'tool_use', id: safeId(c.id), name: c.name, input: c.args });
  return content;
}

export function toMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.text }] });
    } else if (m.role === 'assistant') {
      const content = assistantContent(m);
      if (content.length) out.push({ role: 'assistant', content });
    } else {
      // All results of one step go back in a single user message.
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: safeId(r.callId),
          content: [
            { type: 'text', text: r.text || '(no output)' },
            ...(r.image ? [{ type: 'image', source: { type: 'base64', media_type: r.image.mime, data: r.image.data } }] : []),
          ],
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

export function buildRequest(req: CompletionRequest): { body: Record<string, unknown>; beta?: string } {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: Math.min(MAX_TOKENS, req.maxOutput ?? MAX_TOKENS),
    system: req.system,
    messages: toMessages(req.messages),
    cache_control: { type: 'ephemeral' },
  };
  if (req.tools.length) body.tools = toolDefs(req.tools);
  if (!FALLBACK_MODELS.has(req.model)) return { body };
  body.fallbacks = 'default';
  return { body, beta: FALLBACK_BETA };
}

export function parseResponse(json: any): Completion {
  let blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  // After a server-side fallback only text survives from before the last
  // switch point; the declined model's thinking and tool calls are dropped.
  const boundary = blocks.map((b) => b?.type).lastIndexOf('fallback');
  if (boundary >= 0) blocks = [...blocks.slice(0, boundary).filter((b) => b?.type === 'text'), ...blocks.slice(boundary + 1)];

  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n');
  const calls: ToolCall[] = blocks
    .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => ({ id: String(b.id), name: b.name, args: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {} }));
  const reason = String(json?.stop_reason ?? '');
  const stop: StopReason =
    reason === 'refusal'
      ? 'refusal'
      : reason === 'max_tokens'
        ? 'max_tokens'
        : calls.length
          ? 'tool_use'
          : reason === 'end_turn' || reason === 'stop_sequence'
            ? 'end'
            : 'other';
  const sd = json?.stop_details;
  const detail =
    stop === 'refusal'
      ? [sd?.category ? `category: ${sd.category}` : '', typeof sd?.explanation === 'string' ? sd.explanation : ''].filter(Boolean).join(' · ') || undefined
      : stop === 'other'
        ? `stop_reason: ${reason || 'none'}`
        : undefined;
  const u = json?.usage;
  return {
    text,
    calls,
    raw: { kind: 'anthropic', content: blocks },
    hasContent: stop !== 'refusal' && blocks.length > 0,
    stop,
    detail,
    usage: u ? { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens, cached: u.cache_read_input_tokens } : undefined,
    model: typeof json?.model === 'string' ? json.model : undefined,
  };
}

export function parseModels(json: any): ModelInfo[] {
  return (Array.isArray(json?.data) ? json.data : [])
    .filter((m: any) => typeof m?.id === 'string')
    .map((m: any) => ({
      id: m.id,
      name: typeof m.display_name === 'string' ? m.display_name : undefined,
      vision: typeof m.capabilities?.image_input?.supported === 'boolean' ? m.capabilities.image_input.supported : undefined,
      maxOutput: typeof m.max_tokens === 'number' ? m.max_tokens : undefined,
    }));
}

export const anthropicProvider: Provider = {
  async complete(cfg, req) {
    const { body, beta } = buildRequest(req);
    const json = await requestJson(joinUrl(cfg.baseUrl, 'messages'), { headers: headers(cfg, beta), body, signal: req.signal, secret: cfg.apiKey });
    return parseResponse(json);
  },

  async listModels(cfg, signal) {
    const models: ModelInfo[] = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const query = `models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      const json = await requestJson(joinUrl(cfg.baseUrl, query), { headers: headers(cfg), signal, secret: cfg.apiKey, timeoutMs: 30_000, retries: 1 });
      models.push(...parseModels(json));
      if (!json?.has_more || typeof json.last_id !== 'string') break;
      after = json.last_id;
    }
    return models;
  },
};
