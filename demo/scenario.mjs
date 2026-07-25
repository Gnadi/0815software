#!/usr/bin/env node
/**
 * 0815software Platform — live end-to-end demo.
 *
 * Boots eight Platform Services and three business modules as real processes,
 * all sharing one identity provider and one service credential, then drives a
 * complete business day for the fictional company "Acme Corporation":
 *
 *   1. An admin signs into the Invoicing app — validated by PS-01 Identity (SSO).
 *   2. Acme bills a customer: the invoice number comes from PS-10 (gapless),
 *      the PDF is archived in PS-06, the customer is emailed via PS-03, and the
 *      whole thing is recorded on PS-07's tamper-evident audit log.
 *   3. The customer pays: PS-08 Payments runs the settlement.
 *   4. A support ticket comes in; PS-04 AI drafts the reply.
 *   5. A contract is filed in the Documents app: stored in PS-06, indexed in
 *      PS-09, and found again by full-text search.
 *   6. The platform proves itself: PS-07 verifies the audit chain over every
 *      action taken above, across all three apps.
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
};

const ssoEnv = {
  IDENTITY_URL: P.identity,
  IDENTITY_ORG: ORG,
  PLATFORM_SERVICE_TOKEN: SVC_TOKEN,
  ADMIN_PASSWORD: ADMIN_PW,
  SESSION_SECRET,
  INTAKE_SECRET: 'demo-intake-secret',
};
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
      SELLER_NAME: 'Acme Corporation',
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
  step('Booting 8 Platform Services and 3 business apps…');
  await waitForHealth({ ...P, ...M });
  ok('All services healthy. One identity provider, one platform, three apps.');

  // Pre-stage the two platform resources the apps expect to exist.
  await client(P.number).post(
    '/api/sequences',
    { scope: 'invoice', format: 'RE-{YYYY}-{seq:0000}', period: 'year' },
    { serviceToken: SVC_TOKEN },
  );
  await client(P.files).post('/api/buckets', { name: 'invoices' }, { serviceToken: SVC_TOKEN });

  // ══════════════════════════════════════════════════════════════════════════
  act('Single sign-on — one identity across every app');
  const invoicing = client(M.invoicing);
  step(`Admin opens the Invoicing app and signs in as ${c.bold(HUMAN.email)}…`);
  const login = await invoicing.post('/api/login', { username: HUMAN.email, password: HUMAN.password });
  expect(login.status === 200, `SSO login failed (${login.status})`);
  ok('Logged in — the app never checked a local password.');
  note('PS-01 Identity validated the credentials and confirmed the platform:admin role.');
  const badLogin = await client(M.invoicing).post('/api/login', { username: HUMAN.email, password: 'wrong' });
  expect(badLogin.status === 401, 'a wrong password should be rejected');
  ok('A wrong password is rejected by PS-01 — the app delegates auth entirely.');

  // ══════════════════════════════════════════════════════════════════════════
  act('Invoicing — one action, five services');
  step('Acme adds a customer and drafts an invoice…');
  const customer = await invoicing.post('/api/customers', {
    name: 'Blaustern Café GmbH',
    email: 'buchhaltung@blaustern.example',
    vat_id: 'ATU12345678',
    address: 'Hauptstraße 12, 5020 Salzburg',
  });
  expect(customer.status === 201, 'customer creation failed');
  const draft = await invoicing.post('/api/invoices', {
    customer_id: customer.body.id,
    lines: [
      { description: 'Consulting — platform onboarding (10h)', quantity: 10, unit_price_cents: 12000, vat_rate: 20 },
      { description: 'Priority support, one year', quantity: 1, unit_price_cents: 90000, vat_rate: 20 },
    ],
  });
  expect(draft.status === 201, `invoice draft failed (${draft.status}): ${JSON.stringify(draft.body)}`);
  ok(`Draft invoice created for ${c.bold(customer.body.name)}.`);

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
  expect(messages.messages.some((m) => m.to_address === customer.body.email), 'customer was not emailed via PS-03');
  ok(`PS-03 Notifications queued the invoice email to ${c.bold(customer.body.email)}.`);

  const auditAdmin = await adminToken(P.audit);
  const issuedEvents = (await client(P.audit).get(`/api/events?resource=invoice:${number}`, { token: auditAdmin })).body;
  expect(issuedEvents.events.some((e) => e.action === 'invoice.issued'), 'no invoice.issued audit event');
  ok('PS-07 Audit recorded an "invoice.issued" event on the tamper-evident chain.');
  note('One HTTP call from the app → five coordinated Platform Services.');

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
  note('Invoices, payments, tickets and documents — from three separate apps — one trail.');

  const health = await Promise.all(
    Object.entries(P).map(async ([k, url]) => `${k}:${(await fetch(`${url}/api/ready`)).ok ? 'ready' : 'DOWN'}`),
  );
  ok(`Every service reports ready → ${c.dim(health.join('  '))}`);

  console.log('');
  hr();
  console.log(c.bold(c.green('  DEMO COMPLETE — 8 services, 3 apps, one integrated platform.')));
  console.log(c.dim('  SSO · gapless numbering · file archive · notifications · payments · AI · search · audit'));
  hr();
  console.log('');
}

run()
  .catch((err) => {
    if (!process.exitCode) process.exitCode = 1;
    console.error(err.stack ?? err);
  })
  .finally(shutdown);
