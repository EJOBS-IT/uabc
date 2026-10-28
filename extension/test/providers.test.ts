import { afterEach, describe, expect, it, vi } from 'vitest';
import * as anthropic from '../src/assistant/providers/anthropic';
import * as gemini from '../src/assistant/providers/gemini';
import * as openai from '../src/assistant/providers/openai';
import type { ChatMessage, CompletionRequest, ProviderConfig } from '../src/assistant/types';
import { TOOLS } from '../src/shared/tools';

const KEY = 'sk-test-0123456789abcdef';
const cfg = (kind: ProviderConfig['kind'], baseUrl: string): ProviderConfig => ({ id: kind, kind, label: kind, baseUrl, apiKey: KEY, models: [] });

/** Replays `responses` in order and records each request. */
function mockFetch(...responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift() ?? { status: 500, body: { error: { message: 'no more responses' } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  });
  vi.stubGlobal('fetch', fn);
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

// A conversation that touched every message kind: a user turn, an OpenAI
// assistant turn with a tool call, and a tool result with a screenshot.
const openaiTurn: ChatMessage = {
  role: 'assistant',
  text: '',
  calls: [{ id: 'call:1', name: 'browser_screenshot', args: { marks: true } }],
  raw: { kind: 'openai', content: { content: null, tool_calls: [{ id: 'call:1', type: 'function', function: { name: 'browser_screenshot', arguments: '{"marks": true}' } }] } },
};
const history: ChatMessage[] = [
  { role: 'user', text: 'Look at the page' },
  openaiTurn,
  { role: 'tool', results: [{ callId: 'call:1', name: 'browser_screenshot', text: 'Screenshot of tab 3.', isError: false, image: { mime: 'image/jpeg', data: 'QUJD' } }] },
];
const request = (model: string, messages = history): CompletionRequest => ({ model, system: 'SYS', tools: TOOLS, messages });

describe('OpenAI-compatible adapter', () => {
  it('replays its own turns verbatim and sends screenshots as a user image', () => {
    const msgs = openai.toMessages(request('m'), 'openai');
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call:1', type: 'function', function: { name: 'browser_screenshot', arguments: '{"marks": true}' } }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call:1', content: 'Screenshot of tab 3.' });
    expect(msgs[4]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] });
  });

  it('parses tool calls, tolerating missing ids, object arguments and bad JSON', () => {
    const c = openai.parseCompletion(
      {
        model: 'gpt-x',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'browser_tabs', arguments: '{"action":"new","url":"https://x.example"}' } },
              { type: 'function', function: { name: 'browser_get_state', arguments: { mode: 'full' } } },
              { id: 'c', type: 'function', function: { name: 'browser_click', arguments: '{"ref": 3' } },
              { id: 'd', type: 'function', function: { name: 'browser_status', arguments: '' } },
            ],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 64 } },
      },
      'compatible',
    );
    expect(c.stop).toBe('tool_use');
    expect(c.calls[0]).toEqual({ id: 'a', name: 'browser_tabs', args: { action: 'new', url: 'https://x.example' } });
    expect(c.calls[1]!.id).toMatch(/^uabc_/);
    expect(c.calls[1]!.args).toEqual({ mode: 'full' });
    expect(c.calls[2]!.badArgs).toBe('{"ref": 3');
    expect(c.calls[3]!.args).toEqual({});
    // the replayed message carries the generated id, so tool results match it
    expect((c.raw.content as any).tool_calls[1].id).toBe(c.calls[1]!.id);
    expect(c.usage).toEqual({ input: 100, output: 7, cached: 64 });
  });

  it('maps finish reasons', () => {
    const reply = (finish: string) => openai.parseCompletion({ choices: [{ finish_reason: finish, message: { content: 'x' } }] }, 'openai').stop;
    expect(reply('stop')).toBe('end');
    expect(reply('length')).toBe('max_tokens');
    expect(reply('content_filter')).toBe('refusal');
  });

  it('lists tool-capable OpenRouter models and chat models from OpenAI', () => {
    const or = openai.parseModels({
      data: [
        { id: 'a/vision', name: 'A', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] }, top_provider: { max_completion_tokens: 8000 } },
        { id: 'b/no-tools', supported_parameters: ['temperature'] },
        { id: 'c/text', supported_parameters: ['tools', 'tool_choice'], architecture: { input_modalities: ['text'] } },
      ],
    }, 'openrouter');
    expect(or).toEqual([{ id: 'a/vision', name: 'A', vision: true, maxOutput: 8000 }, { id: 'c/text', vision: false }]);
    const oa = openai.parseModels({ data: [{ id: 'old-chat', created: 1 }, { id: 'text-embedding-3', created: 9 }, { id: 'new-chat', created: 5 }, { id: 'whisper-1', created: 3 }] }, 'openai');
    expect(oa.map((m) => m.id)).toEqual(['new-chat', 'old-chat']);
  });

  it('posts to <base>/chat/completions with the key, no cookies, and OpenRouter attribution', async () => {
    const requests = mockFetch({ body: { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] } });
    const c = await openai.openaiProvider.complete(cfg('openrouter', 'https://openrouter.ai/api/v1/'), request('x/y', [{ role: 'user', text: 'hi' }]));
    expect(c.text).toBe('hi');
    expect(requests[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['x-title']).toBe('UABC');
    expect(requests[0]!.init.credentials).toBe('omit');
    expect(requests[0]!.body.tools).toHaveLength(11);
    expect(requests[0]!.body.tools[0]).toMatchObject({ type: 'function', function: { name: 'browser_status' } });
  });

  it('a local server needs no key', async () => {
    const requests = mockFetch({ body: { choices: [{ message: { content: 'ok' } }] } });
    await openai.openaiProvider.complete({ ...cfg('compatible', 'http://localhost:11434/v1'), apiKey: '' }, request('llama', [{ role: 'user', text: 'hi' }]));
    expect(requests[0]!.init.headers).not.toHaveProperty('authorization');
  });

  it('turns HTTP errors into actionable messages without leaking the key', async () => {
    mockFetch({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } });
    await expect(openai.openaiProvider.complete(cfg('openai', 'https://api.openai.com/v1'), request('m'))).rejects.toThrow(
      /api\.openai\.com rejected the API key \(HTTP 401\): Incorrect API key provided: ••••\. Check the key/,
    );
  });

  it('retries rate limits, honouring retry-after', async () => {
    const requests = mockFetch({ status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } }, { body: { choices: [{ message: { content: 'ok' } }] } });
    const c = await openai.openaiProvider.complete(cfg('openai', 'https://api.openai.com/v1'), request('m', [{ role: 'user', text: 'x' }]));
    expect(c.text).toBe('ok');
    expect(requests).toHaveLength(2);
  });

  it('does not follow redirects (the key would go along)', async () => {
    const requests = mockFetch({ status: 307, body: {}, headers: { location: 'https://elsewhere.example/v1/chat/completions' } });
    await expect(openai.openaiProvider.complete(cfg('openai', 'https://api.openai.com/v1'), request('m'))).rejects.toThrow(/redirected the request/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.redirect).toBe('manual');
  });

  it('refuses plain http to remote hosts before sending anything', async () => {
    const requests = mockFetch({ body: {} });
    await expect(openai.openaiProvider.complete(cfg('compatible', 'http://api.example.com/v1'), request('m'))).rejects.toThrow(/Use https/);
    expect(requests).toHaveLength(0);
  });
});

