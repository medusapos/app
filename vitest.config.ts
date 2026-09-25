import { defineConfig } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';

// pnpm links `@tallyui/components` into apps/expo/node_modules as a symlink; Vite resolves
// symlinks (does not preserve them) when it loads a file reached through one, so a component's
// own relative imports (e.g. Catalogue's `../product`) end up keyed by the *real* path, not this
// symlink path. A deep alias must resolve through the same real path, or vi.mock (which matches by
// resolved module id) never intercepts what the real component actually imports.
const componentsRoot = fs.realpathSync(path.resolve(__dirname, 'apps/expo/node_modules/@tallyui/components'));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'react-native': 'react-native-web',
      // TallyUI's own vitest config points react-native-svg at its web element source for the same
      // reason: a component's SVG icon (e.g. SearchInput's SearchIcon) must render through
      // react-native-web, never the native (Flow-typed) entry.
      'react-native-svg': path.resolve(__dirname, 'apps/expo/node_modules/react-native-svg/src/elements.web.ts'),
      react: path.resolve(__dirname, 'apps/expo/node_modules/react'),
      'react-dom': path.resolve(__dirname, 'apps/expo/node_modules/react-dom'),
      // @tallyui/components' own sale/product/input/ui submodules, so a test can mock exactly the
      // module a real (importOriginal-sourced) component imports internally (e.g. Cart's `../cart`,
      // Catalogue's `../product`) without a literal node_modules path. These must be listed before
      // the plain `@tallyui/components` alias below: Vite's string aliases match a `find + '/'`
      // prefix as well as an exact string, checked in listed order, so `@tallyui/components` would
      // otherwise shadow `@tallyui/components/cart` and mis-resolve it to `.../index.ts/cart`.
      ...Object.fromEntries(['cart', 'checkout', 'product', 'input', 'ui'].map(
        (name) => [`@tallyui/components/${name}`, path.join(componentsRoot, `src/${name}/index.ts`)],
      )),
      ...Object.fromEntries(['core', 'components', 'database', 'pos', 'primitives', 'theme', 'connector-medusa'].map(
        (name) => [`@tallyui/${name}`, path.resolve(__dirname, `apps/expo/node_modules/@tallyui/${name}/src/index.ts`)],
      )),
      '@tallyui/storage-sqlite/web': path.resolve(__dirname, 'apps/expo/node_modules/@tallyui/storage-sqlite/src/web/index.ts'),
    },
  },
  test: {
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'dev/**', 'packages/medusa-plugin/**'],
    passWithNoTests: true,
    setupFiles: ['apps/expo/tests/setup-storage.ts'],
    // The shared agent host caps test workers at 2.
    maxWorkers: 2,
    server: {
      // vitest externalizes packages under node_modules by default, which skips the app's alias
      // pipeline (react-native -> react-native-web) for files @tallyui/components imports
      // internally, loading the native (Flow-typed) react-native entry and failing with
      // "SyntaxError: Unexpected token 'typeof'". Inlining keeps every @tallyui/* module on the
      // same transform + alias pipeline as the rest of the app.
      deps: { inline: [/@tallyui\//] },
    },
  },
});
