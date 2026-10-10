import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // One shared local stack and a few seconds of real simulated time per scenario.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