describe('Anthropic adapter', () => {
  it('builds a cached request with tools, and opts into fallbacks where available', () => {
    const { body, beta } = anthropic.buildRequest({ ...request('claude-opus-5-5'), maxOutput: 8192 });
    expect(beta).toBe('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 8192, system: 'SYS', cache_control: { type: 'ephemeral' }, fallbacks: 'default' });
    expect((body.tools as any[])[0]).toEqual({ name: 'browser_status', description: TOOLS[0]!.description, input_schema: TOOLS[0]!.parameters });
    const haiku = anthropic.buildRequest(request('claude-haiku-5-5'));
    expect(haiku.beta).toBeUndefined();
    expect(haiku.body).not.toHaveProperty('fallbacks');
    expect(haiku.body.max_tokens).toBe(16_000);
  });

  it('rebuilds turns from other providers with valid ids and returns results in one user message', () => {
    const msgs = anthropic.toMessages(history);
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'browser_screenshot', input: { marks: true } }] });
    expect(msgs[2]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'text', text: 'Screenshot of tab 3.' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }],
      }],
    });
  });

  it('replays its own content (thinking blocks included) unchanged', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'browser_status', input: {} }];
    const msgs = anthropic.toMessages([{ role: 'user', text: 'x' }, { role: 'assistant', text: '', calls: [], raw: { kind: 'anthropic', content: raw } }]);
    expect(msgs[1]!.content).toBe(raw);
  });

  it('parses text, tool calls, refusals and usage', () => {
    const c = anthropic.parseResponse({
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Opening it.' }, { type: 'tool_use', id: 'toolu_9', name: 'browser_tabs', input: { action: 'new' } }],
      usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 20 },
    });
    expect(c).toMatchObject({ text: 'Opening it.', stop: 'tool_use', hasContent: true, usage: { input: 1000, output: 20, cached: 900 } });
    expect(c.calls).toEqual([{ id: 'toolu_9', name: 'browser_tabs', args: { action: 'new' } }]);
    expect(c.raw.content).toHaveLength(3);

    const refused = anthropic.parseResponse({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: null } });
    expect(refused).toMatchObject({ stop: 'refusal', hasContent: false, detail: 'category: cyber' });
  });

  it('drops what the declined model produced before a fallback switch point', () => {
    const c = anthropic.parseResponse({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '', signature: 'old' },
        { type: 'text', text: 'Partial. ' },
        { type: 'tool_use', id: 'toolu_old', name: 'browser_click', input: {} },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
        { type: 'text', text: 'Done.' },
      ],
    });
    expect(c.calls).toEqual([]);
    expect(c.raw.content).toEqual([{ type: 'text', text: 'Partial. ' }, { type: 'text', text: 'Done.' }]);
    expect(c.model).toBe('claude-opus-5');
  });

  it('calls /v1/messages with the version, beta and browser-access headers', async () => {
    const requests = mockFetch({ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } });
    await anthropic.anthropicProvider.complete(cfg('anthropic', 'https://api.anthropic.com/v1'), request('claude-sonnet-5-5', [{ role: 'user', text: 'hi' }]));
    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0]!.init.headers).toMatchObject({
      'x-api-key': KEY,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
  });

  it('lists models with vision and output limits, following pages', async () => {
    const requests = mockFetch(
      { body: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_tokens: 128000, capabilities: { image_input: { supported: true } } }], has_more: true, last_id: 'claude-opus-5-5' } },
      { body: { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false } },
    );
    const models = await anthropic.anthropicProvider.listModels(cfg('anthropic', 'https://api.anthropic.com/v1'));
    expect(models).toEqual([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', vision: true, maxOutput: 128000 }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }]);
    expect(requests[1]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5');
  });
});

