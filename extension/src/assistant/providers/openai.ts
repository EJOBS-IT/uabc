// OpenAI Chat Completions with function tools: OpenAI itself, OpenRouter and
// any OpenAI-compatible server (Ollama, LM Studio, vLLM, DeepSeek, Groq …).

import type { ToolSpec } from '../../shared/tools';
import { ProviderError, joinUrl, requestJson } from '../http';
import {
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  type ModelInfo,
  type Provider,
  type ProviderConfig,
  type ProviderKind,
  type StopReason,
  type ToolCall,
  newCallId,
} from '../types';

const FAMILY: ProviderKind[] = ['openai', 'openrouter', 'compatible'];

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.kind === 'openrouter') {
    // App attribution, see openrouter.ai/docs/app-attribution.
    h['http-referer'] = 'https://github.com/EJOBS-IT/uabc';
    h['x-title'] = 'UABC';
  }
  return h;
}

export function toolDefs(tools: ToolSpec[]) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Replays our own earlier turns verbatim; turns from another provider are rebuilt. */
function assistantMessage(m: Extract<ChatMessage, { role: 'assistant' }>, kind: ProviderKind): Record<string, unknown> {
  if (FAMILY.includes(m.raw.kind) && m.raw.content && typeof m.raw.content === 'object') {
    const raw = m.raw.content as Record<string, unknown>;
    const out: Record<string, unknown> = { role: 'assistant', content: raw.content ?? null };
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length) out.tool_calls = raw.tool_calls;
    if (kind === 'openrouter' && m.raw.kind === 'openrouter' && raw.reasoning_details) out.reasoning_details = raw.reasoning_details;
    return out;
  }
  const out: Record<string, unknown> = { role: 'assistant', content: m.text || null };
  if (m.calls.length) {
    out.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  }
  return out;
}

export function toMessages(req: CompletionRequest, kind: ProviderKind): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') out.push(assistantMessage(m, kind));
    else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.text });
      // Tool messages carry text only; screenshots follow as a user message.
      const images = m.results.filter((r) => r.image);
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: `Screenshot${images.length > 1 ? 's' : ''} returned by ${images.map((r) => r.name).join(', ')} above.` },
            ...images.map((r) => ({ type: 'image_url', image_url: { url: `data:${r.image!.mime};base64,${r.image!.data}` } })),
          ],
        });
      }
    }
  }
  return out;
}

function parseArgs(raw: unknown): Pick<ToolCall, 'args' | 'badArgs'> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { args: {} };
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v };
    } catch {
      // fall through
    }
  }
  return { args: {}, badArgs: String(raw).slice(0, 300) };
}

export function parseCompletion(json: any, kind: ProviderKind): Completion {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '';
  // Fill in missing ids so the replayed message and the tool results agree.
  const rawCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c: any) => c?.function?.name) : [];
  const toolCalls = rawCalls.map((c) => ({ ...c, id: typeof c.id === 'string' && c.id ? c.id : newCallId(), type: 'function' }));
  const calls: ToolCall[] = toolCalls.map((c) => ({ id: c.id, name: String(c.function.name), ...parseArgs(c.function.arguments) }));
  const finish = String(choice?.finish_reason ?? '');
  const stop: StopReason =
    finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : calls.length ? 'tool_use' : finish === 'stop' || !finish ? 'end' : 'other';
  const content: Record<string, unknown> = { content: typeof msg.content === 'string' || msg.content === null ? msg.content : text || null };
  if (toolCalls.length) content.tool_calls = toolCalls;
  if (msg.reasoning_details) content.reasoning_details = msg.reasoning_details;
  return {
    text,
    calls,
    raw: { kind, content },
    hasContent: Boolean(text || calls.length),
    stop,
    detail: stop === 'refusal' ? 'The provider filtered the response (content_filter).' : stop === 'other' ? `finish_reason: ${finish}` : undefined,
    usage: json?.usage
      ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens, cached: json.usage.prompt_tokens_details?.cached_tokens }
      : undefined,
    model: typeof json?.model === 'string' ? json.model : undefined,
  };
}

const NOT_CHAT = /embed|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|sora|computer-use/i;

export function parseModels(json: any, kind: ProviderKind): ModelInfo[] {
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  const models: Array<ModelInfo & { created: number }> = [];
  for (const m of list) {
    const id = typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : '';
    if (!id) continue;
    if (kind === 'openrouter') {
      // Only models that can call tools are any use to the assistant.
      if (Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')) continue;
      const input: unknown = m.architecture?.input_modalities;
      models.push({
        id,
        name: typeof m.name === 'string' ? m.name : undefined,
        vision: Array.isArray(input) ? input.includes('image') : undefined,
        maxOutput: typeof m.top_provider?.max_completion_tokens === 'number' ? m.top_provider.max_completion_tokens : undefined,
        created: 0, // keep OpenRouter's own order (newest first)
      });
    } else {
      if (kind === 'openai' && NOT_CHAT.test(id)) continue;
      models.push({ id, created: typeof m.created === 'number' ? m.created : 0 });
    }
  }
  if (kind !== 'openrouter') models.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  return models.map(({ created: _created, ...m }) => m);
}

export const openaiProvider: Provider = {
  async complete(cfg, req) {
    const body: Record<string, unknown> = { model: req.model, messages: toMessages(req, cfg.kind) };
    if (req.tools.length) body.tools = toolDefs(req.tools);
    const json = await requestJson(joinUrl(cfg.baseUrl, 'chat/completions'), { headers: headers(cfg), body, signal: req.signal, secret: cfg.apiKey });
    // OpenRouter reports some upstream failures as HTTP 200 with an error body.
    if (json?.error) throw new ProviderError(String(json.error?.message ?? json.error));
    return parseCompletion(json, cfg.kind);
  },

  async listModels(cfg, signal) {
    const json = await requestJson(joinUrl(cfg.baseUrl, 'models'), { headers: headers(cfg), signal, secret: cfg.apiKey, timeoutMs: 30_000, retries: 1 });
    return parseModels(json, cfg.kind);
  },
};
