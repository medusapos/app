import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CHOICES } from './theme-choice';

// Uniwind needs every theme to define the same variables. The seven extra themes in themes.css must
// define exactly the `--color-*` set of @tallyui/theme's dark theme (tokens.css `@variant dark`) plus
// what global.css adds to its own dark variant (v2's tile tints and destructive), so a TallyUI bump
// that adds a token fails here instead of leaving it unset in those themes.
const read = (path: string) => readFileSync(path, 'utf8');
const tokensCss = read(createRequire(new URL('../package.json', import.meta.url)).resolve('@tallyui/theme/tokens.css'));
const themesCss = read(new URL('../themes.css', import.meta.url).pathname);
const globalCss = read(new URL('../global.css', import.meta.url).pathname);
const metroConfig = read(new URL('../metro.config.js', import.meta.url).pathname);

/** The body of each `@variant <name> {` block, by brace depth. */
function variants(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/@variant ([a-z-]+) \{/g)) {
    const start = match.index! + match[0].length;
    let depth = 1, i = start;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    out.set(match[1], css.slice(start, i - 1));
  }
  return out;
}
const colorNames = (body: string) => new Set([...body.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map(m => m[1]));

const tokensDark = variants(tokensCss).get('dark');
const appDark = variants(globalCss).get('dark');
const expected = new Set([...colorNames(tokensDark ?? ''), ...colorNames(appDark ?? '')]);
const extraThemes = variants(themesCss);
const EXTRA_CHOICES = THEME_CHOICES.filter(choice => !['system', 'light', 'dark'].includes(choice));

describe('themes.css', () => {
  it('reads a dark theme from @tallyui/theme and from global.css', () => {
    expect(tokensDark).toBeDefined();
    expect(appDark).toBeDefined();
    expect(expected.size).toBeGreaterThan(40);
  });

  it('defines the seven extra themes that metro.config.js and THEME_CHOICES register', () => {
    const metro = metroConfig.match(/extraThemes:\s*\[([^\]]*)\]/)?.[1].match(/[a-z-]+/g);
    expect([...extraThemes.keys()]).toEqual(EXTRA_CHOICES);
    expect(metro).toEqual(EXTRA_CHOICES);
    expect(EXTRA_CHOICES).toHaveLength(7);
  });

  it.each(EXTRA_CHOICES)('%s defines exactly the dark theme tokens', (theme) => {
    const names = colorNames(extraThemes.get(theme) ?? '');
    const missing = [...expected].filter(name => !names.has(name));
    const extra = [...names].filter(name => !expected.has(name));
    expect({ theme, missing, extra }).toEqual({ theme, missing: [], extra: [] });
  });
});
