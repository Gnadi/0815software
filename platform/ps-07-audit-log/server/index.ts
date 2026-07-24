import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

seed(db);

const app = createApp({ db, auth: config.auth });

app.listen(config.port, () => {
  console.log(`[ps-07] audit log API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-07] WARNING: using default credentials/secret — set real ones in production');
  }
});
