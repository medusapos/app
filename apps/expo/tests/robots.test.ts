import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Vercel = { rewrites: { source: string; has?: { type: string; value: string }[]; destination: string }[] };
const vercel: Vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
describe('web robots.txt and sitemap.xml (apps/expo/vercel.json)', () => {
  it('maps each host to its robots file with exactly one host condition', () => {
    const robots = vercel.rewrites.filter(({ source }) => source === '/robots.txt');
    expect(robots).toHaveLength(2);
    expect(Object.fromEntries(robots.map(({ has, destination }) => {
      expect(has).toEqual([{ type: 'host', value: expect.any(String) }]);
      return [has?.[0].value, destination];
    }))).toEqual({ 'demo.medusapos.com': '/robots-demo.txt', 'app.medusapos.com': '/robots-app.txt' });
  });
  it('preserves demo robots and allows app crawling without naming a host or sitemap', () => {
    // A file in the output is served before rewrites, on every host.
    expect(existsSync(new URL('../public/robots.txt', import.meta.url))).toBe(false);
    expect(readFileSync(new URL('../public/robots-demo.txt', import.meta.url), 'utf8')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://demo.medusapos.com/sitemap.xml\n');
    const app = readFileSync(new URL('../public/robots-app.txt', import.meta.url), 'utf8');
    expect(app.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
    expect(app).not.toMatch(/:\/\/|sitemap:|medusapos\.com/i);
  });
  it('serves the unchanged sitemap only on the demo host', () => {
    const sitemap = vercel.rewrites.filter(({ source }) => source === '/sitemap.xml');
    expect(sitemap).toHaveLength(1);
    expect(sitemap).toEqual([{ source: '/sitemap.xml', has: [{ type: 'host', value: 'demo.medusapos.com' }], destination: '/sitemap-demo.xml' }]);
    // A file in the output is served before rewrites, on every host.
    expect(existsSync(new URL('../public/sitemap.xml', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../public/sitemap-app.xml', import.meta.url))).toBe(false);
    expect(readFileSync(new URL('../public/sitemap-demo.xml', import.meta.url), 'utf8')).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://demo.medusapos.com/</loc>\n  </url>\n  <url>\n    <loc>https://demo.medusapos.com/demo</loc>\n  </url>\n</urlset>\n');
  });
});
