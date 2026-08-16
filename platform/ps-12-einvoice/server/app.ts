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
  checkInvoice,
  getDocument,
  issueDocument,
  listDocuments,
  listInbound,
  nowIso,
  receiveDocument,
} from './documents.js';
import { XmlParseError } from './xml.js';
import { attachFacturX, PdfAttachError, type FacturXProfile } from './pdf-attach.js';
import { PROFILES, type EInvoiceInput, type Profile } from '../shared/types.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  identityFetch?: SeamFetch;
  /** Rate limiting / security headers / CORS; omitted in tests, set on boot. */
  hardening?: HardeningConfig;
  /** Emit one JSON log line per request (default false; index.ts passes true). */
  logRequests?: boolean;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** Read the requested profile, defaulting to plain EN 16931. */
function profileOf(raw: unknown): Profile {
  if (raw === undefined || raw === null || raw === '') return 'en16931';
  if (typeof raw !== 'string' || !(PROFILES as readonly string[]).includes(raw)) {
    fail(422, `profile must be one of: ${PROFILES.join(', ')}`);
  }
  return raw as Profile;
}

export function createApp(opts: AppOptions): express.Express {
  const { db, auth, now = Date.now } = opts;
  const app = express();
  if (opts.hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (opts.hardening.trustProxy > 0) app.set('trust proxy', opts.hardening.trustProxy);
    app.use(hardeningMiddleware(opts.hardening));
  }
  app.use(requestTelemetry({ service: 'ps-12', log: opts.logRequests === true }));
  app.use(express.json({ limit: '1mb' }));
  // Inbound documents arrive as raw XML, not as JSON — a sender's mail gateway
  // hands over the attachment as it stands.
  app.use('/api/inbound', express.text({ type: ['application/xml', 'text/xml'], limit: '8mb' }));
  // A caller's rendered PDF arrives as bytes, for the hybrid route below.
  app.use('/api/documents/:source/:number/hybrid', express.raw({ type: 'application/pdf', limit: '16mb' }));

  const at = (): string => nowIso(now());

  const callerOk = (req: Request): boolean => {
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifyToken(auth, token)) return true;
    return checkServiceToken(auth, req.headers[SERVICE_HEADER]) === 'ok';
  };
  const requireCaller = (req: Request, res: Response, nextFn: NextFunction): void => {
    if (callerOk(req)) {
      nextFn();
      return;
    }
    const token = parseBearer(req.headers.authorization) ?? parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && auth.identityUrl) {
      const doFetch = opts.identityFetch ?? (globalThis.fetch as unknown as SeamFetch);
      void verifyIdentityToken(auth.identityUrl, token, doFetch)
        .then((ok) => (ok ? nextFn() : res.status(401).json({ error: 'Authentication required' })))
        .catch(() => res.status(401).json({ error: 'Authentication required' }));
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  const gauges: Gauge[] = [
    {
      name: 'einvoice_documents_total',
      help: 'Structured invoices issued and kept for the retention period.',
      value: () => count('SELECT COUNT(*) AS n FROM documents'),
    },
    {
      name: 'einvoice_documents_xrechnung_total',
      help: 'Issued documents carrying the German XRechnung CIUS.',
      value: () => count("SELECT COUNT(*) AS n FROM documents WHERE profile = 'xrechnung'"),
    },
    {
      name: 'einvoice_inbound_total',
      help: 'Structured invoices received from third parties (deduplicated by content).',
      value: () => count('SELECT COUNT(*) AS n FROM inbound'),
    },
    {
      // Worth watching: an inbound document whose number could not be read is
      // one a human has to look at, and a rising count means a sender's format
      // is not being understood.
      name: 'einvoice_inbound_unparsed_total',
      help: 'Received invoices whose invoice number could not be read.',
      value: () => count('SELECT COUNT(*) AS n FROM inbound WHERE number IS NULL'),
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

  // ── Outbound ────────────────────────────────────────────────────────

  /**
   * Validate without issuing. A module can call this while an invoice is still
   * a draft and show the operator what is missing BEFORE the number is
   * assigned and the document becomes immutable — which is the only moment the
   * missing field is still cheap to fix.
   */
  app.post('/api/validate', requireCaller, (req, res) => {
    const b = body(req);
    const profile = profileOf(b.profile);
    res.json(checkInvoice((b.invoice ?? {}) as EInvoiceInput, profile));
  });

  /** Issue a document. Idempotent per (source, invoice number). */
  app.post('/api/documents', requireCaller, (req, res) => {
    const b = body(req);
    const source = reqText(b, 'source', 120);
    const profile = profileOf(b.profile);
    const result = issueDocument(db, source, (b.invoice ?? {}) as EInvoiceInput, profile, at());
    res.status(result.replayed ? 200 : 201).json({
      document: result.document,
      xml: result.xml,
      replayed: result.replayed,
    });
  });

  app.get('/api/documents', requireCaller, (req, res) => {
    res.json({
      documents: listDocuments(db, {
        source: typeof req.query.source === 'string' && req.query.source !== '' ? req.query.source : undefined,
        limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
      }),
    });
  });

  app.get('/api/documents/:source/:number', requireCaller, (req, res) => {
    const found = getDocument(db, req.params.source as string, req.params.number as string);
    res.json({ document: found.document, xml: found.xml });
  });

  /** The bare XML, for a caller that wants to attach or forward the file. */
  app.get('/api/documents/:source/:number/xml', requireCaller, (req, res) => {
    const found = getDocument(db, req.params.source as string, req.params.number as string);
    res.type('application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${found.document.number.replace(/[^\w.-]/g, '_')}.xml"`);
    res.send(found.xml);
  });

  /**
   * The ZUGFeRD / Factur-X hybrid: POST the rendered PDF, get it back with the
   * already-issued XML embedded.
   *
   * The PDF comes from the CALLER because PS-12 has no renderer and is not
   * going to grow one — MOD-04 and MOD-13 each own theirs, and every package in
   * this catalogue installs and runs on its own. The original bytes come back
   * untouched with objects appended, so a change to a module's layout can never
   * break the attachment.
   *
   * The document must already have been issued: this route embeds what was
   * validated, it is not a second way in past the gate.
   */
  app.post('/api/documents/:source/:number/hybrid', requireCaller, (req, res) => {
    const found = getDocument(db, req.params.source as string, req.params.number as string);
    // Two ways in, because they serve different callers. Raw `application/pdf`
    // is what an operator with curl sends and what a mail gateway hands over;
    // `{ pdf_base64 }` is what the typed client sends, so the request rides the
    // same JSON transport as every other call and keeps its retry, timeout and
    // error mapping. Either way the RESPONSE is the file itself.
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    const encoded = raw === null ? body(req).pdf_base64 : null;
    const pdf =
      raw ?? (typeof encoded === 'string' && encoded !== '' ? Buffer.from(encoded, 'base64') : null);
    if (!pdf || pdf.length === 0) {
      fail(422, 'POST the rendered invoice PDF as application/pdf, or as JSON { pdf_base64 }');
    }
    const level: FacturXProfile = found.document.profile === 'xrechnung' ? 'XRECHNUNG' : 'EN 16931';
    const hybrid = attachFacturX(pdf, found.xml, level, {
      description: `Invoice ${found.document.number} in EN 16931 CII format`,
      at: at(),
    });
    res.type('application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${found.document.number.replace(/[^\w.-]/g, '_')}.pdf"`,
    );
    res.send(hybrid);
  });

  // ── Inbound ─────────────────────────────────────────────────────────

  /**
   * Record a structured invoice somebody sent us. Accepts raw XML, or JSON
   * `{ xml }` for a caller that already has it in a string.
   */
  app.post('/api/inbound', requireCaller, (req, res) => {
    const xml = typeof req.body === 'string' ? req.body : ((body(req).xml ?? '') as string);
    if (typeof xml !== 'string' || xml.trim() === '') fail(422, 'an XML document is required');
    const result = receiveDocument(db, xml, at());
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.get('/api/inbound', requireCaller, (req, res) => {
    res.json({ invoices: listInbound(db, req.query.limit !== undefined ? Number(req.query.limit) : undefined) });
  });

  app.use((err: unknown, _req: Request, res: Response, nextFn: NextFunction) => {
    if (res.headersSent) {
      nextFn(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    // A document that is not XML is the sender's mistake, not a server fault —
    // 422 with the reason, so a mail gateway retrying forever is not the
    // consequence of somebody attaching a PDF to the wrong endpoint.
    if (err instanceof XmlParseError) {
      res.status(422).json({ error: `not a parseable XML document: ${err.message}`, details: [] });
      return;
    }
    // Handing over something that is not a PDF is the caller's mistake, not a
    // server fault — and a 500 would have a module retrying forever.
    if (err instanceof PdfAttachError) {
      res.status(422).json({ error: `could not embed the invoice XML: ${err.message}`, details: [] });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
