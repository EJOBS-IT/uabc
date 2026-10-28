// HTTP for provider APIs: JSON in and out, timeouts, a couple of retries for
// overload and rate limits, and error messages a user can act on. API keys
// never appear in errors, and no cookies are sent (the extension's host
// permissions would otherwise attach the user's provider-site cookies).

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  /** Masked out of error messages. */
  secret?: string;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * This computer: the only place plain http is accepted (Ollama, LM Studio, a
 * local relay). Not the LAN: on another network the same address may answer
 * from someone else's machine.
 */
export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Why `raw` cannot be used as a provider base URL, or null if it can. */
export function baseUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Enter a full address, for example https://api.example.com/v1';
  }
  if (u.username || u.password) return 'Do not put credentials in the address; use the API key field.';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && isLoopback(u.hostname)) return null;
  return 'Use https://. Plain http:// is only allowed for this computer (for example http://localhost:11434/v1); reach a server elsewhere through https or an SSH tunnel.';
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? NaN : /^\d+(\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 20_000) : 1500 * 3 ** attempt;
}

function providerMessage(json: any, text: string): string {
  const e = json?.error;
  const msg = typeof e === 'string' ? e : (e?.message ?? json?.message ?? json?.detail);
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function describe(status: number, message: string, host: string): string {
  const detail = message ? `: ${message}${/[.!?…]$/.test(message) ? '' : '.'}` : '.';
  switch (status) {
    case 400:
      return `${host} rejected the request (HTTP 400)${detail}`;
    case 401:
      return `${host} rejected the API key (HTTP 401)${detail} Check the key in UABC settings.`;
    case 402:
      return `${host} says payment is required (HTTP 402)${detail}`;
    case 403:
      return `${host} denied access (HTTP 403)${detail}`;
    case 404:
      return `${host} has no such model or endpoint (HTTP 404)${detail} Check the model id and the server address.`;
    case 429:
      return `${host} rate limit or quota reached (HTTP 429)${detail}`;
    default:
      return status >= 500 ? `${host} is overloaded or failing (HTTP ${status})${detail} Try again in a moment.` : `${host} answered HTTP ${status}${detail}`;
  }
}

function mask(text: string, secret?: string): string {
  const clean = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  return secret && secret.length >= 6 ? clean.split(secret).join('••••') : clean;
}

export async function requestJson<T = any>(url: string, o: RequestOptions = {}): Promise<T> {
  const problem = baseUrlProblem(url);
  if (problem) throw new ProviderError(problem);
  const host = new URL(url).host;
  const retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 300_000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
        headers: { ...(o.body === undefined ? {} : { 'content-type': 'application/json' }), ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        // The key is in the headers: never let it follow a redirect to another server.
        redirect: 'manual',
      });
      text = res.type === 'opaqueredirect' ? '' : await res.text();
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason;
      if (timeout.aborted) throw new ProviderError(`${host} did not answer within ${Math.round((o.timeoutMs ?? 300_000) / 1000)} s.`, 0, true);
      const local = isLoopback(new URL(url).hostname);
      throw new ProviderError(
        `Could not reach ${host}${local ? '. Is the local model server running?' : '. Check your connection and the server address.'} (${mask(String((e as Error)?.message ?? e), o.secret)})`,
      );
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new ProviderError(`${host} redirected the request to another address. Enter the final address as the server address.`, res.status);
    }
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (res.ok) {
      if (json === undefined) throw new ProviderError(`${host} answered with something that is not JSON.`);
      return json as T;
    }
    const retryable = RETRYABLE.has(res.status);
    if (retryable && attempt < retries) {
      await sleep(retryDelay(res, attempt), o.signal);
      continue;
    }
    throw new ProviderError(mask(describe(res.status, providerMessage(json, text), host), o.secret), res.status, retryable);
  }
}
