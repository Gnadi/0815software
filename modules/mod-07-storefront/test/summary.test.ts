import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { MODULE_ID } from '../server/summary.js';
import { isModulePath, SUMMARY_VERSION, validateSummary, type ModuleSummary } from '../shared/summary.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};


/**
 * What this module puts on a shell's board.
 *
 * This is one of the three modules whose end users are NOT staff, so it has a
 * summary but no handoff and no embed: a staff shell has no principal to sign
 * in as here (docs/PLATFORM-READINESS.md, item C1). It does carry lists: a shop's orders are staff-visible already.
 */

const TOKEN = 'test-machine-token';

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, serviceToken: TOKEN });
});

function summary(query = ''): request.Test {
  return request(app).get(`/api/summary${query}`).set('X-Service-Token', TOKEN);
}

describe('GET /api/summary — auth', () => {
  it('requires the machine token', async () => {
    // No machine token: this route does not answer at all — it falls through,
    // so the property asserted is that no shell summary comes back.
    const anonymous = await request(app).get('/api/summary');
    expect(anonymous.body.summary_version).toBeUndefined();

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
    for (const href of hrefs) expect(isModulePath(href)).toBe(true);
  });

  it('does carry rows, unlike the other two domain-user modules', async () => {
    const body = (await summary().expect(200)).body as ModuleSummary;
    // A shop's orders are already visible to whoever runs the shop, and there
    // is no per-user access rule here for a shell to bypass — so a board may
    // show them.
    expect(body.lists.length).toBeGreaterThan(0);
  });
});

describe('the context a shell passes', () => {
  it('applies nothing when asked for nothing, and never overclaims', async () => {
    const none = (await summary().expect(200)).body as ModuleSummary;
    expect(none.context.applied).toEqual([]);

    const filtered = (await summary('?party=77&from=2026-01-01&to=2026-12-31').expect(200)).body as ModuleSummary;
    for (const filter of filtered.context.applied) expect(filtered.context.supported).toContain(filter);
  });

  it('ignores a malformed context instead of failing the widget', async () => {
    const body = (await summary('?party=nonsense&from=yesterday').expect(200)).body as ModuleSummary;
    expect(body.context.applied).toEqual([]);
    expect(validateSummary(body)).toEqual([]);
  });
});
