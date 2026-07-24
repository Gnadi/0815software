import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { isChannelType } from '../shared/types.js';
import {
  checkCredentials,
  checkServiceToken,
  clearedCookie,
  createToken,
  nowIso,
  SERVICE_HEADER,
  sessionCookie,
  requireAuth,
  type AuthConfig,
  type SeamFetch,
} from './auth.js';
import type { TwilioConfig } from './providers/twilio-sms.js';
import { DomainError, fail, reqText } from './errors.js';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import { MIGRATIONS } from './db.js';
import { pendingCount } from './migrations.js';
import { renderMetrics, requestTelemetry, type Gauge } from './telemetry.js';
import { latestTemplate, mapTemplate, renderTemplate, type TemplateRow } from './templates.js';
import { enqueue, mapChannel, mapMessage, tick, type ChannelRow, type MessageRow } from './queue.js';
import { buildResolver } from './providers/registry.js';
import type { FetchLike, ProviderResolver } from './providers/index.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  /** Override provider resolution (tests). Otherwise built from config. */
  resolve?: ProviderResolver;
  resendApiKey?: string | null;
  twilio?: TwilioConfig | null;
  fetchImpl?: FetchLike;
  /** Injectable fetch for the identity-seam verification call (tests). */
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
  /** Emit one JSON log line per request (default false; index.ts passes true). */
  logRequests?: boolean;
}

