import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, it } from 'vitest';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const root = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<\/body>/)?.[1];
const style = html.match(/<style id="splash-style">([\s\S]*?)<\/style>/)?.[1];

it('index.html paints a splash inside #root: MedusaPOS and a loading line', () => {
  expect(root).toMatch(/^\s*<div id="splash" role="status" aria-live="polite">[\s\S]*<\/div>\s*$/);
  expect(root).toMatch(/<h1>MedusaPOS<\/h1>/);
  expect(root).toMatch(/<p>Loading the point of sale…<\/p>/);
});

it('the splash uses no script, no external URL, and inline styles only', () => {
  expect(style).toBeDefined();
  expect(`${root}${style}`).not.toMatch(/<script|http|url\(/i);
});

it('the splash markup and style stay under 2 KB', () => {
  expect(style).toBeDefined();
  expect(Buffer.byteLength(style ?? '')).toBeLessThan(1024);
  expect(Buffer.byteLength(`${root ?? ''}${style ?? ''}`)).toBeLessThan(2048);
});
