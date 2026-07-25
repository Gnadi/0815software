import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { AiClient } from '../../clients/src/index.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let server: Server;
let baseUrl: string;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  server = createApp({ db, auth }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('AiClient ↔ PS-04 contract', () => {
  it('chats, embeds, and round-trips RAG via the deterministic mock', async () => {
    const ai = new AiClient({ baseUrl, serviceToken: 'test-service' });

    const chat = await ai.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(typeof chat.text).toBe('string');
    expect(chat.model).toBeDefined();

    const emb = await ai.embed({ input: 'hello world' });
    expect(emb.vectors.length).toBe(1);
    expect(emb.dims).toBeGreaterThan(0);

    const ingested = await ai.ragIngest('kb', 'the sky is blue');
    expect(typeof ingested.id).toBe('number');

    const found = await ai.ragSearch({ collection: 'kb', query: 'sky' });
    expect(found.results.length).toBeGreaterThanOrEqual(1);
    expect(found.results[0]!.text).toContain('sky');

    const agent = await ai.runAgent({ goal: 'summarize the thread' });
    expect(typeof agent.output).toBe('string');
  });
});
