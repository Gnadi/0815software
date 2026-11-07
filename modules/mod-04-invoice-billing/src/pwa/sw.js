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

/* ── Push and the app badge (docs/NOTIFICATIONS-PLAN.md) ──────────────────
 * A push carries what PS-03 encrypted for this device: a title that is safe on
 * a lock screen, a body (the details only if the person chose that), and which
 * module to open. It never carries a count: the badge is asked for here, from
 * /api/inbox/count with this app's own session, so it is always what the
 * modules say waits now — never a number that drifted. Signed out or offline,
 * the badge becomes a plain dot: something is new, sign in to see it.
 */
async function recountBadge() {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    const res = await fetch('/api/inbox/count', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const { count } = await res.json();
    if (count > 0) await self.navigator.setAppBadge(count);
    else await self.navigator.clearAppBadge();
  } catch {
    await self.navigator.setAppBadge().catch(() => undefined);
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : 'New notification' };
  }
  const title = data.title || 'New notification';
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: data.body || '',
        tag: data.tag || undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { module: data.module || null, href: data.href || null },
      }),
      recountBadge(),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { module } = event.notification.data || {};
  // The app opens the module the notification is about (a shell reads ?open=).
  const target = module ? `/?open=${encodeURIComponent(module)}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const win of windows) {
        if (new URL(win.url).origin === self.location.origin && 'focus' in win) {
          win.postMessage({ type: 'open', module: module || null });
          return win.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'recount') event.waitUntil(recountBadge());
});
