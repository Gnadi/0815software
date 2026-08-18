import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import {
  actorOf,
  checkCredentials,
  clearedCookie,
  createToken,
  requireAuth,
  sessionCookie,
  type AuthConfig,
} from './auth.js';
import {
  addWidget,
  createBoard,
  deleteBoard,
  deleteWidget,
  DomainError,
  ensureBoards,
  getBoard,
  placeWidgets,
  readPreferences,
  renameBoard,
  writeActiveBoard,
  writeContext,
} from './boards.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import type { PeerClient } from './peers.js';
import type { ModuleSessions } from './sessions.js';
import { createHandoff, isRedeemPath, safeServiceTokenEqual } from './handoff.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import { CATALOGUE } from '../shared/catalogue.js';
import { ACTIONS, actionById } from '../shared/actions.js';
import { isModulePath } from '../shared/summary.js';
import type { WidgetPlacement } from '../shared/types.js';

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/** How many activity rows the feed asks PS-07 for. */
const ACTIVITY_LIMIT = 50;
/** How many parties the context picker offers at once. */
const PARTY_LIMIT = 20;
/** Longest reference an action will forward to another module. */
const MAX_ITEM_ID_LENGTH = 200;

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** The modules in this stack. */
  peers: PeerClient;
  /** Per-user sessions held for those modules, for running actions as them. */
  sessions: ModuleSessions;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional Platform Services integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
  /**
   * Which credentials this deployment accepts, served as-is from
   * GET /api/auth-mode. Defaults to this module's own — the standalone case.
   *
   * It answers a second question too, which is why there is no separate flag
   * for it: with no identity provider this module has exactly ONE account that
   * can authenticate — `auth.ts` compares the submitted username against the
   * single configured ADMIN_USERNAME — so every operator is literally the same
   * actor. Boards key on that actor, and so does the identity the shell asserts
   * when it hands off or runs an action.
   *
   * Nothing is broken by it, and the isolation is real code either way
   * (`getBoard` filters on owner). But "shared board" and "your colleague's
   * name on your invoice" are surprises worth stating out loud rather than
   * leaving to be discovered, so `/api/catalogue` reports it and the board
   * says so. Both facts come from `loginMode` because they are the same fact.
   */
  loginMode?: LoginMode;
  /**
   * The platform machine token (PLATFORM_SERVICE_TOKEN), for the handoff routes
   * below. This shell CONSUMES the token to call its peers; these two routes are
   * the other direction — another shell calling this one.
   */
  serviceToken?: string;
  /**
   * The shell origins allowed to embed THIS module and to sign users into it.
   *
   * A shell being framed by another shell is not a curiosity: MOD-16 Mosaic
   * tiles whole modules, and this is one. The registry has said
   * `embeddable: true` since this module existed, but the routes that promise
   * makes were never mounted — so a Mosaic pane holding the Workspace showed a
   * login form instead of the board. Empty is still the default.
   */
  shellOrigins?: string[];
}

