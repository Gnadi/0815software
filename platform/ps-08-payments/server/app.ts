import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import {
  checkCredentials,
  checkServiceToken,
  clearedCookie,
  COOKIE_NAME,
  createToken,
  parseBearer,
  parseCookies,
  SERVICE_HEADER,
  sessionCookie,
  verifyIdentityToken,
  verifyToken,
  type AuthConfig,
  type SeamFetch,
} from './auth.js';
import { DomainError, fail, reqText } from './errors.js';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import { MIGRATIONS } from './db.js';
import { pendingCount } from './migrations.js';
import { renderMetrics, requestTelemetry, type Gauge } from './telemetry.js';
import {
  confirmIntent,
  createIntent,
  getIntentRow,
  intentDetail,
  listIntents,
  listLedger,
  reconcileFailed,
  reconcileSucceeded,
  refundIntent,
  settleProcessing,
} from './payments.js';
import { mockProvider } from './providers/mock.js';
import { stripeProvider } from './providers/stripe.js';
import { defaultFetch, type FetchLike, type PaymentProvider } from './providers/index.js';
import { storeWebhookEvent, verifySignature, verifyStripeSignature } from './webhooks.js';
import { withRetry } from './retry-fetch.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  webhookSecret: string;
  stripeSecretKey?: string | null;
  now?: () => number;
  fetchImpl?: FetchLike;
  /** Injectable fetch for the identity-seam verification call (tests). */
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
  /** Emit one JSON log line per request (default false; index.ts passes true). */
  logRequests?: boolean;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}
function idParam(req: Request): number | null {
  const raw = req.params.id as string;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}
function rawBodyOf(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? '';
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, webhookSecret, now = Date.now } = opts;
  const fetchImpl = opts.fetchImpl ?? withRetry(defaultFetch);

  // Provider selection: the real Stripe adapter only when a key is configured,
  // otherwise the deterministic offline mock. A caller may still create an
  // intent with provider "mock" explicitly (e.g. for tests).
  const stripe: PaymentProvider | null = opts.stripeSecretKey ? stripeProvider(opts.stripeSecretKey, fetchImpl) : null;
  const defaultProvider = stripe ?? mockProvider;
  const providerFor = (name: string): PaymentProvider => (name === 'mock' ? mockProvider : defaultProvider);

  const app = express();
  if (opts.hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (opts.hardening.trustProxy > 0) app.set('trust proxy', opts.hardening.trustProxy);
    app.use(hardeningMiddleware(opts.hardening));
  }
  app.use(requestTelemetry({ service: 'ps-08', log: opts.logRequests === true }));
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  // A caller is the admin (session) or a module (service token), with the
  // optional PS-01 identity seam on the session path.
  const callerOk = (req: Request): boolean => {
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifyToken(auth, token)) return true;
    return checkServiceToken(auth, req.headers[SERVICE_HEADER]) === 'ok';
  };
  const requireCaller = (req: Request, res: Response, next: NextFunction): void => {
    if (callerOk(req)) {
      next();
      return;
    }
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && auth.identityUrl) {
      const doFetch = opts.identityFetch ?? (globalThis.fetch as unknown as SeamFetch);
      void verifyIdentityToken(auth.identityUrl, token, doFetch)
        .then((ok) => (ok ? next() : res.status(401).json({ error: 'Authentication required' })))
        .catch(() => res.status(401).json({ error: 'Authentication required' }));
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };

  // ── Public ─────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const gauges: Gauge[] = [
    {
      name: 'payments_processing_intents',
      help: 'Intents whose latest event is processing (stuck if persistently high).',
      value: () =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM payment_intents pi
               WHERE (SELECT type FROM intent_events e WHERE e.intent_id = pi.id ORDER BY e.id DESC LIMIT 1) = 'processing'`,
            )
            .get() as { n: number }
        ).n,
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
    res.type('text/plain').send(renderMetrics('ps-08', gauges));
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

  // Inbound PSP webhook — HMAC-verified, reconciled to the intent.
  app.post('/api/webhooks/:provider', (req, res) => {
    const provider = req.params.provider as string;
    const raw = rawBodyOf(req);
    // Stripe uses its real `Stripe-Signature: t=…,v1=…` scheme (signed over
    // `${t}.${body}`, with a timestamp tolerance); other/mock providers use
    // the generic `X-Signature` HMAC of the raw body.
    const valid =
      provider === 'stripe'
        ? verifyStripeSignature(webhookSecret, raw, req.headers['stripe-signature'] as string | undefined, now())
        : typeof req.headers['x-signature'] === 'string' && verifySignature(webhookSecret, raw, req.headers['x-signature']);
    const b = body(req);
    const eventType = typeof b.type === 'string' ? b.type : null;
    const intentPublicId = typeof b.intent === 'string' ? b.intent : null;
    const id = storeWebhookEvent(db, { provider, eventType, intentPublicId, signatureValid: valid, payload: raw, now: now() });
    if (!valid) {
      res.status(403).json({ error: 'Invalid webhook signature', id, signature_valid: false });
      return;
    }
    if (intentPublicId && eventType === 'payment.succeeded') reconcileSucceeded(db, intentPublicId, now());
    if (intentPublicId && eventType === 'payment.failed') reconcileFailed(db, intentPublicId, now());
    res.status(202).json({ id, signature_valid: true });
  });

  // ── Caller-gated ───────────────────────────────────────────────────
  app.post('/api/intents', requireCaller, (req, res, next) => {
    void (async () => {
      const b = body(req);
      const reference = reqText(b, 'reference', 200);
      const currency = typeof b.currency === 'string' ? b.currency : 'EUR';
      const amountMinor = Number(b.amount_minor);
      const provider = b.provider === 'mock' ? 'mock' : defaultProvider.name;
      const idempotencyKey = typeof b.idempotency_key === 'string' ? b.idempotency_key : null;
      const { row, created } = createIntent(db, { reference, amountMinor, currency, provider, idempotencyKey }, now());
      // Optionally confirm right away.
      if (b.confirm === true && created) await confirmIntent(db, providerFor(row.provider), row, now());
      res.status(created ? 201 : 200).json(intentDetail(db, getIntentRow(db, row.id)));
    })().catch(next);
  });

  app.get('/api/intents', requireCaller, (_req, res) => {
    res.json({ intents: listIntents(db) });
  });

  app.get('/api/intents/:id', requireCaller, (req, res) => {
    res.json(intentDetail(db, getIntentRow(db, idParam(req) ?? -1)));
  });

  app.post('/api/intents/:id/confirm', requireCaller, (req, res, next) => {
    void (async () => {
      const row = getIntentRow(db, idParam(req) ?? -1);
      await confirmIntent(db, providerFor(row.provider), row, now());
      res.json(intentDetail(db, getIntentRow(db, row.id)));
    })().catch(next);
  });

  app.post('/api/intents/:id/refund', requireCaller, (req, res, next) => {
    void (async () => {
      const row = getIntentRow(db, idParam(req) ?? -1);
      const amountMinor = body(req).amount_minor === undefined ? undefined : Number(body(req).amount_minor);
      await refundIntent(db, providerFor(row.provider), row, amountMinor, now());
      res.json(intentDetail(db, getIntentRow(db, row.id)));
    })().catch(next);
  });

  app.get('/api/ledger', requireCaller, (_req, res) => {
    res.json({ ledger: listLedger(db) });
  });

  // Settle processing mock intents (a real PSP settles via webhook instead).
  app.post('/api/tick', requireCaller, (_req, res) => {
    res.json({ settled: settleProcessing(db, now()) });
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
