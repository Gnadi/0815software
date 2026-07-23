import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { isProvider, type ChatMessage, type ProviderName } from '../shared/types.js';
import {
  checkCredentials,
  checkServiceToken,
  clearedCookie,
  COOKIE_NAME,
  createToken,
  nowIso,
  parseBearer,
  parseCookies,
  requireAuth,
  SERVICE_HEADER,
  sessionCookie,
  verifyToken,
  type AuthConfig,
} from './auth.js';
import { DomainError, fail, reqText } from './errors.js';
import {
  activeTemplate,
  mapPrompt,
  promptByKey,
  renderMessages,
  validateTemplate,
  type PromptRow,
  type PromptVersionRow,
} from './prompts.js';
import { runChat, type ChatConfig } from './chat.js';
import { EMBED_DIMS, EMBED_MODEL, embed } from './embeddings.js';
import { ingestDocument, search } from './rag.js';
import { approxTokens, type FetchLike } from './providers/index.js';

export interface AppOptions {
  db: Database.Database;
  auth: AuthConfig;
  now?: () => number;
  anthropicApiKey?: string | null;
  anthropicModel?: string;
  openaiApiKey?: string | null;
  openaiModel?: string;
  geminiApiKey?: string | null;
  geminiModel?: string;
  ollamaBaseUrl?: string | null;
  ollamaModel?: string;
  fetchImpl?: FetchLike;
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
  const chatConfig: ChatConfig = {
    anthropicApiKey: opts.anthropicApiKey ?? null,
    anthropicModel: opts.anthropicModel ?? 'claude-sonnet-5',
    openaiApiKey: opts.openaiApiKey ?? null,
    openaiModel: opts.openaiModel ?? 'gpt-4o-mini',
    geminiApiKey: opts.geminiApiKey ?? null,
    geminiModel: opts.geminiModel ?? 'gemini-1.5-flash',
    ollamaBaseUrl: opts.ollamaBaseUrl ?? null,
    ollamaModel: opts.ollamaModel ?? 'llama3.1',
    fetchImpl: opts.fetchImpl,
  };

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  // A caller is either the admin (session) or a module (service token).
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
    res.status(401).json({ error: 'Authentication required' });
  };
  const requireAdmin = requireAuth(auth);

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

  // ── Chat & embeddings (caller) ─────────────────────────────────────
  app.post('/api/chat/completions', requireCaller, async (req, res) => {
    const b = body(req);
    const provider = typeof b.provider === 'string' && isProvider(b.provider) ? (b.provider as ProviderName) : undefined;
    const messages = Array.isArray(b.messages) ? (b.messages as ChatMessage[]) : undefined;
    const response = await runChat(db, chatConfig, {
      messages,
      promptKey: typeof b.prompt_key === 'string' ? b.prompt_key : undefined,
      variables: (b.variables ?? {}) as Record<string, unknown>,
      provider,
      model: typeof b.model === 'string' ? b.model : undefined,
      idempotencyKey: typeof b.idempotency_key === 'string' ? b.idempotency_key : null,
      now: now(),
    });
    res.json(response);
  });

  app.post('/api/embeddings', requireCaller, (req, res) => {
    const b = body(req);
    const input = Array.isArray(b.input) ? b.input : typeof b.input === 'string' ? [b.input] : null;
    if (!input || input.length === 0 || !input.every((s) => typeof s === 'string')) {
      fail(422, 'Validation failed', [{ field: 'input', message: 'must be a non-empty string or string array' }]);
    }
    const texts = input as string[];
    const vectors = texts.map((t) => embed(db, t, now()));
    const promptTokens = texts.reduce((n, t) => n + approxTokens(t), 0);
    res.json({ model: EMBED_MODEL, dims: EMBED_DIMS, vectors, usage: { prompt_tokens: promptTokens, completion_tokens: 0 } });
  });

  // ── Prompt management ──────────────────────────────────────────────
  app.get('/api/prompts', requireCaller, (_req, res) => {
    const rows = db.prepare('SELECT * FROM prompts ORDER BY key').all() as PromptRow[];
    res.json({ prompts: rows.map((r) => mapPrompt(db, r)) });
  });

  app.get('/api/prompts/:key', requireCaller, (req, res) => {
    const row = promptByKey(db, req.params.key as string);
    if (!row) fail(404, 'Prompt not found');
    const versions = db
      .prepare('SELECT version, template, notes, created_at FROM prompt_versions WHERE prompt_id = ? ORDER BY version')
      .all(row.id) as PromptVersionRow[];
    res.json({
      prompt: mapPrompt(db, row),
      version_details: versions.map((v) => ({
        version: v.version,
        template: JSON.parse(v.template),
        notes: v.notes,
        created_at: v.created_at,
      })),
    });
  });

  app.post('/api/prompts', requireAdmin, (req, res) => {
    const b = body(req);
    const key = reqText(b, 'key', 120);
    const name = reqText(b, 'name', 200);
    const template = validateTemplate(b.template);
    if (promptByKey(db, key)) fail(409, 'Prompt already exists — POST a new version instead');
    const created = db.transaction((): PromptRow => {
      const info = db
        .prepare('INSERT INTO prompts (key, name, active_version, created_at) VALUES (?, ?, 1, ?)')
        .run(key, name, nowIso(now()));
      const promptId = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO prompt_versions (prompt_id, version, template, notes, created_at) VALUES (?, 1, ?, ?, ?)').run(
        promptId,
        JSON.stringify(template),
        typeof b.notes === 'string' ? b.notes : null,
        nowIso(now()),
      );
      return db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId) as PromptRow;
    })();
    res.status(201).json({ prompt: mapPrompt(db, created) });
  });

  app.post('/api/prompts/:key/versions', requireAdmin, (req, res) => {
    const prompt = promptByKey(db, req.params.key as string);
    if (!prompt) fail(404, 'Prompt not found');
    const b = body(req);
    const template = validateTemplate(b.template);
    const max = db.prepare('SELECT MAX(version) AS v FROM prompt_versions WHERE prompt_id = ?').get(prompt.id) as { v: number };
    const version = max.v + 1;
    db.prepare('INSERT INTO prompt_versions (prompt_id, version, template, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(
      prompt.id,
      version,
      JSON.stringify(template),
      typeof b.notes === 'string' ? b.notes : null,
      nowIso(now()),
    );
    res.status(201).json({ version });
  });

  app.put('/api/prompts/:key/active', requireAdmin, (req, res) => {
    const prompt = promptByKey(db, req.params.key as string);
    if (!prompt) fail(404, 'Prompt not found');
    const version = Number(body(req).version);
    if (!Number.isInteger(version)) fail(422, 'Validation failed', [{ field: 'version', message: 'is required' }]);
    const exists = db.prepare('SELECT 1 FROM prompt_versions WHERE prompt_id = ? AND version = ?').get(prompt.id, version);
    if (!exists) fail(404, 'Version not found');
    db.prepare('UPDATE prompts SET active_version = ? WHERE id = ?').run(version, prompt.id);
    res.json({ ok: true, active_version: version });
  });

  app.post('/api/prompts/:key/render', requireCaller, (req, res) => {
    const messages = renderMessages(activeTemplate(db, req.params.key as string), (body(req).variables ?? {}) as Record<string, unknown>);
    res.json({ messages });
  });

  // ── Completions log ────────────────────────────────────────────────
  app.get('/api/completions', requireCaller, (_req, res) => {
    const rows = db
      .prepare('SELECT id, provider, model, prompt_key, prompt_tokens, completion_tokens, latency_ms, created_at FROM completions ORDER BY id DESC LIMIT 100')
      .all();
    res.json({ completions: rows });
  });

  app.get('/api/completions/:id', requireCaller, (req, res) => {
    const id = idParam(req);
    const row = id ? db.prepare('SELECT * FROM completions WHERE id = ?').get(id) : undefined;
    if (!row) fail(404, 'Completion not found');
    res.json({ completion: row });
  });

  // ── RAG ────────────────────────────────────────────────────────────
  app.post('/api/rag/documents', requireCaller, (req, res) => {
    const b = body(req);
    const collection = reqText(b, 'collection', 120);
    const text = reqText(b, 'text', 20000);
    res.status(201).json({ id: ingestDocument(db, collection, text, now()) });
  });

  app.post('/api/rag/search', requireCaller, (req, res) => {
    const b = body(req);
    const collection = reqText(b, 'collection', 120);
    const query = reqText(b, 'query', 20000);
    const k = Number.isInteger(b.k) ? (b.k as number) : 3;
    res.json({ results: search(db, collection, query, k, now()) });
  });

  // ── Documented stubs (not implemented in v1) ───────────────────────
  for (const path of ['/api/agents/run', '/api/images/generate', '/api/speech/transcribe']) {
    app.post(path, requireCaller, (_req, res) => {
      res.status(501).json({ error: `${path} is not implemented in this release`, capability: 'planned' });
    });
  }

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
