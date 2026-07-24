import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import {
  checkCredentials,
  clearedCookie,
  createToken,
  nowIso,
  requireAuth,
  sessionCookie,
  type AuthConfig,
  type SeamFetch,
} from './auth.js';
import { DomainError, fail, reqText } from './errors.js';
import { providerEntry, publicRegistry, REGISTRY } from './provider-registry.js';
import { connectionEvent, createConnection, credentialsOf, mapConnection, type ConnectionRow } from './connections.js';
import { encrypt } from './crypto.js';
import { storeWebhookEvent, verifySignature } from './webhooks.js';
import { defaultFetch, proxyGraphql, proxyRest, type FetchLike } from './proxy.js';
import { createSyncJob, listSyncJobs, mapSyncJob, runSyncJobs } from './sync.js';
import {
  beginAuthorize,
  connectionFromTokens,
  consumeState,
  exchangeCode,
  refreshToken,
  type OAuthConfig,
} from './oauth.js';
import type { WebhookEvent } from '../shared/types.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  encryptionKey: Buffer;
  webhookSecret: string;
  now?: () => number;
  fetchImpl?: FetchLike;
  oauth?: OAuthConfig;
  selfBaseUrl?: string;
  /** Injectable fetch for the identity-seam verification call (tests). */
  identityFetch?: SeamFetch;
}

function idParam(req: Request): number | null {
  const raw = req.params.id as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}
