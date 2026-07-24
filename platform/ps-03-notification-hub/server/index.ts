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
]);
const db = openDb(config.databasePath);

seed(db);

const app = createApp({ db, auth: config.auth, resendApiKey: config.resendApiKey, twilio: config.twilio, hardening: hardeningFromEnv() });

app.listen(config.port, () => {
  console.log(`[ps-03] notification hub API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-03] WARNING: using default credentials/secret — set real ones in production');
  }
  if (!config.resendApiKey) {
    console.log('[ps-03] note: RESEND_API_KEY unset — email channels degrade to the console provider');
  }
});
