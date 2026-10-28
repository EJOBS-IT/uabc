// A fake model provider that speaks three wire formats: OpenAI-compatible
// chat completions, Anthropic Messages and Gemini generateContent. Each
// request is reduced to a neutral view (system prompt, user text, tool
// results so far) and handed to a scripted "brain" that picks the next step.
// Every request is recorded so tests can check exactly what left the browser.

import { createServer } from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// ----- request → neutral view ---------------------------------------------------------

function openaiView(b) {
  const msgs = b.messages ?? [];
  return {
    system: msgs.find((m) => m.role === 'system')?.content ?? '',
    users: msgs.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content),
    results: msgs.filter((m) => m.role === 'tool').map((m) => m.content),
    images: msgs.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((p) => p.type === 'image_url')).length,
    tools: (b.tools ?? []).map((t) => t.function.name),
  };
}

function anthropicView(b) {
  const blocks = (b.messages ?? []).filter((m) => m.role === 'user').flatMap((m) => m.content);
  const results = blocks.filter((c) => c.type === 'tool_result');
  return {
    system: typeof b.system === 'string' ? b.system : (b.system ?? []).map((s) => s.text).join(''),
    users: blocks.filter((c) => c.type === 'text').map((c) => c.text),
    results: results.map((r) => r.content.find((c) => c.type === 'text')?.text ?? ''),
    images: results.flatMap((r) => r.content.filter((c) => c.type === 'image')).length,
    tools: (b.tools ?? []).map((t) => t.name),
  };
}

function geminiView(b) {
  const parts = (b.contents ?? []).filter((c) => c.role === 'user').flatMap((c) => c.parts);
  const responses = parts.filter((p) => p.functionResponse).map((p) => p.functionResponse);
  return {
    system: b.systemInstruction?.parts?.map((p) => p.text).join('') ?? '',
    users: parts.filter((p) => typeof p.text === 'string').map((p) => p.text),
    results: responses.map((r) => r.response.output ?? r.response.error ?? ''),
    images: responses.flatMap((r) => r.parts ?? []).length + parts.filter((p) => p.inlineData).length,
    tools: (b.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).map((f) => f.name),
  };
}

// ----- step → wire response -----------------------------------------------------------

let seq = 0;

function openaiReply(step, model) {
  const message = step.call
    ? { role: 'assistant', content: step.text ?? null, tool_calls: [{ id: `call_${++seq}`, type: 'function', function: { name: step.call.name, arguments: JSON.stringify(step.call.args ?? {}) } }] }
    : { role: 'assistant', content: step.text ?? '' };
  return { id: `chatcmpl-${++seq}`, object: 'chat.completion', model, choices: [{ index: 0, finish_reason: step.call ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } };
}

function anthropicReply(step, model) {
  if (step.refusal) return { id: `msg_${++seq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: step.refusal, explanation: null }, usage: { input_tokens: 10, output_tokens: 0 } };
  const content = [{ type: 'thinking', thinking: '', signature: `sig-${++seq}` }];
  if (step.text) content.push({ type: 'text', text: step.text });
  if (step.call) content.push({ type: 'tool_use', id: `toolu_${++seq}`, name: step.call.name, input: step.call.args ?? {} });
  return { id: `msg_${++seq}`, type: 'message', role: 'assistant', model, content, stop_reason: step.call ? 'tool_use' : 'end_turn', usage: { input_tokens: 50, cache_read_input_tokens: 900, output_tokens: 20 } };
}

function geminiReply(step, model) {
  const parts = [];
  if (step.text) parts.push({ text: step.text });
  if (step.call) parts.push({ functionCall: { name: step.call.name, args: step.call.args ?? {} }, thoughtSignature: `gsig-${++seq}` });
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20 }, modelVersion: model };
}

// ----- server -----------------------------------------------------------------------------

/** `brain(view, format)` returns {call: {name, args}} | {text} | {refusal}, optionally with {delayMs}. */
export async function startFakeLlm(brain) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    const entry = { method: req.method, path: url.pathname, headers: req.headers, raw, body, aborted: false };
    requests.push(entry);
    // The client hung up before we answered (for example the user pressed Stop).
    res.on('close', () => {
      if (!res.writableFinished) entry.aborted = true;
    });
    const send = (status, json) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    };
    const answer = async (format, view, reply) => {
      const step = brain(view, format);
      if (step.delayMs) await sleep(step.delayMs);
      send(200, reply(step, body.model ?? 'fake-model'));
    };

    if (req.method === 'GET' && url.pathname === '/v1/models') return send(200, { object: 'list', data: [{ id: 'fake-model', created: 1 }] });
    if (req.method === 'GET' && url.pathname === '/anthropic/v1/models') return send(200, { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_tokens: 128000, capabilities: { image_input: { supported: true } } }], has_more: false });
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return answer('openai', openaiView(body), openaiReply);
    if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') return answer('anthropic', anthropicView(body), anthropicReply);
    const gem = /^\/gemini\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (req.method === 'POST' && gem) return answer('gemini', geminiView(body), (step) => geminiReply(step, gem[1]));
    send(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** Completion requests only (not model listings). */
    completions: () => requests.filter((r) => r.method === 'POST'),
    reset: () => requests.splice(0),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
