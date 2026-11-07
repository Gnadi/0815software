import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { buildPeople, noopPeople } from '../server/people.js';
import { inboxHandler } from '../server/inbox.js';
import { consume, startWatch } from '../server/watch.js';

/**
 * The notification building blocks every module carries (copy-in): who is
 * told (server/people.ts), the inbox route a shell asks (server/inbox.ts),
 * and the log reader behind both (server/watch.ts). Byte-identical in every
 * module that has them; each module's own rules are in test/inbox-rules.test.ts.
 */

function stubServices() {
  const events: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/directory/holders') {
      asked.push(u.searchParams.get('permission')!);
      return new Response(JSON.stringify({ holders: ['boss@acme.test', 'ada@acme.test'] }), { status: 200 });
    }
    events.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ recorded: 1, skipped: 0 }), { status: 201 });
  }) as unknown as typeof fetch;
  return { events, asked, fetchImpl };
}

describe('telling people (server/people.ts)', () => {
  it('does nothing at all without PS-03', () => {
    expect(buildPeople({ module: 'x', notificationUrl: undefined, serviceToken: 't' })).toBe(noopPeople);
  });

  it('names people directly and by level, never the person who caused it, deduplicated', async () => {
    const { events, asked, fetchImpl } = stubServices();
    const people = buildPeople(
      { module: 'offers', notificationUrl: 'http://ps03', identityUrl: 'http://ps01', identityOrg: 'acme', serviceToken: 't' },
      { fetch: fetchImpl },
    );
    people.notify({
      kind: 'k',
      category: 'approvals',
      urgency: 'digest',
      recipients: ['Ada@Acme.test', 'local-admin', null],
      holders: 'manage',
      actor: 'boss@acme.test',
      title: 'Something waits',
      key: 'x:1',
    });
    await people.flush();
    expect(asked).toEqual(['module:offers:manage']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ module: 'offers', recipients: ['ada@acme.test'], actor: 'boss@acme.test', idempotency_key: 'offers:x:1' });
  });

  it('never throws into the write that caused it when PS-03 is down', async () => {
    const people = buildPeople({ module: 'm', notificationUrl: 'http://ps03', serviceToken: 't' }, {
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(() => people.notify({ kind: 'k', category: 'c', urgency: 'now', recipients: ['a@b.c'], title: 't', key: 'k' })).not.toThrow();
    await people.flush();
  });
});

describe('the inbox route (server/inbox.ts)', () => {
  const app = express();
  app.get('/api/inbox', inboxHandler('stack', 'mine', (person, level) => ({
    count: 3,
    items: [{ id: '1', kind: 'k', title: `for ${person} at ${level}`, detail: null, tone: 'neutral', at: null, href: null }],
  })));

  it('needs the stack token, a person and a level', async () => {
    expect((await request(app).get('/api/inbox?for=a@b.c&level=view')).status).toBe(401);
    expect((await request(app).get('/api/inbox?for=a@b.c&level=boss').set('X-Service-Token', 'stack')).status).toBe(422);
  });

  it('answers the shell contract', async () => {
    const res = await request(app).get('/api/inbox?for=A@B.c&level=edit').set('X-Service-Token', 'stack').expect(200);
    expect(res.body).toEqual({
      version: 1,
      module: 'mine',
      count: 3,
      items: [{ id: '1', kind: 'k', title: 'for a@b.c at edit', detail: null, tone: 'neutral', at: null, href: null }],
    });
  });
});

describe('reading the logs (server/watch.ts)', () => {
  it('starts at the end, then hands over each new row once', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, what TEXT)');
    db.prepare("INSERT INTO things (what) VALUES ('old')").run();
    const seen: string[] = [];
    const read = () => consume<{ id: number; what: string }>(db, 'things', 'things', (r) => seen.push(r.what));
    expect(read()).toBe(0); // a fresh install never replays history
    db.prepare("INSERT INTO things (what) VALUES ('new 1'), ('new 2')").run();
    expect(read()).toBe(2);
    expect(read()).toBe(0);
    expect(seen).toEqual(['new 1', 'new 2']);
  });

  it('runs nothing when notifications are off', () => {
    let ran = false;
    const stop = startWatch(new Database(':memory:'), noopPeople, () => {
      ran = true;
    });
    stop();
    expect(ran).toBe(false);
  });
});
