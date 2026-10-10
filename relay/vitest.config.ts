import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.relay.jsonc' } })],
        test: { name: 'workers', include: ['test/**/*.test.ts'], exclude: ['test/node/**'] },
      },
      {
        test: { name: 'node', include: ['test/node/**/*.test.ts'] },
      },
    ],
  },
});
