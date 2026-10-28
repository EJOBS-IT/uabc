import { describe, expect, it } from 'vitest';
import { classifyUrl, grantMatches, normalizeGrant } from '../src/shared/url-policy';

describe('classifyUrl', () => {
  it('allows only http(s) web pages', () => {
    expect(classifyUrl('https://mail.google.com/mail/u/0/')).toEqual({ kind: 'web', origin: 'https://mail.google.com' });
    expect(classifyUrl('http://127.0.0.1:8080/x')).toEqual({ kind: 'web', origin: 'http://127.0.0.1:8080' });
    expect(classifyUrl('about:blank').kind).toBe('blank');
    for (const bad of [
      'chrome://settings', 'chrome-extension://abc/approve.html', 'file:///etc/passwd', 'javascript:alert(1)',
      'data:text/html,<b>x</b>', 'view-source:https://example.com', 'devtools://devtools/x', 'not a url',
      'https://user:pw@example.com/', 'https://chromewebstore.google.com/detail/x',
    ]) {
      expect(classifyUrl(bad).kind, bad).toBe('blocked');
    }
  });
});

describe('grants', () => {
  it('match exact origins', () => {
    expect(grantMatches('https://example.com', 'https://example.com')).toBe(true);
    expect(grantMatches('https://example.com', 'http://example.com')).toBe(false);
    expect(grantMatches('https://example.com', 'https://evil-example.com')).toBe(false);
  });

  it('match wildcard subdomains with the same scheme and port', () => {
    expect(grantMatches('https://*.example.com', 'https://a.b.example.com')).toBe(true);
    expect(grantMatches('https://*.example.com', 'https://example.com')).toBe(true);
    expect(grantMatches('https://*.example.com', 'https://notexample.com')).toBe(false);
    expect(grantMatches('https://*.example.com', 'http://a.example.com')).toBe(false);
    expect(grantMatches('https://*.example.com', 'https://a.example.com:8443')).toBe(false);
  });

  it('normalize what users type', () => {
    expect(normalizeGrant('example.com')).toBe('https://example.com');
    expect(normalizeGrant('http://localhost:3000/app?x=1')).toBe('http://localhost:3000');
    expect(normalizeGrant('*.example.com')).toBe('https://*.example.com');
    expect(normalizeGrant('chrome://settings')).toBeNull();
    expect(normalizeGrant('   ')).toBeNull();
  });
});
