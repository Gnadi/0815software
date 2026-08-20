import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { assertKeyStoreReadable, loadKeySecret } from './keystore.js';
import { Transport, httpPost } from './transport.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
  { name: 'EBICS_KEY_SECRET', value: config.keySecret },
]);

const db = openDb(config.databasePath);

/**
 * Prove the key store still opens before accepting a single request.
 *
 * `deploy/provision.mjs` mints a fresh random value for every declared secret
 * on every provision, so re-provisioning a live stack rotates
 * `EBICS_KEY_SECRET` — and a service that booted anyway would look healthy,
 * accept a payment run, and only discover at signing time that it cannot reach
 * its own key. Failing here, loudly, while a human is still watching the logs
 * is the only useful moment to find out.
 */
assertKeyStoreReadable(db, loadKeySecret(config.keySecret));

await seed(db);

const app = createApp({
  db,
  auth: config.auth,
  keySecret: config.keySecret,
  transport: new Transport({ post: httpPost, egress: config.egress }),
  hardening: hardeningFromEnv(),
  logRequests: true,
});

app.listen(config.port, () => {
  console.log(`[ps-12] banking API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-12] WARNING: using default credentials/secret — set real ones in production');
  }
  if (config.keySecret === '0'.repeat(64)) {
    console.warn(
      '[ps-12] WARNING: EBICS_KEY_SECRET is the shipped default, so the RSA keys that sign payments are ' +
        'encrypted under a value published in this repository. Set a real one (openssl rand -hex 32) — and ' +
        'back it up, because losing it means re-initialising with the bank on paper.',
    );
  }
  console.log('[ps-12] note: no part of this service has been tested against a real bank');
});
