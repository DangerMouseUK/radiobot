import { configDefaults, defineConfig } from 'vitest/config';

/** Measures event-loop delay while a stream plays, so it runs on its own (see `projects`). */
const BUDGET_TEST = 'tests/integration/main-thread-budget.test.ts';

export default defineConfig({
  test: {
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
    projects: [
      {
        extends: true,
        test: {
          name: 'tests',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, BUDGET_TEST],
          sequence: { groupOrder: 0 },
        },
      },
      // After every other file has finished: test processes running alongside it on the same
      // CPUs would be measured as event-loop delay too.
      {
        extends: true,
        test: { name: 'budget', include: [BUDGET_TEST], sequence: { groupOrder: 1 } },
      },
    ],
  },
});
