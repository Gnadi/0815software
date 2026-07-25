#!/usr/bin/env node
/**
 * 0815software Platform — live, clickable demo.
 *
 * Boots the platform (8 services) plus four real business apps — Offers,
 * Invoicing, Support, Documents — each serving its actual web UI, all wired to
 * one shared identity provider and platform. Then it serves a hub page that
 * links you into every running app with the demo logins.
 *
 * Open http://localhost:4400 and click through a real, integrated product.
 * Everything runs offline (mock/console adapters) — no vendor keys, no Docker.
 *
 *   node demo/serve.mjs      (or: npm run demo)
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boot, c, client, shutdown, waitForHealth } from './lib/harness.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const HUB_PORT = 4400;
const SVC_TOKEN = 'demo-service-token';
const ADMIN_PW = 'demo-admin';
const SESSION_SECRET = 'demo0815demo0815demo0815demo0815demo0815demo0815demo0815demo0815';
const ORG = 'acme';

// ── Make sure each app's web UI and compiled server are built ────────────────
const APPS = [
  { name: 'mod-13-offers', label: 'Offers', port: 4413 },
  { name: 'mod-04-invoice-billing', label: 'Invoicing', port: 4404 },
  { name: 'mod-12-support-tickets', label: 'Support', port: 4412 },
  { name: 'mod-09-document-management', label: 'Documents', port: 4409 },
];

function ensureBuilt() {
  for (const app of APPS) {
    const dir = join(ROOT, 'modules', app.name);
    const hasUi = existsSync(join(dir, 'dist/client/index.html'));
    const hasServer = existsSync(join(dir, 'dist/server/server/index.js'));
    if (hasUi && hasServer) continue;
    console.log(`  ${c.cyan('▸')} Building ${c.bold(app.label)} (web UI + server)…`);
    if (!hasUi) execFileSync('npx', ['vite', 'build'], { cwd: dir, stdio: 'ignore' });
    if (!hasServer) execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json'], { cwd: dir, stdio: 'ignore' });
  }
}

// ── Topology ─────────────────────────────────────────────────────────────────
const platformEnv = { SERVICE_TOKEN: SVC_TOKEN, ADMIN_PASSWORD: ADMIN_PW, SESSION_SECRET };
let P, M;

function bootStack() {
  P = {
    identity: boot({ group: 'platform', name: 'ps-01-identity', port: 4301, tag: 'PS-01', env: platformEnv }),
    notify: boot({ group: 'platform', name: 'ps-03-notification-hub', port: 4303, tag: 'PS-03', env: platformEnv }),
    ai: boot({ group: 'platform', name: 'ps-04-ai-platform', port: 4304, tag: 'PS-04', env: platformEnv }),
    files: boot({ group: 'platform', name: 'ps-06-file-storage', port: 4306, tag: 'PS-06', env: platformEnv }),
    audit: boot({ group: 'platform', name: 'ps-07-audit-log', port: 4307, tag: 'PS-07', env: platformEnv }),
    payments: boot({ group: 'platform', name: 'ps-08-payments', port: 4308, tag: 'PS-08', env: platformEnv }),
    search: boot({ group: 'platform', name: 'ps-09-search', port: 4309, tag: 'PS-09', env: platformEnv }),
    number: boot({ group: 'platform', name: 'ps-10-number', port: 4310, tag: 'PS-10', env: platformEnv }),
  };

  const ssoEnv = {
    IDENTITY_URL: P.identity,
    IDENTITY_ORG: ORG,
    PLATFORM_SERVICE_TOKEN: SVC_TOKEN,
    ADMIN_PASSWORD: ADMIN_PW,
    SESSION_SECRET,
    INTAKE_SECRET: 'demo-intake-secret',
  };

  M = {
    Offers: boot({
      group: 'modules', name: 'mod-13-offers', port: 4413, tag: 'Offers', compiled: true,
      env: { ...ssoEnv, NOTIFICATION_URL: P.notify, AUDIT_URL: P.audit, SELLER_NAME: 'Acme Corporation', PUBLIC_BASE_URL: 'http://localhost:4413' },
    }),
    Invoicing: boot({
      group: 'modules', name: 'mod-04-invoice-billing', port: 4404, tag: 'Invoicing', compiled: true,
      env: {
        ...ssoEnv, NOTIFICATION_URL: P.notify, FILES_URL: P.files, AUDIT_URL: P.audit,
        PAYMENTS_URL: P.payments, NUMBER_URL: P.number, NOTIFICATION_INVOICE_CHANNEL: 'transactional-email', SELLER_NAME: 'Acme Corporation',
      },
    }),
    Support: boot({
      group: 'modules', name: 'mod-12-support-tickets', port: 4412, tag: 'Support', compiled: true,
      env: { ...ssoEnv, NOTIFICATION_URL: P.notify, AUDIT_URL: P.audit, AI_URL: P.ai },
    }),
    Documents: boot({
      group: 'modules', name: 'mod-09-document-management', port: 4409, tag: 'Documents', compiled: true,
      env: { ...ssoEnv, FILES_URL: P.files, AUDIT_URL: P.audit, SEARCH_URL: P.search },
    }),
  };
}

// ── The hub page — a local landing that links into every running app ─────────
const CARDS = [
  { label: 'Offers', port: 4413, blurb: 'Quotes a customer accepts online.', services: 'Notifications · Audit', login: 'SSO' },
  { label: 'Invoicing', port: 4404, blurb: 'Bills the accepted quote — one click, five services.', services: 'Numbering · Files · Notifications · Payments · Audit', login: 'SSO' },
  { label: 'Support', port: 4412, blurb: 'Tickets with AI-drafted replies.', services: 'AI · Notifications · Audit', login: 'SSO' },
  { label: 'Documents', port: 4409, blurb: 'Files a contract, finds it by full-text search.', services: 'Files · Search · Audit', login: 'Local' },
];

function hubHtml() {
  const card = (a) => `
    <a class="card" href="http://localhost:${a.port}" target="_blank" rel="noopener">
      <div class="card__top">
        <span class="card__name">${a.label}</span>
        <span class="card__badge card__badge--${a.login === 'SSO' ? 'sso' : 'local'}">${a.login}</span>
      </div>
      <p class="card__blurb">${a.blurb}</p>
      <div class="card__svc">${a.services}</div>
      <span class="card__open">Open :${a.port} ↗</span>
    </a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>0815software — Live Platform Demo</title>
<style>
  :root { --bg:#0b0c0e; --bg2:#131519; --fg:#f3f4f6; --dim:#9aa1ab; --mute:#6b727c; --line:#242830; --accent:#c8ff3d; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--fg); font-family:'Inter Tight',system-ui,sans-serif; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1000px; margin:0 auto; padding:64px 28px 96px; }
  .eyebrow { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--mute); margin-bottom:20px; }
  h1 { font-size:44px; font-weight:600; letter-spacing:-1.5px; line-height:1.02; margin-bottom:18px; }
  h1 span { color:var(--accent); }
  .lead { font-size:17px; color:var(--dim); max-width:640px; margin-bottom:12px; }
  .creds { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:13px; color:var(--dim); background:var(--bg2); border:1px solid var(--line); border-radius:6px; padding:12px 16px; margin:24px 0 40px; display:inline-block; }
  .creds b { color:var(--fg); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .card { display:block; background:var(--bg2); border:1px solid var(--line); border-radius:10px; padding:22px; text-decoration:none; color:inherit; transition:border-color .12s, transform .12s; }
  .card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .card__top { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .card__name { font-size:20px; font-weight:600; letter-spacing:-.3px; }
  .card__badge { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.5px; padding:3px 8px; border-radius:20px; text-transform:uppercase; }
  .card__badge--sso { background:rgba(200,255,61,.14); color:var(--accent); }
  .card__badge--local { background:#20242c; color:var(--dim); }
  .card__blurb { font-size:14px; color:var(--dim); margin-bottom:14px; min-height:40px; }
  .card__svc { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; color:var(--mute); margin-bottom:18px; }
  .card__open { font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; color:var(--accent); }
  .story { margin-top:48px; padding-top:32px; border-top:1px solid var(--line); font-size:14px; color:var(--dim); }
  .story b { color:var(--fg); }
  .foot { margin-top:40px; font-size:13px; color:var(--mute); }
  .foot a { color:var(--dim); }
  @media (max-width:680px){ .grid{grid-template-columns:1fr} h1{font-size:34px} }
</style></head>
<body><div class="wrap">
  <div class="eyebrow">Live demo · 8 services · 4 apps · one platform</div>
  <h1>Four separate apps.<br><span>One platform underneath.</span></h1>
  <p class="lead">Every app below is a real, independent product — and every one is running against the same identity provider, audit log, notifications, payments, storage, search and numbering service. Log into one and you're logged into all of them.</p>
  <div class="creds">Single sign-on: <b>owner@acme.test</b> / <b>demo-owner</b> &nbsp;·&nbsp; Documents (own login): <b>admin</b> / <b>demo-admin</b></div>
  <div class="grid">${CARDS.map(card).join('')}</div>
  <div class="story">
    <b>Try this path:</b> in <b>Offers</b>, send a quote and accept it → in <b>Invoicing</b>, bill it and watch one "finalize" click assign a gapless number, archive the PDF, email the customer and record an audit event → collect payment → in <b>Support</b>, open a ticket and ask the AI for a reply → in <b>Documents</b>, file a contract and find it by search. Then check the audit trail — every action from every app is on one tamper-evident chain.
  </div>
  <div class="foot">Runs offline with mock adapters. See <a href="https://github.com/Gnadi/0815software/tree/main/demo">demo/README.md</a> for how it's wired.</div>
</div></body></html>`;
}

// ── Boot everything, pre-stage platform resources, serve the hub ─────────────
async function main() {
  console.log(c.bold('\n  0815software — live, clickable platform demo\n'));
  ensureBuilt();
  console.log(`  ${c.cyan('▸')} Booting 8 services and 4 apps…`);
  bootStack();
  await waitForHealth({ ...P, ...M });

  // Pre-stage what the apps expect: an invoice sequence and the invoice bucket.
  await client(P.number).post('/api/sequences', { scope: 'invoice', format: 'RE-{YYYY}-{seq:0000}', period: 'year' }, { serviceToken: SVC_TOKEN });
  await client(P.files).post('/api/buckets', { name: 'invoices' }, { serviceToken: SVC_TOKEN });

  const hub = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(hubHtml());
  });
  await new Promise((r) => hub.listen(HUB_PORT, r));

  console.log(`  ${c.green('✓')} Everything is up.\n`);
  console.log(`  ${c.bold('Open the hub:')}  ${c.cyan(`http://localhost:${HUB_PORT}`)}`);
  console.log(c.dim(`  Apps: ${CARDS.map((a) => `${a.label} :${a.port}`).join('  ·  ')}`));
  console.log(c.dim('  SSO login: owner@acme.test / demo-owner   ·   Documents: admin / demo-admin'));
  console.log(c.dim('\n  Press Ctrl-C to stop the whole stack.\n'));
}

main().catch((err) => {
  console.error(err.stack ?? err);
  shutdown();
  process.exit(1);
});
