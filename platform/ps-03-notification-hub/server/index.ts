import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { tick } from './queue.js';
import { buildResolver } from './providers/registry.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
]);
const db = openDb(config.databasePath);

seed(db);

const app = createApp({ db, auth: config.auth, resendApiKey: config.resendApiKey, twilio: config.twilio, retentionDays: config.retentionDays, egress: config.egress, hardening: hardeningFromEnv(), logRequests: true });

app.listen(config.port, () => {
  console.log(`[ps-03] notification hub API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-03] WARNING: using default credentials/secret — set real ones in production');
  }
  if (!config.resendApiKey) {
    console.log('[ps-03] note: RESEND_API_KEY unset — email channels degrade to the console provider');
  }

  if (config.tickIntervalMs > 0) {
    // Optional internal ticker: drain the delivery queue on a timer so no
    // external cron is needed. POST /api/tick still works either way.
    const resolve = buildResolver({ resendApiKey: config.resendApiKey, twilio: config.twilio });
    const timer = setInterval(() => {
      tick(db, resolve, Date.now(), config.retentionDays, { egress: config.egress }).catch((err) =>
        console.error('[ps-03] tick error', err),
      );
    }, config.tickIntervalMs);
    timer.unref?.();
    console.log(`[ps-03] internal ticker every ${config.tickIntervalMs}ms`);
  } else {
    console.log('[ps-03] note: queued messages only send while POST /api/tick is called (or a real cron drives it)');
  }
});
