import { describe, expect, it, vi } from 'vitest';
import { type TurnEvents, newConversation, runTurn } from '../src/assistant/agent';
import { maskKey, normalize } from '../src/assistant/config';
import { baseUrlProblem, isLoopback } from '../src/assistant/http';
import type { Completion, CompletionRequest, ProviderConfig, ToolCall } from '../src/assistant/types';
import type { ToolOutput } from '../src/shared/runner';

const provider: ProviderConfig = { id: 'p', kind: 'openai', label: 'P', baseUrl: 'https://api.example/v1', apiKey: 'k', models: [] };

function reply(text: string, calls: ToolCall[] = [], extra: Partial<Completion> = {}): Completion {
  return { text, calls, raw: { kind: 'openai', content: { content: text, tool_calls: calls } }, hasContent: true, stop: calls.length ? 'tool_use' : 'end', ...extra };
}
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, args });

/** Scripted model: each entry answers one request; requests are snapshotted as JSON. */
function script(...replies: Array<Completion | ((req: CompletionRequest) => Completion)>) {
  const seen: string[] = [];
  const complete = vi.fn(async (_cfg: ProviderConfig, req: CompletionRequest) => {
    seen.push(JSON.stringify(req.messages));
    const r = replies.shift();
    if (!r) throw new Error('model called too often');
    return typeof r === 'function' ? r(req) : r;
  });
  return { complete, seen };
}

function runner(results: Record<string, ToolOutput> = {}) {
  const ran: string[] = [];
  return {
    ran,
    run: vi.fn(async (name: string) => {
      ran.push(name);
      return results[name] ?? { text: `${name} ok`, isError: false };
    }),
  };
}

function options(complete: ReturnType<typeof script>['complete'], r: ReturnType<typeof runner>, extra: { maxSteps?: number; signal?: AbortSignal; events?: TurnEvents } = {}) {
  return { provider, model: 'm', runner: r, maxSteps: extra.maxSteps ?? 10, signal: extra.signal ?? new AbortController().signal, events: extra.events, complete };
}

describe('agent loop', () => {
  it('runs the tools the model calls until it answers, and the history only grows', async () => {
    const conv = newConversation({ screenshots: true, today: '2026-10-27' });
    const { complete, seen } = script(reply('', [call('1', 'browser_tabs', { action: 'new' }), call('2', 'browser_get_state')]), reply('', [call('3', 'browser_click', { ref: 4 })]), reply('Done.'));
    const r = runner();
    const texts: string[] = [];
    const outcome = await runTurn(conv, 'Open it', options(complete, r, { events: { text: (t) => texts.push(t) } }));
    expect(outcome).toBe('done');
    expect(r.ran).toEqual(['browser_tabs', 'browser_get_state', 'browser_click']);
    expect(texts).toEqual(['Done.']);
    expect(conv.system).toContain("Today's date is 2026-10-27.");
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    // Append-only: every request starts with the previous request's messages, byte for byte.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.startsWith(seen[i - 1]!.slice(0, -1))).toBe(true);
  });

  it('answers every call, also the ones it refuses to run', async () => {
    const conv = newConversation({ screenshots: false });
    const bad: ToolCall = { id: 'b', name: 'browser_click', args: {}, badArgs: '{"ref":' };
    const { complete } = script(reply('', [bad, call('s', 'browser_screenshot'), call('u', 'rm_rf')]), reply('Sorry.'));
    const r = runner();
    await runTurn(conv, 'go', options(complete, r));
    expect(r.ran).toEqual([]);
    const results = conv.messages.find((m) => m.role === 'tool');
    expect(results && results.role === 'tool' && results.results.map((x) => x.text.split(':')[0])).toEqual([
      'Error INVALID_PARAMS',
      'Error UNKNOWN_METHOD', // no screenshot tool when screenshots are off
      'Error UNKNOWN_METHOD',
    ]);
    expect(conv.tools.some((t) => t.name === 'browser_screenshot')).toBe(false);
  });

  it('stops at once when the user pauses AI control', async () => {
    const conv = newConversation({ screenshots: true });
    const { complete } = script(reply('', [call('1', 'browser_click', { ref: 1 }), call('2', 'browser_type', { ref: 2, text: 'x' })]));
    const r = runner({ browser_click: { text: 'Error PAUSED: The user has paused AI control of the browser.', isError: true } });
    expect(await runTurn(conv, 'go', options(complete, r))).toBe('paused');
    expect(r.ran).toEqual(['browser_click']);
    expect(complete).toHaveBeenCalledTimes(1);
    const last = conv.messages.at(-1);
    expect(last?.role === 'tool' && last.results[1]!.text).toMatch(/^Error PAUSED: Not run/);
  });

  it('stops after the current action when the user presses Stop', async () => {
    const conv = newConversation({ screenshots: true });
    const ac = new AbortController();
    const { complete } = script(reply('', [call('1', 'browser_click', { ref: 1 }), call('2', 'browser_click', { ref: 2 })]));
    const r = runner();
    r.run.mockImplementationOnce(async (name: string) => {
      r.ran.push(name);
      ac.abort();
      return { text: 'Clicked.', isError: false };
    });
    expect(await runTurn(conv, 'go', options(complete, r, { signal: ac.signal }))).toBe('stopped');
    expect(r.ran).toEqual(['browser_click']);
    const last = conv.messages.at(-1);
    expect(last?.role === 'tool' && last.results[1]!.text).toMatch(/^Error CANCELLED/);
  });

  it('forgets a request the model declined outright', async () => {
    const conv = newConversation({ screenshots: true });
    const notices: string[] = [];
    const { complete } = script(reply('', [], { stop: 'refusal', hasContent: false, detail: 'category: cyber' }));
    expect(await runTurn(conv, 'bad idea', options(complete, runner(), { events: { notice: (_l, t) => notices.push(t) } }))).toBe('refused');
    expect(conv.messages).toEqual([]);
    expect(notices[0]).toBe('The model declined to continue (category: cyber).');
  });

  it('does not run calls from a reply that was cut off', async () => {
    const conv = newConversation({ screenshots: true });
    const { complete } = script(reply('', [call('1', 'browser_type', { ref: 1, text: 'lo' })], { stop: 'max_tokens' }), reply('ok'));
    const r = runner();
    await runTurn(conv, 'go', options(complete, r));
    expect(r.ran).toEqual([]);
  });

  it('gives the model one more chance after an unusable reply', async () => {
    const conv = newConversation({ screenshots: true });
    const { complete } = script(reply('', [], { stop: 'other', hasContent: false, retry: 'Try again.' }), reply('Fine.'));
    expect(await runTurn(conv, 'go', options(complete, runner()))).toBe('done');
    expect(conv.messages.map((m) => (m.role === 'user' ? m.text : m.role))).toEqual(['go', 'Try again.', 'assistant']);
  });

  it('stops after the step limit and reports provider errors', async () => {
    const conv = newConversation({ screenshots: true });
    const loop = () => reply('', [call(String(Math.random()), 'browser_status')]);
    const notices: string[] = [];
    const { complete } = script(loop, loop, loop);
    expect(await runTurn(conv, 'go', options(complete, runner(), { maxSteps: 2, events: { notice: (_l, t) => notices.push(t) } }))).toBe('max_steps');
    expect(notices.at(-1)).toMatch(/Stopped after 2 steps/);
    const failing = vi.fn(async () => {
      throw new Error('api.example rejected the API key (HTTP 401).');
    });
    expect(await runTurn(conv, 'again', { ...options(failing as never, runner()), complete: failing as never, events: { notice: (_l, t) => notices.push(t) } })).toBe('error');
    expect(notices.at(-1)).toBe('api.example rejected the API key (HTTP 401).');
  });
});

