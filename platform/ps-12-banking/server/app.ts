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
  clearFailure,
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
  sendSpr,
  suspend,
  verifyBankKeys,
  type ExchangeContext,
} from './connections.js';
import {
  listOrders,
  orderDetail,
  previewOrder,
  submitOrder,
  type OrderContext,
  type VopMode,
} from './orders.js';
import { exchangeDetail, listExchanges, sqliteRecorder } from './exchanges.js';
import { chainHead, verifyChain } from './chain.js';
import {
  downloadContent,
  downloadDetail,
  fetchOne,
  listDownloads,
  tick,
  type DownloadContext,
} from './downloads.js';
import type { Product } from './ebics/envelopes.js';
import {
  cancel as veuCancel,
  detail as veuDetail,
  overview as veuOverview,
  sign as veuSign,
  transactions as veuTransactions,
  type VeuContext,
  type VeuOrderInput,
} from './veu.js';
import {
  availableDownloads,
  fetchAvailableOrderData,
  fetchBankParameters,
  fetchCustomerData,
} from './customer-data.js';
import {
  addSubscription,
  listSubscriptions,
  removeSubscription,
  setSubscriptionEnabled,
} from './subscriptions.js';
import { changeKeys, completeKeyChange, discardKeyChange, pendingKeyChange } from './key-change.js';
import {
  findEntries,
  listStatements,
  reparseStatements,
  statementDetail,
  type EntryQuery,
} from './statements.js';
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

/** A bounded integer from the query string, or undefined. */
function queryInt(req: Request, name: string, min: number, max: number): number | undefined {
  const raw = req.query[name];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DomainError(422, 'Validation failed', [{ field: name, message: `must be an integer ${min}..${max}` }]);
  }
  return value;
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

/** Which queued order a VEU request names. */
function veuOrderInput(source: Record<string, unknown>): VeuOrderInput {
  const partnerId = optionalText(source, 'partner_id');
  const btf = btfFrom(source);
  // Required here, unlike on an order: the queue is indexed by service, and
  // the connection's own profile says nothing about an order somebody else
  // submitted under a different one.
  if (btf === undefined) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'btf', message: 'required — name the service the queued order was submitted under' },
    ]);
  }
  return {
    btf,
    orderId: reqText(source, 'order_id', 40),
    ...(partnerId === undefined ? {} : { partnerId }),
  };
}

/**
 * Read the Verification-of-Payee choice off a request body.
 *
 * Refused rather than silently ignored when it is not one of the three: a
 * typo'd "optout" would otherwise leave the connection on the market default
 * while its record claims a deliberate choice was made.
 */
function vopMode(source: Record<string, unknown>): VopMode | undefined {
  const raw = optionalText(source, 'vop');
  if (raw === undefined) return undefined;
  if (raw !== 'default' && raw !== 'opt_out' && raw !== 'opt_in') {
    throw new DomainError(422, 'Validation failed', [
      { field: 'vop', message: 'must be "default", "opt_out" (VOO) or "opt_in" (VOI)' },
    ]);
  }
  return raw;
}

/**
 * Read the optional `Product` off a request body.
 *
 * `product_name` alone is not enough: the schema makes `Language` mandatory on
 * the element, so a name without a language would produce a message no bank
 * accepts. Refusing it here means the operator finds out while filling in the
 * form, not at the first upload.
 */
