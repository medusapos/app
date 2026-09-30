import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMedusaConnector } from '@tallyui/connector-medusa';

// medusapos takes @tallyui/* only from npm, pinned to one exact version (README "TallyUI").
// The root pnpm.overrides carry the same pins so they reach transitive deps; they stay pinned too.
const repoRoot = new URL('../../../', import.meta.url);
const readText = (relative: string) => readFileSync(new URL(relative, repoRoot), 'utf8');
const readJson = (relative: string) => JSON.parse(readText(relative));

type Pins = [name: string, version: string][];
const tallyui = (deps: Record<string, string> | undefined): Pins =>
  Object.entries(deps ?? {}).filter(([name]) => name.includes('@tallyui/'));
const fromManifest = (relative: string): Pins => {
  const manifest = readJson(relative);
  return [...tallyui(manifest.dependencies), ...tallyui(manifest.devDependencies)];
};
const names = (pins: Pins) => pins.map(([name]) => name).sort();

const overrides = tallyui(readJson('package.json').pnpm?.overrides);
const app = fromManifest('apps/expo/package.json');
const plugin = fromManifest('packages/medusa-plugin/package.json');
const allPins = [...overrides, ...app, ...plugin];

// An exact published version. The prerelease part lets a `3.0.0-rc.1` pin pass; file:, link:,
// workspace:, npm:, a path, a range, ^, ~ or a dist-tag all fail.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// A text scan, so no YAML parser is needed. Each lockfile line whose key starts with @tallyui/
// opens a block that runs until the next non-blank line indented no deeper than that key. This
// takes in the overrides and importers entries (`version: link:...`) and the packages entries
// (`resolution: {...}`), each with the lines nested under it.
function tallyuiLockBlocks(lockfile: string): string[] {
  const blocks: string[][] = [];
  let depth = -1;
  let open = false;
  for (const line of lockfile.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (open && line.trim() && indent <= depth) open = false;
    if (!open && /^'?@tallyui\//.test(line.trimStart())) {
      blocks.push([]);
      depth = indent;
      open = true;
    }
    if (open) blocks[blocks.length - 1].push(line);
  }
  return blocks.map((block) => block.join('\n'));
}

describe('TallyUI dependencies', () => {
  it('every @tallyui/* pin is an exact published version', () => {
    expect(app.length).toBeGreaterThanOrEqual(8);
    expect(plugin.length).toBeGreaterThan(0);
    expect(allPins.filter(([, version]) => !EXACT_VERSION.test(version))).toEqual([]);
  });

  it('all @tallyui/* pins share one version', () => {
    const versions = [...new Set(allPins.map(([, version]) => version))];
    expect(versions).toEqual([allPins[0][1]]);
  });

  it('pnpm.overrides and apps/expo/package.json list the same @tallyui/* packages', () => {
    expect(names(overrides)).toEqual(names(app));
    expect(overrides.length).toBeGreaterThanOrEqual(8);
  });

  it('the lockfile resolves every @tallyui/* package from the registry', () => {
    const blocks = tallyuiLockBlocks(readText('pnpm-lock.yaml'));
    expect(blocks.filter((block) => /\b(file|link|tarball):/.test(block))).toEqual([]);
    // Not vacuous: every published package has a registry resolution (an integrity hash).
    expect(blocks.filter((block) => /resolution: \{integrity:/.test(block)).length).toBeGreaterThanOrEqual(8);
  });

  it('the plugin lockfile resolves @tallyui/core from the registry, at the pinned version', () => {
    const version = allPins[0][1];
    const core = readJson('packages/medusa-plugin/package-lock.json').packages?.['node_modules/@tallyui/core'];
    expect(core?.version).toBe(version);
    expect(core?.link).toBeUndefined();
    expect(core?.resolved).toBe(`https://registry.npmjs.org/@tallyui/core/-/core-${version}.tgz`);
    expect(core?.integrity).toMatch(/^sha512-/);
  });

  it('the published Medusa connector resolves', () => {
    // 'medusa' is the id @tallyui/connector-medusa declares in src/index.ts; each store session builds its own (#307).
    expect(createMedusaConnector().id).toBe('medusa');
  });
});