function idParam(req: Request): number | null {
  const raw = req.params.id as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, now = Date.now } = opts;
  const resolve =
    opts.resolve ??
    buildResolver({ resendApiKey: opts.resendApiKey ?? null, twilio: opts.twilio ?? null, fetchImpl: opts.fetchImpl });

  const app = express();
  if (opts.hardening) app.use(hardeningMiddleware(opts.hardening));
  app.use(requestTelemetry({ service: 'ps-03', log: opts.logRequests === true }));
  app.use(express.json({ limit: '256kb' }));

  const channelByName = (name: string): ChannelRow | undefined =>
    db.prepare('SELECT * FROM channels WHERE name = ?').get(name) as ChannelRow | undefined;

  // ── Public routes ──────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const gauges: Gauge[] = [
    {
      name: 'notification_dead_messages',
      help: 'Messages that exhausted their delivery retries.',
      value: () => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'dead'").get() as { n: number }).n,
    },
    {
      name: 'notification_queued_messages',
      help: 'Messages waiting to be sent or retried.',
      value: () => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status IN ('queued', 'failed')").get() as { n: number }).n,
    },
  ];

  // Readiness: DB reachable and schema fully migrated (liveness is /api/health).
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const pending = pendingCount(db, MIGRATIONS);
      if (pending > 0) {
        res.status(503).json({ ready: false, pending_migrations: pending });
        return;
      }
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  app.get('/api/metrics', (_req, res) => {
    res.type('text/plain').send(renderMetrics('ps-03', gauges));
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

  // Submit a message — authenticated by the shared service token.
  app.post('/api/send', (req, res) => {
    const verdict = checkServiceToken(auth, req.headers[SERVICE_HEADER]);
    if (verdict === 'missing') fail(401, 'Service token required');
    if (verdict === 'bad') fail(403, 'Invalid service token');

    const b = body(req);
    const channelName = reqText(b, 'channel', 120);
    const to = reqText(b, 'to', 320);
    const channel = channelByName(channelName);
    if (!channel) fail(404, 'Channel not found');
    const variables = (b.variables ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof b.idempotency_key === 'string' ? b.idempotency_key : null;

    let subject: string | null = null;
    let text: string;
    let templateKey: string | null = null;
    if (typeof b.template_key === 'string') {
      const tpl = latestTemplate(db, b.template_key);
      if (!tpl) fail(404, 'Template not found');
      templateKey = tpl.key;
      const rendered = renderTemplate(tpl, variables);
      subject = rendered.subject;
      text = rendered.body;
    } else {
      subject = typeof b.subject === 'string' ? b.subject : null;
      text = reqText(b, 'body', 20000);
    }

    const enqueued = enqueue(db, {
      channelId: channel.id,
      templateKey,
      to,
      subject,
      body: text,
      variables,
      idempotencyKey,
      now: now(),
    });
    res.status(enqueued.created ? 201 : 200).json({ message: mapMessage(enqueued.message) });
  });

  // ── Admin gate ─────────────────────────────────────────────────────
  app.use('/api', requireAuth(auth, { fetch: opts.identityFetch }));

  // ── Channels ───────────────────────────────────────────────────────
  app.get('/api/channels', (_req, res) => {
    const rows = db.prepare('SELECT * FROM channels ORDER BY id').all() as ChannelRow[];
    res.json({ channels: rows.map(mapChannel) });
  });

  app.post('/api/channels', (req, res) => {
    const b = body(req);
    const type = reqText(b, 'type', 40);
    if (!isChannelType(type)) fail(422, 'Validation failed', [{ field: 'type', message: 'unknown channel type' }]);
    const name = reqText(b, 'name', 120);
    const provider = typeof b.provider === 'string' && b.provider ? b.provider : 'console';
    const config = (b.config ?? {}) as Record<string, unknown>;
    if (channelByName(name)) fail(409, 'A channel with that name already exists');
    const info = db
      .prepare('INSERT INTO channels (type, name, provider, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(type, name, provider, JSON.stringify(config), b.enabled === false ? 0 : 1, nowIso(now()));
    res.status(201).json({ channel: mapChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid) as ChannelRow) });
  });

  app.patch('/api/channels/:id', (req, res) => {
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined) : undefined;
    if (!row) fail(404, 'Channel not found');
    const b = body(req);
    if (typeof b.enabled === 'boolean') db.prepare('UPDATE channels SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id);
    if (typeof b.provider === 'string') db.prepare('UPDATE channels SET provider = ? WHERE id = ?').run(b.provider, id);
    if (b.config && typeof b.config === 'object') db.prepare('UPDATE channels SET config = ? WHERE id = ?').run(JSON.stringify(b.config), id);
    res.json({ channel: mapChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow) });
  });

  // ── Templates ──────────────────────────────────────────────────────
  const insertTemplate = (key: string, version: number, b: Record<string, unknown>): TemplateRow => {
    const channelType = reqText(b, 'channel_type', 40);
    if (!isChannelType(channelType)) fail(422, 'Validation failed', [{ field: 'channel_type', message: 'unknown channel type' }]);
    const bodyText = reqText(b, 'body', 20000);
    const subject = typeof b.subject === 'string' ? b.subject : null;
    const locale = typeof b.locale === 'string' && b.locale ? b.locale : 'en';
    const info = db
      .prepare('INSERT INTO templates (key, version, channel_type, locale, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key, version, channelType, locale, subject, bodyText, nowIso(now()));
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid) as TemplateRow;
  };

  app.get('/api/templates', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM templates t
         WHERE t.version = (SELECT MAX(version) FROM templates x WHERE x.key = t.key)
         ORDER BY t.key`,
      )
      .all() as TemplateRow[];
    res.json({ templates: rows.map(mapTemplate) });
  });

  app.get('/api/templates/:key', (req, res) => {
    const row = latestTemplate(db, req.params.key as string);
    if (!row) fail(404, 'Template not found');
    res.json({ template: mapTemplate(row) });
  });

  app.post('/api/templates', (req, res) => {
    const b = body(req);
    const key = reqText(b, 'key', 120);
    if (latestTemplate(db, key)) fail(409, 'Template already exists — POST a new version instead');
    res.status(201).json({ template: mapTemplate(insertTemplate(key, 1, b)) });
  });

  app.post('/api/templates/:key/versions', (req, res) => {
    const key = req.params.key as string;
    const cur = latestTemplate(db, key);
    if (!cur) fail(404, 'Template not found');
    res.status(201).json({ template: mapTemplate(insertTemplate(key, cur.version + 1, body(req))) });
  });

  app.post('/api/templates/:key/preview', (req, res) => {
    const row = latestTemplate(db, req.params.key as string);
    if (!row) fail(404, 'Template not found');
    const variables = (body(req).variables ?? {}) as Record<string, unknown>;
    res.json({ rendered: renderTemplate(row, variables) });
  });

  // ── Messages ───────────────────────────────────────────────────────
  app.get('/api/messages', (req, res) => {
    const rows = (
      typeof req.query.status === 'string'
        ? db.prepare('SELECT * FROM messages WHERE status = ? ORDER BY id DESC').all(req.query.status)
        : db.prepare('SELECT * FROM messages ORDER BY id DESC').all()
    ) as MessageRow[];
    res.json({ messages: rows.map(mapMessage) });
  });

  app.get('/api/messages/:id', (req, res) => {
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) : undefined;
    if (!row) fail(404, 'Message not found');
    const events = db.prepare('SELECT type, meta, created_at FROM message_events WHERE message_id = ? ORDER BY id').all(row.id);
    res.json({ message: mapMessage(row), events });
  });

  app.post('/api/messages/:id/retry', (req, res) => {
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) : undefined;
    if (!row) fail(404, 'Message not found');
    db.prepare(
      `UPDATE messages SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(nowIso(now()), nowIso(now()), row.id);
    res.json({ ok: true });
  });

  app.post('/api/tick', async (_req, res) => {
    res.json(await tick(db, resolve, now()));
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
