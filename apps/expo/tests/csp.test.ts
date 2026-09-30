import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR 0002: a strict Content-Security-Policy is the one mitigation for keeping the session token in
// localStorage. Its only source is the `/(.*)` headers in vercel.json (Vercel serves them; e2e/serve.mjs
// replays them, and the e2e CSP gate fails on any violation). This pins the directives that make it strict.
type Vercel = { headers: { source: string; headers: { key: string; value: string }[] }[] };
const vercel: Vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const headers = vercel.headers.find(({ source }) => source === '/(.*)')?.headers ?? [];
const header = (key: string) => headers.filter(entry => entry.key === key).map(entry => entry.value);

// Directive name → its sources, e.g. `script-src` → ["'self'", "'wasm-unsafe-eval'"].
const csp = new Map(header('Content-Security-Policy').join(';').split(';').map(directive => directive.trim())
  .filter(Boolean).map(directive => {
    const [name, ...sources] = directive.split(/\s+/);
    return [name, sources] as const;
  }));

// The local backend in dev and e2e (http://localhost:9100 and the per-checkout ports): the only
// plain-http sources, and only for images and API calls.
const DEV_HOSTS = ['http://localhost:*', 'http://127.0.0.1:*'];
const DEV_HOST_DIRECTIVES = ['img-src', 'connect-src'];

describe('web Content-Security-Policy (apps/expo/vercel.json)', () => {
  it('is set once, on every path', () => {
    expect(header('Content-Security-Policy')).toHaveLength(1);
    expect(csp.size).toBeGreaterThan(0);
  });

  // C1. When 'wasm-unsafe-eval' is narrowed to the SQLite worker, this changes with it.
  it("C1: script-src is exactly 'self' 'wasm-unsafe-eval'", () => {
    const scriptSrc = csp.get('script-src');
    expect(scriptSrc).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    for (const loose of ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', 'data:', 'blob:']) {
      expect(scriptSrc).not.toContain(loose);
    }
  });

  it('C2: default, object, base, frame-ancestors and form-action are locked down', () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
  });

  it('C3: no wildcard, no bare http:, no data: scripts; plain http only for the dev hosts', () => {
    for (const [name, sources] of csp) {
      expect(sources, name).not.toContain('*');
      expect(sources, name).not.toContain('http:');
      const plainHttp = sources.filter(source => source.startsWith('http://'));
      expect(plainHttp, name).toEqual(DEV_HOST_DIRECTIVES.includes(name) ? DEV_HOSTS : []);
    }
    expect(csp.get('script-src')).not.toContain('data:');
  });

  it('C4: the companion headers have their exact values', () => {
    expect(header('Referrer-Policy')).toEqual(['no-referrer']);
    expect(header('X-Content-Type-Options')).toEqual(['nosniff']);
    expect(header('Permissions-Policy')).toEqual(['camera=(), microphone=(), geolocation=()']);
  });
});
