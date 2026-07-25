// One-shot demo staging: after the platform is up, configure the invoice
// number format (PS-10) and create the file bucket the Invoicing app writes to
// (PS-06). Re-runs on every `docker compose restart`, so it re-stages after a
// reset. Idempotent — a 409 (already exists) is fine.
const SVC = process.env.SERVICE_TOKEN;
const H = { 'content-type': 'application/json', 'x-service-token': SVC };

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${url}`);
}

await waitFor('http://ps10:4010/api/health');
await waitFor('http://ps06:4006/api/health');

await fetch('http://ps10:4010/api/sequences', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ scope: 'invoice', format: 'RE-{YYYY}-{seq:0000}', period: 'year' }),
}).catch(() => {});

await fetch('http://ps06:4006/api/buckets', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: 'invoices' }),
}).catch(() => {});

console.log('[init] demo platform resources staged');
