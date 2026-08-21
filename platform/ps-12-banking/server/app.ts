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
import { Transport } from './transport.js';
import { publicRegistry } from './bank-registry.js';
import { renderIniLetter } from './ini-letter.js';
import { KeyStoreError, loadKeySecret } from './keystore.js';
import {
  connectionDetail,
  createConnection,
  fetchBankKeys,
  generateKeys,
  listConnections,
  nowIso,
  probeVersions,
  resume,
  sendHia,
  sendIni,
  suspend,
  verifyBankKeys,
  type ExchangeContext,
} from './connections.js';
import { listOrders, orderDetail, previewOrder, submitOrder, type OrderContext } from './orders.js';
import {
  downloadContent,
  downloadDetail,
  fetchOne,
  listDownloads,
  tick,
  type DownloadContext,
} from './downloads.js';
import type { BtfInput } from '../shared/types.js';

/**
 * The HTTP surface.
 *
 * Two kinds of caller, and the split is the point:
 *
 * - **A human, with an admin session**, does everything to do with keys. Every
 *   lifecycle route — creating a connection, generating keys, INI, HIA, HPB,
 *   confirming the bank's digests, suspending — is session-only.
 * - **A module, with `X-Service-Token`**, may submit orders and read them.
 *   Nothing more.
 *
 * A module credential therefore cannot bring a connection into existence,
 * cannot move one to `ready`, and cannot lift its own ceilings. Given that at
 * signature class E a submitted order is money gone, the blast radius of a
 * leaked service token is bounded by limits a human set on a connection a human
 * activated — and that bound only holds if the token cannot reach these routes.
 *
 * Key material has no route at all. Digests are the only thing about a key that
 * ever leaves this process.
 */

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  /** 64 hex characters — the key store's encryption key. */
  keySecret: string;
  /** Injectable so tests can hand over a mock bank instead of the network. */
  transport?: Transport;
  now?: () => string;
  identityFetch?: SeamFetch;
  hardening?: HardeningConfig;
  logRequests?: boolean;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function optionalText(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalInt(source: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DomainError(422, 'Validation failed', [
      { field, message: `must be a whole number between ${min} and ${max}` },
    ]);
  }
  return value;
}

/**
 * Read a BTF off a request body, refusing one that would not route a file.
 *
 * Absent is fine and is the ordinary case: the connection's bank profile
 * supplies one, so a module that has produced a pain.001 does not also have to
 * know what a Business Transaction Format is. Present but malformed is not.
 */
function btfFrom(source: Record<string, unknown>): BtfInput | undefined {
  const raw = source.btf;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new DomainError(422, 'Validation failed', [{ field: 'btf', message: 'must be an object' }]);
  }
  const btf = raw as Record<string, unknown>;
  return {
    service_name: reqText(btf, 'service_name', 40),
    scope: optionalText(btf, 'scope'),
    option: optionalText(btf, 'option'),
    msg_name: reqText(btf, 'msg_name', 40),
    msg_version: optionalText(btf, 'msg_version'),
    container: optionalText(btf, 'container'),
  };
}

