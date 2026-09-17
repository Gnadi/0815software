import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { SignedXml } from 'xml-crypto';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import {
  buildConfig,
  identityFromProfile,
  normalizeCert,
  requestIdCache,
  samlConfigFromEnv,
} from '../server/saml.js';

/**
 * SAML 2.0.
 *
 * These cases exist to justify a dependency. PS-01 verifies JWS on built-in
 * crypto, and the argument for NOT doing the same with XML-DSig is that its
 * failure mode is signature wrapping — an attacker keeps a legitimately signed
 * assertion where a naive verifier will find a valid signature, and puts their
 * own unsigned assertion where the consumer reads the identity. A wrong
 * implementation does not error; it signs the attacker in.
 *
 * So the assertions below are real: signed with a real key by `xml-crypto`,
 * against a committed test certificate. The wrapping case constructs the real
 * attack and requires a 401.
 */

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const IDP_KEY = readFileSync(join(FIXTURES, 'idp-key.pem'), 'utf8');
const IDP_CERT = readFileSync(join(FIXTURES, 'idp-cert.pem'), 'utf8');

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const SELF = 'https://identity.example.com';
const PROVIDER = 'entra';
const SP_ENTITY = `${SELF}/api/saml/${PROVIDER}/metadata`;
const ACS = `${SELF}/api/saml/${PROVIDER}/acs`;
const IDP_ENTITY = 'https://sts.windows.net/test-tenant/';

const env = {
  SAML_ENTRA_ENTRY_POINT: 'https://login.microsoftonline.com/test-tenant/saml2',
  SAML_ENTRA_IDP_CERT: IDP_CERT,
  SAML_ENTRA_IDP_ISSUER: IDP_ENTITY,
};

let db: Database.Database;
let app: Express;

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session, selfBaseUrl: SELF, saml: samlConfigFromEnv(env) });
});

// ── A test IdP ─────────────────────────────────────────────────────────

const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const DIGEST = 'http://www.w3.org/2001/04/xmlenc#sha256';

interface ResponseOptions {
  inResponseTo: string;
  nameId?: string;
  audience?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  attributes?: Record<string, string>;
  issuer?: string;
}

