import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { tallyuiSubpathAliases } from './apps/expo/tests/tallyui-subpath-aliases';

const tallyuiRoot = path.resolve(__dirname, 'apps/expo/node_modules/@tallyui');

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
      // Export subpath aliases must precede general `@tallyui/<name>` aliases:
      // Vite's string aliases also match `find + '/'`, so a general alias
      // would otherwise shadow e.g. `@tallyui/core/rxdb`.
      ...tallyuiSubpathAliases(tallyuiRoot),
      ...Object.fromEntries(['core', 'components', 'database', 'pos', 'primitives', 'theme', 'connector-medusa'].map(
        (name) => [`@tallyui/${name}`, path.resolve(__dirname, `apps/expo/node_modules/@tallyui/${name}/src/index.ts`)],
      )),
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
