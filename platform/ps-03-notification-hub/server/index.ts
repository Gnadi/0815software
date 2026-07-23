import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

seed(db);

const app = createApp({ db, auth: config.auth, resendApiKey: config.resendApiKey });

app.listen(config.port, () => {
  console.log(`[ps-03] notification hub API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-03] WARNING: using default credentials/secret — set real ones in production');
  }
  if (!config.resendApiKey) {
    console.log('[ps-03] note: RESEND_API_KEY unset — email channels degrade to the console provider');
  }
});
