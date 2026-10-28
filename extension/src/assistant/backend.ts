// The side panel's line to the service worker: one port per panel. The
// service worker opens an AI session for it, exactly like an MCP client's,
// and runs its commands through the same gate (tab group, site approvals,
// sensitive fields, kill switch).

import type { ErrorBody } from '../shared/protocol';
import type { Backend } from '../shared/runner';

export const ASSISTANT_PORT = 'uabc-assistant';

/** Port messages, panel → service worker. */
export type ToWorker =
  | { type: 'call'; id: number; method: string; params: Record<string, unknown> }
  | { type: 'cancel'; id: number }
  | { type: 'client'; name: string }
  | { type: 'ping' };

/** Port messages, service worker → panel. */
export type FromWorker =
  | { type: 'hello'; session: string }
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: ErrorBody };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: ErrorBody) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerBackend implements Backend {
  generation = 0;
  /** The service worker's id for this panel's session (matches approval prompts). */
  session = '';
  private port: chrome.runtime.Port | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private keepalive?: ReturnType<typeof setInterval>;

  constructor(private clientName = 'UABC assistant') {}

  connect(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = chrome.runtime.connect({ name: ASSISTANT_PORT });
    this.port = port;
    this.generation++;
    port.onMessage.addListener((m: FromWorker) => {
      if (m.type === 'hello') {
        this.session = m.session;
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(m.error);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.session = '';
      clearInterval(this.keepalive);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject({
          code: 'EXTENSION_DISCONNECTED',
          message: 'The UABC service worker restarted while this action was running.',
          hint: 'Check the page with browser_get_state before retrying.',
        });
      }
      this.pending.clear();
    });
    this.send({ type: 'client', name: this.clientName });
    // Messages keep the service worker alive (and with it this session's
    // "allow this time" grants) while the panel is open.
    this.keepalive = setInterval(() => this.send({ type: 'ping' }), 20_000);
    return port;
  }

  setClientName(name: string): void {
    this.clientName = name;
    if (this.port) this.send({ type: 'client', name });
  }

  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ type: 'cancel', id });
        reject({ code: 'TIMEOUT', message: `The browser did not finish ${method} within ${Math.round(timeoutMs / 1000)} s.` } satisfies ErrorBody);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'call', id, method, params });
    });
  }

  private send(m: ToWorker): void {
    try {
      this.port?.postMessage(m);
    } catch {
      // disconnected; onDisconnect rejects what is pending
    }
  }
}
