import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { runSyncJobs } from './sync.js';

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
  hardening: hardeningFromEnv(), logRequests: true,
});

app.listen(config.port, () => {
  console.log(`[ps-05] integration hub API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-05] WARNING: using default credentials/secret — set real ones in production');
  }
  if (config.encryptionKey.equals(Buffer.alloc(32))) {
    console.warn('[ps-05] WARNING: using the all-zero default INTEGRATION_ENCRYPTION_KEY — set a real one');
  }

  if (config.tickIntervalMs > 0) {
    // Optional internal ticker: run due sync jobs on a timer so no external
    // cron is needed. POST /api/tick still works either way.
    const timer = setInterval(() => {
      try {
        runSyncJobs(db, undefined, Date.now());
      } catch (err) {
        console.error('[ps-05] tick error', err);
      }
    }, config.tickIntervalMs);
    timer.unref?.();
    console.log(`[ps-05] internal ticker every ${config.tickIntervalMs}ms`);
  } else {
    console.log('[ps-05] note: sync jobs only run while POST /api/tick is called (or a real cron drives it)');
  }
});
