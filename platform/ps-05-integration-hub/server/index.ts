import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv(); // throws fast if INTEGRATION_ENCRYPTION_KEY is malformed
const db = openDb(config.databasePath);

seed(db, config.encryptionKey);

const app = createApp({
  db,
  auth: config.auth,
  encryptionKey: config.encryptionKey,
  webhookSecret: config.webhookSecret,
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