describe('provider addresses', () => {
  it('allow https anywhere and plain http only on this computer', () => {
    expect(baseUrlProblem('https://api.example.com/v1')).toBeNull();
    for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1', 'http://ollama.localhost/v1']) expect(baseUrlProblem(ok)).toBeNull();
    // The LAN is not this computer: on café Wi-Fi the same address is someone else.
    for (const bad of ['http://192.168.1.20:11434/v1', 'http://10.0.0.5/v1', 'http://gpu-box.local/v1', 'http://api.example.com/v1']) expect(baseUrlProblem(bad)).toMatch(/Use https/);
    expect(baseUrlProblem('https://user:pw@api.example.com')).toMatch(/credentials/);
    expect(baseUrlProblem('api.example.com')).toMatch(/full address/);
    expect(isLoopback('127.0.0.53')).toBe(true);
    expect(isLoopback('127.example.com')).toBe(false);
    expect(isLoopback('8.8.8.8')).toBe(false);
  });
});

describe('settings', () => {
  it('normalizes stored settings defensively', () => {
    const c = normalize({
      providers: [
        { id: 'openai', kind: 'openai', apiKey: 'sk-1', models: [{ id: 'gpt' }, { nope: 1 }] },
        { id: 'openai-fake', kind: 'evil' },
        { id: 'anthropic', kind: 'openai', apiKey: 'x' }, // a preset id with the wrong kind
      ],
      selected: { provider: 'openai', model: 'gpt' },
      maxSteps: 10_000,
    });
    expect(c.providers).toHaveLength(1);
    expect(c.providers[0]).toMatchObject({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt' }] });
    expect(c.maxSteps).toBe(200);
    expect(c.screenshots).toBe(true);
    expect(normalize(undefined)).toEqual({ providers: [], maxSteps: 40, screenshots: true });
  });

  it('pins built-in providers to their own address; only custom ones may point elsewhere', () => {
    const c = normalize({
      providers: [
        { id: 'openai', kind: 'openai', baseUrl: 'https://evil.example/v1', apiKey: 'sk-1' },
        { id: 'custom-proxy', kind: 'anthropic', baseUrl: 'https://claude-proxy.example/v1', apiKey: 'k' },
      ],
    });
    expect(c.providers.map((p) => p.baseUrl)).toEqual(['https://api.openai.com/v1', 'https://claude-proxy.example/v1']);
  });

  it('never shows a meaningful part of a key', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('short-key')).toBe('••••');
    expect(maskKey('sk-proj-0123456789abcdef')).toBe('sk-…cdef');
  });
});
