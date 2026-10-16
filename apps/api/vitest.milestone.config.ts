import { defineConfig } from 'vitest/config';

/** First-milestone acceptance against the containerized Control Plane: `pnpm test:milestone`. */
export default defineConfig({
  test: {
    name: 'milestone',
    include: ['test/milestone/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
