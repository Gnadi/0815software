import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import { changesFromPatch, intParam, parseFilter, parsePatchOps, ScimError } from '../server/scim.js';

/**
 * SCIM 2.0 provisioning.
 *
 * The case that matters most is the last one in this file: somebody leaves the
 * company, the directory deactivates them here, and the session they are
 * holding stops working immediately rather than at its next expiry. Everything
 * else is the surface an IdP needs in order to get there.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const SELF = 'https://identity.example.com';
const SCIM = '/scim/v2';
/** What an operator should actually mint for an IdP connector. */
const SCIM_SCOPES = ['org:read', 'user:read', 'user:write', 'role:read', 'role:write'];

let db: Database.Database;
let app: Express;
/** A full-authority key, as an operator would mint for the IdP connector. */
let key: string;

async function mintKey(scopes?: string[]): Promise<string> {
  const login = await request(app)
    .post('/api/login')
    .send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' });
  const res = await request(app)
    .post('/api/api-keys')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send(scopes ? { name: 'scim', scopes } : { name: 'scim' });
  return res.body.secret as string;
}

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session, selfBaseUrl: SELF });
  key = await mintKey();
});

const scim = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token = key) =>
  request(app)[method](`${SCIM}${path}`).set('Authorization', `Bearer ${token}`);

const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';

const newUser = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemas: [USER_SCHEMA],
  userName: 'grace@acme.test',
  displayName: 'Grace Hopper',
  externalId: 'dir-0001',
  emails: [{ value: 'grace@acme.test', primary: true }],
  ...over,
});

// ── Unit: the bits an IdP gets subtly wrong ────────────────────────────

describe('filter parsing', () => {
  it('accepts the one shape provisioning clients actually send', () => {
    expect(parseFilter('userName eq "ada@corp.test"', ['userName'])).toEqual({
      attribute: 'userName',
      value: 'ada@corp.test',
    });
    // Attribute names are case-insensitive on the wire.
    expect(parseFilter('USERNAME eq "x"', ['userName']).attribute).toBe('userName');
  });

  it('refuses anything more complex rather than matching everything', () => {
    // A de-provisioning client that gets "everything" back from a filter it
    // thought was narrow is how a whole directory gets disabled at once.
    for (const bad of ['userName co "acme"', 'userName eq "a" and active eq true', 'active eq true', '']) {
      expect(() => parseFilter(bad, ['userName'])).toThrow(ScimError);
    }
  });

  it('refuses an attribute it does not support', () => {
    expect(() => parseFilter('password eq "x"', ['userName'])).toThrow(/not supported/);
  });
});

describe('paging parameters', () => {
  it('rejects a non-integer instead of answering 500', () => {
    expect(() => intParam('abc', 'count', 100, 0, 200)).toThrow(/must be an integer/);
  });

  it('clamps to the server maximum and the documented floor', () => {
    expect(intParam('9999', 'count', 100, 0, 200)).toBe(200);
    expect(intParam('-4', 'startIndex', 1, 1, 1000)).toBe(1);
    expect(intParam(undefined, 'count', 100, 0, 200)).toBe(100);
  });
});

