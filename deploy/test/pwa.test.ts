import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Installable apps and the shells they live in — the claims the registry and
 * the shells make about them, re-derived from the files.
 *
 * - `constraints.installable` is true exactly where a module ships a manifest
 *   and the PWA copy-in (service worker template, build plugin, registration),
 *   and those are byte-identical to MOD-11's, like every other copy-in.
 * - A shell's catalogue says `installable` exactly where the registry does —
 *   it is what makes a pane open from the browser's copy when offline.
 * - Every module a shell can frame serves the shell's sign-out, and every
 *   shell frame grants the camera — or a module's scanner cannot start there.
 */

const root = new URL('../..', import.meta.url).pathname;
const registry = JSON.parse(readFileSync(join(root, 'modules/registry.json'), 'utf8')) as {
  modules: { id: string; constraints: Record<string, boolean> }[];
};
const REFERENCE = 'mod-11-time-tracking';
const PWA_FILES = ['src/pwa/sw.js', 'src/pwa/register.ts', 'scripts/pwa-plugin.mjs'];
const SHELLS = ['mod-15-workspace', 'mod-16-mosaic'];

const read = (id: string, rel: string) => readFileSync(join(root, 'modules', id, rel), 'utf8');
const has = (id: string, rel: string) => existsSync(join(root, 'modules', id, rel));

describe.each(registry.modules.map((m) => [m.id, m] as const))('%s', (id, mod) => {
  it('is installable exactly when it ships the manifest and the PWA copy-in', () => {
    const files = ['public/manifest.webmanifest', ...PWA_FILES].map((rel) => has(id, rel));
    expect(files, `${id}: installable is ${mod.constraints.installable}`).toEqual(files.map(() => mod.constraints.installable));
  });

  if (!mod.constraints.installable) return;

  it('carries the PWA copy-in unchanged, and uses it', () => {
    for (const rel of PWA_FILES) expect(read(id, rel), rel).toBe(read(REFERENCE, rel));
    expect(read(id, 'vite.config.ts')).toContain('serviceWorker()');
    expect(read(id, 'src/main.tsx')).toContain('registerServiceWorker();');
    expect(read(id, 'index.html')).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('has a manifest an app can be installed from', () => {
    const m = JSON.parse(read(id, 'public/manifest.webmanifest'));
    expect(m).toMatchObject({ name: expect.any(String), short_name: expect.any(String), display: 'standalone', scope: '/', start_url: expect.stringMatching(/^\//) });
    expect(m.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
    for (const icon of m.icons as { src: string }[]) expect(has(id, `public${icon.src}`), icon.src).toBe(true);
  });

  it('serves the service worker and its page uncached, so an update reaches an installed app', () => {
    expect(read(id, 'server/app.ts')).toMatch(/file\.endsWith\('sw\.js'\) \|\| file\.endsWith\('index\.html'\)/);
  });
});

describe('the service worker never holds an answer', () => {
  it('leaves /api and /session to the network, and only answers its own GETs', () => {
    const sw = read(REFERENCE, 'src/pwa/sw.js');
    expect(sw).toContain("if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/session/')) return;");
    expect(sw).toContain("if (request.method !== 'GET') return;");
    expect(sw).toContain('if (url.origin !== self.location.origin) return;');
  });
});

describe.each(SHELLS)('the shell %s', (shell) => {
  const catalogue = read(shell, 'shared/catalogue.ts');
  const entries = [...catalogue.matchAll(/\{ id: '([^']+)'[^\n]*installable: (true|false) \}/g)].map((m) => [m[1]!, m[2] === 'true'] as const);

  it('says installable exactly where the registry does', () => {
    expect(entries.length).toBeGreaterThan(10);
    for (const [id, installable] of entries) {
      const mod = registry.modules.find((m) => m.id === id);
      expect(mod, id).toBeDefined();
      expect(installable, `${shell} catalogue: ${id}`).toBe(mod!.constraints.installable);
    }
  });

  it('grants its frames the camera, the clipboard and full screen', () => {
    const frames = [...read(shell, shell === 'mod-16-mosaic' ? 'src/components/PaneFrame.tsx' : 'src/App.tsx').matchAll(/<iframe[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).toContain('allow={FRAME_ALLOW}');
    expect(read(shell, 'src/frame.ts')).toContain("export const FRAME_ALLOW = 'camera; clipboard-read; clipboard-write; fullscreen';");
  });
});

describe('signing out from a shell', () => {
  it('is served by every module that takes a handoff', () => {
    const framable = registry.modules.filter((m) => has(m.id, 'server/app.ts') && read(m.id, 'server/app.ts').includes("app.get('/session/handoff'"));
    expect(framable.length).toBeGreaterThan(10);
    for (const m of framable) {
      expect(read(m.id, 'server/app.ts'), m.id).toContain("app.get('/session/logout', (req, res) => {\n      const out = signOutResponse(req.headers['sec-fetch-site'], clearedCookie());");
      expect(has(m.id, 'test/sign-out.test.ts'), m.id).toBe(true);
      expect(read(m.id, 'test/sign-out.test.ts')).toBe(read(REFERENCE, 'test/sign-out.test.ts'));
    }
  });
});
