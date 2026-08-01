import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * PS-11 holds the primary copy of a counterparty's identity, so a subject
 * access request lands here hardest. What the answer has to include beyond the
 * party row: the per-module references, which say which other systems in this
 * deployment hold a row about the same person, and any duplicate that was
 * merged away — its row still carries the identity.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let db: Database.Database;
let app: Express;
const svc = () => ({ 'X-Service-Token': 'test-service' });

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
});

describe('subject export', () => {
  it('returns the party and the modules that reference it', async () => {
    const created = await request(app)
      .post('/api/parties/resolve')
      .set(svc())
      .send({
        name: 'Ada Lovelace',
        email: 'ada@acme.test',
        vat_id: 'ATU12345678',
        source: 'mod-04-invoice-billing',
        external_id: '42',
      });
    expect(created.status).toBe(201); // a resolve that creates answers 201

    const res = await request(app).get('/api/export?subject=ada@acme.test').set(svc());
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('ps-11-customers');
    expect(res.body.records.parties[0].email).toBe('ada@acme.test');
    expect(res.body.records.parties[0].vat_id).toBe('ATU12345678');
    // Which other system holds a row about the same person is part of the answer.
    expect(res.body.records.references[0]).toMatchObject({
      source: 'mod-04-invoice-billing',
      external_id: '42',
    });
  });

  it('includes a duplicate that was merged away', async () => {
    const survivor = await request(app)
      .post('/api/parties')
      .set(svc())
      .send({ name: 'Ada Lovelace', email: 'ada@acme.test' });
    const loser = await request(app)
      .post('/api/parties')
      .set(svc())
      .send({ name: 'A. Lovelace', vat_id: 'ATU99999999' });
    await request(app)
      .post(`/api/parties/${loser.body.party.id}/merge`)
      .set(svc())
      .send({ into: survivor.body.party.id })
      .expect(200);

    const res = await request(app).get('/api/export?subject=ada@acme.test').set(svc());
    expect(res.status).toBe(200);
    // The merged-away row still holds an identity that was theirs.
    expect(res.body.records.merged_away).toHaveLength(1);
    expect(res.body.records.merged_away[0].name).toBe('A. Lovelace');
  });

  it('can be asked by party id when the operator already knows it', async () => {
    const created = await request(app)
      .post('/api/parties')
      .set(svc())
      .send({ name: 'No Mail GmbH', vat_id: 'ATU00000001' });

    const res = await request(app).get(`/api/export?subject=${created.body.party.id}`).set(svc());
    expect(res.status).toBe(200);
    expect(res.body.records.parties[0].name).toBe('No Mail GmbH');
  });

  it('answers honestly when it holds nothing, and needs a caller', async () => {
    const empty = await request(app).get('/api/export?subject=nobody@nowhere.test').set(svc());
    expect(empty.status).toBe(200);
    expect(empty.body.records).toEqual({});

    expect((await request(app).get('/api/export?subject=x@y.test')).status).toBe(401);
  });
});
