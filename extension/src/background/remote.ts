// Remote access: an outbound WebSocket to a UABC relay (`uabc relay`), so AI
// apps in the cloud (Claude custom connectors, ChatGPT developer mode, any
// remote MCP client) can use this browser through a secret connector URL.
// Commands arrive in the same messages as from the native host (hop C) and
// pass the same gates. Messages every 20 s keep the service worker alive.

import { baseUrlProblem, joinUrl } from '../assistant/http';
import { browserInfo } from '../shared/browser';
import { type FromHost, type HostInfo, PROTOCOL, type ToHost } from '../shared/protocol';
import { settings } from './settings';

export type RemoteState = 'off' | 'connecting' | 'connected' | 'error';

export interface RemoteSettings {
  enabled: boolean;
  relayUrl: string;
  /** Identifies this browser profile at the relay. */
  deviceId: string;
  /** Proves the device id (the relay keeps only its hash). */
  deviceSecret: string;
  /** Last segment of the connector URL; rotating it revokes the old URL. */
  connectorSecret: string;
  /** The relay's access code, if it requires one to add a browser. */
  accessCode: string;
}

const KEY = 'remote';
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let loading: Promise<RemoteSettings> | null = null;

/** Memoized like settings(): concurrent first calls must not mint two device ids. */
export function remoteSettings(): Promise<RemoteSettings> {
  loading ??= (async () => {
    const stored = ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as Partial<RemoteSettings>;
    const r: RemoteSettings = {
      enabled: stored.enabled === true,
      relayUrl: typeof stored.relayUrl === 'string' ? stored.relayUrl : '',
      deviceId: /^[0-9a-f]{32}$/.test(stored.deviceId ?? '') ? stored.deviceId! : hex(16),
      deviceSecret: /^[0-9a-f]{64}$/.test(stored.deviceSecret ?? '') ? stored.deviceSecret! : hex(32),
      connectorSecret: /^[0-9a-f]{64}$/.test(stored.connectorSecret ?? '') ? stored.connectorSecret! : hex(32),
      accessCode: typeof stored.accessCode === 'string' ? stored.accessCode : '',
    };
    if ((Object.keys(r) as Array<keyof RemoteSettings>).some((k) => stored[k] !== r[k])) await chrome.storage.local.set({ [KEY]: r });
    return r;
  })();
  return loading;
}

export async function updateRemote(patch: Partial<RemoteSettings>): Promise<RemoteSettings> {
  const r = { ...(await remoteSettings()), ...patch };
  loading = Promise.resolve(r);
  await chrome.storage.local.set({ [KEY]: r });
  return r;
}

/** A new connector URL; the relay forgets the old one when we reconnect. */
export function rotateConnector(): Promise<RemoteSettings> {
  return updateRemote({ connectorSecret: hex(32) });
}

/** A fresh identity, for a different relay. */
export function newDeviceCredentials(): Pick<RemoteSettings, 'deviceId' | 'deviceSecret' | 'connectorSecret'> {
  return { deviceId: hex(16), deviceSecret: hex(32), connectorSecret: hex(32) };
}

export function connectorUrl(r: RemoteSettings): string {
  return joinUrl(r.relayUrl, `mcp/${r.deviceId}/${r.connectorSecret}`);
}

function socketUrl(relayUrl: string): string {
  return joinUrl(relayUrl, 'ws').replace(/^http/, 'ws');
}

export function relayUrlProblem(url: string): string | null {
  return baseUrlProblem(url);
}

export class RemoteBridge {
  state: RemoteState = 'off';
  lastError = '';
  host?: HostInfo;
  private ws: WebSocket | null = null;
  /** Set while connect() awaits settings, so overlapping calls open one socket. */
  private starting = false;
  private retries = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onMessage: (m: FromHost) => void,
    private readonly onState: (state: RemoteState) => void,
  ) {}

  get connected(): boolean {
    return this.state === 'connected';
  }

  async connect(): Promise<void> {
    if (this.ws || this.starting) return;
    this.starting = true;
    try {
      await this.open();
    } finally {
      this.starting = false;
    }
  }

  private async open(): Promise<void> {
    clearTimeout(this.timer);
    const r = await remoteSettings();
    if (!r.enabled || !r.relayUrl) return this.setState('off');
    const problem = relayUrlProblem(r.relayUrl);
    if (problem) {
      this.lastError = problem;
      return this.setState('error');
    }
    const s = await settings();
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl(r.relayUrl));
    } catch (e) {
      this.lastError = (e as Error).message;
      this.setState('error');
      return this.scheduleReconnect();
    }
    this.ws = ws;
    this.setState('connecting');
    let keepalive: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      void sha256Hex(r.connectorSecret).then((connectorHash) =>
        this.sendRaw({
          type: 'hello',
          protocol: PROTOCOL,
          device: { id: r.deviceId, secret: r.deviceSecret },
          connector: { sha256: connectorHash },
          extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version },
          instance: { id: s.instanceId, label: s.label },
          browser: browserInfo(),
          ...(r.accessCode ? { registration: { token: r.accessCode } } : {}),
        }),
      );
      keepalive = setInterval(() => this.sendRaw({ type: 'ping' }), 20_000);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m: (FromHost & Record<string, unknown>) | { type: 'error'; error: { message: string } } | { type: 'pong' };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'pong') return;
      if (m.type === 'error') {
        this.lastError = (m as { error: { message: string } }).error?.message ?? 'refused by the relay';
        return;
      }
      if (m.type === 'welcome') {
        this.host = (m as { host: HostInfo }).host;
        this.retries = 0;
        this.lastError = '';
        this.setState('connected');
      }
      this.onMessage(m as FromHost);
    };
    ws.onclose = () => {
      clearInterval(keepalive);
      if (this.ws !== ws) return;
      this.ws = null;
      this.host = undefined;
      if (!this.lastError) this.lastError = 'connection to the relay closed';
      this.setState('error');
      this.scheduleReconnect();
    };
  }

  send(m: ToHost): boolean {
    return this.sendRaw(m);
  }

  /** Reconnects with the current settings (relay changed, connector rotated, turned off). */
  async restart(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    clearTimeout(this.timer);
    ws?.close();
    this.lastError = '';
    this.setState('off');
    await this.connect();
  }

  private sendRaw(m: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.timer);
    const delay = Math.min(1_000 * 2 ** Math.min(this.retries, 6), 60_000);
    this.retries++;
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private setState(state: RemoteState): void {
    this.state = state;
    this.onState(state);
  }
}