export function createApp({
  db,
  hardening,
  auth,
  peers,
  sessions,
  staticDir,
  platform = noopPlatform,
  verifyLogin = nullVerifier,
  loginMode = LOCAL_LOGIN,
  serviceToken,
  shellOrigins = [],
}: AppOptions): express.Express {
  const app = express();
  const handoff = shellOrigins.length > 0 ? createHandoff(auth) : null;

  if (hardening) {
    if (hardening.trustProxy > 0) app.set('trust proxy', hardening.trustProxy);
    app.use(hardeningMiddleware(hardening));
  }
  app.use(express.json({ limit: '1mb' }));

  // ── Public routes ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Readiness: this module's own database is reachable and its schema is in
   * place. Deliberately says nothing about the peers.
   *
   * A Workspace whose peers are down is a Workspace with unavailable widgets,
   * not an unhealthy service — and reporting otherwise would make one sick
   * module take the dashboard out of the load balancer during exactly the
   * incident someone opens the dashboard to understand.
   */
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT COUNT(*) FROM boards').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Which credentials this deployment accepts, read by the login form before
  // anyone is signed in — hence public. With SSO configured, PS-01 validates
  // logins and this module's own admin credentials are rejected, so a form
  // advertising them would send people at a password that cannot work. The org
  // slug is deployment configuration, not a secret.
  app.get('/api/auth-mode', (_req, res) => {
    res.json(loginMode);
  });

  // ── Shell handoff ────────────────────────────────────────────────────
  // Mounted only when the operator named a shell in SHELL_ORIGIN, so a
  // standalone install has no such surface at all. Byte-identical to the
  // eleven other modules that accept a handoff; see handoff.ts for why the
  // destination is signed into the ticket rather than passed alongside it.
  if (handoff) {
    const requireServiceToken = (req: Request): void => {
      const provided = req.headers['x-service-token'];
      if (!serviceToken || typeof provided !== 'string' || !safeServiceTokenEqual(provided, serviceToken)) {
        throw new DomainError(401, 'Service token required');
      }
    };

    app.post('/api/session/handoff', (req, res) => {
      requireServiceToken(req);
      const { actor, path } = body(req);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      const target = path === undefined ? '/' : path;
      if (!isRedeemPath(target)) throw new DomainError(422, 'path must be module-relative');
      res.json(handoff.issue(actor.trim(), target));
    });

    app.post('/api/session/issue', (req, res) => {
      requireServiceToken(req);
      const { actor } = body(req);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      res.json(handoff.issueSession(actor.trim()));
    });

    // The browser lands here from a frame's `src`. Deliberately NOT under /api:
    // it is a navigation, and it must stay outside the session gate — it is how
    // a session is obtained in the first place.
    app.get('/session/handoff', (req, res) => {
      const result = handoff.redeem(req.query.ticket);
      if (!result.ok) {
        // One status for all three verdicts. Which of "never issued", "already
        // used" and "expired" a ticket hit is not something an unauthenticated
        // caller gets to probe for.
        res.status(401).type('text/plain').send('Handoff ticket is not valid');
        return;
      }
      res.setHeader('Set-Cookie', result.cookie);
      res.redirect(302, result.location);
    });
  }

  app.post('/api/login', async (req, res) => {
    const { username, password } = body(req);
    const verdict = await verifyLogin(username, password);
    if (verdict === null) {
      if (!checkCredentials(auth, username, password)) throw new DomainError(401, 'Invalid credentials');
    } else if (!verdict.ok) {
      throw new DomainError(verdict.reason === 'unavailable' ? 503 : 401, 'Invalid credentials');
    }
    const actor = verdict?.ok ? verdict.actor : (username as string);
    // Keep the PS-01 token this login was validated with: PS-07 gates its reads
    // behind a principal, so the activity feed is read AS this person, with
    // their authority rather than a borrowed admin account. Standalone there is
    // no such token and the feed is simply empty.
    if (verdict?.ok && verdict.identityToken) sessions.rememberIdentity(actor, verdict.identityToken);
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor)));
    res.json({ ok: true, username: actor });
  });

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    // Drop any module sessions held for this person: they were obtained so the
    // board could act as them, and the board is no longer theirs to act on.
    sessions.forget(actorOf(res, auth));
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: actorOf(res, auth) });
  });

  // ── The catalogue: what this stack contains ──────────────────────────
  app.get('/api/catalogue', (_req, res) => {
    res.json({
      modules: peers.statuses(),
      actions: ACTIONS.map(({ id, label, sourceModule, sourceList, targetModule }) => ({
        id,
        label,
        source_module: sourceModule,
        source_list: sourceList,
        target_module: targetModule,
        // An action is only offered when BOTH ends are in this stack. Showing
        // "BILL THIS" in a stack with no invoicing module would be a button
        // whose only possible outcome is an error.
        available: peers.has(sourceModule) && peers.has(targetModule),
      })),
      customers_configured: platform.hasCustomers(),
      identity_configured: loginMode.sso,
    });
  });

  // ── Boards ───────────────────────────────────────────────────────────
  app.get('/api/boards', (_req, res) => {
    const owner = actorOf(res, auth);
    const boards = ensureBoards(db, owner);
    res.json({ boards, preferences: readPreferences(db, owner) });
  });

  app.post('/api/boards', (req, res) => {
    res.status(201).json(createBoard(db, actorOf(res, auth), body(req).name));
  });

  app.get('/api/boards/:id', (req, res) => {
    res.json(getBoard(db, actorOf(res, auth), Number(req.params.id)));
  });

  app.put('/api/boards/:id', (req, res) => {
    res.json(renameBoard(db, actorOf(res, auth), Number(req.params.id), body(req).name));
  });

  app.delete('/api/boards/:id', (req, res) => {
    deleteBoard(db, actorOf(res, auth), Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/boards/:id/active', (req, res) => {
    writeActiveBoard(db, actorOf(res, auth), Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/boards/:id/widgets', (req, res) => {
    res.status(201).json(addWidget(db, actorOf(res, auth), Number(req.params.id), body(req) as never));
  });

  app.delete('/api/boards/:id/widgets/:widgetId', (req, res) => {
    deleteWidget(db, actorOf(res, auth), Number(req.params.id), Number(req.params.widgetId));
    res.json({ ok: true });
  });

  app.put('/api/boards/:id/layout', (req, res) => {
    const placements = body(req).widgets;
    if (!Array.isArray(placements)) {
      throw new DomainError(422, 'Validation failed', [{ field: 'widgets', message: 'widgets must be an array' }]);
    }
    res.json(placeWidgets(db, actorOf(res, auth), Number(req.params.id), placements as WidgetPlacement[]));
  });

  // ── The context bar ──────────────────────────────────────────────────
  app.put('/api/context', (req, res) => {
    res.json({ context: writeContext(db, actorOf(res, auth), body(req)) });
  });

  app.get('/api/parties', async (req, res) => {
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.json({ parties: await platform.parties(search, PARTY_LIMIT), configured: platform.hasCustomers() });
  });

  // ── Widget data ──────────────────────────────────────────────────────
  /**
   * Every peer's summary under this person's context, in one call.
   *
   * One request rather than one per widget: a board with nine widgets fed by
   * three modules would otherwise ask those three modules nine times for the
   * same three answers. The client splits the summaries across its widgets.
   *
   * The service token stays here. The browser never holds it, which is why the
   * peers can treat it as a machine credential at all.
   */
  app.get('/api/summaries', async (_req, res) => {
    const { context } = readPreferences(db, actorOf(res, auth));
    res.json({ summaries: await peers.summaries(context), context });
  });

  app.get('/api/activity', async (_req, res) => {
    const actor = actorOf(res, auth);
    // PS-07 gates READS behind a principal, so with no held identity the call
    // comes back 401 and `activity()` yields []. Reported separately because
    // "nobody has done anything" and "this board cannot read the trail as you"
    // are different facts with different fixes, and they produce the same
    // empty array — the distinction `configured` already draws for an unwired
    // audit service, drawn one level further in.
    const identity = sessions.identityFor(actor);
    res.json({
      events: await platform.activity(ACTIVITY_LIMIT, identity),
      // PS-07, not PS-11 — this route once reported the customers service by
      // copy-paste, which made an unwired audit log look like a quiet one.
      configured: platform.hasAudit(),
      readable: identity !== undefined,
    });
  });

  // ── Embedding ────────────────────────────────────────────────────────
  /**
   * A URL that opens a module already signed in as this person.
   *
   * The Workspace asks the module for a single-use ticket and hands back the
   * public URL that redeems it. It never sees the module's cookie: the browser
   * gets it directly from the module, which is what keeps each module the
   * authority over its own sessions.
   */
  app.get('/api/embed/:moduleId', async (req, res) => {
    const moduleId = req.params.moduleId;
    const path = typeof req.query.path === 'string' && req.query.path !== '' ? req.query.path : '/';
    // The path comes from a summary href, which the contract already restricts
    // to module-relative paths — but this is the point where it becomes a URL
    // the browser will follow, so it is checked again here rather than trusted
    // to have been checked upstream.
    if (!isModulePath(path)) throw new DomainError(422, 'path must be module-relative');

    const result = await peers.handoff(moduleId, actorOf(res, auth), path);
    if (!result.ok) throw new DomainError(409, result.problem);
    res.json({ url: result.url });
  });

  // ── Cross-module actions ─────────────────────────────────────────────
  /**
   * Run a declared action against its target module, as this person.
   *
   * The Workspace holds no privilege of its own here. It obtains a session for
   * whoever clicked (`sessions.cookieFor`) and calls the route the target
   * module already serves for its own UI, so the target authorizes and records
   * the action exactly as it would from its own screens — and its audit trail
   * names the person, not the shell.
   */
  app.post('/api/actions/:id', async (req, res) => {
    const action = actionById(req.params.id);
    if (!action) throw new DomainError(404, 'Unknown action');

    const itemId = body(req).item_id;
    if (typeof itemId !== 'string' || itemId.trim() === '') {
      throw new DomainError(422, 'Validation failed', [{ field: 'item_id', message: 'item_id is required' }]);
    }
    // Bounded because this is forwarded verbatim into a request to another
    // module. An item id is a reference the peer itself put in a summary — an
    // offer number, a ticket key — so anything long enough to matter is not one.
    if (itemId.length > MAX_ITEM_ID_LENGTH) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'item_id', message: `item_id must be at most ${MAX_ITEM_ID_LENGTH} characters` },
      ]);
    }
    if (!peers.has(action.targetModule)) {
      throw new DomainError(409, `${action.targetModule} is not in this stack`);
    }

    const actor = actorOf(res, auth);
    const session = await sessions.cookieFor(actor, action.targetModule);
    if (!session.ok) throw new DomainError(409, session.problem);

    const result = await peers.callAs(action.targetModule, session.cookie, action.path, {
      method: action.method,
      body: JSON.stringify(action.body(itemId.trim())),
    });
    if (!result.ok) throw new DomainError(502, result.problem);
    if (result.status >= 400) {
      // The target's own message is the useful one — "offer is not accepted"
      // beats "the action failed" — so it is passed through rather than
      // replaced with something this module invented.
      const message = (result.body as { error?: unknown } | null)?.error;
      throw new DomainError(result.status, typeof message === 'string' ? message : `${action.targetModule} refused the action`);
    }

    await platform.audit({
      actor,
      action: `workspace.${action.id}`,
      resource: `mod-15-workspace:action/${action.id}`,
      metadata: { item: itemId.trim(), target: action.targetModule },
    });
    res.json({ ok: true, message: action.success.replace('{id}', itemId.trim()), result: result.body });
  });

  // ── Static client (production build) ─────────────────────────────────
  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile('index.html', { root: staticDir });
        return;
      }
      next();
    });
  }

  // ── Error mapping ────────────────────────────────────────────────────
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

/** Exported so a test can assert the catalogue and the peer map agree. */
export { CATALOGUE };
