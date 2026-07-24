import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

seed(db);

const app = createApp({
  db,
  auth: config.auth,
  signingSecret: config.signingSecret,
  maxObjectBytes: config.maxObjectBytes,
});

app.listen(config.port, () => {
  console.log(`[ps-06] file storage API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-06] WARNING: using default credentials/secret — set real ones in production');
  }
});