describe('PATCH parsing', () => {
  it('reads a de-provision sent the way Entra ID sends it', () => {
    // Note the capitalised verb and the STRING "False" — both are real.
    const ops = parsePatchOps({ schemas: [PATCH], Operations: [{ op: 'Replace', value: { active: 'False' } }] });
    expect(changesFromPatch(ops)).toEqual({ active: false });
  });

  it('reads a de-provision sent the way Okta sends it', () => {
    const ops = parsePatchOps({ schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(changesFromPatch(ops)).toEqual({ active: false });
  });

  it('reads renames and externalId changes from either shape', () => {
    const ops = parsePatchOps({
      schemas: [PATCH],
      Operations: [
        { op: 'replace', path: 'userName', value: 'new@acme.test' },
        { op: 'replace', value: { displayName: 'New Name', externalId: 'dir-9' } },
      ],
    });
    expect(changesFromPatch(ops)).toEqual({ email: 'new@acme.test', name: 'New Name', externalId: 'dir-9' });
  });

  it('refuses a body that is not a PatchOp at all', () => {
    expect(() => parsePatchOps({ Operations: [] })).toThrow(/must declare/);
    expect(() => parsePatchOps({ schemas: [PATCH] })).toThrow(/no Operations/);
    expect(() => parsePatchOps({ schemas: [PATCH], Operations: [{ op: 'destroy' }] })).toThrow(/Unsupported PATCH op/);
  });
});

// ── The HTTP surface ───────────────────────────────────────────────────

describe('authentication', () => {
  it('refuses an anonymous caller, in the SCIM error shape', async () => {
    const res = await request(app).get(`${SCIM}/Users`);
    expect(res.status).toBe(401);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(res.body.status).toBe('401');
  });

  it('refuses a key that lacks the permission, and says which', async () => {
    const readOnly = await mintKey(['user:read']);
    expect((await scim('get', '/Users', readOnly)).status).toBe(200);
    const denied = await scim('post', '/Users', readOnly).send(newUser());
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toMatch(/user:write/);
  });

  it('accepts a session token too, so the surface can be driven by hand', async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' });
    expect((await scim('get', '/Users', login.body.token)).status).toBe(200);
  });
});

describe('discovery documents', () => {
  it('advertises what this server really supports', async () => {
    const res = await scim('get', '/ServiceProviderConfig');
    expect(res.status).toBe(200);
    expect(res.body.patch.supported).toBe(true);
    expect(res.body.filter.supported).toBe(true);
    // Honest about what is not built: no bulk, no sorting, no password writes.
    expect(res.body.bulk.supported).toBe(false);
    expect(res.body.sort.supported).toBe(false);
    expect(res.body.changePassword.supported).toBe(false);
  });

  it('lists its resource types and schemas', async () => {
    expect((await scim('get', '/ResourceTypes')).body.Resources).toHaveLength(2);
    expect((await scim('get', '/Schemas')).body.Resources).toHaveLength(2);
  });
});

describe('provisioning a user', () => {
  it('creates one, in the caller’s tenant, with a Location and the default role', async () => {
    const res = await scim('post', '/Users').send(newUser());
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/scim\+json/);
    expect(res.headers.location).toBe(`${SELF}${SCIM}/Users/${res.body.id}`);
    expect(res.body.userName).toBe('grace@acme.test');
    expect(res.body.active).toBe(true);
    expect(res.body.externalId).toBe('dir-0001');
    expect(res.body.groups.map((g: { display: string }) => g.display)).toContain('Member');

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(res.body.id)) as { org_id: number; password_hash: string };
    const acme = db.prepare("SELECT id FROM organizations WHERE slug = 'acme'").get() as { id: number };
    expect(row.org_id).toBe(acme.id);
    // Provisioned accounts sign in through the IdP, so the password column
    // holds a hash of something nobody was ever told.
    expect(row.password_hash).toMatch(/^scrypt:/);
  });

  it('lower-cases the address, like every other path into this service', async () => {
    const res = await scim('post', '/Users').send(newUser({ userName: 'Grace@ACME.test' }));
    expect(res.body.userName).toBe('grace@acme.test');
  });

  it('falls back to the primary email when userName is absent', async () => {
    const res = await scim('post', '/Users').send({
      schemas: [USER_SCHEMA],
      emails: [{ value: 'alt@acme.test', primary: true }],
      name: { givenName: 'Alt', familyName: 'Person' },
    });
    expect(res.status).toBe(201);
    expect(res.body.userName).toBe('alt@acme.test');
    expect(res.body.displayName).toBe('Alt Person');
  });

  it('answers a re-create with 409 uniqueness, which is what a re-sync expects', async () => {
    await scim('post', '/Users').send(newUser());
    const again = await scim('post', '/Users').send(newUser());
    expect(again.status).toBe(409);
    expect(again.body.scimType).toBe('uniqueness');

    // Same for a re-used externalId under a different address.
    const clash = await scim('post', '/Users').send(newUser({ userName: 'other@acme.test' }));
    expect(clash.status).toBe(409);
  });

  it('refuses a create with no address at all', async () => {
    const res = await scim('post', '/Users').send({ schemas: [USER_SCHEMA], displayName: 'Nameless' });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe('invalidValue');
  });

  it('can create an already-inactive user', async () => {
    const res = await scim('post', '/Users').send(newUser({ active: false }));
    expect(res.body.active).toBe(false);
  });
});

