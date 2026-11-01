import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The service worker (src/pwa/sw.js), written next to the build with the
 * exact files of THIS build to cache, and a version derived from them — so a
 * new deployment is a new cache, and the old one is dropped on activation.
 * Hand-rolled on purpose: a dozen lines instead of a plugin dependency.
 */
function serviceWorker(): Plugin {
  const fromPublic = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
  return {
    name: 'mod-11-service-worker',
    apply: 'build',
    // After Vite's own plugins, so index.html is in the bundle to be listed.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map'))
        .sort()
        .map((file) => `/${file}`);
      const files = [...built, ...fromPublic];
      const hash = createHash('sha256');
      for (const [file, chunk] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(file);
        hash.update(chunk.type === 'chunk' ? chunk.code : typeof chunk.source === 'string' ? chunk.source : Buffer.from(chunk.source));
      }
      const source = readFileSync(new URL('./src/pwa/sw.js', import.meta.url), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 16))
        .replace('__PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5201,
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 3011}`,
    },
  },
});
