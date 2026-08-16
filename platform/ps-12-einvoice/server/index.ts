import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
]);
const db = openDb(config.databasePath);

const app = createApp({ db, auth: config.auth, hardening: hardeningFromEnv(), logRequests: true });

app.listen(config.port, () => {
  console.log(`[ps-12] e-invoicing API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-12] WARNING: using default credentials/secret — set real ones in production');
  }
});