describe('reading users', () => {
  it('lists the tenant with SCIM paging', async () => {
    const res = await scim('get', '/Users?startIndex=1&count=2');
    expect(res.status).toBe(200);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(res.body.Resources).toHaveLength(2);
    expect(res.body.startIndex).toBe(1);
    // acme is seeded with three users; the total counts all of them.
    expect(res.body.totalResults).toBe(3);

    const page2 = await scim('get', '/Users?startIndex=3&count=2');
    expect(page2.body.Resources).toHaveLength(1);
  });

  it('supports count=0 as a total-only probe', async () => {
    const res = await scim('get', '/Users?count=0');
    expect(res.body.Resources).toHaveLength(0);
    expect(res.body.totalResults).toBe(3);
  });

  it('answers ?count=abc with 400 rather than 500', async () => {
    const res = await scim('get', '/Users?count=abc');
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe('invalidValue');
  });

  it('finds a user by userName and by externalId — the two sync lookups', async () => {
    await scim('post', '/Users').send(newUser());
    const byName = await scim('get', `/Users?filter=${encodeURIComponent('userName eq "grace@acme.test"')}`);
    expect(byName.body.totalResults).toBe(1);
    const byExternal = await scim('get', `/Users?filter=${encodeURIComponent('externalId eq "dir-0001"')}`);
    expect(byExternal.body.totalResults).toBe(1);
    const miss = await scim('get', `/Users?filter=${encodeURIComponent('userName eq "nobody@acme.test"')}`);
    expect(miss.body.totalResults).toBe(0);
  });

  it('refuses a filter it cannot honour', async () => {
    const res = await scim('get', `/Users?filter=${encodeURIComponent('userName co "acme"')}`);
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe('invalidFilter');
  });
});

describe('tenant isolation', () => {
  it('cannot see, fetch or change a user in another organization', async () => {
    const globexOwner = db.prepare("SELECT u.id FROM users u JOIN organizations o ON o.id = u.org_id WHERE o.slug = 'globex'").get() as { id: number };

    expect((await scim('get', `/Users/${globexOwner.id}`)).status).toBe(404);
    expect((await scim('put', `/Users/${globexOwner.id}`).send({ userName: 'x@y.test' })).status).toBe(404);
    expect((await scim('delete', `/Users/${globexOwner.id}`)).status).toBe(404);

    // And the listing never mentions them.
    const list = await scim('get', '/Users?count=200');
    expect(list.body.Resources.map((r: { id: string }) => r.id)).not.toContain(String(globexOwner.id));
  });

  it('answers a nonsense id with 404, not a crash', async () => {
    expect((await scim('get', '/Users/not-a-number')).status).toBe(404);
    expect((await scim('get', '/Users/999999')).status).toBe(404);
  });
});

describe('updating a user', () => {
  let id: string;

  beforeEach(async () => {
    id = (await scim('post', '/Users').send(newUser())).body.id as string;
  });

  it('renames through PUT without blanking what the client omitted', async () => {
    const res = await scim('put', `/Users/${id}`).send({
      schemas: [USER_SCHEMA],
      userName: 'grace.hopper@acme.test',
      active: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.userName).toBe('grace.hopper@acme.test');
    // displayName was not sent, and did not become empty.
    expect(res.body.displayName).toBe('Grace Hopper');
  });

  it('refuses a rename onto an address that is taken', async () => {
    const res = await scim('put', `/Users/${id}`).send({ schemas: [USER_SCHEMA], userName: 'owner@acme.test' });
    expect(res.status).toBe(409);
    expect(res.body.scimType).toBe('uniqueness');
  });

  it('applies a PATCH and reports the resource back', async () => {
    const res = await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', value: { displayName: 'Rear Admiral Hopper' } }],
    });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Rear Admiral Hopper');
  });

  it('writes what it did to the audit trail', async () => {
    await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    const types = (db.prepare('SELECT type FROM auth_events WHERE user_id = ?').all(Number(id)) as { type: string }[]).map((r) => r.type);
    expect(types).toContain('scim_user_created');
    expect(types).toContain('scim_user_deactivated');
  });
});

