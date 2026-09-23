import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'dev/**', 'packages/medusa-plugin/**'],
    passWithNoTests: true,
    // The shared agent host caps test workers at 2.
    maxWorkers: 2,
  },
});
