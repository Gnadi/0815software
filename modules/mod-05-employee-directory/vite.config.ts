import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5195,
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 3005}`,
    },
  },
});
