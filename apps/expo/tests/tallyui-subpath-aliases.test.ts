import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tallyuiSubpathAliases } from './tallyui-subpath-aliases';
import vitestConfig from '../../../vitest.config';

let tmpDir: string;

beforeEach(() => {
  // Resolved because macOS's os.tmpdir() is itself a symlink (/tmp -> /private/tmp); the fixture
  // packages below assert against the same realpath the builder returns.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tallyui-subpath-aliases-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePackage(name: string, exportsField: unknown): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ exports: exportsField }));
  return dir;
}

describe('tallyuiSubpathAliases', () => {
  it('aliases a subpath export that declares a source', () => {
    const dir = writePackage('pkg-a', {
      '.': { source: './src/index.ts' },
      './rxdb': { source: './src/rxdb/index.ts' },
    });

    expect(tallyuiSubpathAliases(tmpDir)).toEqual({
      '@tallyui/pkg-a/rxdb': path.join(dir, 'src/rxdb/index.ts'),
    });
  });

  it('skips a subpath export with no source', () => {
    writePackage('pkg-b', {
      '.': { source: './src/index.ts' },
      './no-source': { types: './dist/no-source.d.ts' },
    });

    expect(tallyuiSubpathAliases(tmpDir)).toEqual({});
  });

  it('skips a package with no exports field', () => {
    const dir = path.join(tmpDir, 'pkg-c');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-c' }));

    expect(tallyuiSubpathAliases(tmpDir)).toEqual({});
  });
});

describe('@tallyui subpaths, resolved for real through the vitest pipeline', () => {
  it('resolves @tallyui/storage-sqlite/web', async () => {
    const mod = await import('@tallyui/storage-sqlite/web');
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  const coreRealDir = fs.realpathSync(path.resolve(__dirname, '../node_modules/@tallyui/core'));
  const corePkg = JSON.parse(fs.readFileSync(path.join(coreRealDir, 'package.json'), 'utf8'));
  const coreHasRxdbSubpath = Boolean(corePkg.exports?.['./rxdb']);

  // Skipped at the current TallyUI pin (03ad08a): core doesn't declare `./rxdb` yet. This goes
  // live on the next pin bump, once core's package.json exports it. The specifier is built at
  // runtime (not a string literal) so `tsc` doesn't try to statically resolve a subpath that
  // doesn't exist yet.
  it.skipIf(!coreHasRxdbSubpath)('resolves @tallyui/core/rxdb', async () => {
    const specifier = ['@tallyui/core', 'rxdb'].join('/');
    const mod = await import(specifier);
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

describe('alias order in vitest.config.ts', () => {
  it('lists each generated @tallyui/<pkg>/<sub> alias before the general @tallyui/<pkg> alias', () => {
    const tallyuiRoot = fs.realpathSync(path.resolve(__dirname, '../node_modules/@tallyui'));
    const generated = tallyuiSubpathAliases(tallyuiRoot);
    const configKeys = Object.keys(vitestConfig.resolve!.alias as Record<string, string>);

    // Sanity: the current pin does generate at least one (storage-sqlite's `./web`), so this
    // isn't vacuously true.
    expect(Object.keys(generated).length).toBeGreaterThan(0);

    for (const subpathAlias of Object.keys(generated)) {
      const pkgAlias = subpathAlias.replace(/\/[^/]+$/, '');
      const subpathIndex = configKeys.indexOf(subpathAlias);
      const pkgIndex = configKeys.indexOf(pkgAlias);

      expect(subpathIndex).toBeGreaterThanOrEqual(0);
      if (pkgIndex !== -1) expect(subpathIndex).toBeLessThan(pkgIndex);
    }
  });
});
