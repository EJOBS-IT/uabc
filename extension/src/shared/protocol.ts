// Wire types shared with the Rust host (host/src/proto.rs). See docs/protocol.md.

export const PROTOCOL = 1;
export const NATIVE_HOST = 'com.ejobsit.uabc';

export const Code = {
  EXTENSION_DISCONNECTED: 'EXTENSION_DISCONNECTED',
  PAUSED: 'PAUSED',
  NO_TAB: 'NO_TAB',
  TAB_NOT_SHARED: 'TAB_NOT_SHARED',
  BLOCKED_URL: 'BLOCKED_URL',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  REF_NOT_FOUND: 'REF_NOT_FOUND',
  STALE_REF: 'STALE_REF',
  NOT_INTERACTABLE: 'NOT_INTERACTABLE',
  OBSCURED: 'OBSCURED',
  SENSITIVE_FIELD: 'SENSITIVE_FIELD',
  NO_SUCH_OPTION: 'NO_SUCH_OPTION',
  CDP_UNAVAILABLE: 'CDP_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  INVALID_PARAMS: 'INVALID_PARAMS',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  INTERNAL: 'INTERNAL',
} as const;
export type Code = (typeof Code)[keyof typeof Code];

export interface ErrorBody {
  code: string;
  message: string;
  hint?: string;
  /** The message quotes page-controlled text (element names, page-chosen hosts): fence it. */
  page_text?: boolean;
}

/** Thrown anywhere in the extension; becomes an error response to the AI client. */
export class CommandError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly hint?: string,
    readonly quotesPage = false,
  ) {
    super(message);
  }

  toBody(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.quotesPage ? { page_text: true } : {}),
    };
  }
}

export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof CommandError) return e.toBody();
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ErrorBody;
  return { code: Code.INTERNAL, message: e instanceof Error ? e.message : String(e) };
}

export interface ClientInfo {
  name: string;
  version?: string;
}

export interface HostInfo {
  version: string;
  pid: number;
  endpoint?: string;
}

/** host → extension */
export type FromHost =
  | { type: 'welcome'; protocol: number; host: HostInfo }
  | { type: 'session.open'; session: string; client: ClientInfo }
  | { type: 'session.close'; session: string }
  | { type: 'request'; id: number; session: string; method: string; params?: Record<string, unknown> }
  | { type: 'cancel'; id: number };

/** extension → host */
export type ToHost =
  | {
      type: 'hello';
      protocol: number;
      extension: { id: string; version: string };
      instance: { id: string; label: string };
      browser: { name: string; version: string };
    }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: ErrorBody };

/** Result envelope used between the service worker and content scripts. */
export type Reply<T> = { ok: true; result: T } | { ok: false; error: ErrorBody };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states?: string[];
  href?: string;
  options?: string[];
  n_options?: number;
  offscreen?: 'above' | 'below' | 'left' | 'right';
}

export interface ScrollState {
  x: number;
  y: number;
  max_x: number;
  max_y: number;
}

export interface Snapshot {
  doc: string;
  url: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  scroll: ScrollState;
  elements: SnapshotElement[];
  counts: { total: number; shown: number; above: number; below: number; truncated: boolean };
  notes: string[];
  text?: string;
  text_truncated?: boolean;
}

/** Where to act, as resolved by the content script (viewport CSS pixels). */
export interface ActionPoint {
  doc: string;
  x: number;
  y: number;
  description: string;
}
