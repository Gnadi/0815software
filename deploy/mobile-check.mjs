#!/usr/bin/env node
/**
 * Is every module usable on a phone? (docs/MOBILE-PLAN.md, section 5)
 *
 *   node deploy/mobile-check.mjs [mod-04-invoice-billing …] [--skip-build] [--shots <dir>]
 *
 * For each module: build it, start the production server on a scratch
 * database (the module seeds its demo data), sign in with the local
 * administrator, and visit every entry of its navigation at 360 × 740,
 * 390 × 844 and 1280 × 800. Each view must pass:
 *
 *   M1  no horizontal scrolling of the page,
 *   M2  every visible control at least 44 px tall on a phone (24 px for a
 *       checkbox; a link inside running text is exempt — WCAG 2.5.8),
 *   M3  form fields with a 16 px font or larger on a phone (iOS zooms in
 *       on anything smaller and does not zoom out again),
 *   M4  a table shown as cards keeps every value on the screen,
 *   M7  the navigation reachable without scrolling sideways.
 *
 * Exits non-zero when a view fails, and writes a screenshot of it. Needs
 * Playwright with Chromium (preinstalled in CI images and dev containers;
 * `.github/workflows/mobile.yml` installs it).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = await import('playwright');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const shotsAt = args.indexOf('--shots');
const SHOTS = resolve(shotsAt >= 0 ? args[shotsAt + 1] : join(ROOT, 'deploy', 'mobile-shots'));
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--shots');
const ALL = readdirSync(join(ROOT, 'modules')).filter((d) => /^mod-\d\d-/.test(d)).sort();
const MODULES = wanted.length > 0 ? wanted : ALL;

const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 740, phone: true },
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop', width: 1280, height: 800, phone: false },
];

/** Where a module keeps its staff sign-in, when it is not the front page. */
const LOGIN_PATH = { 'mod-07-storefront': '/admin', 'mod-01-customer-portal': '/', 'mod-12-support-tickets': '/agent' };
/** Pages the public sees without signing in — a customer's phone counts too. */
const PUBLIC_PATHS = { 'mod-07-storefront': ['/'], 'mod-12-support-tickets': ['/'] };
/** Modules that need a setting to boot at all. */
const EXTRA_ENV = {};

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function startModule(id) {
  const dir = join(ROOT, 'modules', id);
  if (!skipBuild) execFileSync('npm', ['run', '--silent', 'build'], { cwd: dir, stdio: 'inherit' });
  const scratch = mkdtempSync(join(tmpdir(), `${id}-`));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_PATH: join(scratch, 'data.db'),
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'mobile-check',
    SESSION_SECRET: 'mobile-check-secret',
    STORAGE_DIR: join(scratch, 'storage'),
    EXPORTS_DIR: join(scratch, 'exports'),
    DOCUMENTS_DIR: join(scratch, 'documents'),
    NODE_ENV: 'development',
    ...(EXTRA_ENV[id] ?? {}),
  };
  const child = spawn('node', ['dist/server/server/index.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, stop: () => (child.kill(), rmSync(scratch, { recursive: true, force: true })), log: () => log };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`${id} did not start:\n${log}`);
}

async function signIn(page, base, id) {
  await page.goto(`${base}${LOGIN_PATH[id] ?? '/'}`, { waitUntil: 'networkidle' });
  const user = page.locator('input[autocomplete="username"], input[type="email"], input[name="username"]').first();
  if ((await user.count()) === 0) return;
  await user.fill(id === 'mod-01-customer-portal' ? 'anna@example.com' : 'admin');
  await page.locator('input[type="password"]').first().fill(id === 'mod-01-customer-portal' ? 'demo-customer' : 'mobile-check');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

/** Everything the checks look at, measured inside the page. */
function measure([phone, expected]) {
  // A phone browser zooms OUT when something is wider than the screen, and
  // then innerWidth is the zoomed-out width — so compare with the device's.
  const vw = expected;
  const doc = document.documentElement;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${cls}`;
  };
  // An element is only "too wide" if no ancestor of it scrolls on its own.
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(s.overflowX)) return true;
    }
    return false;
  };
  const wide = [];
  if (doc.scrollWidth > vw + 1 || window.innerWidth > vw + 1) {
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el) || clipped(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1) wide.push(`${name(el)} (${Math.round(r.right)}px)`);
    }
  }
  // A table laid out as cards must show every value on the screen — not
  // off to the right inside its own scrolling box, which M1 cannot see.
  const offCard = [];
  for (const cell of document.querySelectorAll('table.table--cards td')) {
    if (!visible(cell)) continue;
    const r = cell.getBoundingClientRect();
    if (r.right > vw + 1) offCard.push(`${cell.getAttribute('data-label') || 'cell'} (${Math.round(r.right)}px)`);
  }
  const small = [];
  const tiny = [];
  if (phone) {
    for (const el of document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // A link inside running text is exempt (WCAG 2.5.8, "inline").
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
      const min = el.type === 'checkbox' || el.type === 'radio' ? 24 : 44;
      if (r.height < min - 0.5) small.push(`${name(el)} ${Math.round(r.height)}px`);
    }
    for (const el of document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea')) {
      if (!visible(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) tiny.push(`${name(el)} ${size}px`);
    }
  }
  return {
    overflow: Math.max(doc.scrollWidth, window.innerWidth) - vw,
    offCard: [...new Set(offCard)].slice(0, 5),
    offCardCount: offCard.length,
    wide: [...new Set(wide)].slice(0, 8),
    small: [...new Set(small)].slice(0, 8),
    smallCount: small.length,
    tiny: [...new Set(tiny)].slice(0, 5),
  };
}

async function checkModule(browser, id) {
  const server = await startModule(id);
  const failures = [];
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.phone, isMobile: vp.phone });
      const page = await context.newPage();
      for (const path of PUBLIC_PATHS[id] ?? []) {
        await page.goto(`${server.base}${path}`, { waitUntil: 'networkidle' });
        const m = await page.evaluate(measure, [vp.phone, vp.width]);
        const problems = [];
        if (m.overflow > 1) problems.push(`M1 page scrolls sideways by ${m.overflow}px: ${m.wide.join(', ')}`);
        if (vp.phone && m.offCardCount > 0) problems.push(`M4 ${m.offCardCount} card value(s) off the screen: ${m.offCard.join(', ')}`);
        if (vp.phone && m.smallCount > 0) problems.push(`M2 ${m.smallCount} control(s) under 44px: ${m.small.join(', ')}`);
        if (vp.phone && m.tiny.length > 0) problems.push(`M3 fields under 16px: ${m.tiny.join(', ')}`);
        if (problems.length > 0) {
          mkdirSync(SHOTS, { recursive: true });
          const file = join(SHOTS, `${id}--${vp.name}--public${path.replace(/[^a-z0-9]+/gi, '-')}.png`);
          await page.screenshot({ path: file, fullPage: true });
          failures.push({ view: `public ${path}`, viewport: vp.name, problems, screenshot: file });
        }
      }
      await signIn(page, server.base, id);
      const navSel = '.sidebar__nav button, .sidebar__nav a, .ws__tabs button, nav button';
      const labels = await page.locator(navSel).evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()).filter(Boolean));
      const views = labels.length > 0 ? labels : ['(start)'];
      for (const label of [...new Set(views)].slice(0, 20)) {
        if (label !== '(start)') {
          const target = page.locator(navSel).filter({ hasText: label }).first();
          if ((await target.count()) === 0 || !(await target.isVisible())) continue;
          try {
            await target.click({ timeout: 5000 });
          } catch {
            // Something covers it, or it never settles: on a phone that is a
            // navigation entry nobody can reach.
            failures.push({ view: label, viewport: vp.name, problems: [`M7 "${label}" cannot be tapped — something covers it`], screenshot: null });
            continue;
          }
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(250);
        }
        const m = await page.evaluate(measure, [vp.phone, vp.width]);
        const problems = [];
        if (m.overflow > 1) problems.push(`M1 page scrolls sideways by ${m.overflow}px: ${m.wide.join(', ')}`);
        if (vp.phone && m.offCardCount > 0) problems.push(`M4 ${m.offCardCount} card value(s) off the screen: ${m.offCard.join(', ')}`);
        if (vp.phone && m.smallCount > 0) problems.push(`M2 ${m.smallCount} control(s) under 44px: ${m.small.join(', ')}`);
        if (vp.phone && m.tiny.length > 0) problems.push(`M3 fields under 16px: ${m.tiny.join(', ')}`);
        if (problems.length > 0) {
          mkdirSync(SHOTS, { recursive: true });
          const file = join(SHOTS, `${id}--${vp.name}--${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
          await page.screenshot({ path: file, fullPage: true });
          failures.push({ view: label, viewport: vp.name, problems, screenshot: file });
        }
      }
      await context.close();
    }
  } finally {
    server.stop();
  }
  return failures;
}

const browser = await playwright.chromium.launch();
let failed = 0;
const report = {};
for (const id of MODULES) {
  try {
    const failures = await checkModule(browser, id);
    report[id] = failures;
    failed += failures.length;
    console.log(`${failures.length === 0 ? '✓' : '✗'} ${id}${failures.length ? ` — ${failures.length} view(s) fail` : ''}`);
    for (const f of failures) console.log(`    ${f.viewport} · ${f.view}\n      ${f.problems.join('\n      ')}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${id} — could not be checked: ${err.message.split('\n')[0]}`);
  }
}
await browser.close();
process.exit(failed > 0 ? 1 : 0);
