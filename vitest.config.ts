import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // `pnpm test:coverage`: how much of the bot's code the tests run, by file.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      reporter: ['text-summary', 'text'],
      // CI fails if coverage drops below these (just under what the tests reach today).
      thresholds: { lines: 98, statements: 97, functions: 97, branches: 92 },
    },
  },
});