function assertionXml(o: ResponseOptions, assertionId: string): string {
  const now = new Date();
  const notBefore = (o.notBefore ?? new Date(now.getTime() - 60_000)).toISOString();
  const notOnOrAfter = (o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
  const attrs = Object.entries(o.attributes ?? { email: 'ada@customer.example', displayName: 'Ada Lovelace' })
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`,
    )
    .join('');
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>${o.issuer ?? IDP_ENTITY}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? 'ada@customer.example'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" Recipient="${ACS}" NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${o.audience ?? SP_ENTITY}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_session-1">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  );
}

function wrap(assertion: string, inResponseTo: string, responseId = '_resp-1'): string {
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${responseId}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${ACS}" InResponseTo="${inResponseTo}">` +
    `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `${assertion}</samlp:Response>`
  );
}

/** Sign the Assertion in place, the way a real IdP does. */
function signAssertion(xml: string, key = IDP_KEY, assertionId = '_assertion-1'): string {
  const sig = new SignedXml({
    privateKey: key,
    publicCert: IDP_CERT,
    signatureAlgorithm: SIG_ALG,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath: `//*[local-name(.)='Assertion' and @ID='${assertionId}']`,
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
    digestAlgorithm: DIGEST,
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='Assertion' and @ID='${assertionId}']/*[local-name(.)='Issuer']`, action: 'after' },
  });
  return sig.getSignedXml();
}

/** Drive a login and return the RelayState plus the AuthnRequest id. */
async function beginLogin(target = app): Promise<{ relayState: string; requestId: string }> {
  const res = await request(target).get(`/api/saml/${PROVIDER}/login?org_slug=acme`).redirects(0);
  expect(res.status).toBe(302);
  const relayState = new URL(res.headers.location as string).searchParams.get('RelayState')!;
  const row = db.prepare('SELECT id FROM saml_request_ids ORDER BY rowid DESC LIMIT 1').get() as { id: string };
  return { relayState, requestId: row.id };
}

const post = (body: Record<string, string>) =>
  request(app).post(`/api/saml/${PROVIDER}/acs`).type('form').send(body).redirects(0);

const b64 = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');

// ── Configuration ──────────────────────────────────────────────────────

describe('configuration', () => {
  it('declares a provider per SAML_<NAME>_ENTRY_POINT', () => {
    const cfg = samlConfigFromEnv(env);
    expect(Object.keys(cfg)).toEqual(['entra']);
    expect(cfg.entra!.wantAuthnResponseSigned).toBe(false);
    expect(cfg.entra!.idpIssuer).toBe(IDP_ENTITY);
  });

  it('refuses a provider with no IdP certificate — there would be nothing to verify against', () => {
    expect(() => samlConfigFromEnv({ SAML_X_ENTRY_POINT: 'https://idp.example/sso' })).toThrow(/needs SAML_X_IDP_CERT/);
    expect(() =>
      samlConfigFromEnv({ SAML_X_ENTRY_POINT: 'https://idp.example/sso', SAML_X_IDP_CERT: '  ' }),
    ).toThrow(/needs SAML_X_IDP_CERT/);
  });

  it('refuses sha1, which the library would otherwise accept', () => {
    expect(() =>
      samlConfigFromEnv({ ...env, SAML_ENTRA_SIGNATURE_ALGORITHM: 'sha1' } as NodeJS.ProcessEnv),
    ).toThrow(/must be sha256 or sha512/);
  });

  it('accepts a certificate as bare base64, which is how IdP metadata prints it', () => {
    const bare = IDP_CERT.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(normalizeCert(bare)).toContain('-----BEGIN CERTIFICATE-----');
    expect(normalizeCert(bare).replace(/\s+/g, '')).toBe(IDP_CERT.replace(/\s+/g, ''));
    expect(() => normalizeCert('not a certificate!')).toThrow(/neither PEM nor base64/);
    expect(() => normalizeCert('   ')).toThrow(/empty/);
  });

  it('reads several certificates, so a key rollover does not need a restart window', () => {
    const cfg = samlConfigFromEnv({ ...env, SAML_ENTRA_IDP_CERT: `${IDP_CERT}|${IDP_CERT}` });
    expect(cfg.entra!.idpCert).toHaveLength(2);
  });
});

// ── Metadata and the redirect ──────────────────────────────────────────

describe('service provider metadata', () => {
  it('publishes our entity ID and ACS URL for the administrator to upload', async () => {
    const res = await request(app).get(`/api/saml/${PROVIDER}/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain(`entityID="${SP_ENTITY}"`);
    expect(res.text).toContain(ACS);
    expect(res.text).toContain('WantAssertionsSigned="true"');
  });

  it('is a 404 for a provider nobody configured', async () => {
    expect((await request(app).get('/api/saml/nope/metadata')).status).toBe(404);
    expect((await request(app).get('/api/saml/..%2Fadmin/metadata')).status).toBe(404);
  });
});

describe('beginning a login', () => {
  it('redirects to the IdP and records the request id and RelayState', async () => {
    const res = await request(app).get(`/api/saml/${PROVIDER}/login?org_slug=acme`).redirects(0);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe(env.SAML_ENTRA_ENTRY_POINT);
    expect(url.searchParams.get('SAMLRequest')).toBeTruthy();
    expect(url.searchParams.get('RelayState')).toMatch(/^[0-9a-f]{32}$/);
    // The id we must later see echoed back is stored, not held in memory.
    expect((db.prepare('SELECT COUNT(*) AS n FROM saml_request_ids').get() as { n: number }).n).toBe(1);
  });

  it('refuses an unknown org and an off-site redirect target', async () => {
    expect((await request(app).get(`/api/saml/${PROVIDER}/login?org_slug=nope`).redirects(0)).status).toBe(404);
    expect((await request(app).get(`/api/saml/${PROVIDER}/login`).redirects(0)).status).toBe(422);
    expect(
      (
        await request(app)
          .get(`/api/saml/${PROVIDER}/login?org_slug=acme&redirect_uri=https://evil.example/x`)
          .redirects(0)
      ).status,
    ).toBe(422);
  });
});

// ── A valid assertion ──────────────────────────────────────────────────

