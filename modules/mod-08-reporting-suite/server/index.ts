import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hardeningFromEnv } from './hardening.js';
import { assertProductionConfig } from './guard.js';
import { buildPlatform } from './platform.js';
import { buildLoginVerifier, loginModeOf } from './sso.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { ensureSourceDb, seedMeta } from './seed.js';
import { startScheduler } from './scheduler.js';
import { openSourceDb } from './source-db.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
]);

// The source database must exist. If SOURCE_DB_PATH was set explicitly to
// a missing file, refuse to start (don't silently invent data over it).
if (config.sourceDbExplicit && !existsSync(config.sourceDbPath)) {
  console.error(
    `[mod-08] SOURCE_DB_PATH points to a file that does not exist: ${config.sourceDbPath}\n` +
      `          Point it at an existing SQLite database, or unset it to use the built-in demo.`,
  );
  process.exit(1);
}

// Default (unset) source path: generate the demo database on first start.
if (!config.sourceDbExplicit) {
  ensureSourceDb(config.sourceDbPath);
}

const db = openDb(config.databasePath);
seedMeta(db, config.exportsDir); // first start only; existing metadata untouched

const sourceDb = openSourceDb(config.sourceDbPath);

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const app = createApp({ db, hardening: hardeningFromEnv(), sourceDb, sourceViewsOnly: config.sourceViewsOnly, auth: config.auth, exportsDir: config.exportsDir, staticDir, platform: buildPlatform(config.platform), verifyLogin: buildLoginVerifier(config.sso), loginMode: loginModeOf(config.sso), serviceToken: config.platform.serviceToken, shellOrigins: config.shellOrigins });

startScheduler(
  { db, sourceDb, exportsDir: config.exportsDir, sourceViewsOnly: config.sourceViewsOnly },
  config.schedulerTickSeconds,
);

app.listen(config.port, () => {
  console.log(`[mod-08] reporting suite API on http://localhost:${config.port}`);
  console.log(`[mod-08] source db (read-only): ${config.sourceDbPath}`);
  if (config.sourceViewsOnly) {
    console.log('[mod-08] SOURCE_VIEWS_ONLY: reports may read only the source’s report_* views');
  }
  if (staticDir) console.log(`[mod-08] serving client from ${staticDir}`);
  if (config.auth.password === 'admin') {
    console.warn('[mod-08] WARNING: using default credentials (admin/admin) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
});
