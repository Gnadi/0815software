// The demo hub — a tiny landing page served at https://<DEMO_DOMAIN> that links
// into each running app on its own subdomain. Templated from DEMO_DOMAIN.
import { createServer } from 'node:http';

const DOMAIN = process.env.DEMO_DOMAIN || 'demo.example.com';
const PORT = Number(process.env.PORT) || 8080;

const CARDS = [
  { label: 'Offers', sub: 'offers', blurb: 'Quote a customer; they accept online via a public link.', services: 'Notifications · Audit', login: 'SSO' },
  { label: 'Invoicing', sub: 'invoicing', blurb: 'Bill the accepted quote — one “finalize” click, five services.', services: 'Numbering · Files · Notifications · Payments · Audit', login: 'SSO' },
  { label: 'Support', sub: 'support', blurb: 'Tickets with an AI-drafted reply.', services: 'AI · Notifications · Audit', login: 'SSO' },
  { label: 'Documents', sub: 'documents', blurb: 'File a contract, find it by full-text search.', services: 'Files · Search · Audit', login: 'Local' },
];

const card = (a) => `
  <a class="card" href="https://${a.sub}.${DOMAIN}" target="_blank" rel="noopener">
    <div class="card__top"><span class="card__name">${a.label}</span>
      <span class="card__badge card__badge--${a.login === 'SSO' ? 'sso' : 'local'}">${a.login}</span></div>
    <p class="card__blurb">${a.blurb}</p>
    <div class="card__svc">${a.services}</div>
    <span class="card__open">${a.sub}.${DOMAIN} ↗</span>
  </a>`;

const html = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>0815software — Live Platform Demo</title>
<style>
  :root { --bg:#0b0c0e; --bg2:#131519; --fg:#f3f4f6; --dim:#9aa1ab; --mute:#6b727c; --line:#242830; --accent:#c8ff3d; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,'Inter Tight',sans-serif; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1000px; margin:0 auto; padding:64px 28px 96px; }
  .eyebrow { font-family:ui-monospace,'JetBrains Mono',monospace; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--mute); margin-bottom:20px; }
  h1 { font-size:44px; font-weight:600; letter-spacing:-1.5px; line-height:1.02; margin-bottom:18px; }
  h1 span { color:var(--accent); }
  .lead { font-size:17px; color:var(--dim); max-width:640px; }
  .creds { font-family:ui-monospace,'JetBrains Mono',monospace; font-size:13px; color:var(--dim); background:var(--bg2); border:1px solid var(--line); border-radius:6px; padding:12px 16px; margin:24px 0 40px; display:inline-block; }
  .creds b { color:var(--fg); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .card { display:block; background:var(--bg2); border:1px solid var(--line); border-radius:10px; padding:22px; text-decoration:none; color:inherit; transition:border-color .12s, transform .12s; }
  .card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .card__top { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .card__name { font-size:20px; font-weight:600; letter-spacing:-.3px; }
  .card__badge { font-family:ui-monospace,'JetBrains Mono',monospace; font-size:10px; letter-spacing:.5px; padding:3px 8px; border-radius:20px; text-transform:uppercase; }
  .card__badge--sso { background:rgba(200,255,61,.14); color:var(--accent); }
  .card__badge--local { background:#20242c; color:var(--dim); }
  .card__blurb { font-size:14px; color:var(--dim); margin-bottom:14px; min-height:40px; }
  .card__svc { font-family:ui-monospace,'JetBrains Mono',monospace; font-size:11px; color:var(--mute); margin-bottom:18px; }
  .card__open { font-family:ui-monospace,'JetBrains Mono',monospace; font-size:12px; color:var(--accent); }
  .story { margin-top:48px; padding-top:32px; border-top:1px solid var(--line); font-size:14px; color:var(--dim); }
  .story b { color:var(--fg); }
  .foot { margin-top:40px; font-size:13px; color:var(--mute); }
  .foot a { color:var(--dim); }
  @media (max-width:680px){ .grid{grid-template-columns:1fr} h1{font-size:34px} }
</style></head>
<body><div class="wrap">
  <div class="eyebrow">Live demo · 8 services · 4 apps · one platform</div>
  <h1>Four separate apps.<br><span>One platform underneath.</span></h1>
  <p class="lead">Every app below is a real, independent product — and every one runs against the same identity provider, audit log, notifications, payments, storage, search and numbering. Sign into one and you're signed into all of them.</p>
  <div class="creds">Single sign-on: <b>owner@acme.test</b> / <b>demo-owner</b> &nbsp;·&nbsp; Documents (own login): <b>admin</b> / <b>demo-admin</b></div>
  <div class="grid">${CARDS.map(card).join('')}</div>
  <div class="story"><b>Try this path:</b> in <b>Offers</b>, send a quote and accept it → in <b>Invoicing</b>, bill it and watch one “finalize” click assign a gapless number, archive the PDF, email the customer and record an audit event → collect payment → in <b>Support</b>, open a ticket and ask the AI for a reply → in <b>Documents</b>, file a contract and find it by search. Every action, from every app, lands on one tamper-evident audit chain.</div>
  <div class="foot">Shared, resettable demo data. Source: <a href="https://github.com/Gnadi/0815software/tree/main/demo">github.com/Gnadi/0815software</a></div>
</div></body></html>`;

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html());
}).listen(PORT, () => console.log(`[hub] serving on :${PORT} for ${DOMAIN}`));
