import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

seed(db);

const app = createApp({ db, auth: config.auth });

app.listen(config.port, () => {
  console.log(`[ps-02] workflow engine API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-02] WARNING: using default credentials/secret — set real ones in production');
  }
  console.log('[ps-02] note: schedules only advance while POST /api/tick is called (or a real cron drives it)');
});
