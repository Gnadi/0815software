import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { runSchedules } from './scheduler.js';
import { defaultFetch, dispatch } from './webhooks.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

seed(db);

const app = createApp({ db, auth: config.auth });

app.listen(config.port, () => {
  console.log(`[ps-02] workflow engine API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-02] WARNING: using default credentials/secret — set real ones in production');
  }

  if (config.tickIntervalMs > 0) {
    // Optional internal ticker: drive the scheduler + delivery queue on a
    // timer so no external cron is needed. POST /api/tick still works for
    // tests and cron-driven deployments.
    const timer = setInterval(() => {
      try {
        runSchedules(db, Date.now());
        void dispatch(db, defaultFetch, Date.now());
      } catch (err) {
        console.error('[ps-02] tick error', err);
      }
    }, config.tickIntervalMs);
    timer.unref?.();
    console.log(`[ps-02] internal ticker every ${config.tickIntervalMs}ms`);
  } else {
    console.log('[ps-02] note: schedules only advance while POST /api/tick is called (or a real cron drives it)');
  }
});
