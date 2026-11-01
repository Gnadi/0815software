import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The installable app (public/manifest.webmanifest, src/pwa/sw.js): it
 * names files that exist, and its service worker keeps the app — never an
 * answer about a person — in its cache.
 */

const here = (p: string) => new URL(`../${p}`, import.meta.url);

describe('the manifest', () => {
  it('is installable: a name, standalone, icons that exist including a maskable one', () => {
    const m = JSON.parse(readFileSync(here('public/manifest.webmanifest'), 'utf8'));
    expect(m).toMatchObject({ name: expect.any(String), short_name: expect.any(String), display: 'standalone', start_url: expect.stringMatching(/^\//), scope: '/' });
    expect(m.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
    for (const icon of m.icons as { src: string }[]) expect(existsSync(here(`public${icon.src}`)), icon.src).toBe(true);
    expect(readFileSync(here('index.html'), 'utf8')).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });
});

describe('the service worker', () => {
  const sw = readFileSync(here('src/pwa/sw.js'), 'utf8');

  it('is filled in by the build with this build\'s files and a version', () => {
    expect(sw).toContain("const VERSION = '__VERSION__';");
    expect(sw).toContain('const PRECACHE = __PRECACHE__;');
    expect(readFileSync(here('scripts/pwa-plugin.mjs'), 'utf8')).toContain("fileName: 'sw.js'");
    expect(readFileSync(here('vite.config.ts'), 'utf8')).toContain('serviceWorker()');
  });

  it('leaves /api and the shell handoff to the network, untouched and uncached', () => {
    expect(sw).toContain("if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/session/')) return;");
    // Only GETs of its own origin are ever answered from the cache.
    expect(sw).toContain("if (request.method !== 'GET') return;");
    expect(sw).toContain('if (url.origin !== self.location.origin) return;');
  });
});

describe('signed out from the shell', () => {
  it('serves GET /session/logout only with a shell named, and only to the stack', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../server/app.js');
    const { openDb } = await import('../server/db.js');
    const auth = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
    const framed = createApp({ db: openDb(':memory:'), auth, shellOrigins: ['https://mosaic.acme.example'] });
    const res = await request(framed).get('/session/logout').set('Sec-Fetch-Site', 'same-site').expect(200);
    expect(res.headers['clear-site-data']).toBe('"storage"');
    expect(res.headers['set-cookie']![0]).toMatch(/Max-Age=0/);
    await request(framed).get('/session/logout').set('Sec-Fetch-Site', 'cross-site').expect(403);
    // Standalone: no shell, no such route — it falls through like any unknown path.
    const standalone = createApp({ db: openDb(':memory:'), auth });
    expect((await request(standalone).get('/session/logout')).headers['clear-site-data']).toBeUndefined();
  });
});
