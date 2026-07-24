import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
  { name: 'WEBHOOK_SECRET', value: config.webhookSecret },
  { name: 'INTEGRATION_ENCRYPTION_KEY', value: process.env.INTEGRATION_ENCRYPTION_KEY ?? '0'.repeat(64) },
]); // throws fast if INTEGRATION_ENCRYPTION_KEY is malformed
const db = openDb(config.databasePath);

seed(db, config.encryptionKey);

const app = createApp({
  db,
  auth: config.auth,
  encryptionKey: config.encryptionKey,
  webhookSecret: config.webhookSecret,
  oauth: config.oauth,
  selfBaseUrl: config.selfBaseUrl,
  hardening: hardeningFromEnv(),
});

app.listen(config.port, () => {
  console.log(`[ps-05] integration hub API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-05] WARNING: using default credentials/secret — set real ones in production');
  }
  if (config.encryptionKey.equals(Buffer.alloc(32))) {
    console.warn('[ps-05] WARNING: using the all-zero default INTEGRATION_ENCRYPTION_KEY — set a real one');
  }
});
