import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildLoginVerifier } from '../server/sso.js';
import type { AuthConfig } from '../server/auth.js';
// Boot the REAL PS-01 Identity in-process and log into mod-02 through it — the
// end-to-end proof that the SSO seam (module → IdentityClient → PS-01 verify →
// platform:admin check) works against the real service, not just a stub.
import { createApp as createIdentityApp } from '../../../platform/ps-01-identity/server/app.js';
import { openDb as openIdentityDb } from '../../../platform/ps-01-identity/server/db.js';
import { seed as seedIdentity } from '../../../platform/ps-01-identity/server/seed.js';

const auth: AuthConfig = { username: 'admin', password: 'local-only', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let identityServer: Server;
let identityUrl: string;
let app: Express;

beforeAll(() => {
  const idDb = openIdentityDb(':memory:');
  seedIdentity(idDb);
  identityServer = createIdentityApp({ db: idDb, session: { secret: 'id-secret', ttlHours: 12, secureCookie: false } }).listen(0);
  identityUrl = `http://127.0.0.1:${(identityServer.address() as AddressInfo).port}`;

  const db: Database.Database = openDb(':memory:');
  seed(db);
  // A real verifier pointed at the live PS-01, requiring platform:admin.
  const verifyLogin = buildLoginVerifier({ identityUrl, identityOrg: 'acme', identityPermission: 'platform:admin' });
  app = createApp({ db, auth, verifyLogin });
});

afterAll(() => {
  identityServer.close();
});

describe('mod-02 login via real PS-01 identity', () => {
  const login = (username: string, password: string) =>
    request(app).post('/api/login').send({ username, password });

  it('accepts an org owner who holds platform:admin', async () => {
    // Seeded acme owner; the owner role carries platform:admin (Phase 1).
    await login('owner@acme.test', 'demo-owner').expect(200);
  });

  it('rejects a wrong password', async () => {
    await login('owner@acme.test', 'nope').expect(401);
  });

  it('rejects a valid user who lacks platform:admin', async () => {
    // Seeded acme member authenticates at PS-01 but has no platform:admin.
    await login('member@acme.test', 'demo-member').expect(401);
  });

  it('rejects the local admin creds now that SSO is in force', async () => {
    await login('admin', 'local-only').expect(401);
  });
});
