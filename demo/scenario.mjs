#!/usr/bin/env node
/**
 * 0815software Platform — automated end-to-end proof (headless).
 *
 * The clickable demo is `serve.mjs` (npm run demo). THIS script is the same
 * wired stack driven headlessly and asserted end to end — the demo as a
 * pass/fail integration test (npm run e2e), handy for CI.
 *
 * Boots nine Platform Services and four business modules as real processes,
 * all sharing one identity provider and one service credential, then drives a
 * complete quote-to-cash-to-care day for the fictional company "Acme Corporation":
 *
 *   1. A salesperson signs into the Offers app — validated by PS-01 Identity (SSO).
 *   2. Acme quotes a customer: PS-03 emails the offer link, PS-07 audits it, and
 *      the customer accepts online through the public link (no login).
 *   3. Acme bills the accepted quote WITH ONE ACTION — Invoicing pulls the
 *      offer from Offers as a neutral document transfer, resolves the customer
 *      through PS-11 Customers (so both apps mean the same party), and produces
 *      a draft. Finalizing it takes the invoice number from PS-10 (gapless),
 *      archives the PDF in PS-06, emails the customer via PS-03, and records
 *      the lot on PS-07's tamper-evident log.
 *   4. Acme renames itself once in PS-11 Customers and both apps' letterheads
 *      follow, with no restart — the seller identity has one home instead of
 *      being duplicated in two modules' SELLER_* environments.
 *   5. The customer pays: PS-08 Payments runs the settlement.
 *   6. A support ticket comes in; PS-04 AI drafts the reply.
 *   7. A contract is filed in the Documents app: stored in PS-06, indexed in
 *      PS-09, and found again by full-text search.
 *   8. The platform proves itself: PS-07 verifies the audit chain over every
 *      action taken above, across all four apps.
 *
 * Everything runs offline with mock/console adapters — no vendor keys needed.
 *
 *   node demo/scenario.mjs
 */
import { boot, c, client, shutdown, waitForHealth } from './lib/harness.mjs';

// ── Topology ───────────────────────────────────────────────────────────────
const SVC_TOKEN = 'demo-service-token';
const ADMIN_PW = 'demo-admin';
const ORG = 'acme';
// The seeded Acme owner holds platform:admin — the human who logs into the apps.
const HUMAN = { email: 'owner@acme.test', password: 'demo-owner' };

// A real (demo) session secret so the services don't print production warnings.
const SESSION_SECRET = 'demo0815demo0815demo0815demo0815demo0815demo0815demo0815demo0815';
const platformEnv = { SERVICE_TOKEN: SVC_TOKEN, ADMIN_PASSWORD: ADMIN_PW, SESSION_SECRET };
const P = {
  identity: boot({ group: 'platform', name: 'ps-01-identity', port: 4301, tag: 'PS-01', env: platformEnv }),
  notify: boot({ group: 'platform', name: 'ps-03-notification-hub', port: 4303, tag: 'PS-03', env: platformEnv }),
  ai: boot({ group: 'platform', name: 'ps-04-ai-platform', port: 4304, tag: 'PS-04', env: platformEnv }),
  files: boot({ group: 'platform', name: 'ps-06-file-storage', port: 4306, tag: 'PS-06', env: platformEnv }),
  audit: boot({ group: 'platform', name: 'ps-07-audit-log', port: 4307, tag: 'PS-07', env: platformEnv }),
  payments: boot({ group: 'platform', name: 'ps-08-payments', port: 4308, tag: 'PS-08', env: platformEnv }),
  search: boot({ group: 'platform', name: 'ps-09-search', port: 4309, tag: 'PS-09', env: platformEnv }),
  number: boot({ group: 'platform', name: 'ps-10-number', port: 4310, tag: 'PS-10', env: platformEnv }),
  customers: boot({ group: 'platform', name: 'ps-11-customers', port: 4311, tag: 'PS-11', env: platformEnv }),
};

