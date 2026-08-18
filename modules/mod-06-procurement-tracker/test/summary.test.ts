import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { MODULE_ID } from '../server/summary.js';
import type { AuthConfig } from '../server/auth.js';
import { isModulePath, SUMMARY_VERSION, validateSummary, type ModuleSummary } from '../shared/summary.js';

/**
 * What this module puts on a shell's board.
 *
 * Two properties carry the weight. The summary must satisfy `validateSummary` —
 * MOD-15 refuses a peer that fails it, so a shape mistake here is a blank
 * widget rather than a wrong one. And the machine token must be the ONLY way
 * in: a staff session is deliberately not enough, because the caller is
 * another service in the stack rather than a person.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const TOKEN = 'test-machine-token';

let db: Database.Database;
let app: Express;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, serviceToken: TOKEN });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(login.status).toBe(200);
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
});

function summary(query = ''): request.Test {
  return request(app).get(`/api/summary${query}`).set('X-Service-Token', TOKEN);
}

describe('GET /api/summary — auth', () => {
  it('requires the machine token, and a staff session is not one', async () => {
    // No machine token: this route does not answer at all. It falls through,
    // which is a 404 in most modules and MOD-11's own unrelated /api/summary in
    // that one — so the property asserted is that no shell summary comes back,
    // not a particular status.
    const anonymous = await request(app).get('/api/summary');
    expect(anonymous.body.summary_version).toBeUndefined();

    // A staff session is deliberately not a way in either: the caller this
    // endpoint exists for is another service in the stack, not a person.
    const staff = await request(app).get('/api/summary').set('Cookie', cookie);
    expect(staff.body.summary_version).toBeUndefined();

    // A token that is present but wrong IS refused, rather than falling
    // through — a machine that got the credential wrong deserves to be told.
    await request(app).get('/api/summary').set('X-Service-Token', 'wrong').expect(401);
    await summary().expect(200);
  });

  it('is closed when the stack has no machine token', async () => {
    const standalone = createApp({ db, auth });
    // With no token configured the endpoint is closed even to a caller that
    // presents one — the standalone default.
    await request(standalone).get('/api/summary').set('X-Service-Token', TOKEN).expect(401);
  });
});

describe('the summary a shell renders', () => {
  it('satisfies the contract every consumer validates against', async () => {
    const res = await summary().expect(200);
    expect(validateSummary(res.body)).toEqual([]);
    expect(res.body.summary_version).toBe(SUMMARY_VERSION);
    expect(res.body.module).toBe(MODULE_ID);
  });

  it('offers at least one widget to put on a board', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    expect(body.tiles.length + body.lists.length).toBeGreaterThan(0);
  });

  it('hands out only paths, never absolute URLs', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    const hrefs = [
      ...body.tiles.map((t) => t.href),
      ...body.lists.map((l) => l.href),
      ...body.lists.flatMap((l) => l.items.map((i) => i.href)),
    ].filter((h): h is string => h !== null);

    expect(hrefs.length).toBeGreaterThan(0);
    // The shell joins these to this module's public origin. A peer that could
    // return an absolute URL would decide where the shell's UI navigates.
    for (const href of hrefs) expect(isModulePath(href)).toBe(true);
  });

  it('keeps its keys unique, so a saved board can restore every widget', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    const keys = [...body.tiles.map((t) => t.key), ...body.lists.map((l) => l.key)];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the context a shell passes', () => {
  it('applies nothing when asked for nothing', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual([]);
  });

  it('never claims to have applied a filter it does not support', async () => {
    const body = (await summary('?party=77&from=2026-01-01&to=2026-12-31').expect(200)).body as ModuleSummary;
    // The honest echo is the point: a board that says "filtered to this
    // customer" while showing everyone's rows is worse than one that admits it
    // could not narrow.
    for (const filter of body.context.applied) expect(body.context.supported).toContain(filter);
    expect(validateSummary(body)).toEqual([]);
  });

  it('ignores a malformed context instead of failing the widget', async () => {
    const body = (await summary('?party=nonsense&from=yesterday').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual([]);
    expect(validateSummary(body)).toEqual([]);
  });
});