function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}
function rawBodyOf(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? '';
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, encryptionKey, webhookSecret, now = Date.now } = opts;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const oauth: OAuthConfig = opts.oauth ?? {};
  const selfBaseUrl = opts.selfBaseUrl ?? 'http://localhost:4005';

  const app = express();
  app.use(
    express.json({
      limit: '512kb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  const loadConnection = (id: number | null): ConnectionRow => {
    const row = id ? (db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined) : undefined;
    if (!row) fail(404, 'Connection not found');
    return row;
  };

  const mapWebhookEvent = (row: {
    id: number;
    provider: string;
    connection_id: number | null;
    event_type: string | null;
    signature_valid: number;
    status: string;
    received_at: string;
    processed_at: string | null;
  }): WebhookEvent => ({
    id: row.id,
    provider: row.provider,
    connection_id: row.connection_id,
    event_type: row.event_type,
    signature_valid: row.signature_valid === 1,
    status: row.status,
    received_at: row.received_at,
    processed_at: row.processed_at,
  });

  // ── Public ─────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/login', (req, res) => {
    const b = body(req);
    if (!checkCredentials(auth, b.username, b.password)) fail(401, 'Invalid username or password');
    const token = createToken(auth);
    res.setHeader('Set-Cookie', sessionCookie(auth, token));
    res.json({ token });
  });
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // Inbound webhook receiver — verifies the provider signature.
  app.post('/api/webhooks/:provider', (req, res) => {
    const entry = providerEntry(req.params.provider as string);
    if (!entry) fail(404, 'Unknown provider');
    const b = body(req);
    const eventType = typeof b.type === 'string' ? b.type : (typeof req.headers['x-event-type'] === 'string' ? (req.headers['x-event-type'] as string) : null);

    if (entry.signature_scheme !== 'none') {
      const provided = entry.signature_header ? req.headers[entry.signature_header] : undefined;
      if (typeof provided !== 'string' || provided.length === 0) fail(401, 'Missing webhook signature');
      const valid = verifySignature(entry, webhookSecret, rawBodyOf(req), provided);
      const id = storeWebhookEvent(db, { provider: entry.key, eventType, signatureValid: valid, payload: rawBodyOf(req), now: now() });
      if (!valid) {
        res.status(403).json({ error: 'Invalid webhook signature', id, signature_valid: false });
        return;
      }
      res.status(202).json({ id, signature_valid: true });
      return;
    }

    const id = storeWebhookEvent(db, { provider: entry.key, eventType, signatureValid: true, payload: rawBodyOf(req), now: now() });
    res.status(202).json({ id, signature_valid: true });
  });

  // ── Admin gate ─────────────────────────────────────────────────────
  app.use('/api', requireAuth(auth, { fetch: opts.identityFetch }));

  app.get('/api/providers', (_req, res) => {
    res.json({ providers: publicRegistry() });
  });

  // ── Connections ────────────────────────────────────────────────────
  app.get('/api/connections', (_req, res) => {
    const rows = db.prepare('SELECT * FROM connections ORDER BY id').all() as ConnectionRow[];
    res.json({ connections: rows.map(mapConnection) });
  });

  app.post('/api/connections', (req, res) => {
    const b = body(req);
    const provider = reqText(b, 'provider', 60);
    if (!providerEntry(provider)) fail(422, 'Validation failed', [{ field: 'provider', message: 'unknown provider' }]);
    const name = reqText(b, 'name', 200);
    const credentials = (b.credentials ?? {}) as Record<string, unknown>;
    const row = createConnection(
      db,
      encryptionKey,
      {
        provider,
        name,
        credentials,
        scopes: typeof b.scopes === 'string' ? b.scopes : '',
        externalAccount: typeof b.external_account === 'string' ? b.external_account : null,
      },
      now(),
    );
    res.status(201).json({ connection: mapConnection(row) });
  });

  app.get('/api/connections/:id', (req, res) => {
    res.json({ connection: mapConnection(loadConnection(idParam(req))) });
  });

  app.delete('/api/connections/:id', (req, res) => {
    const row = loadConnection(idParam(req));
    db.prepare(`UPDATE connections SET status = 'disconnected', updated_at = ? WHERE id = ?`).run(nowIso(now()), row.id);
    connectionEvent(db, row.id, 'revoked', {}, now());
    res.json({ ok: true });
  });

  app.post('/api/connections/:id/refresh', (req, res, next) => {
    void (async () => {
      const row = loadConnection(idParam(req));
      const creds = credentialsOf(encryptionKey, row);
      const tokens = await refreshToken(creds, oauth[row.provider], fetchImpl, now());
      if (tokens) {
        // Re-encrypt the rotated credentials at rest in place.
        const blob = encrypt(
          encryptionKey,
          JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
        );
        db.prepare('UPDATE connections SET credentials_encrypted = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(
          blob,
          tokens.expires_at ?? null,
          nowIso(now()),
          row.id,
        );
      } else {
        db.prepare('UPDATE connections SET updated_at = ? WHERE id = ?').run(nowIso(now()), row.id);
      }
      connectionEvent(db, row.id, 'refreshed', { real: tokens !== null }, now());
      res.json({
        ok: true,
        refreshed: tokens !== null,
        connection: mapConnection(db.prepare('SELECT * FROM connections WHERE id = ?').get(row.id) as ConnectionRow),
      });
    })().catch(next);
  });

  // OAuth connect flow (string provider, distinct from the numeric :id routes).
  app.get('/api/connections/:provider/authorize', (req, res) => {
    const entry = providerEntry(req.params.provider as string);
    if (!entry) fail(404, 'Unknown provider');
    const name = typeof req.query.name === 'string' ? req.query.name : `${entry.name} connection`;
    res.redirect(
      302,
      beginAuthorize(db, entry.key, { name, providerConfig: oauth[entry.key], selfBaseUrl }, now()),
    );
  });
  app.get('/api/connections/:provider/callback', (req, res, next) => {
    void (async () => {
      const entry = providerEntry(req.params.provider as string);
      if (!entry) fail(404, 'Unknown provider');
      const stateRow = consumeState(db, entry.key, req.query.state);
      if (!stateRow) fail(400, 'Invalid or expired OAuth state');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) fail(422, 'code is required');
      const redirectUri = `${selfBaseUrl}/api/connections/${entry.key}/callback`;
      const tokens = await exchangeCode(code, redirectUri, oauth[entry.key], fetchImpl, now());
      const connection = connectionFromTokens(
        db,
        encryptionKey,
        entry.key,
        stateRow.name ?? `${entry.name} connection`,
        tokens,
        now(),
      );
      res.status(201).json({ connection: mapConnection(connection) });
    })().catch(next);
  });

  // ── Proxy (REST + GraphQL) ─────────────────────────────────────────
  app.post('/api/connections/:id/proxy', async (req, res) => {
    const row = loadConnection(idParam(req));
    const entry = providerEntry(row.provider);
    if (!entry) fail(404, 'Unknown provider');
    const b = body(req);
    const result = await proxyRest(
      entry,
      credentialsOf(encryptionKey, row),
      {
        method: typeof b.method === 'string' ? b.method : 'GET',
        path: typeof b.path === 'string' ? b.path : '/',
        query: (b.query ?? undefined) as Record<string, string> | undefined,
        body: b.body,
      },
      fetchImpl,
    );
    res.status(result.ok ? 200 : 502).json({ status: result.status, body: result.body });
  });

  app.post('/api/connections/:id/graphql', async (req, res) => {
    const row = loadConnection(idParam(req));
    const entry = providerEntry(row.provider);
    if (!entry) fail(404, 'Unknown provider');
    const b = body(req);
    const query = reqText(b, 'query', 20000);
    const result = await proxyGraphql(
      entry,
      credentialsOf(encryptionKey, row),
      { query, variables: (b.variables ?? {}) as Record<string, unknown> },
      fetchImpl,
    );
    res.status(result.ok ? 200 : 502).json({ status: result.status, body: result.body });
  });

  // ── Webhook event log ──────────────────────────────────────────────
  app.get('/api/webhook-events', (_req, res) => {
    const rows = db.prepare('SELECT * FROM webhook_events ORDER BY id DESC').all() as Parameters<typeof mapWebhookEvent>[0][];
    res.json({ webhook_events: rows.map(mapWebhookEvent) });
  });
  app.get('/api/webhook-events/:id', (req, res) => {
    const id = idParam(req);
    const row = id ? db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(id) : undefined;
    if (!row) fail(404, 'Webhook event not found');
    res.json({ webhook_event: mapWebhookEvent(row as Parameters<typeof mapWebhookEvent>[0]) });
  });

  // ── Sync jobs ──────────────────────────────────────────────────────
  app.post('/api/connections/:id/sync', (req, res) => {
    const row = loadConnection(idParam(req));
    const kind = reqText(body(req), 'kind', 120);
    res.status(201).json({ sync_job: mapSyncJob(createSyncJob(db, row.id, kind, now())) });
  });
  app.get('/api/sync-jobs', (_req, res) => {
    res.json({ sync_jobs: listSyncJobs(db).map(mapSyncJob) });
  });
  // Drive the sync worker once: advance every pending job to done.
  app.post('/api/tick', (_req, res) => {
    const ran = runSyncJobs(db, undefined, now());
    res.json({ ran });
  });

  // ── Terminal error middleware ──────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// Re-export for tests/tools that want the registry keys.
export { REGISTRY };
