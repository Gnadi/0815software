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
  anthropicApiKey: config.anthropicApiKey,
  anthropicModel: config.anthropicModel,
});

app.listen(config.port, () => {
  console.log(`[ps-04] ai platform API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-04] WARNING: using default credentials/secret — set real ones in production');
  }
  console.log(
    config.anthropicApiKey
      ? '[ps-04] Anthropic adapter available for provider="anthropic" chat requests'
      : '[ps-04] note: ANTHROPIC_API_KEY unset — all inference uses the deterministic mock provider',
  );
});