function optionalProduct(source: Record<string, unknown>): Product | undefined {
  const name = optionalText(source, 'product_name');
  const language = optionalText(source, 'product_language');
  const instituteId = optionalText(source, 'product_institute_id');
  if (name === undefined) {
    if (language === undefined && instituteId === undefined) return undefined;
    throw new DomainError(422, 'Validation failed', [
      { field: 'product_name', message: 'required when a product language or institute id is given' },
    ]);
  }
  if (name.length > 64) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'product_name', message: 'must be at most 64 characters (EBICS ProductType)' },
    ]);
  }
  if (language === undefined || !/^[a-z]{2}$/.test(language)) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'product_language', message: 'required with a product name: a two-letter ISO 639 code, e.g. "de"' },
    ]);
  }
  if (instituteId !== undefined && instituteId.length > 64) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'product_institute_id', message: 'must be at most 64 characters' },
    ]);
  }
  return { name, language, ...(instituteId === undefined ? {} : { instituteId }) };
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
    msg_variant: optionalText(btf, 'msg_variant'),
    msg_format: optionalText(btf, 'msg_format'),
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
  const transport = opts.transport ?? new Transport({ record: sqliteRecorder(db) });
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

  const exchangeCtx = (req: Request): ExchangeContext & OrderContext & DownloadContext & VeuContext => ({
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

  // Verifying walks every link and every record it stands for, so the verdict
  // is cached for a minute: a scrape every fifteen seconds must not turn the
  // integrity check into the service's own load problem.
  let chainCheck: { at: number; valid: boolean } | null = null;

  const gauges: Gauge[] = [
    {
      name: 'banking_chain_valid',
      help: 'Tamper-evidence over this service’s own history (1 = holds, 0 = broken); rechecked at most once a minute.',
      value: () => {
        const t = Date.now();
        if (!chainCheck || t - chainCheck.at >= 60_000) chainCheck = { at: t, valid: verifyChain(db).valid };
        return chainCheck.valid ? 1 : 0;
      },
    },
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

  /**
   * Does this service's own history still hold?
   *
   * Admin only, and answered here rather than by asking PS-07: a platform
   * service that needs a second service running to answer for its own records
   * is not independent, and "the audit trail was unavailable" is not an answer
   * anybody accepts about a payment.
   *
   * The `head` in the response is the point. A hash chain proves nothing in
   * the middle changed; it cannot prove the whole database was not rewritten.
   * Copy this head somewhere outside the container — a log shipper, a backup
   * manifest, a note — and the remaining hole becomes one an outsider can see.
   */
  app.get('/api/audit/chain', requireAdmin, (_req, res) => {
    res.json(verifyChain(db));
  });

  /** The cheap version: the head hash, without walking the chain to get it. */
  app.get('/api/audit/head', requireAdmin, (_req, res) => {
    res.json({ head: chainHead(db) ?? null });
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
        product: optionalProduct(b),
        requestEds: b.request_eds === true || b.request_eds === 'true',
        vop: vopMode(b),
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

  // SPR — ask the bank to lock the subscriber. Separate from /suspend on
  // purpose: suspending stops orders HERE and is undone with /resume, this
  // ends the subscriber's authorisation AT THE BANK and cannot be undone from
  // this service at all.
  app.post('/api/connections/:key/lock', requireAdmin, (req, res, next) => {
    const b = body(req);
    sendSpr(exchangeCtx(req), req.params.key as string, reqText(b, 'reason', 200))
      .then((detail) => res.json(detail))
      .catch(next);
  });

  // ── VEU: the distributed-signature queue ───────────────────────────
  //
  // Admin session only, never a service token. A module submitting a payment
  // is one thing; a second human approving one is exactly the step VEU exists
  // to require, and handing it to a machine credential would undo the point.
  app.get('/api/connections/:key/veu', requireAdmin, (req, res, next) => {
    const withDetails = req.query.details === '1' || req.query.details === 'true';
    veuOverview(exchangeCtx(req), req.params.key as string, { orderType: withDetails ? 'HVZ' : 'HVU' })
      .then((orders) => res.json({ orders }))
      .catch(next);
  });

  app.post('/api/connections/:key/veu/detail', requireAdmin, (req, res, next) => {
    veuDetail(exchangeCtx(req), req.params.key as string, veuOrderInput(body(req)))
      .then((detail) => res.json(detail))
      .catch(next);
  });

  app.post('/api/connections/:key/veu/transactions', requireAdmin, (req, res, next) => {
    const b = body(req);
    veuTransactions(exchangeCtx(req), req.params.key as string, veuOrderInput(b), {
      completeOrderData: b.complete_order_data === true,
      fetchLimit: optionalInt(b, 'limit', 1, 10_000) ?? 100,
      fetchOffset: optionalInt(b, 'offset', 0, 1_000_000) ?? 0,
    })
      .then((result) => res.json(result))
      .catch(next);
  });

  // The two that move money. The digest signed is fetched from the bank by
  // `veu.ts`, never taken from this body — see the note in that file.
  app.post('/api/connections/:key/veu/sign', requireAdmin, (req, res, next) => {
    veuSign(exchangeCtx(req), req.params.key as string, veuOrderInput(body(req)))
      .then((result) => res.json(result))
      .catch(next);
  });

  app.post('/api/connections/:key/veu/cancel', requireAdmin, (req, res, next) => {
    veuCancel(exchangeCtx(req), req.params.key as string, veuOrderInput(body(req)))
      .then((result) => res.json(result))
      .catch(next);
  });

  // ── What the bank says this customer may do ────────────────────────
  //
  // HTD (this subscriber) or HKD (the whole customer). Read-only, moves no
  // money, and the answer is worth more than any table in this repository:
  // it is the bank's own list of the order types and BTFs it has enabled for
  // this contract, with the signature class and ceilings it enforces.
  app.get('/api/connections/:key/customer-data', requireAdmin, (req, res, next) => {
    const scope = req.query.scope === 'customer' ? 'customer' : 'subscriber';
    fetchCustomerData(exchangeCtx(req), req.params.key as string, scope)
      .then((data) => res.json({ scope, ...data, available_downloads: availableDownloads(data) }))
      .catch(next);
  });

  // HPD — the bank's own parameters. The cheapest compatibility check there
  // is, and the one whose absence turns into an obscure return code later.
  app.get('/api/connections/:key/bank-parameters', requireAdmin, (req, res, next) => {
    fetchBankParameters(exchangeCtx(req), req.params.key as string)
      .then((parameters) => res.json(parameters))
      .catch(next);
  });

  // HAA — what the bank has waiting RIGHT NOW, as opposed to what this
  // customer is permitted to fetch. Different question, different answer.
  app.get('/api/connections/:key/waiting', requireAdmin, (req, res, next) => {
    fetchAvailableOrderData(exchangeCtx(req), req.params.key as string)
      .then((btfs) => res.json({ waiting: btfs }))
      .catch(next);
  });

  // ── What the tick fetches, per connection ──────────────────────────
  //
  // Any BTF, not the two this service used to hard-code. `available_downloads`
  // above is where the legitimate values come from.
  app.get('/api/connections/:key/subscriptions', requireAdmin, (req, res) => {
    res.json({ subscriptions: listSubscriptions(db, req.params.key as string) });
  });

  app.post('/api/connections/:key/subscriptions', requireAdmin, (req, res) => {
    const b = body(req);
    const btf = btfFrom(b);
    if (btf === undefined) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'btf', message: 'is required — name what to fetch on every tick' },
      ]);
    }
    res.status(201).json(
      addSubscription(
        db,
        req.params.key as string,
        {
          btf,
          ...(typeof b.label === 'string' ? { label: b.label.slice(0, 120) } : {}),
          ...(optionalInt(b, 'lookback_days', 1, 3650) === undefined
            ? {}
            : { lookbackDays: optionalInt(b, 'lookback_days', 1, 3650) as number }),
          ...(b.enabled === false ? { enabled: false } : {}),
        },
        now,
      ),
    );
  });

  app.post('/api/connections/:key/subscriptions/:id/enable', requireAdmin, (req, res) => {
    res.json(setSubscriptionEnabled(db, req.params.key as string, Number(req.params.id), true));
  });

  app.post('/api/connections/:key/subscriptions/:id/disable', requireAdmin, (req, res) => {
    res.json(setSubscriptionEnabled(db, req.params.key as string, Number(req.params.id), false));
  });

  app.delete('/api/connections/:key/subscriptions/:id', requireAdmin, (req, res) => {
    removeSubscription(db, req.params.key as string, Number(req.params.id));
    res.status(204).end();
  });

  // ── Key rotation over the wire: HCA and HCS ────────────────────────
  //
  // Admin session only, and never a service token. A module that could rotate
  // the ES key could rotate it to a key it holds, which is the whole security
  // model handed over in one request.
  app.get('/api/connections/:key/key-change', requireAdmin, (req, res) => {
    res.json({ pending: pendingKeyChange(exchangeCtx(req), req.params.key as string) });
  });

  app.post('/api/connections/:key/key-change', requireAdmin, (req, res, next) => {
    const b = body(req);
    changeKeys(exchangeCtx(req), req.params.key as string, { includeSignature: b.include_signature === true })
      .then((result) => res.json(result))
      .catch(next);
  });

  // The recovery for a crash between the bank's acceptance and our commit.
  // Deliberately explicit: an operator must have established with the bank
  // that the change actually went through.
  app.post('/api/connections/:key/key-change/complete', requireAdmin, (req, res) => {
    res.json({ keys: completeKeyChange(exchangeCtx(req), req.params.key as string) });
  });

  app.delete('/api/connections/:key/key-change', requireAdmin, (req, res) => {
    discardKeyChange(exchangeCtx(req), req.params.key as string);
    res.status(204).end();
  });

  app.post('/api/connections/:key/suspend', requireAdmin, (req, res) => {
    const b = body(req);
    res.json(suspend(exchangeCtx(req), req.params.key as string, reqText(b, 'reason', 200)));
  });

  app.post('/api/connections/:key/resume', requireAdmin, (req, res) => {
    res.json(resume(exchangeCtx(req), req.params.key as string));
  });

  /**
   * Step a connection back out of `failed` so the setup can be retried.
   *
   * Backwards only, to the last step actually completed — clearing a failure
   * is never a route to `ready` without a human confirming the bank's digests.
   */
  app.post('/api/connections/:key/clear-failure', requireAdmin, (req, res) => {
    res.json(clearFailure(exchangeCtx(req), req.params.key as string));
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

  /**
   * The bank conversations behind an order — what was actually sent and said.
   *
   * Admin only, and deliberately not open to `X-Service-Token`: the envelope
   * carries the payment file, and a module that submitted an order already
   * knows what it submitted. This route exists for the human reconstructing a
   * transfer after the fact, which is the one job the folded status cannot do.
   */
  app.get('/api/orders/:public_id/exchanges', requireAdmin, (req, res) => {
    // Resolves the order first, so an unknown id is a 404 rather than a
    // convincing empty list.
    const order = orderDetail(db, req.params.public_id as string);
    res.json({ exchanges: listExchanges(db, { order: order.public_id, limit: 500 }) });
  });

  app.get('/api/exchanges', requireAdmin, (req, res) => {
    const query = req.query as Record<string, unknown>;
    res.json({
      exchanges: listExchanges(db, {
        connection: optionalText(query, 'connection'),
        order: optionalText(query, 'order'),
        limit: optionalInt(query, 'limit', 1, 1_000),
      }),
    });
  });

  /** One conversation with its bodies. The evidence, not the summary. */
  app.get('/api/exchanges/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new DomainError(400, 'the exchange id must be a whole number');
    res.json(exchangeDetail(db, id));
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
  // ── Account statements, read into bookings ─────────────────────────
  //
  // Service token as well as admin session: this is what a module consumes.
  // Reading bookings moves no money and needs no human, unlike everything
  // under /connections.
  //
  // What is deliberately NOT here: any notion of an entry being "matched" to
  // an invoice. Which invoice a payment settles depends on the invoices, and
  // those live in the module that issued them. This answers "what did the bank
  // book"; the module decides what that means.
  app.get('/api/statements', requireCaller, (req, res) => {
    res.json({
      statements: listStatements(db, {
        ...(typeof req.query.connection === 'string' ? { connection: req.query.connection } : {}),
        ...(typeof req.query.account === 'string' ? { account: req.query.account } : {}),
        ...(typeof req.query.source === 'string' ? { source: req.query.source } : {}),
        ...(queryInt(req, 'limit', 1, 500) === undefined ? {} : { limit: queryInt(req, 'limit', 1, 500) as number }),
      }),
    });
  });

  app.get('/api/statements/:public_id', requireCaller, (req, res) => {
    res.json(statementDetail(db, req.params.public_id as string));
  });

  /**
   * The query a payment matcher needs.
   *
   * `status` defaults to BOOK. A pending entry is money the bank has seen and
   * not booked, and treating it as a payment is how an invoice gets marked
   * settled against a transaction that later vanishes — so a caller that
   * wants them has to say so.
   */
  app.get('/api/entries', requireCaller, (req, res) => {
    const text = (name: string): string | undefined =>
      typeof req.query[name] === 'string' && req.query[name] !== '' ? (req.query[name] as string) : undefined;
    const query: EntryQuery = {
      ...(text('connection') === undefined ? {} : { connection: text('connection') as string }),
      ...(text('account') === undefined ? {} : { account: text('account') as string }),
      ...(text('from') === undefined ? {} : { from: text('from') as string }),
      ...(text('to') === undefined ? {} : { to: text('to') as string }),
      ...(text('end_to_end_id') === undefined ? {} : { endToEndId: text('end_to_end_id') as string }),
      ...(text('reference') === undefined ? {} : { reference: text('reference') as string }),
      ...(text('search') === undefined ? {} : { search: text('search') as string }),
      ...(text('status') === undefined ? {} : { status: text('status') as string }),
      // Defaults to `statement` server-side: see EntryQuery.source.
      ...(text('source') === undefined ? {} : { source: text('source') as EntryQuery['source'] }),
      ...(req.query.credit === undefined ? {} : { credit: req.query.credit === '1' || req.query.credit === 'true' }),
      ...(req.query.exclude_reversals === '1' || req.query.exclude_reversals === 'true'
        ? { excludeReversals: true }
        : {}),
      ...(queryInt(req, 'amount_hundredths', 0, Number.MAX_SAFE_INTEGER) === undefined
        ? {}
        : { amountHundredths: queryInt(req, 'amount_hundredths', 0, Number.MAX_SAFE_INTEGER) as number }),
      ...(queryInt(req, 'limit', 1, 1000) === undefined ? {} : { limit: queryInt(req, 'limit', 1, 1000) as number }),
    };
    res.json({ entries: findEntries(db, query) });
  });

  /**
   * Re-read every stored statement.
   *
   * The bytes are the record, so a fix to the reader should improve statements
   * already collected and not only the next one. Admin-only: it drops and
   * rebuilds the derived rows, which is not something a module should trigger.
   */
  app.post('/api/statements/reparse', requireAdmin, (req, res) => {
    const b = body(req);
    const connection = typeof b.connection === 'string' ? b.connection : undefined;
    res.json({ downloads_queued: reparseStatements(db, connection) });
  });

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
