// Connection to the local `uabc` native messaging host. An open native port
// also keeps the MV3 service worker alive (Chrome 105+).

import { browserInfo } from '../shared/browser';
import { type FromHost, type HostInfo, NATIVE_HOST, PROTOCOL, type ToHost } from '../shared/protocol';
import { settings } from './settings';

export type BridgeState = 'connecting' | 'connected' | 'missing' | 'disconnected';

export class NativeBridge {
  state: BridgeState = 'disconnected';
  lastError = '';
  host?: HostInfo;
  private port: chrome.runtime.Port | null = null;
  /** Set while connect() awaits settings, so overlapping calls open one port. */
  private starting = false;
  private retries = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onMessage: (m: FromHost) => void,
    private readonly onState: (state: BridgeState) => void,
  ) {}

  get connected(): boolean {
    return this.state === 'connected';
  }

  async connect(): Promise<void> {
    if (this.port || this.starting) return;
    this.starting = true;
    clearTimeout(this.timer);
    const s = await settings().finally(() => (this.starting = false));
    this.setState('connecting');
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    this.port = port;
    port.onMessage.addListener((m: FromHost) => {
      if (m.type === 'welcome') {
        this.host = m.host;
        this.retries = 0;
        this.lastError = '';
        this.setState('connected');
      }
      this.onMessage(m);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.lastError = chrome.runtime.lastError?.message ?? 'disconnected';
      this.port = null;
      this.host = undefined;
      this.setState(/not found|forbidden/i.test(this.lastError) ? 'missing' : 'disconnected');
      this.scheduleReconnect();
    });
    port.postMessage({
      type: 'hello',
      protocol: PROTOCOL,
      extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version },
      instance: { id: s.instanceId, label: s.label },
      browser: browserInfo(),
    } satisfies ToHost);
  }

  send(m: ToHost): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(m);
      return true;
    } catch {
      return false;
    }
  }

  /** Drops the connection and reconnects (e.g. after the profile label changed). */
  async restart(): Promise<void> {
    const port = this.port;
    this.port = null;
    port?.disconnect();
    this.setState('disconnected');
    await this.connect();
  }

  private scheduleReconnect(): void {
    clearTimeout(this.timer);
    // Missing host: the user has to run `uabc install`; poll slowly (alarms also retry).
    const base = this.state === 'missing' ? 15_000 : 1_000 * 2 ** Math.min(this.retries, 5);
    this.retries++;
    this.timer = setTimeout(() => void this.connect(), Math.min(base, 60_000));
  }

  private setState(state: BridgeState): void {
    this.state = state;
    this.onState(state);
  }
}
