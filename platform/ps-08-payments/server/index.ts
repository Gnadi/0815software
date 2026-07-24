import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

await seed(db);

const app = createApp({
  db,
  auth: config.auth,
  webhookSecret: config.webhookSecret,
  stripeSecretKey: config.stripeSecretKey,
});

app.listen(config.port, () => {
  console.log(`[ps-08] payments API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-08] WARNING: using default credentials/secret — set real ones in production');
  }
  if (!config.stripeSecretKey) {
    console.log('[ps-08] note: STRIPE_SECRET_KEY unset — using the deterministic mock PSP');
  }
});
