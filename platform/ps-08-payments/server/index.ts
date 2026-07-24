import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { settleProcessing } from './payments.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
  { name: 'WEBHOOK_SECRET', value: config.webhookSecret },
]);
const db = openDb(config.databasePath);

await seed(db);

const app = createApp({
  db,
  auth: config.auth,
  webhookSecret: config.webhookSecret,
  stripeSecretKey: config.stripeSecretKey,
  hardening: hardeningFromEnv(), logRequests: true,
});

app.listen(config.port, () => {
  console.log(`[ps-08] payments API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-08] WARNING: using default credentials/secret — set real ones in production');
  }
  if (!config.stripeSecretKey) {
    console.log('[ps-08] note: STRIPE_SECRET_KEY unset — using the deterministic mock PSP');
  }

  if (config.tickIntervalMs > 0) {
    // Optional internal ticker: settle mock processing intents on a timer so
    // no external cron is needed. POST /api/tick still works either way.
    const timer = setInterval(() => {
      try {
        settleProcessing(db, Date.now());
      } catch (err) {
        console.error('[ps-08] tick error', err);
      }
    }, config.tickIntervalMs);
    timer.unref?.();
    console.log(`[ps-08] internal ticker every ${config.tickIntervalMs}ms`);
  } else {
    console.log('[ps-08] note: mock intents only settle while POST /api/tick is called (or a real cron drives it)');
  }
});
