import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { isTriggerType, type InstanceDetail, type InstanceSummary } from '../shared/types.js';
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
import { DomainError, fail, reqText } from './errors.js';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import {
  allowedTransitions,
  currentDefinition,
  deriveCurrentStep,
  deriveStatus,
  instanceEvents,
  mapDefinition,
  mapEvent,
  validateDefinition,
  type InstanceRow,
  type WorkflowDefRow,
} from './workflows.js';
import { advanceInstance, ingestEvent, startInstance } from './events.js';
import { runSchedules } from './scheduler.js';
import { defaultFetch, dispatch, mapDelivery, mapWebhook, type DeliveryRow, type FetchLike, type WebhookRow } from './webhooks.js';
import type { WorkflowDefinitionBody } from '../shared/types.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  fetchImpl?: FetchLike;
  /** Injectable fetch for the identity-seam verification call (tests). */
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
}

function idParam(req: Request, name = 'id'): number | null {
  const raw = req.params[name] as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function createApp({ db, auth, now = Date.now, fetchImpl = defaultFetch, identityFetch, hardening }: AppOptions): express.Express {
  const app = express();
  if (hardening) app.use(hardeningMiddleware(hardening));
  app.use(express.json({ limit: '256kb' }));

  const summarize = (row: InstanceRow): InstanceSummary => {
    const events = instanceEvents(db, row.id);
    return {
      id: row.id,
      workflow_key: row.workflow_key,
      workflow_version: row.workflow_version,
      idempotency_key: row.idempotency_key,
      created_at: row.created_at,
      current_step: deriveCurrentStep(events),
      status: deriveStatus(events),
    };
  };

  const detail = (row: InstanceRow): InstanceDetail => {
    const events = instanceEvents(db, row.id);
    const status = deriveStatus(events);
    const currentStep = deriveCurrentStep(events);
    const defRow = db
      .prepare('SELECT * FROM workflow_definitions WHERE key = ? AND version = ?')
      .get(row.workflow_key, row.workflow_version) as WorkflowDefRow | undefined;
    const def = defRow ? (JSON.parse(defRow.definition) as WorkflowDefinitionBody) : null;
    return {
      ...summarize(row),
      input: JSON.parse(row.input) as Record<string, unknown>,
      events: events.map(mapEvent),
      allowed_transitions: def ? allowedTransitions(def, currentStep, status) : [],
    };
  };

  // ── Public routes ──────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const b = body(req);
    if (!checkCredentials(auth, b.username, b.password)) fail(401, 'Invalid username or password');
    // Session expiry uses the wall clock; the injected `now` is the domain
    // clock (scheduling, backoff), independent of session lifetime.
    const token = createToken(auth);
    res.setHeader('Set-Cookie', sessionCookie(auth, token));
    res.json({ token });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // Event ingestion — authenticated by the shared service token.
  app.post('/api/events', (req, res) => {
    const verdict = checkServiceToken(auth, req.headers[SERVICE_HEADER]);
    if (verdict === 'missing') fail(401, 'Service token required');
    if (verdict === 'bad') fail(403, 'Invalid service token');
    const b = body(req);
    const type = reqText(b, 'type', 120);
    const payload = (b.payload ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof b.idempotency_key === 'string' ? b.idempotency_key : null;
    res.json(ingestEvent(db, { type, payload, idempotencyKey, now: now() }));
  });

  // Inbound webhook receiver — shared secret in the path. Fires both `event`
  // and `webhook` triggers whose configured event name matches.
  app.post('/api/hooks/:token', (req, res) => {
    if (checkServiceToken(auth, req.params.token) !== 'ok') fail(403, 'Invalid hook token');
    const b = body(req);
    const type = reqText(b, 'type', 120);
    const payload = (b.payload ?? {}) as Record<string, unknown>;
    res.status(202).json(ingestEvent(db, { type, payload, matchTypes: ['event', 'webhook'], now: now() }));
  });

  // ── Admin gate ─────────────────────────────────────────────────────
  app.use('/api', requireAuth(auth, { fetch: identityFetch }));

  // ── Workflows ──────────────────────────────────────────────────────
  app.get('/api/workflows', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM workflow_definitions w
         WHERE w.version = (SELECT MAX(version) FROM workflow_definitions x WHERE x.key = w.key)
         ORDER BY w.key`,
      )
      .all() as WorkflowDefRow[];
    res.json({ workflows: rows.map(mapDefinition) });
  });

  app.get('/api/workflows/:key', (req, res) => {
    const row = currentDefinition(db, req.params.key as string);
    if (!row) fail(404, 'Workflow not found');
    res.json({ workflow: mapDefinition(row) });
  });

  app.post('/api/workflows', (req, res) => {
    const b = body(req);
    const key = reqText(b, 'key', 120);
    const name = reqText(b, 'name', 200);
    const def = validateDefinition(b.definition);
    if (currentDefinition(db, key)) fail(409, 'Workflow already exists — POST a new version instead');
    const enabled = b.enabled === false ? 0 : 1;
    const info = db
      .prepare(
        `INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
         VALUES (?, 1, ?, ?, ?, ?)`,
      )
      .run(key, name, JSON.stringify(def), enabled, nowIso(now()));
    const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(info.lastInsertRowid) as WorkflowDefRow;
    res.status(201).json({ workflow: mapDefinition(row) });
  });

  app.post('/api/workflows/:key/versions', (req, res) => {
    const key = req.params.key as string;
    const b = body(req);
    const cur = currentDefinition(db, key);
    if (!cur) fail(404, 'Workflow not found');
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : cur.name;
    const def = validateDefinition(b.definition);
    const enabled = b.enabled === false ? 0 : 1;
    const info = db
      .prepare(
        `INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, cur.version + 1, name, JSON.stringify(def), enabled, nowIso(now()));
    const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(info.lastInsertRowid) as WorkflowDefRow;
    res.status(201).json({ workflow: mapDefinition(row) });
  });

  app.post('/api/workflows/:key/run', (req, res) => {
    const key = req.params.key as string;
    const b = body(req);
    const input = (b.input ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof b.idempotency_key === 'string' ? b.idempotency_key : null;
    const started = startInstance(db, { key, input, idempotencyKey, now: now() });
    res.status(started.created ? 201 : 200).json({ instance: detail(started.instance) });
  });

  // ── Triggers ───────────────────────────────────────────────────────
  app.get('/api/triggers', (_req, res) => {
    const rows = db.prepare('SELECT * FROM triggers ORDER BY id').all() as {
      id: number;
      workflow_key: string;
      type: string;
      config: string;
      enabled: number;
      last_run_at: string | null;
      created_at: string;
    }[];
    res.json({
      triggers: rows.map((r) => ({
        id: r.id,
        workflow_key: r.workflow_key,
        type: r.type,
        config: JSON.parse(r.config),
        enabled: r.enabled === 1,
        last_run_at: r.last_run_at,
        created_at: r.created_at,
      })),
    });
  });

  app.post('/api/triggers', (req, res) => {
    const b = body(req);
    const workflowKey = reqText(b, 'workflow_key', 120);
    const type = reqText(b, 'type', 40);
    if (!isTriggerType(type)) fail(422, 'Validation failed', [{ field: 'type', message: 'unknown trigger type' }]);
    if (!currentDefinition(db, workflowKey)) fail(404, 'Workflow not found');
    const config = (b.config ?? {}) as Record<string, unknown>;
    const info = db
      .prepare(
        `INSERT INTO triggers (workflow_key, type, config, enabled, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workflowKey, type, JSON.stringify(config), b.enabled === false ? 0 : 1, nowIso(now()));
    res.status(201).json({ trigger_id: Number(info.lastInsertRowid) });
  });

  app.patch('/api/triggers/:id', (req, res) => {
    const id = idParam(req);
    const row = id ? db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) : undefined;
    if (!row) fail(404, 'Trigger not found');
    const b = body(req);
    if (typeof b.enabled === 'boolean') {
      db.prepare('UPDATE triggers SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id);
    }
    if (b.config && typeof b.config === 'object') {
      db.prepare('UPDATE triggers SET config = ? WHERE id = ?').run(JSON.stringify(b.config), id);
    }
    res.json({ ok: true });
  });

  // Fire a manual trigger on demand: starts its workflow with the given input.
  app.post('/api/triggers/:id/fire', (req, res) => {
    const id = idParam(req);
    const row = id
      ? (db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as
          | { id: number; workflow_key: string; type: string; enabled: number }
          | undefined)
      : undefined;
    if (!row) fail(404, 'Trigger not found');
    if (row.type !== 'manual') fail(422, 'Only manual triggers can be fired directly');
    if (row.enabled !== 1) fail(422, 'Trigger is disabled');
    const b = body(req);
    const input = (b.input ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof b.idempotency_key === 'string' ? b.idempotency_key : null;
    const started = startInstance(db, { key: row.workflow_key, input, idempotencyKey, triggerId: row.id, now: now() });
    res.status(started.created ? 201 : 200).json({ instance: detail(started.instance) });
  });

  // ── Instances ──────────────────────────────────────────────────────
  app.get('/api/instances', (req, res) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (typeof req.query.workflow === 'string') {
      clauses.push('workflow_key = ?');
      params.push(req.query.workflow);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    let rows = db.prepare(`SELECT * FROM workflow_instances ${where} ORDER BY id DESC`).all(...params) as InstanceRow[];
    let summaries = rows.map(summarize);
    if (typeof req.query.status === 'string') {
      summaries = summaries.filter((s) => s.status === req.query.status);
    }
    res.json({ instances: summaries });
  });

  app.get('/api/instances/:id', (req, res) => {
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(id) as InstanceRow | undefined) : undefined;
    if (!row) fail(404, 'Instance not found');
    res.json({ instance: detail(row) });
  });

  app.post('/api/instances/:id/advance', (req, res) => {
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(id) as InstanceRow | undefined) : undefined;
    if (!row) fail(404, 'Instance not found');
    const toStep = reqText(body(req), 'to_step', 120);
    advanceInstance(db, row, toStep, now());
    res.json({ instance: detail(row) });
  });

  // ── Webhooks & deliveries ──────────────────────────────────────────
  app.get('/api/webhooks', (_req, res) => {
    const rows = db.prepare('SELECT * FROM webhooks ORDER BY id').all() as WebhookRow[];
    res.json({ webhooks: rows.map(mapWebhook) });
  });

  app.post('/api/webhooks', (req, res) => {
    const b = body(req);
    const eventType = reqText(b, 'event_type', 120);
    const url = reqText(b, 'url', 500);
    const secret = typeof b.secret === 'string' && b.secret ? b.secret : randomBytes(16).toString('hex');
    const info = db
      .prepare('INSERT INTO webhooks (event_type, url, secret, active, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(eventType, url, secret, nowIso(now()));
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid) as WebhookRow;
    res.status(201).json({ webhook: mapWebhook(row), secret });
  });

  app.delete('/api/webhooks/:id', (req, res) => {
    const id = idParam(req);
    if (!id || !db.prepare('SELECT 1 FROM webhooks WHERE id = ?').get(id)) fail(404, 'Webhook not found');
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  app.get('/api/deliveries', (req, res) => {
    const rows = (
      typeof req.query.status === 'string'
        ? db.prepare('SELECT * FROM webhook_deliveries WHERE status = ? ORDER BY id DESC').all(req.query.status)
        : db.prepare('SELECT * FROM webhook_deliveries ORDER BY id DESC').all()
    ) as DeliveryRow[];
    res.json({ deliveries: rows.map(mapDelivery) });
  });

  app.post('/api/deliveries/:id/retry', (req, res) => {
    const id = idParam(req);
    const row = id ? (db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as DeliveryRow | undefined) : undefined;
    if (!row) fail(404, 'Delivery not found');
    db.prepare(
      `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, last_error = NULL,
         next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(nowIso(now()), nowIso(now()), row.id);
    res.json({ ok: true });
  });

  // ── Tick: drive scheduler + dispatcher once ────────────────────────
  app.post('/api/tick', async (_req, res) => {
    const scheduled = runSchedules(db, now());
    const dispatched = await dispatch(db, fetchImpl, now());
    res.json({ scheduled, ...dispatched });
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
