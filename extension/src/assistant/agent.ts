// The assistant's agent loop: ask the model, run the browser tools it calls,
// feed the results back, until it answers in text. History is append-only:
// earlier turns are never edited, which keeps prompt caches valid and is what
// providers that sign their reasoning require.

import * as format from '../shared/format';
import { type ToolOutput, resolveTool } from '../shared/runner';
import { ASSISTANT_INSTRUCTIONS, TOOLS, type ToolSpec } from '../shared/tools';
import { providerFor } from './providers';
import type { ChatMessage, Completion, CompletionRequest, ProviderConfig, ToolCall, ToolResult } from './types';

export interface Conversation {
  /** Fixed for the conversation's lifetime (a changing prefix would defeat caching). */
  readonly system: string;
  readonly tools: ToolSpec[];
  readonly messages: ChatMessage[];
}

export function newConversation(opts: { screenshots: boolean; today?: string }): Conversation {
  const today = opts.today ?? new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
  return {
    system: `${ASSISTANT_INSTRUCTIONS}\n\nToday's date is ${today}.`,
    tools: opts.screenshots ? TOOLS : TOOLS.filter((t) => t.name !== 'browser_screenshot'),
    messages: [],
  };
}

export interface TurnEvents {
  text?(text: string): void;
  toolStart?(call: ToolCall): void;
  toolEnd?(call: ToolCall, out: ToolOutput, ran: boolean): void;
  notice?(level: 'info' | 'warn' | 'error', text: string): void;
  usage?(usage: NonNullable<Completion['usage']>, model?: string): void;
  /** True while waiting for the model. */
  thinking?(on: boolean): void;
}

export type TurnOutcome = 'done' | 'stopped' | 'paused' | 'refused' | 'max_steps' | 'error';

export interface TurnOptions {
  provider: ProviderConfig;
  model: string;
  maxOutput?: number;
  runner: { run(name: string, args: unknown): Promise<ToolOutput> };
  maxSteps: number;
  signal: AbortSignal;
  events?: TurnEvents;
  /** Defaults to the provider's adapter (tests pass a fake). */
  complete?: (cfg: ProviderConfig, req: CompletionRequest) => Promise<Completion>;
}

function refusedToRun(code: string, message: string): ToolOutput {
  return { text: format.error({ code, message }), isError: true };
}

export async function runTurn(conv: Conversation, userText: string, o: TurnOptions): Promise<TurnOutcome> {
  const ev = o.events ?? {};
  const complete = o.complete ?? ((cfg, req) => providerFor(cfg.kind).complete(cfg, req));
  const start = conv.messages.length;
  conv.messages.push({ role: 'user', text: userText });
  let retried = false;

  for (let step = 0; step < o.maxSteps; step++) {
    if (o.signal.aborted) return 'stopped';
    let res: Completion;
    ev.thinking?.(true);
    try {
      res = await complete(o.provider, {
        model: o.model,
        system: conv.system,
        tools: conv.tools,
        messages: conv.messages,
        maxOutput: o.maxOutput,
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal.aborted) return 'stopped';
      ev.notice?.('error', e instanceof Error ? e.message : String(e));
      return 'error';
    } finally {
      ev.thinking?.(false);
    }
    if (res.usage) ev.usage?.(res.usage, res.model);

    if (res.stop === 'refusal') {
      ev.notice?.('warn', `The model declined to continue${res.detail ? ` (${res.detail})` : ''}.`);
      // Forget a request that was declined outright, so the next message starts clean.
      if (step === 0) conv.messages.splice(start);
      return 'refused';
    }
    if (res.hasContent) conv.messages.push({ role: 'assistant', text: res.text, calls: res.calls, raw: res.raw });
    if (res.text) ev.text?.(res.text);

    if (!res.calls.length) {
      if (res.retry && !retried) {
        retried = true;
        conv.messages.push({ role: 'user', text: res.retry });
        continue;
      }
      if (res.stop === 'max_tokens') ev.notice?.('warn', 'The reply was cut off at the output limit.');
      else if (!res.text) ev.notice?.('warn', `The model stopped without answering${res.detail ? ` (${res.detail})` : ''}.`);
      return 'done';
    }

    // Every call gets a result, even the ones not run, or the next request is invalid.
    const results: ToolResult[] = [];
    let paused = false;
    for (const call of res.calls) {
      let out: ToolOutput;
      let ran = false;
      ev.toolStart?.(call);
      if (o.signal.aborted) out = refusedToRun('CANCELLED', 'Not run: the user stopped the assistant.');
      else if (paused) out = refusedToRun('PAUSED', 'Not run: the user paused AI control.');
      else if (res.stop === 'max_tokens') out = refusedToRun('INVALID_PARAMS', 'Not run: your reply was cut off at the output limit. Make one call at a time with shorter arguments.');
      else if (call.badArgs !== undefined) out = refusedToRun('INVALID_PARAMS', `Not run: the arguments were not valid JSON: ${call.badArgs}`);
      else if (!resolveTool(call.name, conv.tools)) {
        out = refusedToRun('UNKNOWN_METHOD', `There is no tool named "${call.name}". The tools are: ${conv.tools.map((t) => t.name).join(', ')}.`);
      } else {
        out = await o.runner.run(call.name, call.args);
        ran = true;
        if (out.isError && out.text.startsWith('Error PAUSED')) paused = true;
      }
      ev.toolEnd?.(call, out, ran);
      results.push({ callId: call.id, name: call.name, text: out.text, isError: out.isError, ...(out.image ? { image: out.image } : {}) });
    }
    conv.messages.push({ role: 'tool', results });

    if (paused) {
      ev.notice?.('warn', 'AI control is paused. Resume it from the UABC toolbar button, then send a message to continue.');
      return 'paused';
    }
    if (o.signal.aborted) return 'stopped';
  }
  ev.notice?.('info', `Stopped after ${o.maxSteps} steps. Send "continue" to let the assistant keep going.`);
  return 'max_steps';
}
