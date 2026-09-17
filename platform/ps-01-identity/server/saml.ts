import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CacheItem, CacheProvider, Profile, SamlConfig } from '@node-saml/node-saml';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import type { ResolvedIdentity } from './oauth.js';

/**
 * SAML 2.0 service provider.
 *
 * **This module is the reason PS-01 has a third runtime dependency**, and that
 * is worth stating plainly because the rest of the service is built on Node's
 * `crypto` alone.
 *
 * The security of SAML rests entirely on XML Digital Signature, and XML-DSig is
 * the one primitive here that should not be hand-rolled. Verifying it correctly
 * means exclusive canonicalisation with its namespace rules, digest checking,
 * and — the part that actually bites — defending against signature wrapping,
 * where an attacker keeps the legitimately signed assertion somewhere the
 * parser will still find a valid signature for it, and puts their own unsigned
 * assertion where the consumer will read it. That class of bug has produced a
 * long line of CVEs in libraries maintained by people who do nothing else, and
 * it fails OPEN: a wrong implementation authenticates the attacker rather than
 * erroring. `@node-saml/node-saml` (MIT) is the maintained implementation, and
 * taking it is the cheaper of two risks.
 *
 * The obvious objection is PS-12, which implements exclusive canonicalisation
 * and XML-DSig itself and takes no dependency for it. The difference is the
 * direction. PS-12 SIGNS, with its own key, over a document it composed: there
 * is no adversary choosing the input, and a bug there produces a signature the
 * bank rejects — it fails closed, loudly, against one counterparty. Here we
 * VERIFY a document an attacker writes in full, and a bug hands them a session.
 * Those are not the same job, and only one of them is safe to hand-roll.
 *
 * OIDC needs no such dependency — a JWS is three base64url segments and one
 * signature check, which `server/oidc.ts` does on built-in crypto. Prefer OIDC
 * where the customer's IdP offers it; this exists for the ones that do not,
 * which in practice means older enterprise deployments and public-sector
 * federations.
 *
 * The library is imported lazily, so a deployment that never configures a SAML
 * provider does not load it, and an install that somehow lacks it still boots
 * with every other route working.
 */

/** Same shape rule as OAuth provider names: a path segment and an env infix. */
export const SAML_PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isSamlProvider(v: string): boolean {
  return SAML_PROVIDER_NAME_RE.test(v);
}

/** How long an unanswered AuthnRequest id stays redeemable. */
export const REQUEST_ID_TTL_MS = 10 * 60_000;

export interface SamlProviderConfig {
  /** The IdP's SSO endpoint (HTTP-Redirect binding). */
  entryPoint: string;
  /** The IdP's signing certificate(s), PEM or bare base64. */
  idpCert: string[];
  /** Our SP entity ID. Defaults to this service's metadata URL. */
  issuer?: string;
  /** The IdP's entity ID, verified against the Response Issuer when set. */
  idpIssuer?: string;
  identifierFormat: string | null;
  signatureAlgorithm: 'sha256' | 'sha512';
  /** Optional SP key/cert, to sign our AuthnRequests and decrypt assertions. */
  privateKey?: string;
  publicCert?: string;
  decryptionPvk?: string;
  /**
   * Require the whole Response to be signed, not just the assertion. Off by
   * default because Entra ID and several others sign only the assertion, which
   * is the signature that matters. The assertion signature is NOT optional and
   * is not configurable — see `buildConfig`.
   */
  wantAuthnResponseSigned: boolean;
  /** Attribute names to read the address and display name from, in order. */
  emailAttributes: string[];
  nameAttributes: string[];
}

export type SamlConfigMap = Record<string, SamlProviderConfig | undefined>;

const DEFAULT_EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];
const DEFAULT_NAME_ATTRIBUTES = [
  'displayName',
  'cn',
  'name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
];