const ssoEnv = {
  IDENTITY_URL: P.identity,
  IDENTITY_ORG: ORG,
  PLATFORM_SERVICE_TOKEN: SVC_TOKEN,
  ADMIN_PASSWORD: ADMIN_PW,
  SESSION_SECRET,
  INTAKE_SECRET: 'demo-intake-secret',
};
// Invoicing is constructed before Offers in this literal, so its OFFERS_URL is
// the known port rather than a reference to M.offers.
const M_OFFERS_URL = 'http://127.0.0.1:4413';

const M = {
  invoicing: boot({
    group: 'modules',
    name: 'mod-04-invoice-billing',
    port: 4404,
    tag: 'Invoicing',
    env: {
      ...ssoEnv,
      NOTIFICATION_URL: P.notify,
      FILES_URL: P.files,
      AUDIT_URL: P.audit,
      PAYMENTS_URL: P.payments,
      NUMBER_URL: P.number,
      NOTIFICATION_INVOICE_CHANNEL: 'transactional-email',
      CUSTOMERS_URL: P.customers,
      // The quote-to-invoice bridge: Invoicing can fetch an accepted offer
      // from Offers as a neutral document transfer (shared/transfer.ts).
      OFFERS_URL: M_OFFERS_URL,
      SELLER_NAME: 'Acme Corporation',
    },
  }),
  offers: boot({
    group: 'modules',
    name: 'mod-13-offers',
    port: 4413,
    tag: 'Offers',
    env: {
      ...ssoEnv,
      NOTIFICATION_URL: P.notify,
      AUDIT_URL: P.audit,
      CUSTOMERS_URL: P.customers,
      SELLER_NAME: 'Acme Corporation',
      // Short refresh so the demo can show a letterhead change taking effect
      // without a restart; production defaults to five minutes.
      SELLER_REFRESH_MS: '400',
      PUBLIC_BASE_URL: 'http://127.0.0.1:4413',
    },
  }),
  support: boot({
    group: 'modules',
    name: 'mod-12-support-tickets',
    port: 4412,
    tag: 'Support',
    env: { ...ssoEnv, NOTIFICATION_URL: P.notify, AUDIT_URL: P.audit, AI_URL: P.ai },
  }),
  documents: boot({
    group: 'modules',
    name: 'mod-09-document-management',
    port: 4409,
    tag: 'Documents',
    env: { ...ssoEnv, FILES_URL: P.files, AUDIT_URL: P.audit, SEARCH_URL: P.search },
  }),
};