/** Decode the payload, refusing base64 that is not base64. */
function payloadFrom(source: Record<string, unknown>): Buffer {
  const raw = source.payload_base64;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DomainError(422, 'Validation failed', [{ field: 'payload_base64', message: 'is required' }]);
  }
  const cleaned = raw.replace(/\s+/g, '');
  const decoded = Buffer.from(cleaned, 'base64');
  // Buffer.from silently drops anything that is not base64, so the round trip
  // is the only honest check — and signing bytes the caller did not send is
  // exactly the mistake worth refusing.
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
    throw new DomainError(422, 'Validation failed', [{ field: 'payload_base64', message: 'is not valid base64' }]);
  }
  return decoded;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth } = opts;
  const now = opts.now ?? nowIso;
  const transport = opts.transport ?? new Transport();
  const keySecret = loadKeySecret(opts.keySecret);

  const app = express();
  if (opts.hardening) {
    if (opts.hardening.trustProxy > 0) app.set('trust proxy', opts.hardening.trustProxy);
    app.use(hardeningMiddleware(opts.hardening));
  }
  app.use(requestTelemetry({ service: 'ps-12', log: opts.logRequests === true }));
  // A pain.001 for a few hundred transfers is well under a megabyte; the cap is
  // generous enough for a large payment run and small enough to be a limit.
  app.use(express.json({ limit: '8mb' }));

  const sessionOk = (req: Request): boolean => {
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    return token !== undefined && token !== null && token !== '' && verifyToken(auth, token);
  };

  /** A human. Everything to do with keys goes through this. */
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (sessionOk(req)) {
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
    // Deliberately explicit: a module presenting a service token here is not
    // "unauthenticated", it is using the wrong credential for a human's job.
    if (checkServiceToken(auth, req.headers[SERVICE_HEADER]) === 'ok') {
      res.status(403).json({ error: 'This route is for an operator with an admin session, not a service token' });
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };

  /** A human or a module. Orders only. */
  const requireCaller = (req: Request, res: Response, next: NextFunction): void => {
    if (checkServiceToken(auth, req.headers[SERVICE_HEADER]) === 'ok') {
      next();
      return;
    }
    requireAdmin(req, res, next);
  };

  const actorOf = (req: Request): string => (sessionOk(req) ? auth.username : 'service');

  const exchangeCtx = (req: Request): ExchangeContext & OrderContext & DownloadContext => ({
    db,
    keySecret,
    transport,
    actor: actorOf(req),
    now,
  });

  // ── Public ─────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const gauges: Gauge[] = [
    {
      name: 'banking_connections_ready',
      help: 'Bank connections a human has activated — the only ones that can carry an order.',
      value: () =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bank_connections c
               WHERE EXISTS (SELECT 1 FROM bank_keys k WHERE k.connection_id = c.id AND k.verified_at IS NOT NULL)`,
            )
            .get() as { n: number }
        ).n,
    },
    {
      name: 'banking_orders_failed',
      help: 'Orders whose outcome is UNKNOWN — the conversation broke. Each one needs a human to check with the bank.',
      value: () =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM orders o
               WHERE EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.type = 'failed')`,
            )
            .get() as { n: number }
        ).n,
    },
  ];

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
    res.type('text/plain').send(renderMetrics('ps-12', gauges));
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

  // ── The bank profile registry ──────────────────────────────────────
  app.get('/api/banks', requireCaller, (_req, res) => {
    res.json({ banks: publicRegistry() });
  });

  // ── Connections — an operator's routes ─────────────────────────────
  app.post('/api/connections', requireAdmin, (req, res) => {
    const b = body(req);
    const connection = createConnection(
      db,
      {
        key: reqText(b, 'key', 60),
        displayName: reqText(b, 'display_name', 120),
        bankKey: reqText(b, 'bank_key', 60),
        url: reqText(b, 'url', 400),
        hostId: reqText(b, 'host_id', 60),
        partnerId: reqText(b, 'partner_id', 60),
        userId: reqText(b, 'user_id', 60),
        esVersion: b.es_version === 'A006' ? 'A006' : 'A005',
        debtorIban: optionalText(b, 'debtor_iban'),
        maxAmountMinor: optionalInt(b, 'max_amount_minor', 1, Number.MAX_SAFE_INTEGER),
        maxTransfers: optionalInt(b, 'max_transfers', 1, 1_000_000),
      },
      actorOf(req),
    );
    res.status(201).json(connectionDetail(db, connection.key));
  });

  app.get('/api/connections', requireAdmin, (_req, res) => {
    res.json({ connections: listConnections(db) });
  });

  app.get('/api/connections/:key', requireAdmin, (req, res) => {
    res.json(connectionDetail(db, req.params.key as string));
  });

  app.post('/api/connections/:key/keys', requireAdmin, (req, res) => {
    res.status(201).json(generateKeys(exchangeCtx(req), req.params.key as string));
  });

  app.get('/api/connections/:key/versions', requireAdmin, (req, res, next) => {
    void (async () => {
      res.json(await probeVersions(exchangeCtx(req), req.params.key as string));
    })().catch(next);
  });

  app.post('/api/connections/:key/ini', requireAdmin, (req, res, next) => {
    void (async () => {
      res.json(await sendIni(exchangeCtx(req), req.params.key as string));
    })().catch(next);
  });

  app.post('/api/connections/:key/hia', requireAdmin, (req, res, next) => {
    void (async () => {
      res.json(await sendHia(exchangeCtx(req), req.params.key as string));
    })().catch(next);
  });

  app.post('/api/connections/:key/hpb', requireAdmin, (req, res, next) => {
    void (async () => {
      res.json(await fetchBankKeys(exchangeCtx(req), req.params.key as string));
    })().catch(next);
  });

  // The letter that has to be printed, signed by hand and posted. It carries
  // digests, not keys — see ini-letter.ts for why the paper is the security.
  app.get('/api/connections/:key/ini-letter.pdf', requireAdmin, (req, res) => {
    const key = req.params.key as string;
    const pdf = renderIniLetter(db, key, now().slice(0, 10));
    res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="ini-letter-${key}.pdf"`);
    res.send(pdf);
  });

  /**
   * The one step in the whole service that is a human judgement.
   *
   * HPB cannot prove the keys came from the bank, so an operator compares the
   * digests against the bank's own published letter. Until that happens the
   * connection cannot carry an order.
   */
  app.post('/api/connections/:key/verify-bank-keys', requireAdmin, (req, res) => {
    const b = body(req);
    res.json(
      verifyBankKeys(exchangeCtx(req), req.params.key as string, {
        authDigest: reqText(b, 'auth_digest', 200),
        encDigest: reqText(b, 'enc_digest', 200),
      }),
    );
  });

  app.post('/api/connections/:key/suspend', requireAdmin, (req, res) => {
    const b = body(req);
    res.json(suspend(exchangeCtx(req), req.params.key as string, reqText(b, 'reason', 200)));
  });

  app.post('/api/connections/:key/resume', requireAdmin, (req, res) => {
    res.json(resume(exchangeCtx(req), req.params.key as string));
  });

  // ── Orders — what a module reaches ─────────────────────────────────
  app.post('/api/orders', requireCaller, (req, res, next) => {
    void (async () => {
      const b = body(req);
      const input = {
        connection: reqText(b, 'connection', 60),
        btf: btfFrom(b),
        payload: payloadFrom(b),
        idempotencyKey: optionalText(b, 'idempotency_key'),
      };

      // A dry run signs nothing and stores nothing: it is how a caller checks
      // a file and a BTF against a connection before committing to them.
      if (req.query.validate === '1') {
        res.json(previewOrder(db, input));
        return;
      }

      const { order, replayed } = await submitOrder(exchangeCtx(req), input);
      res.status(replayed ? 200 : 201).json(order);
    })().catch(next);
  });

  app.get('/api/orders', requireCaller, (req, res) => {
    res.json({
      orders: listOrders(db, {
        connection: optionalText(req.query as Record<string, unknown>, 'connection'),
        limit: optionalInt(req.query as Record<string, unknown>, 'limit', 1, 1_000),
      }),
    });
  });

  app.get('/api/orders/:public_id', requireCaller, (req, res) => {
    res.json(orderDetail(db, req.params.public_id as string));
  });

  // ── Downloads — what the bank has for us ───────────────────────────
  app.get('/api/downloads', requireCaller, (req, res) => {
    const query = req.query as Record<string, unknown>;
    res.json({
      downloads: listDownloads(db, {
        connection: optionalText(query, 'connection'),
        kind: optionalText(query, 'kind'),
        limit: optionalInt(query, 'limit', 1, 1_000),
      }),
    });
  });

  app.get('/api/downloads/:public_id', requireCaller, (req, res) => {
    res.json(downloadDetail(db, req.params.public_id as string));
  });

  /**
   * The file itself.
   *
   * Separate from the metadata route so a listing never carries megabytes of
   * XML, and so a module can stream a statement it wants to parse without
   * this service having an opinion about what is in it.
   */
  app.get('/api/downloads/:public_id/content', requireCaller, (req, res) => {
    const detail = downloadDetail(db, req.params.public_id as string);
    res.type('application/xml').setHeader(
      'Content-Disposition',
      `attachment; filename="${detail.public_id}-${detail.btf.msg_name}.xml"`,
    );
    res.send(downloadContent(db, detail.public_id));
  });

  /** Fetch one BTF now, without waiting for the tick. An operator's button. */
  app.post('/api/connections/:key/fetch', requireAdmin, (req, res, next) => {
    void (async () => {
      const b = body(req);
      const btf = btfFrom(b);
      if (btf === undefined) {
        throw new DomainError(422, 'Validation failed', [
          { field: 'btf', message: 'is required — name what to fetch' },
        ]);
      }
      const range = b.date_range as { from?: unknown; to?: unknown } | undefined;
      const dateRange =
        range !== undefined && typeof range.from === 'string' && typeof range.to === 'string'
          ? { from: range.from, to: range.to }
          : undefined;
      res.json(await fetchOne(exchangeCtx(req), req.params.key as string, btf, dateRange));
    })().catch(next);
  });

  /**
   * The periodic pass: fetch what every ready connection has waiting, and fold
   * any payment status reports back into the orders they are about.
   *
   * Answers 200 with the problems listed rather than failing: one bank being
   * unreachable must not stop the others from being polled, and a scheduler
   * calling this every minute needs an answer it can log, not a 500.
   */
  app.post('/api/tick', requireCaller, (req, res, next) => {
    void (async () => {
      res.json(await tick(exchangeCtx(req)));
    })().catch(next);
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
    // A key-store failure is a 500 with a readable message rather than a
    // stack trace: the recovery is an operator action, not a code fix.
    if (err instanceof KeyStoreError) {
      res.status(500).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