/** Normalise a certificate: accept PEM, or bare base64 as IdP metadata gives it. */
export function normalizeCert(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN CERTIFICATE')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  if (body === '') throw new Error('certificate is empty');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('certificate is neither PEM nor base64');
  const wrapped = body.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

const splitList = (raw: string | undefined, fallback: string[]): string[] => {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
};

/**
 * Read SAML providers from the environment.
 *
 * Mirrors `oauthConfigFromEnv`: every `SAML_<NAME>_ENTRY_POINT` declares a
 * provider called `<name>`, served at `/api/saml/<name>/login`.
 */
export function samlConfigFromEnv(env: NodeJS.ProcessEnv): SamlConfigMap {
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    const m = /^SAML_([A-Z0-9][A-Z0-9_]*)_ENTRY_POINT$/.exec(key);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (isSamlProvider(name)) names.add(name);
  }

  const config: SamlConfigMap = {};
  for (const provider of [...names].sort()) {
    const up = provider.toUpperCase();
    const entryPoint = env[`SAML_${up}_ENTRY_POINT`];
    if (!entryPoint) continue;
    const rawCerts = env[`SAML_${up}_IDP_CERT`];
    if (!rawCerts || rawCerts.trim() === '') {
      // Without the IdP's certificate there is nothing to verify a signature
      // against, and an SP that cannot verify signatures is an open door.
      throw new Error(`SAML provider "${provider}" needs SAML_${up}_IDP_CERT (the IdP's signing certificate)`);
    }
    let idpCert: string[];
    try {
      idpCert = rawCerts
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .map(normalizeCert);
    } catch (err) {
      throw new Error(`SAML provider "${provider}": SAML_${up}_IDP_CERT is unreadable — ${(err as Error).message}`);
    }
    if (idpCert.length === 0) throw new Error(`SAML provider "${provider}" needs SAML_${up}_IDP_CERT`);

    const algorithm = env[`SAML_${up}_SIGNATURE_ALGORITHM`] ?? 'sha256';
    if (algorithm !== 'sha256' && algorithm !== 'sha512') {
      // sha1 is accepted by the library and by plenty of old IdPs. It is not
      // accepted here: a signature algorithm nobody should still be using is
      // not something to leave one environment variable away.
      throw new Error(
        `SAML provider "${provider}": SAML_${up}_SIGNATURE_ALGORITHM must be sha256 or sha512 — got "${algorithm}"`,
      );
    }

    const entry: SamlProviderConfig = {
      entryPoint,
      idpCert,
      identifierFormat:
        env[`SAML_${up}_IDENTIFIER_FORMAT`] ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      signatureAlgorithm: algorithm,
      wantAuthnResponseSigned: env[`SAML_${up}_WANT_RESPONSE_SIGNED`] === 'true',
      emailAttributes: splitList(env[`SAML_${up}_EMAIL_ATTRIBUTES`], DEFAULT_EMAIL_ATTRIBUTES),
      nameAttributes: splitList(env[`SAML_${up}_NAME_ATTRIBUTES`], DEFAULT_NAME_ATTRIBUTES),
    };
    const issuer = env[`SAML_${up}_ISSUER`];
    if (issuer) entry.issuer = issuer;
    const idpIssuer = env[`SAML_${up}_IDP_ISSUER`];
    if (idpIssuer) entry.idpIssuer = idpIssuer;
    const privateKey = env[`SAML_${up}_PRIVATE_KEY`];
    if (privateKey) entry.privateKey = privateKey;
    const publicCert = env[`SAML_${up}_SP_CERT`];
    if (publicCert) entry.publicCert = publicCert;
    const decryptionPvk = env[`SAML_${up}_DECRYPTION_KEY`];
    if (decryptionPvk) entry.decryptionPvk = decryptionPvk;

    config[provider] = entry;
  }
  return config;
}

/**
 * A `CacheProvider` over SQLite, for the InResponseTo check.
 *
 * node-saml ships an in-memory one. That would mean every login in flight
 * breaks on restart, and an operator who hits that will reach for
 * `validateInResponseTo: never` — turning off SAML's only replay defence to
 * make deploys quieter. A table costs nothing and removes the temptation.
 */
export function requestIdCache(db: Database.Database, now: () => number): CacheProvider {
  const prune = (): void => {
    db.prepare('DELETE FROM saml_request_ids WHERE created_at < ?').run(nowIso(now() - REQUEST_ID_TTL_MS));
  };
  return {
    saveAsync(key: string, value: string): Promise<CacheItem | null> {
      prune();
      const existing = db.prepare('SELECT 1 FROM saml_request_ids WHERE id = ?').get(key);
      if (existing) return Promise.resolve(null);
      const createdAt = now();
      db.prepare('INSERT INTO saml_request_ids (id, value, created_at) VALUES (?, ?, ?)').run(
        key,
        value,
        nowIso(createdAt),
      );
      return Promise.resolve({ value, createdAt });
    },
    getAsync(key: string): Promise<string | null> {
      prune();
      const row = db.prepare('SELECT value FROM saml_request_ids WHERE id = ?').get(key) as
        | { value: string }
        | undefined;
      return Promise.resolve(row?.value ?? null);
    },
    removeAsync(key: string | null): Promise<string | null> {
      if (key === null) return Promise.resolve(null);
      const info = db.prepare('DELETE FROM saml_request_ids WHERE id = ?').run(key);
      return Promise.resolve(info.changes > 0 ? key : null);
    },
  };
}

/** The SP entity ID for a provider, defaulting to its metadata URL. */
export function spIssuer(cfg: SamlProviderConfig, provider: string, selfBaseUrl: string): string {
  return cfg.issuer ?? `${selfBaseUrl}/api/saml/${provider}/metadata`;
}

export function acsUrl(provider: string, selfBaseUrl: string): string {
  return `${selfBaseUrl}/api/saml/${provider}/acs`;
}

/**
 * Translate our config into node-saml's, pinning the parts that are security
 * decisions rather than preferences.
 */
