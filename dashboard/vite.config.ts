import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// In development the SPA runs on 1440 and talks to the `dashboard` Worker from `wrangler dev` on
// 8788, which verifies the dev auth bypass. Vite proxies `/api` and `/ws` there and rewrites
// Origin so the Worker's same-origin checks see its own origin.
const target = 'http://localhost:8788';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      '/api': { target, changeOrigin: true, headers: { origin: target } },
      '/ws': { target, ws: true, changeOrigin: true, headers: { origin: target } },
    },
  },
  test: { environment: 'jsdom', include: ['test/**/*.test.ts'] },
});
