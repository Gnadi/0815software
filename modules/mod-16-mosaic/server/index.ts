import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hardeningFromEnv } from './hardening.js';
import { assertProductionConfig } from './guard.js';
import { buildPlatform } from './platform.js';
import { createPeerClient } from './peers.js';
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

// No seed. This module has nothing to invent: a person's first board is created
// on their first visit (`ensureBoards`) and starts empty, because which modules
// a customer licensed is not knowable from here.

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const platform = buildPlatform(config.platform);
const peers = createPeerClient({
  peers: config.peers,
  serviceToken: config.platform.serviceToken,
  timeoutMs: config.peerTimeoutMs,
});

const app = createApp({
  db,
  hardening: hardeningFromEnv(),
  auth: config.auth,
  peers,
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
  console.log(`[mod-16] mosaic API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-16] serving client from ${staticDir}`);

  // A pane needs THREE things, and a missing one of them produces a frame that
  // looks broken rather than a message that explains itself. So each is
  // reported at boot, while somebody is still reading the logs.
  const configured = CATALOGUE.filter((entry) => config.peers[entry.id] !== undefined);
  const tileable = configured.filter((entry) => entry.embeddable && config.peers[entry.id]!.publicUrl !== null);
  if (tileable.length === 0) {
    console.log('[mod-16] no module can be tiled yet — set <MODULE>_URL and <MODULE>_PUBLIC_URL');
  } else {
    console.log(`[mod-16] ${tileable.length} module(s) tileable: ${tileable.map((e) => e.label).join(', ')}`);
  }

  if (!config.platform.serviceToken) {
    console.warn('[mod-16] WARNING: PLATFORM_SERVICE_TOKEN is unset — no module will mint a session, so every pane will fail');
  }
  const noPublic = configured.filter((entry) => entry.embeddable && config.peers[entry.id]!.publicUrl === null);
  if (noPublic.length > 0) {
    console.warn(
      `[mod-16] WARNING: no public URL for ${noPublic.map((e) => e.publicUrlEnv).join(', ')} —` +
        ' a browser cannot reach a container name, so those modules cannot be tiled',
    );
  }
  if (config.auth.password === 'admin') {
    console.warn('[mod-16] WARNING: using default credentials (admin/admin) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
});
