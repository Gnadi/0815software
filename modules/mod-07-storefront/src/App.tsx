import { AdminApp } from './components/AdminApp';
import { ShopApp } from './components/ShopApp';

/**
 * One app, two faces. The path decides once, on load:
 *
 *   /admin              → the staff face (login + management)
 *   /order/:ref?token=… → the shop face, opened on the guest order
 *                         status view (the link from the confirmation)
 *   everything else     → the shop face (catalogue)
 *
 * Navigation inside a face is plain component state, same as the other
 * modules — no router dependency.
 */
export function App() {
  const path = window.location.pathname;

  if (path === '/admin' || path.startsWith('/admin/')) {
    return <AdminApp />;
  }

  const orderMatch = /^\/order\/([^/]+)$/.exec(path);
  if (orderMatch) {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    return <ShopApp initialOrder={{ ref: decodeURIComponent(orderMatch[1]!), token }} />;
  }

  return <ShopApp />;
}