// ── Narration helpers ────────────────────────────────────────────────────────
let acts = 0;
const hr = () => console.log(c.dim('─'.repeat(78)));
function act(title) {
  console.log('');
  hr();
  console.log(`${c.bold(c.magenta(`ACT ${++acts}`))}  ${c.bold(title)}`);
  hr();
}
const step = (s) => console.log(`  ${c.cyan('▸')} ${s}`);
const ok = (s) => console.log(`    ${c.green('✓')} ${s}`);
const note = (s) => console.log(`    ${c.dim(s)}`);
function fail(msg) {
  console.error(`\n${c.red('DEMO FAILED')}: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
const expect = (cond, msg) => void (cond || fail(msg));

// Service-token calls (machine-to-machine) and admin logins (for read-backs).
async function serviceGet(base, path) {
  return (await client(base).get(path, { serviceToken: SVC_TOKEN })).body;
}
async function adminToken(base) {
  const res = await client(base).post('/api/login', { username: 'admin', password: ADMIN_PW });
  return res.body.token;
}

async function run() {
  console.log(c.bold('\n  0815software Platform — live demo: "A day at Acme Corporation"\n'));
  step(`Booting ${Object.keys(P).length} Platform Services and ${Object.keys(M).length} business apps…`);
  await waitForHealth({ ...P, ...M });
  ok('All services healthy. One identity provider, one platform, four apps.');

  // Pre-stage the two platform resources the apps expect to exist.
  await client(P.number).post(
    '/api/sequences',
    { scope: 'invoice', format: 'RE-{YYYY}-{seq:0000}', period: 'year' },
    { serviceToken: SVC_TOKEN },
  );
  await client(P.files).post('/api/buckets', { name: 'invoices' }, { serviceToken: SVC_TOKEN });

  // ══════════════════════════════════════════════════════════════════════════
  act('Single sign-on — one identity across every app');
  const offers = client(M.offers);
  step(`A salesperson opens the Offers app and signs in as ${c.bold(HUMAN.email)}…`);
  const login = await offers.post('/api/login', { username: HUMAN.email, password: HUMAN.password });
  expect(login.status === 200, `SSO login failed (${login.status})`);
  ok('Logged in — the app never checked a local password.');
  note('PS-01 Identity validated the credentials and confirmed the platform:admin role.');
  const badLogin = await client(M.offers).post('/api/login', { username: HUMAN.email, password: 'wrong' });
  expect(badLogin.status === 401, 'a wrong password should be rejected');
  ok('A wrong password is rejected by PS-01 — the app delegates auth entirely.');

  // ══════════════════════════════════════════════════════════════════════════
  act('Offers — quote a customer, and they accept online');
  step('Acme adds a prospect and drafts a quote…');
  const prospect = await offers.post('/api/customers', {
    name: 'Blaustern Café GmbH',
    email: 'buchhaltung@blaustern.example',
    vat_id: 'ATU12345678',
    address: 'Hauptstraße 12, 5020 Salzburg',
  });
  expect(prospect.status === 201, `prospect creation failed (${prospect.status}): ${JSON.stringify(prospect.body)}`);
  const offerDraft = await offers.post('/api/offers', {
    customer_id: prospect.body.id,
    title: 'Platform onboarding + one year of priority support',
    valid_until: '2026-12-31',
    lines: [
      { description: 'Consulting — platform onboarding (10h)', quantity: 10, unit_price_cents: 12000, vat_rate: 20 },
      { description: 'Priority support, one year', quantity: 1, unit_price_cents: 90000, vat_rate: 20 },
    ],
  });
  expect(offerDraft.status === 201, `offer draft failed (${offerDraft.status}): ${JSON.stringify(offerDraft.body)}`);
  ok(`Quote drafted for ${c.bold(prospect.body.name)} (2 line items).`);

  step('The salesperson sends the quote…');
  const sent = await offers.post(`/api/offers/${offerDraft.body.id}/send`, {});
  expect(sent.status === 200, `offer send failed (${sent.status})`);
  ok(`Quote ${c.bold(sent.body.number)} sent.`);
  note('↳ PS-03 emailed the customer a link to review it; PS-07 recorded an "offer.sent" event.');

  const offerMsgs = (await client(P.notify).get('/api/messages', { token: await adminToken(P.notify) })).body;
  expect(offerMsgs.messages.some((m) => String(m.subject).includes(sent.body.number)), 'no offer email queued in PS-03');
  ok('PS-03 confirms the quote email is queued to the customer.');

  step('The customer opens the public link and accepts — no login needed…');
  // The public link is /offer/<number>?token=<signed token>; the acceptance
  // endpoint keys off the same number + token.
  const ref = encodeURIComponent(sent.body.number);
  const accept = await client(M.offers).post(`/api/public/offers/${ref}/accept`, { token: sent.body.public_token });
  expect(accept.status === 200, `public accept failed (${accept.status}): ${JSON.stringify(accept.body)}`);
  expect(accept.body.status === 'accepted', `expected accepted, got ${accept.body.status}`);
  ok(`Customer ${c.green('accepted')} the quote online. Time to invoice it.`);

  // ══════════════════════════════════════════════════════════════════════════
  act('Invoicing — one action, five services');
  const invoicing = client(M.invoicing);
  step('The accepted quote moves to the Invoicing app (same identity, next app)…');
  const invLogin = await invoicing.post('/api/login', { username: HUMAN.email, password: HUMAN.password });
  expect(invLogin.status === 200, `invoicing SSO login failed (${invLogin.status})`);
  ok('Signed in to Invoicing via PS-01 — one identity, every app.');

  step(`Acme bills quote ${c.bold(sent.body.number)} — one action, nothing retyped…`);
  const draft = await invoicing.post('/api/invoices/import-offer', { offer_number: sent.body.number });
  expect(draft.status === 201, `offer import failed (${draft.status}): ${JSON.stringify(draft.body)}`);
  expect(draft.body.status === 'draft', `expected a draft, got ${draft.body.status}`);
  ok(`Draft invoice created for ${c.bold(draft.body.customer_name)} from the accepted quote.`);
  note('↳ Invoicing fetched the offer from Offers as a neutral document transfer (shared/transfer.ts).');
  note('↳ PS-11 Customers resolved the customer, so both apps mean the same party.');

  // The numbers are the point: no re-keying means no transcription error.
  const offerDetail = (await offers.get(`/api/offers/${offerDraft.body.id}`)).body;
  expect(
    draft.body.net_cents === offerDetail.net_cents &&
      draft.body.vat_cents === offerDetail.vat_cents &&
      draft.body.gross_cents === offerDetail.gross_cents,
    `totals drifted: offer ${offerDetail.gross_cents} vs invoice ${draft.body.gross_cents}`,
  );
  ok(`Totals and VAT survived the hand-off exactly (${c.bold(String(draft.body.gross_cents / 100))} €).`);

  step('The operator clicks "bill this offer" a second time by accident…');
  const replay = await invoicing.post('/api/invoices/import-offer', { offer_number: sent.body.number });
  expect(replay.status === 200 && replay.body.id === draft.body.id, 'a repeated import must not create a second invoice');
  ok('Nothing happened — the import is idempotent on the offer number. No double-billing.');

  // PS-11 is the authority on who this customer is: one party, two modules.
  const partyList = (await client(P.customers).get('/api/parties?q=Blaustern', { serviceToken: SVC_TOKEN })).body;
  expect(partyList.parties.length === 1, `expected one PS-11 party for the customer, got ${partyList.parties.length}`);
  const partyRefs = (
    await client(P.customers).get(`/api/parties/${partyList.parties[0].id}/refs`, { serviceToken: SVC_TOKEN })
  ).body;
  const refSources = partyRefs.refs.map((r) => r.source).sort();
  expect(
    refSources.includes('mod-13-offers') && refSources.includes('mod-04-invoice-billing'),
    `both modules should reference the one party, got ${refSources.join(', ')}`,
  );
  ok(`PS-11 holds ${c.bold('one')} customer record, referenced by both apps (${refSources.join(', ')}).`);

  step('Admin finalizes the invoice — watch the platform light up…');
  const finalized = await invoicing.post(`/api/invoices/${draft.body.id}/finalize`, {});
  expect(finalized.status === 200, `finalize failed (${finalized.status})`);
  const number = finalized.body.number;
  expect(/^RE-\d{4}-\d{4}$/.test(number), `expected a PS-10 formatted number, got ${number}`);
  ok(`Invoice ${c.bold(number)} issued.`);
  note('↳ PS-10 Number assigned a gapless, formatted invoice number.');

  // Prove each downstream side-effect actually landed.
  const numberState = await serviceGet(P.number, '/api/sequences/invoice');
  expect(numberState.current.last_value === 1, 'PS-10 sequence should be at 1');
  ok(`PS-10 confirms the sequence is authoritative (last value: ${numberState.current.last_value}).`);

  const objects = await serviceGet(P.files, '/api/objects/invoices');
  expect(objects.objects.some((o) => o.key === `${number}.pdf`), 'invoice PDF missing from PS-06');
  ok(`PS-06 Files archived the PDF: ${c.bold(`invoices/${number}.pdf`)}.`);

  const notifyAdmin = await adminToken(P.notify);
  const messages = (await client(P.notify).get('/api/messages', { token: notifyAdmin })).body;
  const customerEmail = prospect.body.email;
  expect(messages.messages.some((m) => m.to_address === customerEmail), 'customer was not emailed via PS-03');
  ok(`PS-03 Notifications queued the invoice email to ${c.bold(customerEmail)}.`);

  const auditAdmin = await adminToken(P.audit);
  const issuedEvents = (await client(P.audit).get(`/api/events?resource=invoice:${number}`, { token: auditAdmin })).body;
  expect(issuedEvents.events.some((e) => e.action === 'invoice.issued'), 'no invoice.issued audit event');
  ok('PS-07 Audit recorded an "invoice.issued" event on the tamper-evident chain.');
  note('One HTTP call from the app → five coordinated Platform Services.');

  // ══════════════════════════════════════════════════════════════════════════
  act('One seller identity — PS-11 owns the letterhead');
  step('Both apps currently print the seller from their own SELLER_* env…');
  const publicRef = encodeURIComponent(sent.body.number);
  const beforeView = await client(M.offers).get(
    `/api/public/offers/${publicRef}?token=${sent.body.public_token}`,
  );
  expect(beforeView.status === 200, `public offer view failed (${beforeView.status})`);
  expect(
    beforeView.body.seller_name === 'Acme Corporation',
    `expected the env letterhead, got ${beforeView.body.seller_name}`,
  );
  ok(`Offer letterhead reads ${c.bold(beforeView.body.seller_name)} — from SELLER_NAME.`);
  note('↳ PS-11 has no `self` party yet, so the env stands. It is the fallback, not a race.');

  step('Acme renames itself once, in PS-11 — not in two .env files…');
  const self = await client(P.customers).req('PUT', '/api/self', {
    body: {
      name: 'Acme Corporation AG',
      vat_id: 'ATU12000000',
      address_lines: ['Handelskai 92', '1200 Wien', 'Austria'],
    },
    serviceToken: SVC_TOKEN,
  });
  expect(self.status === 200, `setting the self party failed (${self.status})`);

  // The modules re-read the seller on their refresh interval (400ms here).
  await new Promise((r) => setTimeout(r, 1200));
  const afterView = await client(M.offers).get(
    `/api/public/offers/${publicRef}?token=${sent.body.public_token}`,
  );
  expect(
    afterView.body.seller_name === 'Acme Corporation AG',
    `letterhead did not follow PS-11: still ${afterView.body.seller_name}`,
  );
  ok(`Offer letterhead now reads ${c.bold(afterView.body.seller_name)} — no restart, no redeploy.`);
  note('↳ One fact, one home. Invoicing picks up the same change on its own refresh.');

  // ══════════════════════════════════════════════════════════════════════════
  act('Payments — collecting the money through PS-08');
  step(`Customer pays invoice ${number}…`);
  const pay = await invoicing.post(`/api/invoices/${draft.body.id}/pay`, {});
  expect(pay.status === 200, `pay failed (${pay.status})`);
  expect(pay.body.payment && pay.body.payment.public_id, 'no PS-08 payment intent returned');
  ok(`PS-08 created and confirmed a payment intent (${c.bold(pay.body.payment.public_id)}).`);
  note(`Status: ${pay.body.payment.status} — the mock PSP settles asynchronously, like a real card.`);

  step('The nightly settlement runs (PS-08 tick)…');
  await client(P.payments).post('/api/tick', {}, { serviceToken: SVC_TOKEN });
  const intents = await serviceGet(P.payments, '/api/intents');
  const intent = intents.intents.find((i) => i.reference === `invoice:${number}`);
  expect(intent && intent.status === 'succeeded', 'PS-08 intent did not settle to succeeded');
  ok(`Payment ${c.bold(intent.public_id)} settled — status: ${c.green(intent.status)}.`);
  const ledger = await serviceGet(P.payments, '/api/ledger');
  expect(ledger.ledger.some((l) => l.direction === 'credit'), 'no credit posted to the PS-08 ledger');
  ok('PS-08 posted the capture to its double-entry ledger.');

  // ══════════════════════════════════════════════════════════════════════════
  act('Support — a customer question, drafted by AI');
  step('A support request arrives through the web form (no login needed)…');
  const support = client(M.support);
  const ticket = await support.post('/api/intake/web', {
    requester_name: 'Blaustern Café',
    requester_email: 'buchhaltung@blaustern.example',
    subject: `Question about invoice ${number}`,
    body: 'Hello, could you confirm the payment terms and whether the support is billed yearly? Thanks!',
    priority: 'normal',
  });
  expect(ticket.status === 201, `ticket intake failed (${ticket.status})`);
  ok(`Ticket ${c.bold(ticket.body.ref)} opened; requester emailed via PS-03.`);

  step('An agent signs in (SSO again) and asks the AI for a draft reply…');
  const agentLogin = await support.post('/api/login', { username: HUMAN.email, password: HUMAN.password });
  expect(agentLogin.status === 200, 'support SSO login failed');
  const suggestion = await support.post(`/api/tickets/${ticket.body.ref}/suggest-reply`, {});
  expect(suggestion.status === 200 && suggestion.body.suggestion, `AI suggestion failed (${suggestion.status})`);
  ok('PS-04 AI drafted a reply for the agent to review:');
  note(`  "${String(suggestion.body.suggestion).slice(0, 100).replace(/\n/g, ' ')}…"`);

  // ══════════════════════════════════════════════════════════════════════════
  act('Documents — filed once, found instantly');
  const documents = client(M.documents);
  // Documents is a domain-user app (per-matter access control), so it keeps its
  // own user model for now — SSO for these is on the roadmap (see the readiness
  // doc). It still consumes the platform for storage, search, and audit.
  const docLogin = await documents.post('/api/login', { username: 'admin', password: 'demo-admin' });
  expect(docLogin.status === 200, `documents login failed (${docLogin.status})`);
  note('Documents keeps its own matter-based logins (SSO deferred for domain-user apps).');
  step('Acme files the signed customer contract…');
  const matter = await documents.post('/api/matters', { key: 'BLAUSTERN', name: 'Blaustern Café — Onboarding', description: 'Contracts & invoices' });
  expect(matter.status === 201, `matter creation failed (${matter.status})`);
  const contractText = `SERVICE AGREEMENT\n\nBetween Acme Corporation and Blaustern Café GmbH.\nScope: platform onboarding and one year of priority support.\nReference: ${number}.`;
  // Document upload is a raw byte body (not JSON) with the title on the query
  // string, so bypass the JSON client and send the bytes directly with the
  // module session cookie.
  const uploadUrl =
    `${M.documents}/api/matters/${matter.body.matter.id}/documents` +
    `?title=${encodeURIComponent('Service Agreement — Blaustern')}&filename=service-agreement.txt`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', cookie: documents.cookie() ?? '' },
    body: contractText,
  });
  expect(uploadRes.status === 201, `document upload failed (${uploadRes.status})`);
  ok('Contract stored in PS-06 Files and indexed in PS-09 Search.');

  step('A colleague later searches the Documents app for "Blaustern"…');
  // Indexing into PS-09 is fire-and-forget on upload, so give it a moment.
  let search;
  for (let i = 0; i < 20; i++) {
    search = await documents.get('/api/search?q=Blaustern');
    if (search.status === 200 && search.body.total >= 1) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  expect(search.status === 200, `search failed (${search.status})`);
  expect(search.body.total >= 1 && search.body.hits.length >= 1, 'search returned no hits');
  ok(`PS-09 found it: "${c.bold(search.body.hits[0].title)}" (score ${search.body.hits[0].score.toFixed(2)}).`);

  // ══════════════════════════════════════════════════════════════════════════
  act('The platform proves itself');
  step('Verifying the audit trail across everything that just happened…');
  const verify = (await client(P.audit).get('/api/verify', { token: auditAdmin })).body;
  expect(verify.valid === true, 'audit chain failed verification');
  ok(`PS-07 hash-chain is intact and tamper-evident over ${c.bold(verify.count)} recorded actions.`);
  note('Quotes, invoices, payments, tickets and documents — from four separate apps — one trail.');

  const health = await Promise.all(
    Object.entries(P).map(async ([k, url]) => `${k}:${(await fetch(`${url}/api/ready`)).ok ? 'ready' : 'DOWN'}`),
  );
  ok(`Every service reports ready → ${c.dim(health.join('  '))}`);

  console.log('');
  hr();
  console.log(
    c.bold(
      c.green(
        `  DEMO COMPLETE — ${Object.keys(P).length} services, ${Object.keys(M).length} apps, one integrated platform.`,
      ),
    ),
  );
  console.log(c.dim('  SSO · quotes · gapless numbering · file archive · notifications · payments · AI · search · audit'));
  hr();
  console.log('');
}

run()
  .catch((err) => {
    if (!process.exitCode) process.exitCode = 1;
    console.error(err.stack ?? err);
  })
  .finally(shutdown);
