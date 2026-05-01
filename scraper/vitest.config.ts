import { defineConfig } from 'vitest/config';

/**
 * Vitest config — sets the env vars `src/config.ts` requires for the parser
 * tests to load. We're testing pure functions (parsing + normalization);
 * no DB or Redis traffic happens in unit tests.
 */
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'rediss://test:test@localhost:6379',
      SCRAPER_ENABLED: 'false',
      DAT_ENABLED: 'false',
      TRUCKSTOP_ENABLED: 'false',
      LOADBOARD123_ENABLED: 'false',
      LOADLINK_ENABLED: 'false',
      LOG_LEVEL: 'error', // quiet test output
    },
    include: ['test/**/*.test.ts'],
  },
});
