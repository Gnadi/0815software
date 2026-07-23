import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

// First start on an empty database: load the demo tenants so the service
// is usable immediately. A database with existing organizations is never
// touched.
seed(db);

const app = createApp({ db, session: config.session });

app.listen(config.port, () => {
  console.log(`[ps-01] identity API on http://localhost:${config.port}`);
  if (config.session.secret === 'dev-secret-change-me') {
    console.warn('[ps-01] WARNING: using the default SESSION_SECRET — set a real one in production');
  }
});
