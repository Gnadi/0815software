/* Service worker — copy-in, byte-identical in every installable module
 * (registry: constraints.installable). The build writes it into
 * dist/client/sw.js with the app's name, a version and the list of files
 * (scripts/pwa-plugin.mjs).
 *
 * It keeps the APP available offline and nothing else:
 *   - the app's own files are cached at install, and served from the cache;
 *   - a page load goes to the network first and falls back to the cached app;
 *   - /api and /session are never touched: no answer about a person or a
 *     business is ever cached, and an answer from yesterday would be worse
 *     than none. What an app captures offline waits in its own storage, not
 *     here.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const PREFIX = '__CACHE__-';
const CACHE = `${PREFIX}${VERSION}`;

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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
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
