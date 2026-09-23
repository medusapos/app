import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'react-native': 'react-native-web',
      react: path.resolve(__dirname, 'apps/expo/node_modules/react'),
      'react-dom': path.resolve(__dirname, 'apps/expo/node_modules/react-dom'),
      ...Object.fromEntries(['core', 'components', 'database', 'pos', 'primitives', 'theme', 'connector-medusa'].map(
        (name) => [`@tallyui/${name}`, path.resolve(__dirname, `apps/expo/node_modules/@tallyui/${name}/src/index.ts`)],
      )),
    },
  },
  test: {
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'dev/**', 'packages/medusa-plugin/**'],
    passWithNoTests: true,
    // The shared agent host caps test workers at 2.
    maxWorkers: 2,
  },
});
