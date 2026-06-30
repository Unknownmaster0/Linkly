import { defineConfig } from 'vitest/config';

// Test config for the worker's async-job suite (Day 15).
//
// `npm run test`            → all tests + HTML coverage (the one command)
// `npm run test:unit`       → tests/unit only (pure, no DB)
// `npm run test:integration`→ tests/integration only (needs Postgres)
//
// Coverage is scoped to the code under test (jobs/ + repositories/). The
// generated Prisma client, the worker.ts wiring entry point, and the
// config/logger/db bootstrap are excluded — covering them would only add noise
// to the percentage. Report-only: a low number never fails the run.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests open one shared Postgres connection and truncate
    // between tests; running their files in parallel would let them clobber
    // each other's rows. Unit tests are unaffected.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'tests/coverage',
      include: ['src/jobs/**', 'src/repositories/**'],
      exclude: [
        'src/jobs/run-aggregation.ts', // thin CLI wrapper — exercised manually
        'src/jobs/run-expiry.ts',
      ],
    },
  },
});