export function buildConfig(
  cfg: SamlProviderConfig,
  provider: string,
  selfBaseUrl: string,
  cache: CacheProvider,
): SamlConfig {
  const issuer = spIssuer(cfg, provider, selfBaseUrl);
  const config: SamlConfig = {
    callbackUrl: acsUrl(provider, selfBaseUrl),
    entryPoint: cfg.entryPoint,
    issuer,
    idpCert: cfg.idpCert,
    identifierFormat: cfg.identifierFormat,
    signatureAlgorithm: cfg.signatureAlgorithm,
    digestAlgorithm: cfg.signatureAlgorithm,

    // ── The settings that are not preferences ──
    // An unsigned assertion is not an assertion. Deliberately not configurable.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: cfg.wantAuthnResponseSigned,
    // The Response must name an AuthnRequest WE sent, and each id is spent on
    // one Response — this is the replay defence, backed by the table above.
    validateInResponseTo: 'always' as SamlConfig['validateInResponseTo'],
    cacheProvider: cache,
    requestIdExpirationPeriodMs: REQUEST_ID_TTL_MS,
    // An assertion addressed to somebody else is not addressed to us.
    audience: issuer,
    // Same tolerance the OIDC path allows for a clock out of step.
    acceptedClockSkewMs: 120_000,
  };
  if (cfg.idpIssuer) config.idpIssuer = cfg.idpIssuer;
  if (cfg.privateKey) config.privateKey = cfg.privateKey;
  if (cfg.publicCert) config.publicCert = cfg.publicCert;
  if (cfg.decryptionPvk) config.decryptionPvk = cfg.decryptionPvk;
  return config;
}

/**
 * The library, loaded on first use.
 *
 * Deliberately lazy: it pulls in a whole XML stack (xml-crypto, xmldom, xpath),
 * and a deployment that configures no SAML provider — which is most of them —
 * never loads any of it. A failed import here means a broken install, so it is
 * left to propagate rather than dressed up as a configuration error.
 */
type SamlModule = typeof import('@node-saml/node-saml');
let cachedModule: Promise<SamlModule> | null = null;

export function loadSamlModule(): Promise<SamlModule> {
  cachedModule ??= import('@node-saml/node-saml');
  return cachedModule;
}

export interface SamlInstance {
  getAuthorizeUrlAsync(relayState: string, host: string | undefined, options: Record<string, never>): Promise<string>;
  validatePostResponseAsync(container: Record<string, string>): Promise<{ profile: Profile | null; loggedOut: boolean }>;
  generateServiceProviderMetadata(decryptionCert: string | null, publicCerts?: string | string[] | null): string;
}

export async function createSaml(
  cfg: SamlProviderConfig,
  provider: string,
  selfBaseUrl: string,
  cache: CacheProvider,
): Promise<SamlInstance> {
  const { SAML } = await loadSamlModule();
  return new SAML(buildConfig(cfg, provider, selfBaseUrl, cache)) as unknown as SamlInstance;
}

/**
 * Read an identity out of a validated assertion.
 *
 * By the time this runs the signature, the audience, the conditions window and
 * the InResponseTo have all been checked by the library — this is only the
 * mapping, and it is where IdPs differ most. The address is looked for in the
 * configured attributes first and the NameID last, because a NameID is only an
 * address when its format says so.
 */
export function identityFromProfile(profile: Profile, cfg: SamlProviderConfig): ResolvedIdentity {
  // The library's own `idpIssuer` option is enforced for LogoutRequest and
  // LogoutResponse only — `verifyIssuer` is never called on an authentication
  // Response (node-saml 5.1.0, lib/saml.js). Configuring it and assuming it
  // applied would mean documenting a check that does not run, so the check is
  // made here, against the issuer node-saml read out of the SIGNED assertion.
  //
  // The signature is still the real authority, and this is defence in depth:
  // it matters where one certificate serves several issuers, which is the
  // shape of a multi-tenant or federated IdP.
  if (cfg.idpIssuer && profile.issuer !== cfg.idpIssuer) {
    throw new DomainError(
      401,
      `The assertion came from an unexpected issuer: expected ${cfg.idpIssuer}, got ${profile.issuer || '(none)'}`,
    );
  }

  const attribute = (names: readonly string[]): string => {
    for (const key of names) {
      const raw = profile[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
  };

  const nameId = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';
  const nameIdIsEmail =
    typeof profile.nameIDFormat === 'string' && profile.nameIDFormat.endsWith('nameid-format:emailAddress');

  const email = attribute(cfg.emailAttributes) || (nameIdIsEmail ? nameId : '');
  if (!email) {
    throw new DomainError(
      422,
      'The SAML assertion carried no email address — map one into an attribute, or use an emailAddress NameID',
    );
  }
  // The NameID is the stable identifier the IdP promises; fall back to the
  // address only when there is none, so a rename does not create a new person.
  const subject = nameId || email;
  return { email, name: attribute(cfg.nameAttributes) || email, subject };
}

/** A fresh RelayState nonce. */
export function newRelayState(): string {
  return randomBytes(16).toString('hex');
}
