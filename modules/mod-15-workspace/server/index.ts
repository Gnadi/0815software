import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hardeningFromEnv } from './hardening.js';
import { assertProductionConfig } from './guard.js';
import { buildPlatform } from './platform.js';
import { createPeerClient } from './peers.js';
import { createModuleSessions } from './sessions.js';
import { buildLoginVerifier, loginModeOf } from './sso.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { CATALOGUE } from '../shared/catalogue.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
]);
const db = openDb(config.databasePath);

// No seed. The Workspace has nothing to invent: a person's first board is
// created on their first visit (`ensureBoards`), and everything on it comes
// from the modules in the stack.

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const platform = buildPlatform(config.platform);
const peers = createPeerClient({
  peers: config.peers,
  serviceToken: config.platform.serviceToken,
  timeoutMs: config.peerTimeoutMs,
});
const sessions = createModuleSessions(peers);

const app = createApp({
  db,
  hardening: hardeningFromEnv(),
  auth: config.auth,
  peers,
  sessions,
  staticDir,
  platform,
  verifyLogin: buildLoginVerifier(config.sso),
  // Derived from the same two fields the verifier switches on, so the login
  // form's hint, the board's shared-account notice and what actually happens at
  // sign-in cannot drift apart. Half-configured counts as unconfigured — the
  // board would otherwise promise separate identities it is not getting.
  loginMode: loginModeOf(config.sso),
});

app.listen(config.port, () => {
  console.log(`[mod-15] workspace API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-15] serving client from ${staticDir}`);

  const configured = CATALOGUE.filter((entry) => config.peers[entry.id] !== undefined);
  if (configured.length === 0) {
    console.log('[mod-15] no modules are wired — set <MODULE>_URL to put them on the board');
  } else {
    console.log(`[mod-15] ${configured.length} module(s) wired: ${configured.map((e) => e.label).join(', ')}`);
  }

  // The two misconfigurations that produce a board which LOOKS broken rather
  // than one that reports a problem, so both are called out at boot.
  if (!config.platform.serviceToken) {
    console.warn('[mod-15] WARNING: PLATFORM_SERVICE_TOKEN is unset — no module will answer a summary');
  }
  const framable = configured.filter((entry) => entry.embeddable && config.peers[entry.id]!.publicUrl === null);
  if (framable.length > 0) {
    console.warn(
      `[mod-15] WARNING: no public URL for ${framable.map((e) => e.publicUrlEnv).join(', ')} —` +
        ' those modules will show figures but cannot be embedded',
    );
  }
  if (config.auth.password === 'admin') {
    console.warn('[mod-15] WARNING: using default credentials (admin/admin) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
});
