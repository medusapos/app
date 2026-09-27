import fs from 'node:fs';
import path from 'node:path';

/**
 * Mirrors metro.config.js's own `@tallyui/<pkg>/<sub>` resolution, for vitest: for every package
 * linked under `tallyuiDir`, reads its package.json `exports` and, for each subpath key (skipping
 * `.`) whose value declares a `source`, returns an alias `@tallyui/<pkg>/<sub>` -> that source
 * file. The package directory is resolved with `fs.realpathSync`, matching `componentsRoot` in
 * vitest.config.ts, for the same reason: a linked package's own relative imports are keyed by its
 * real path, not the node_modules symlink.
 */
export function tallyuiSubpathAliases(tallyuiDir: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!fs.existsSync(tallyuiDir)) return aliases;

  for (const pkgName of fs.readdirSync(tallyuiDir)) {
    const pkgJsonPath = path.join(tallyuiDir, pkgName, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    const exportsField = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).exports;
    if (!exportsField || typeof exportsField !== 'object') continue;

    const realDir = fs.realpathSync(path.join(tallyuiDir, pkgName));
    for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
      if (key === '.') continue;
      const source = (value as { source?: string } | undefined)?.source;
      if (source) aliases[`@tallyui/${pkgName}${key.slice(1)}`] = path.join(realDir, source);
    }
  }

  return aliases;
}
