/* MOD-11 service worker — written into dist/client/sw.js by the build
 * (vite.config.ts fills in the version and the list of files).
 *
 * It keeps the APP available offline and nothing else:
 *   - the app's own files are cached at install, and served from the cache;
 *   - a page load goes to the network first and falls back to the cached app;
 *   - /api is never touched: no answer about a person is ever cached, and an
 *     answer from yesterday would be worse than none. What is captured
 *     offline waits in the app's own outbox (src/pwa/outbox.ts), not here.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `mod-11-app-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mod-11-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/session/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match('/index.html'))));
    return;
  }
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(request).then((hit) => hit || fetch(request))),
  );
});
