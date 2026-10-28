// Google Gemini API, generateContent, with a Google AI Studio key.
//
// The model's content is replayed unchanged: Gemini 3 signs its function calls
// (`thoughtSignature`) and rejects a turn whose signatures are missing.
// Gemini 3 and later take screenshots inside the function response
// (`functionResponse.parts`); older models get them as a separate part.

import type { ToolSpec } from '../../shared/tools';
import { joinUrl, requestJson } from '../http';
import { type ChatMessage, type Completion, type CompletionRequest, type ModelInfo, type Provider, type ProviderConfig, type StopReason, type ToolCall, newCallId } from '../types';

const REFUSALS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'LANGUAGE']);
const BAD_CALL = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']);

function headers(cfg: ProviderConfig): Record<string, string> {
  return { 'x-goog-api-key': cfg.apiKey };
}

const bareModel = (model: string) => model.replace(/^models\//, '');

/** Gemini 3+ accepts images inside function responses. Unknown names (aliases) are assumed current. */
export function imagesInsideResponses(model: string): boolean {
  const m = /gemini-(\d+)/i.exec(model);
  return !m || Number(m[1]) >= 3;
}

export function toolDefs(tools: ToolSpec[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Plain JSON Schema; left out for tools without parameters, as the API asks.
        ...(Object.keys(t.parameters.properties ?? {}).length ? { parametersJsonSchema: t.parameters } : {}),
      })),
    },
  ];
}

const generated = (id: string) => id.startsWith('uabc_');

function modelContent(m: Extract<ChatMessage, { role: 'assistant' }>): { role: 'model'; parts: unknown[] } | null {
  const raw = m.raw.content as { parts?: unknown[] } | null;
  if (m.raw.kind === 'gemini' && Array.isArray(raw?.parts) && raw.parts.length) return { role: 'model', parts: raw.parts };
  const parts: unknown[] = [];
  if (m.text) parts.push({ text: m.text });
  for (const c of m.calls) parts.push({ functionCall: { ...(generated(c.id) ? {} : { id: c.id }), name: c.name, args: c.args } });
  return parts.length ? { role: 'model', parts } : null;
}

export function toContents(messages: ChatMessage[], model: string): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
  const inside = imagesInsideResponses(model);
  const out: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', parts: [{ text: m.text }] });
    else if (m.role === 'assistant') {
      const c = modelContent(m);
      if (c) out.push(c);
    } else {
      // Responses go back in the order of the calls, in one user turn.
      const parts: unknown[] = m.results.map((r) => ({
        functionResponse: {
          ...(generated(r.callId) ? {} : { id: r.callId }),
          name: r.name,
          response: r.isError ? { error: r.text } : { output: r.text },
          ...(r.image && inside ? { parts: [{ inlineData: { mimeType: r.image.mime, data: r.image.data } }] } : {}),
        },
      }));
      if (!inside) for (const r of m.results) if (r.image) parts.push({ inlineData: { mimeType: r.image.mime, data: r.image.data } });
      out.push({ role: 'user', parts });
    }
  }
  return out;
}

export function buildRequest(req: CompletionRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toContents(req.messages, req.model),
    ...(req.tools.length ? { tools: toolDefs(req.tools) } : {}),
  };
}

export function parseResponse(json: any): Completion {
  const cand = json?.candidates?.[0];
  const u = json?.usageMetadata;
  const usage = u ? { input: u.promptTokenCount, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cached: u.cachedContentTokenCount } : undefined;
  const model = typeof json?.modelVersion === 'string' ? json.modelVersion : undefined;
  if (!cand) {
    const blocked = json?.promptFeedback?.blockReason;
    return {
      text: '',
      calls: [],
      raw: { kind: 'gemini', content: null },
      hasContent: false,
      stop: blocked ? 'refusal' : 'other',
      detail: blocked ? `blocked: ${blocked}` : 'the response had no candidates',
      usage,
      model,
    };
  }
  const parts: any[] = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  const text = parts
    .filter((p) => typeof p?.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('');
  const calls: ToolCall[] = parts
    .filter((p) => typeof p?.functionCall?.name === 'string')
    .map((p) => ({
      id: typeof p.functionCall.id === 'string' && p.functionCall.id ? p.functionCall.id : newCallId(),
      name: p.functionCall.name,
      args: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {},
    }));
  const finish = String(cand.finishReason ?? '');
  const stop: StopReason = REFUSALS.has(finish)
    ? 'refusal'
    : finish === 'MAX_TOKENS'
      ? 'max_tokens'
      : calls.length
        ? 'tool_use'
        : BAD_CALL.has(finish) || (!text && finish !== 'STOP')
          ? 'other'
          : 'end';
  return {
    text,
    calls,
    raw: { kind: 'gemini', content: { role: 'model', parts } },
    hasContent: stop !== 'refusal' && parts.length > 0,
    stop,
    detail: stop === 'refusal' || stop === 'other' ? `finishReason: ${finish || 'none'}${cand.finishMessage ? ` (${cand.finishMessage})` : ''}` : undefined,
    retry: BAD_CALL.has(finish) && !calls.length ? 'Your last tool call could not be used (it was malformed or not one of the declared tools). Call one of the declared tools again with valid arguments, or answer in text.' : undefined,
    usage,
    model,
  };
}

const NOT_CHAT = /embedding|aqa|imagen|veo|tts|image|native-audio|live|robotics/i;

export function parseModels(json: any): ModelInfo[] {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m: any) => typeof m?.name === 'string' && (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
    .filter((m: any) => !NOT_CHAT.test(m.name))
    .map((m: any) => ({
      id: bareModel(m.name),
      name: typeof m.displayName === 'string' ? m.displayName : undefined,
      vision: true,
      maxOutput: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : undefined,
    }));
}

export const geminiProvider: Provider = {
  async complete(cfg, req) {
    const url = joinUrl(cfg.baseUrl, `models/${encodeURIComponent(bareModel(req.model))}:generateContent`);
    const json = await requestJson(url, { headers: headers(cfg), body: buildRequest(req), signal: req.signal, secret: cfg.apiKey });
    return parseResponse(json);
  },

  async listModels(cfg, signal) {
    const models: ModelInfo[] = [];
    let token = '';
    for (let page = 0; page < 5; page++) {
      const query = `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const json = await requestJson(joinUrl(cfg.baseUrl, query), { headers: headers(cfg), signal, secret: cfg.apiKey, timeoutMs: 30_000, retries: 1 });
      models.push(...parseModels(json));
      if (typeof json?.nextPageToken !== 'string' || !json.nextPageToken) break;
      token = json.nextPageToken;
    }
    return models;
  },
};
