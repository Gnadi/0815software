/**
 * Registering the service worker — copy-in, byte-identical in every
 * installable module.
 *
 * Only the built app registers: in development a cached app would hide every
 * change. When a new version has taken over, a small notice offers to reload
 * — never a reload on its own, which would throw away what someone is typing.
 * The notice is plain DOM with its own inline style, so it looks the same in
 * every app and depends on none of them.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install takes control of a page that already runs this version.
    if (hadController) showUpdateNotice();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[pwa] service worker not registered:', err));
  });
}

function showUpdateNotice(): void {
  if (document.getElementById('pwa-update')) return;
  const bar = document.createElement('div');
  bar.id = 'pwa-update';
  bar.setAttribute('role', 'status');
  bar.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;' +
    'padding:10px 14px;background:#e8e4dc;color:#0a0a0a;border-radius:2px;font:12px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.5px;box-shadow:0 4px 24px rgba(0,0,0,.4)';
  const text = document.createElement('span');
  text.textContent = 'A NEW VERSION IS READY';
  const reload = document.createElement('button');
  reload.textContent = 'RELOAD';
  reload.style.cssText = 'font:inherit;letter-spacing:inherit;padding:4px 10px;border:1px solid #0a0a0a;background:none;color:inherit;cursor:pointer';
  reload.onclick = () => window.location.reload();
  bar.append(text, reload);
  document.body.append(bar);
}
