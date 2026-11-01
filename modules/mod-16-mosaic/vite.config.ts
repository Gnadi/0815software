import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Copy-in: the service worker of an installable module (scripts/pwa-plugin.mjs).
import { serviceWorker } from './scripts/pwa-plugin.mjs';

export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5206,
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 3016}`,
    },
  },
});
