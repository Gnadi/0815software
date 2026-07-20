import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
const db = openDb(config.databasePath);

// First start on an empty database: load the example data so the app is
// usable immediately. A database with existing data is never touched.
seed(db);

// When running the compiled server (dist/server/server/index.js), the built
// client lives at dist/client. In dev (tsx) it usually doesn't exist yet —
// then only the API is served and the UI comes from `npm run dev:web`.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const app = createApp({ db, auth: config.auth, staticDir });

app.listen(config.port, () => {
  console.log(`[mod-12] support ticket system API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-12] serving client from ${staticDir}`);
  if (config.auth.password === 'agent') {
    console.warn('[mod-12] WARNING: using default credentials (agent/agent) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
  if (config.auth.intakeSecret === 'dev-intake-secret') {
    console.warn('[mod-12] WARNING: using the default intake secret — set INTAKE_SECRET before wiring a real mailbox');
  }
});
