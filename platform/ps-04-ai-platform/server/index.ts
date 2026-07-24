import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
]);
const db = openDb(config.databasePath);

seed(db);

const app = createApp({
  db,
  auth: config.auth,
  anthropicApiKey: config.anthropicApiKey,
  anthropicModel: config.anthropicModel,
  openaiApiKey: config.openaiApiKey,
  openaiModel: config.openaiModel,
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  ollamaBaseUrl: config.ollamaBaseUrl,
  ollamaModel: config.ollamaModel,
  kimiApiKey: config.kimiApiKey,
  kimiModel: config.kimiModel,
  kimiBaseUrl: config.kimiBaseUrl,
  imageModel: config.imageModel,
  speechModel: config.speechModel,
  embedModel: config.embedModel,
  hardening: hardeningFromEnv(),
});

app.listen(config.port, () => {
  console.log(`[ps-04] ai platform API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-04] WARNING: using default credentials/secret — set real ones in production');
  }
  const enabled = [
    config.anthropicApiKey && 'anthropic',
    config.openaiApiKey && 'openai',
    config.geminiApiKey && 'gemini',
    config.ollamaBaseUrl && 'ollama',
    config.kimiApiKey && 'kimi',
  ].filter(Boolean);
  console.log(
    enabled.length
      ? `[ps-04] live providers configured: ${enabled.join(', ')} (mock is always available as fallback)`
      : '[ps-04] note: no live provider configured — all inference uses the deterministic mock provider',
  );
});
