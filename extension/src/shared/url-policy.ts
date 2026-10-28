// Which URLs an agent may ever touch, and how site grants match. Pure functions.

export type UrlVerdict =
  | { kind: 'blank' } // about:blank & the new-tab page: nothing to read, nothing to protect
  | { kind: 'web'; origin: string }
  | { kind: 'blocked'; reason: string };

const BLANK = new Set(['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/']);

// The browser refuses to let extensions script these anyway; refusing early
// gives the agent a clear error instead of a confusing failure.
const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com']);

export function classifyUrl(raw: string | undefined): UrlVerdict {
  if (!raw) return { kind: 'blank' };
  if (BLANK.has(raw)) return { kind: 'blank' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'blocked', reason: `"${raw}" is not an absolute URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'blocked', reason: `${url.protocol} URLs are never available to AI agents` };
  }
  if (url.username || url.password) {
    return { kind: 'blocked', reason: 'URLs with embedded credentials are not allowed' };
  }
  if (STORE_HOSTS.has(url.hostname) && (url.hostname !== 'chrome.google.com' || url.pathname.startsWith('/webstore'))) {
    return { kind: 'blocked', reason: 'extension stores cannot be automated' };
  }
  return { kind: 'web', origin: url.origin };
}

/**
 * A grant is an exact origin (`https://mail.google.com`) or a wildcard for a
 * registrable domain and its subdomains (`https://*.example.com`). Scheme and
 * port always have to match, so granting http never grants https or vice versa.
 */
export function grantMatches(grant: string, origin: string): boolean {
  if (grant === origin) return true;
  const m = /^(https?):\/\/\*\.([^/:]+)(:\d+)?$/.exec(grant);
  if (!m) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const [, scheme, domain, port = ''] = m;
  if (url.protocol !== `${scheme}:`) return false;
  if ((url.port ? `:${url.port}` : '') !== port) return false;
  return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
}

/** Normalizes user input like "example.com" or "https://example.com/path" into a grant. */
export function normalizeGrant(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const wildcard = /^(https?:\/\/)\*\.(.+)$/i.exec(withScheme);
  if (wildcard) {
    const inner = normalizeGrant(`${wildcard[1]}${wildcard[2]}`);
    return inner ? inner.replace('://', '://*.') : null;
  }
  const verdict = classifyUrl(withScheme);
  return verdict.kind === 'web' ? verdict.origin : null;
}