describe('de-provisioning', () => {
  it('kills a live session the moment the directory switches the account off', async () => {
    // Give the new account a password and sign in as them, so there is a real
    // session to lose. (The SCIM-created account has no usable password.)
    const created = await scim('post', '/Users').send(newUser());
    const id = created.body.id as string;
    const pw = await request(app)
      .post(`/api/users/${id}/password`)
      .set('Authorization', `Bearer ${key}`)
      .send({ new_password: 'a-good-password' });
    expect(pw.status, JSON.stringify(pw.body)).toBe(200);
    const login = await request(app)
      .post('/api/login')
      .send({ org_slug: 'acme', email: 'grace@acme.test', password: 'a-good-password' });
    expect(login.status).toBe(200);
    const live = login.body.token as string;
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${live}`)).status).toBe(200);

    // The directory de-provisions.
    const res = await scim('delete', `/Users/${id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    // The token they are still holding is dead, not merely unable to be renewed.
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${live}`)).status).toBe(401);
    // And the row is still there, with its history.
    const row = db.prepare('SELECT status FROM users WHERE id = ?').get(Number(id)) as { status: string };
    expect(row.status).toBe('disabled');
  });

  it('deactivates through PATCH exactly as it does through DELETE', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const res = await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'Replace', value: { active: 'False' } }],
    });
    expect(res.body.active).toBe(false);
    const row = db.prepare('SELECT status, token_version FROM users WHERE id = ?').get(Number(id)) as {
      status: string;
      token_version: number;
    };
    expect(row.status).toBe('disabled');
    expect(row.token_version).toBe(2);
  });

  it('re-activates a returning employee without bumping their token version again', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    await scim('delete', `/Users/${id}`);
    const res = await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'active', value: true }],
    });
    expect(res.body.active).toBe(true);
    const row = db.prepare('SELECT status, token_version FROM users WHERE id = ?').get(Number(id)) as {
      status: string;
      token_version: number;
    };
    expect(row.status).toBe('active');
    expect(row.token_version).toBe(2);
  });

  it('is idempotent — a repeated de-provision is not an error', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    expect((await scim('delete', `/Users/${id}`)).status).toBe(204);
    expect((await scim('delete', `/Users/${id}`)).status).toBe(204);
    const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(Number(id)) as { token_version: number };
    expect(row.token_version).toBe(2); // bumped once, not twice
  });
});

describe('escalation', () => {
  it('will not let a user:write-only key disable the Owner', async () => {
    const scoped = await mintKey(['user:read', 'user:write']);
    const owner = db.prepare("SELECT id FROM users WHERE email = 'owner@acme.test'").get() as { id: number };
    const res = await scim('delete', `/Users/${owner.id}`, scoped);
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Cannot act on an account/);
    const row = db.prepare('SELECT status FROM users WHERE id = ?').get(owner.id) as { status: string };
    expect(row.status).toBe('active');
  });

  it('will not let a key provision an account that would outrank it', async () => {
    // `member` carries org:read, so a key without it cannot create one — the
    // same cap /api/users applies, which SCIM was missing.
    const narrow = await mintKey(['user:read', 'user:write']);
    const res = await scim('post', '/Users', narrow).send(newUser());
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Cannot grant a permission you do not hold: org:read/);
    // And nothing was written on the way to refusing.
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'grace@acme.test'").get() as { n: number }).n).toBe(0);
  });

  it('will not let it grant a role carrying permissions it does not hold', async () => {
    const scoped = await mintKey(SCIM_SCOPES);
    const member = (await scim('post', '/Users', scoped).send(newUser())).body.id as string;
    const owner = db.prepare("SELECT id FROM roles WHERE key = 'owner'").get() as { id: number };
    const res = await scim('patch', `/Groups/${owner.id}`, scoped).send({
      schemas: [PATCH],
      Operations: [{ op: 'add', path: 'members', value: [{ value: member }] }],
    });
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Cannot grant a permission you do not hold/);
  });
});

describe('groups', () => {
  it('lists the roles a tenant may use, with their members', async () => {
    const res = await scim('get', '/Groups');
    expect(res.status).toBe(200);
    const names = res.body.Resources.map((r: { displayName: string }) => r.displayName);
    expect(names).toContain('Owner');
    expect(names).toContain('Member');
    const member = res.body.Resources.find((r: { displayName: string }) => r.displayName === 'Member');
    expect(member.members.length).toBeGreaterThan(0);
  });

  it('finds a group by displayName', async () => {
    const res = await scim('get', `/Groups?filter=${encodeURIComponent('displayName eq "Member"')}`);
    expect(res.body.totalResults).toBe(1);
  });

  it('adds and removes a member, which is how a role is granted', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };

    const added = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'add', path: 'members', value: [{ value: id }] }],
    });
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: { value: string }) => m.value)).toContain(id);

    const removed = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'remove', path: `members[value eq "${id}"]` }],
    });
    expect(removed.body.members.map((m: { value: string }) => m.value)).not.toContain(id);
  });

  it('refuses a member from another tenant', async () => {
    const globex = db.prepare("SELECT u.id FROM users u JOIN organizations o ON o.id = u.org_id WHERE o.slug = 'globex'").get() as { id: number };
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const res = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'add', path: 'members', value: [{ value: String(globex.id) }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/not a user in this organization/);
  });

  it('refuses to write anything but membership', async () => {
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const res = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'displayName', value: 'Superusers' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe('invalidPath');
  });

  it('has no create or delete — a directory does not get to invent authority', async () => {
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    expect((await scim('post', '/Groups').send({ displayName: 'New' })).status).toBe(404);
    expect((await scim('delete', `/Groups/${admin.id}`)).status).toBe(404);
  });
});

describe('malformed input', () => {
  it('answers invalid JSON in the SCIM error shape', async () => {
    const res = await request(app)
      .post(`${SCIM}/Users`)
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'application/scim+json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
  });

  it('accepts the application/scim+json content type clients insist on', async () => {
    const res = await request(app)
      .post(`${SCIM}/Users`)
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'application/scim+json')
      .send(JSON.stringify(newUser()));
    expect(res.status).toBe(201);
  });
});

// ── The remaining shapes a real connector sends ────────────────────────

describe('shapes a connector sends that are easy to get wrong', () => {
  it('finds a user and a group by id filter', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const byId = await scim('get', `/Users?filter=${encodeURIComponent(`id eq "${id}"`)}`);
    expect(byId.body.totalResults).toBe(1);
    // A non-numeric id matches nothing rather than erroring.
    const junk = await scim('get', `/Users?filter=${encodeURIComponent('id eq "abc"')}`);
    expect(junk.body.totalResults).toBe(0);

    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const group = await scim('get', `/Groups?filter=${encodeURIComponent(`id eq "${admin.id}"`)}`);
    expect(group.body.totalResults).toBe(1);
    expect((await scim('get', `/Groups?filter=${encodeURIComponent('id eq "zzz"')}`)).body.totalResults).toBe(0);
  });

  it('fetches a single group', async () => {
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const res = await scim('get', `/Groups/${admin.id}`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Administrator');
    expect((await scim('get', '/Groups/not-a-number')).status).toBe(404);
    expect((await scim('get', '/Groups/999999')).status).toBe(404);
  });

  it('honours count=0 on groups too', async () => {
    const res = await scim('get', '/Groups?count=0');
    expect(res.body.Resources).toHaveLength(0);
    expect(res.body.totalResults).toBeGreaterThan(0);
  });

  it('applies a pathless members change instead of silently doing nothing', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const res = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'add', value: { members: [{ value: id }] } }],
    });
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { value: string }) => m.value)).toContain(id);
  });

  it('refuses a members operation carrying no usable ids, rather than reporting success', async () => {
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const res = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'add', path: 'members', value: [] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe('invalidValue');
  });

  it('answers malformed application/json in the SCIM shape too, not only scim+json', async () => {
    const res = await request(app)
      .post(`${SCIM}/Users`)
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
  });

  it('accepts members as bare id strings, not only {value} objects', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get() as { id: number };
    const res = await scim('patch', `/Groups/${admin.id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'add', path: 'members', value: [id] }],
    });
    expect(res.body.members.map((m: { value: string }) => m.value)).toContain(id);
  });

  it('reads a de-provision sent as remove-the-active-attribute', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const res = await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'remove', path: 'active' }],
    });
    expect(res.body.active).toBe(false);
  });

  it('reads a name sent as a nested object', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const res = await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', value: { name: { formatted: 'Grace B. Hopper' } } }],
    });
    expect(res.body.displayName).toBe('Grace B. Hopper');
  });

  it('re-keys a user whose directory id changed, and refuses a collision', async () => {
    const first = (await scim('post', '/Users').send(newUser())).body.id as string;
    const second = (await scim('post', '/Users').send(newUser({ userName: 'ada@acme.test', externalId: 'dir-0002' })))
      .body.id as string;

    const moved = await scim('patch', `/Users/${first}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', value: { externalId: 'dir-0003' } }],
    });
    expect(moved.body.externalId).toBe('dir-0003');

    const collision = await scim('patch', `/Users/${second}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', value: { externalId: 'dir-0003' } }],
    });
    expect(collision.status).toBe(409);
    expect(collision.body.scimType).toBe('uniqueness');
  });

  it('refuses a PUT that would blank the address', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const res = await scim('put', `/Users/${id}`).send({ schemas: [USER_SCHEMA], userName: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe('invalidValue');
  });

  it('treats a no-op update as success without writing to the trail', async () => {
    const id = (await scim('post', '/Users').send(newUser())).body.id as string;
    const before = (db.prepare('SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ?').get(Number(id)) as { n: number }).n;
    const res = await scim('patch', `/Users/${id}`).send({
      schemas: [PATCH],
      Operations: [{ op: 'replace', value: { displayName: '' } }],
    });
    expect(res.status).toBe(200);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ?').get(Number(id)) as { n: number }).n;
    expect(after).toBe(before);
  });
});
