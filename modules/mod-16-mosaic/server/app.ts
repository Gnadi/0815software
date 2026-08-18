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
  addPane,
  createBoard,
  deleteBoard,
  deletePane,
  DomainError,
  ensureBoards,
  getBoard,
  placePanes,
  readPreferences,
  renameBoard,
  writeActiveBoard,
} from './boards.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import type { PeerClient } from './peers.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import { CATALOGUE } from '../shared/catalogue.js';
import type { PanePlacement } from '../shared/types.js';

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
}


export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  auth: AuthConfig;
  /** The modules in this stack. */
  peers: PeerClient;
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
}

export function createApp({
  db,
  hardening,
  auth,
  peers,
  staticDir,
  platform = noopPlatform,
  verifyLogin = nullVerifier,
  loginMode = LOCAL_LOGIN,
}: AppOptions): express.Express {
  const app = express();

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
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor)));
    res.json({ ok: true, username: actor });
  });

  // ── Everything below requires a valid session ────────────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    // Nothing to forget here. This module holds no credential for anybody: a
    // pane's frame carries the module's OWN cookie, minted by that module from
    // a single-use ticket and never seen by this one.
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

  app.post('/api/boards/:id/panes', (req, res) => {
    const actor = actorOf(res, auth);
    const pane = addPane(db, actor, Number(req.params.id), body(req) as never);
    void platform.audit({
      actor,
      action: 'mosaic.pane_added',
      resource: `mod-16-mosaic:board/${req.params.id}`,
      metadata: { module: pane.module_id },
    });
    res.status(201).json(pane);
  });

  app.delete('/api/boards/:id/panes/:paneId', (req, res) => {
    deletePane(db, actorOf(res, auth), Number(req.params.id), Number(req.params.paneId));
    res.json({ ok: true });
  });

  app.put('/api/boards/:id/layout', (req, res) => {
    const placements = body(req).panes;
    if (!Array.isArray(placements)) {
      throw new DomainError(422, 'Validation failed', [{ field: 'panes', message: 'panes must be an array' }]);
    }
    res.json(placePanes(db, actorOf(res, auth), Number(req.params.id), placements as PanePlacement[]));
  });

  app.get('/api/embed/:moduleId', async (req, res) => {
    const moduleId = req.params.moduleId;
    // Always the module's own front door. A pane shows the module, not one of
    // its screens: ten of the fourteen do not read window.location at start-up
    // (docs/SHELL-CONTRACT.md), so a path would be honoured by four of them and
    // silently ignored by the rest — a setting that works sometimes is worse
    // than one that is not offered.
    const result = await peers.handoff(moduleId, actorOf(res, auth), '/');
    if (!result.ok) throw new DomainError(409, result.problem);
    res.json({ url: result.url });
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