describe('Gemini adapter', () => {
  it('declares tools as JSON Schema, leaving out empty parameter lists', () => {
    const { functionDeclarations } = gemini.toolDefs(TOOLS)[0]!;
    expect(functionDeclarations[0]).toEqual({ name: 'browser_status', description: TOOLS[0]!.description });
    expect(functionDeclarations[1]).toMatchObject({ name: 'browser_tabs', parametersJsonSchema: TOOLS[1]!.parameters });
  });

  it('puts screenshots inside function responses on Gemini 3, beside them before', () => {
    const v3 = gemini.toContents(history, 'gemini-3.5-flash');
    expect(v3[1]).toEqual({ role: 'model', parts: [{ functionCall: { id: 'call:1', name: 'browser_screenshot', args: { marks: true } } }] });
    expect(v3[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'call:1', name: 'browser_screenshot', response: { output: 'Screenshot of tab 3.' }, parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }] } }],
    });
    const v2 = gemini.toContents(history, 'gemini-2.5-pro');
    expect(v2[2]!.parts).toEqual([
      { functionResponse: { id: 'call:1', name: 'browser_screenshot', response: { output: 'Screenshot of tab 3.' } } },
      { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
    ]);
  });

  it('replays signed parts unchanged and answers id-less calls without an id', () => {
    const json = { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { functionCall: { name: 'browser_status', args: {} }, thoughtSignature: 'SIG' }] } }] };
    const c = gemini.parseResponse(json);
    expect(c.text).toBe('');
    expect(c.calls[0]!.id).toMatch(/^uabc_/);
    const contents = gemini.toContents(
      [
        { role: 'user', text: 'status?' },
        { role: 'assistant', text: c.text, calls: c.calls, raw: c.raw },
        { role: 'tool', results: [{ callId: c.calls[0]!.id, name: 'browser_status', text: 'Error PAUSED: paused', isError: true }] },
      ],
      'gemini-3-pro',
    );
    expect(contents[1]!.parts).toBe(json.candidates[0]!.content.parts);
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: 'browser_status', response: { error: 'Error PAUSED: paused' } } }]);
  });

  it('maps safety blocks to refusals and asks once more after a malformed call', () => {
    expect(gemini.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toMatchObject({ stop: 'refusal', hasContent: false });
    expect(gemini.parseResponse({ candidates: [{ finishReason: 'PROHIBITED_CONTENT', content: { parts: [] } }] }).stop).toBe('refusal');
    const bad = gemini.parseResponse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] });
    expect(bad).toMatchObject({ stop: 'other', hasContent: false });
    expect(bad.retry).toMatch(/Call one of the declared tools again/);
  });

  it('calls models/<id>:generateContent with the key header', async () => {
    const requests = mockFetch({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, thoughtsTokenCount: 2 } } });
    const c = await gemini.geminiProvider.complete(cfg('gemini', 'https://generativelanguage.googleapis.com/v1beta'), request('models/gemini-3-flash', [{ role: 'user', text: 'hi' }]));
    expect(c).toMatchObject({ text: 'ok', stop: 'end', usage: { input: 5, output: 3 } });
    expect(requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent');
    expect(requests[0]!.init.headers).toMatchObject({ 'x-goog-api-key': KEY });
    expect(requests[0]!.body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
  });

  it('lists generateContent models without the models/ prefix', () => {
    const models = gemini.parseModels({
      models: [
        { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      ],
    });
    expect(models).toEqual([{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', vision: true, maxOutput: 65536 }]);
  });
});