describe('a validly signed assertion', () => {
  it('signs the user in and provisions them into the right tenant', async () => {
    const { relayState, requestId } = await beginLogin();
    const signed = signAssertion(wrap(assertionXml({ inResponseTo: requestId }, '_assertion-1'), requestId));

    const res = await post({ SAMLResponse: b64(signed), RelayState: relayState });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('ada@customer.example');
    expect(res.body.token).toBeTruthy();

    const acme = db.prepare("SELECT id FROM organizations WHERE slug = 'acme'").get() as { id: number };
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('ada@customer.example') as {
      org_id: number;
      name: string;
    };
    expect(user.org_id).toBe(acme.id);
    expect(user.name).toBe('Ada Lovelace');

    // The token works, and the sign-in is on the trail with its method.
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
    const event = db
      .prepare("SELECT meta FROM auth_events WHERE type = 'login_ok' ORDER BY id DESC LIMIT 1")
      .get() as { meta: string };
    expect(JSON.parse(event.meta).via).toBe(`saml:${PROVIDER}`);
  });

  it('spends the request id, so the same Response cannot be replayed', async () => {
    const { relayState, requestId } = await beginLogin();
    const signed = signAssertion(wrap(assertionXml({ inResponseTo: requestId }, '_assertion-1'), requestId));
    expect((await post({ SAMLResponse: b64(signed), RelayState: relayState })).status).toBe(200);

    // Second time: the RelayState is gone (single use), and so is the id.
    const replay = await post({ SAMLResponse: b64(signed), RelayState: relayState });
    expect(replay.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM saml_request_ids').get() as { n: number }).n).toBe(0);
  });

  it('hands the token to a recorded same-site redirect target', async () => {
    const begin = await request(app)
      .get(`/api/saml/${PROVIDER}/login?org_slug=acme&redirect_uri=/app/landing`)
      .redirects(0);
    const relayState = new URL(begin.headers.location as string).searchParams.get('RelayState')!;
    const requestId = (db.prepare('SELECT id FROM saml_request_ids ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id;
    const signed = signAssertion(wrap(assertionXml({ inResponseTo: requestId }, '_assertion-1'), requestId));

    const res = await post({ SAMLResponse: b64(signed), RelayState: relayState });
    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith('/app/landing?token=')).toBe(true);
    // And that token is a working session rather than a decoration.
    const token = decodeURIComponent(location.split('token=')[1]!);
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('refuses an account an administrator has disabled', async () => {
    const first = await beginLogin();
    const signedFirst = signAssertion(wrap(assertionXml({ inResponseTo: first.requestId }, '_assertion-1'), first.requestId));
    await post({ SAMLResponse: b64(signedFirst), RelayState: first.relayState });
    db.prepare("UPDATE users SET status = 'disabled' WHERE email = ?").run('ada@customer.example');

    const second = await beginLogin();
    const signedSecond = signAssertion(wrap(assertionXml({ inResponseTo: second.requestId }, '_assertion-1'), second.requestId));
    const res = await post({ SAMLResponse: b64(signedSecond), RelayState: second.relayState });
    expect(res.status).toBe(403);
  });
});

// ── Assertions that must be refused ────────────────────────────────────

describe('an assertion that must be refused', () => {
  const expectRejected = async (xml: string, relayState: string): Promise<void> => {
    const res = await post({ SAMLResponse: b64(xml), RelayState: relayState });
    expect(res.status).toBe(401);
    // Nothing was provisioned on the way to refusing.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%customer.example'").get() as { n: number }).n,
    ).toBe(0);
  };

  it('rejects an unsigned assertion', async () => {
    const { relayState, requestId } = await beginLogin();
    await expectRejected(wrap(assertionXml({ inResponseTo: requestId }, '_assertion-1'), requestId), relayState);
  });

  it('rejects one signed by a key that is not the IdP’s', async () => {
    const { relayState, requestId } = await beginLogin();
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = other.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const signed = signAssertion(wrap(assertionXml({ inResponseTo: requestId }, '_assertion-1'), requestId), key);
    await expectRejected(signed, relayState);
  });

  it('rejects a SIGNATURE-WRAPPED response — the attack this dependency exists for', async () => {
    const { relayState, requestId } = await beginLogin();

    // A genuine, correctly signed assertion for the real user.
    const legitimate = signAssertion(
      wrap(assertionXml({ inResponseTo: requestId, nameId: 'ada@customer.example' }, '_assertion-1'), requestId),
    );

    // The attack: keep that signed assertion inside the Response — its
    // signature still verifies wherever a verifier looks for one — and add a
    // second, UNSIGNED assertion naming somebody else. A verifier that checks
    // "is there a valid signature somewhere" and then reads "the assertion"
    // authenticates the attacker. Both orderings are tried, because which
    // element a naive parser reads depends on which one it finds first.
    const forged = assertionXml(
      { inResponseTo: requestId, nameId: 'owner@acme.test', attributes: { email: 'owner@acme.test' } },
      '_assertion-evil',
    );
    const signedAssertionOnly = legitimate.slice(
      legitimate.indexOf('<saml:Assertion'),
      legitimate.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length,
    );

    for (const body of [
      wrap(`${signedAssertionOnly}${forged}`, requestId),
      wrap(`${forged}${signedAssertionOnly}`, requestId),
    ]) {
      const res = await post({ SAMLResponse: b64(body), RelayState: relayState });
      expect([400, 401]).toContain(res.status);
      // Above all: nobody was signed in as the Owner.
      const owner = db.prepare("SELECT token_version FROM users WHERE email = 'owner@acme.test'").get() as {
        token_version: number;
      };
      expect(owner.token_version).toBe(1);
    }
  });

  it('rejects an assertion addressed to a different audience', async () => {
    const { relayState, requestId } = await beginLogin();
    const signed = signAssertion(
      wrap(assertionXml({ inResponseTo: requestId, audience: 'https://someone-else.example/sp' }, '_assertion-1'), requestId),
    );
    await expectRejected(signed, relayState);
  });

  it('rejects an assertion whose conditions window has closed', async () => {
    const { relayState, requestId } = await beginLogin();
    const past = new Date(Date.now() - 60 * 60_000);
    const signed = signAssertion(
      wrap(
        assertionXml(
          { inResponseTo: requestId, notBefore: new Date(past.getTime() - 60_000), notOnOrAfter: past },
          '_assertion-1',
        ),
        requestId,
      ),
    );
    await expectRejected(signed, relayState);
  });

  it('rejects an assertion from an issuer that is not the configured IdP', async () => {
    const { relayState, requestId } = await beginLogin();
    const signed = signAssertion(
      wrap(assertionXml({ inResponseTo: requestId, issuer: 'https://attacker.example/idp' }, '_assertion-1'), requestId),
    );
    await expectRejected(signed, relayState);
  });

  it('rejects a Response answering a request we never sent', async () => {
    const { relayState } = await beginLogin();
    const signed = signAssertion(wrap(assertionXml({ inResponseTo: '_never-issued' }, '_assertion-1'), '_never-issued'));
    await expectRejected(signed, relayState);
  });

  it('rejects a missing or unknown RelayState before doing any crypto', async () => {
    const { requestId } = await beginLogin();
    const signed = b64(signAssertion(wrap(assertionXml({ inResponseTo: requestId }, '_assertion-1'), requestId)));
    expect((await post({ SAMLResponse: signed })).status).toBe(400);
    expect((await post({ SAMLResponse: signed, RelayState: 'made-up' })).status).toBe(400);
  });

  it('rejects a POST with no SAMLResponse at all', async () => {
    const { relayState } = await beginLogin();
    expect((await post({ RelayState: relayState })).status).toBe(422);
    expect((await post({ SAMLResponse: '', RelayState: relayState })).status).toBe(422);
  });

  it('rejects base64 that is not a SAML Response', async () => {
    const { relayState } = await beginLogin();
    expect((await post({ SAMLResponse: b64('<nonsense/>'), RelayState: relayState })).status).toBe(401);
  });
});

// ── Attribute mapping ──────────────────────────────────────────────────

describe('reading an identity out of a validated assertion', () => {
  const cfg = samlConfigFromEnv(env).entra!;

  it('prefers a mapped attribute over the NameID', () => {
    const identity = identityFromProfile(
      {
        nameID: 'AAABBB-opaque-id',
        nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        issuer: IDP_ENTITY,
        email: 'ada@corp.test',
        displayName: 'Ada L',
      },
      cfg,
    );
    // The opaque NameID stays the subject — a rename must not create a new person.
    expect(identity).toEqual({ email: 'ada@corp.test', name: 'Ada L', subject: 'AAABBB-opaque-id' });
  });

  it('falls back to an emailAddress NameID when no attribute carries one', () => {
    const identity = identityFromProfile(
      {
        nameID: 'ada@corp.test',
        nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        issuer: IDP_ENTITY,
      },
      cfg,
    );
    expect(identity).toEqual({ email: 'ada@corp.test', name: 'ada@corp.test', subject: 'ada@corp.test' });
  });

  it('refuses to invent an address from an opaque NameID', () => {
    expect(() =>
      identityFromProfile(
        { nameID: 'AAABBB', nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', issuer: IDP_ENTITY },
        cfg,
      ),
    ).toThrow(/carried no email address/);
  });

  it('reads the Microsoft claim URIs, which is what Entra sends by default', () => {
    const identity = identityFromProfile(
      {
        nameID: 'x',
        nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        issuer: IDP_ENTITY,
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'ada@corp.test',
        'http://schemas.microsoft.com/identity/claims/displayname': 'Ada L',
      },
      cfg,
    );
    expect(identity.email).toBe('ada@corp.test');
    expect(identity.name).toBe('Ada L');
  });

  it('takes the first value when an attribute arrives as a list', () => {
    const identity = identityFromProfile(
      {
        nameID: 'x',
        nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        issuer: IDP_ENTITY,
        email: ['ada@corp.test', 'second@corp.test'] as unknown as string,
      },
      cfg,
    );
    expect(identity.email).toBe('ada@corp.test');
  });
});

// ── The optional settings, and the pieces around the library ───────────

describe('optional provider settings', () => {
  it('carries an SP key, certificate and decryption key through to the library', () => {
    const cfg = samlConfigFromEnv({
      ...env,
      SAML_ENTRA_ISSUER: 'urn:0815software:ps-01',
      SAML_ENTRA_PRIVATE_KEY: IDP_KEY,
      SAML_ENTRA_SP_CERT: IDP_CERT,
      SAML_ENTRA_DECRYPTION_KEY: IDP_KEY,
      SAML_ENTRA_SIGNATURE_ALGORITHM: 'sha512',
      SAML_ENTRA_WANT_RESPONSE_SIGNED: 'true',
      SAML_ENTRA_EMAIL_ATTRIBUTES: 'urn:custom:mail , upn',
      SAML_ENTRA_NAME_ATTRIBUTES: 'fullName',
    })!.entra!;

    expect(cfg.issuer).toBe('urn:0815software:ps-01');
    expect(cfg.signatureAlgorithm).toBe('sha512');
    expect(cfg.wantAuthnResponseSigned).toBe(true);
    expect(cfg.emailAttributes).toEqual(['urn:custom:mail', 'upn']);
    expect(cfg.nameAttributes).toEqual(['fullName']);

    const built = buildConfig(cfg, PROVIDER, SELF, requestIdCache(db, Date.now));
    expect(built.privateKey).toBe(IDP_KEY);
    expect(built.publicCert).toBe(IDP_CERT);
    expect(built.decryptionPvk).toBe(IDP_KEY);
    expect(built.audience).toBe('urn:0815software:ps-01');
    expect(built.idpIssuer).toBe(IDP_ENTITY);
    // Not negotiable, whatever the environment says.
    expect(built.wantAssertionsSigned).toBe(true);
    expect(built.validateInResponseTo).toBe('always');
  });

  it('only turns response signing on for the literal "true"', () => {
    expect(samlConfigFromEnv({ ...env, SAML_ENTRA_WANT_RESPONSE_SIGNED: 'yes' }).entra!.wantAuthnResponseSigned).toBe(
      false,
    );
  });

  it('says which provider a broken certificate belongs to', () => {
    expect(() => samlConfigFromEnv({ ...env, SAML_ENTRA_IDP_CERT: 'nonsense!!' })).toThrow(
      /SAML provider "entra".*unreadable/s,
    );
  });

  it('defaults the SP entity ID to its own metadata URL', () => {
    const built = buildConfig(samlConfigFromEnv(env).entra!, PROVIDER, SELF, requestIdCache(db, Date.now));
    expect(built.issuer).toBe(SP_ENTITY);
    expect(built.audience).toBe(SP_ENTITY);
    expect(built.callbackUrl).toBe(ACS);
  });
});

describe('the request-id cache', () => {
  it('stores an id once and refuses a duplicate', async () => {
    const cache = requestIdCache(db, Date.now);
    expect(await cache.saveAsync('_id-1', 'v')).not.toBeNull();
    // A second save of the same id must not overwrite: that is the replay.
    expect(await cache.saveAsync('_id-1', 'v2')).toBeNull();
    expect(await cache.getAsync('_id-1')).toBe('v');
  });

  it('spends an id on removal and reports an unknown one honestly', async () => {
    const cache = requestIdCache(db, Date.now);
    await cache.saveAsync('_id-1', 'v');
    expect(await cache.removeAsync('_id-1')).toBe('_id-1');
    expect(await cache.removeAsync('_id-1')).toBeNull();
    expect(await cache.removeAsync(null)).toBeNull();
    expect(await cache.getAsync('_id-1')).toBeNull();
  });

  it('prunes ids older than the TTL, so an abandoned login cannot accumulate', async () => {
    let clock = Date.parse('2026-09-17T10:00:00Z');
    const cache = requestIdCache(db, () => clock);
    await cache.saveAsync('_old', 'v');
    clock += 11 * 60_000;
    expect(await cache.getAsync('_old')).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM saml_request_ids').get() as { n: number }).n).toBe(0);
  });
});
