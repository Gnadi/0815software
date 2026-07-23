import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp, type AppOptions } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/providers/index.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

const svc = { 'X-Service-Token': 'test-service' };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;

function makeApp(extra: Partial<AppOptions> = {}): Express {
  return createApp({ db, auth, ...extra });
}
async function adminToken(a: Express): Promise<string> {
  return (await request(a).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

beforeEach(() => {
  db = openDb(':memory:');
  app = makeApp();
});

describe('auth & health', () => {
  it('gates caller routes', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    // The combined caller gate (admin session OR service token) answers 401
    // for any unauthenticated caller, including a wrong service token.
    expect((await request(app).post('/api/embeddings').send({ input: ['x'] })).status).toBe(401);
    expect((await request(app).post('/api/embeddings').set({ 'X-Service-Token': 'no' }).send({ input: ['x'] })).status).toBe(401);
  });
});

describe('mock chat is deterministic', () => {
  it('returns identical output for identical input and touches no network', async () => {
    const msg = { messages: [{ role: 'user', content: 'hello world' }] };
    const a = await request(app).post('/api/chat/completions').set(svc).send(msg);
    const b = await request(app).post('/api/chat/completions').set(svc).send(msg);
    expect(a.status).toBe(200);
    expect(a.body.provider).toBe('mock');
    expect(a.body.text).toBe(b.body.text);
    expect(a.body.usage).toEqual(b.body.usage);
  });
});

describe('prompt versioning & rendering', () => {
  it('versions, switches the active pointer, renders, and 422s on missing vars', async () => {
    const token = await adminToken(app);
    await request(app)
      .post('/api/prompts')
      .set(as(token))
      .send({ key: 'greet', name: 'Greet', template: [{ role: 'user', content: 'Hi {{name}}' }] })
      .expect(201);

    // Render active (v1).
    const r1 = await request(app).post('/api/prompts/greet/render').set(svc).send({ variables: { name: 'Zoe' } });
    expect(r1.body.messages[0].content).toBe('Hi {{name}}'.replace('{{name}}', 'Zoe'));

    // Missing variable → 422.
    expect((await request(app).post('/api/prompts/greet/render').set(svc).send({ variables: {} })).status).toBe(422);

    // Add v2 and activate it.
    await request(app)
      .post('/api/prompts/greet/versions')
      .set(as(token))
      .send({ template: [{ role: 'user', content: 'Hello there {{name}}' }] })
      .expect(201);
    await request(app).put('/api/prompts/greet/active').set(as(token)).send({ version: 2 }).expect(200);

    const r2 = await request(app).post('/api/prompts/greet/render').set(svc).send({ variables: { name: 'Zoe' } });
    expect(r2.body.messages[0].content).toBe('Hello there Zoe');
  });
});

describe('embeddings cache', () => {
  it('dedupes by (model, input_hash) and returns identical vectors', async () => {
    const first = await request(app).post('/api/embeddings').set(svc).send({ input: ['same text'] });
    expect(first.status).toBe(200);
    expect(first.body.dims).toBe(first.body.vectors[0].length);
    const second = await request(app).post('/api/embeddings').set(svc).send({ input: ['same text'] });
    expect(second.body.vectors[0]).toEqual(first.body.vectors[0]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number };
    expect(count.n).toBe(1); // cached, not recomputed/reinserted
  });
});

describe('RAG search', () => {
  it('ranks documents deterministically by similarity', async () => {
    for (const text of ['alpha bravo charlie', 'delta echo foxtrot', 'alpha bravo delta']) {
      await request(app).post('/api/rag/documents').set(svc).send({ collection: 'c', text }).expect(201);
    }
    const res = await request(app).post('/api/rag/search').set(svc).send({ collection: 'c', query: 'alpha bravo charlie', k: 2 });
    expect(res.body.results.length).toBe(2);
    // The exact-match document scores highest and is stable across runs.
    expect(res.body.results[0].text).toBe('alpha bravo charlie');
    expect(res.body.results[0].score).toBeGreaterThanOrEqual(res.body.results[1].score);
  });
});

describe('provider selection', () => {
  it('uses Anthropic only when a key is set, otherwise mock', async () => {
    let fetchCalls = 0;
    const anthropicFetch: FetchLike = async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'anthropic-reply' }], usage: { input_tokens: 5, output_tokens: 2 } }),
      };
    };
    const keyed = makeApp({ anthropicApiKey: 'sk-test', fetchImpl: anthropicFetch });
    const withKey = await request(keyed)
      .post('/api/chat/completions')
      .set(svc)
      .send({ provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }] });
    expect(withKey.body.provider).toBe('anthropic');
    expect(withKey.body.text).toBe('anthropic-reply');
    expect(fetchCalls).toBe(1);

    // No key → falls back to mock even when anthropic is requested; no fetch.
    const nokey = await request(app)
      .post('/api/chat/completions')
      .set(svc)
      .send({ provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }] });
    expect(nokey.body.provider).toBe('mock');
    expect(fetchCalls).toBe(1);
  });

  it('routes OpenAI, Gemini and Ollama to their adapters when configured', async () => {
    let lastUrl = '';
    const okJson = (json: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } => ({
      ok: true,
      status: 200,
      json: async () => json,
    });
    const capture =
      (json: unknown): FetchLike =>
      async (url) => {
        lastUrl = url;
        return okJson(json);
      };

    // OpenAI.
    const openai = makeApp({
      openaiApiKey: 'sk-openai',
      fetchImpl: capture({ choices: [{ message: { content: 'openai-reply' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    });
    const o = await request(openai).post('/api/chat/completions').set(svc).send({ provider: 'openai', messages: [{ role: 'user', content: 'hi' }] });
    expect(o.body.provider).toBe('openai');
    expect(o.body.text).toBe('openai-reply');
    expect(lastUrl).toContain('api.openai.com');

    // Gemini.
    const gemini = makeApp({
      geminiApiKey: 'g-key',
      fetchImpl: capture({ candidates: [{ content: { parts: [{ text: 'gemini-reply' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }),
    });
    const g = await request(gemini).post('/api/chat/completions').set(svc).send({ provider: 'gemini', messages: [{ role: 'user', content: 'hi' }] });
    expect(g.body.provider).toBe('gemini');
    expect(g.body.text).toBe('gemini-reply');
    expect(lastUrl).toContain('generativelanguage.googleapis.com');

    // Ollama (open-source, keyless — enabled by a base URL).
    const ollama = makeApp({
      ollamaBaseUrl: 'http://localhost:11434',
      fetchImpl: capture({ message: { content: 'ollama-reply' }, prompt_eval_count: 3, eval_count: 4 }),
    });
    const ol = await request(ollama).post('/api/chat/completions').set(svc).send({ provider: 'ollama', model: 'mistral', messages: [{ role: 'user', content: 'hi' }] });
    expect(ol.body.provider).toBe('ollama');
    expect(ol.body.text).toBe('ollama-reply');
    expect(ol.body.model).toBe('mistral'); // caller-supplied model override
    expect(lastUrl).toBe('http://localhost:11434/api/chat');

    // Kimi (Moonshot AI, OpenAI-compatible).
    const kimi = makeApp({
      kimiApiKey: 'k-key',
      fetchImpl: capture({ choices: [{ message: { content: 'kimi-reply' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    });
    const km = await request(kimi).post('/api/chat/completions').set(svc).send({ provider: 'kimi', messages: [{ role: 'user', content: 'hi' }] });
    expect(km.body.provider).toBe('kimi');
    expect(km.body.text).toBe('kimi-reply');
    expect(lastUrl).toBe('https://api.moonshot.ai/v1/chat/completions');

    // Each vendor falls back to mock when unconfigured.
    for (const provider of ['openai', 'gemini', 'ollama', 'kimi']) {
      const res = await request(app).post('/api/chat/completions').set(svc).send({ provider, messages: [{ role: 'user', content: 'hi' }] });
      expect(res.body.provider).toBe('mock');
    }
  });
});

describe('documented stubs', () => {
  it('returns 501 for unimplemented capabilities', async () => {
    for (const path of ['/api/agents/run', '/api/images/generate', '/api/speech/transcribe']) {
      expect((await request(app).post(path).set(svc).send({})).status).toBe(501);
    }
  });
});
