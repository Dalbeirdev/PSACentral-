import { defineConfig } from 'vitest/config';

/** Fleet-scale load test (TEST-LOAD): `pnpm test:load` — not part of the default `pnpm test`. */
export default defineConfig({
  test: {
    name: 'load',
    include: ['test/load/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
