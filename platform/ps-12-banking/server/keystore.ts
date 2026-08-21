import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateRsaKeyPair, publicKeyDigest, publicKeyParts, type EsVersion } from './ebics/crypto.js';
import { selfSignedCertificate } from './ebics/x509.js';

/**
 * The key store — the most sensitive thing in this repository.
 *
 * At signature class E the electronic-signature key is sufficient to move
 * money: whoever holds it can sign a payment file the bank will execute. That
 * single fact drives every rule in this file.
 *
 * 1. **Private keys are encrypted at rest** with AES-256-GCM under
 *    `EBICS_KEY_SECRET` (the scheme PS-05 uses for OAuth credentials, copied in
 *    rather than shared, per the repo's copy-in convention). The plaintext is
 *    never written to disk.
 * 2. **Private keys never leave the service.** `publicRecord` is what every API
 *    response and every log line gets; there is deliberately no function here
 *    that returns a private PEM to a caller outside `server/`.
 * 3. **A rotated secret fails loudly at boot**, not quietly at the first
 *    payment. `assertKeyStoreReadable` decrypts one stored key on startup and
 *    refuses to run if it cannot — because `deploy/provision.mjs` generates a
 *    fresh random value for every declared secret on every provision, so a
 *    re-provision of an existing stack WILL rotate this one. Recovering means
 *    restoring the old secret; without it the bank connection is dead and has
 *    to be re-initialised on paper, which takes days.
 */

export class KeyStoreError extends Error {}

/** Parse and validate the 32-byte key; throws (fail-fast) on a bad one. */
export function loadKeySecret(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new KeyStoreError('EBICS_KEY_SECRET must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/** `<iv hex>:<auth tag hex>:<ciphertext hex>` — the shape PS-05 stores too. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(key: Buffer, blob: string): string {
  const [ivHex, tagHex, dataHex] = blob.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new KeyStoreError('malformed ciphertext in the key store');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** What each key pair is FOR. Confusing these is the classic EBICS bug. */
export type KeyPurpose = 'ES' | 'AUTH' | 'ENC';

/** What a caller outside this service is ever allowed to see about a key. */
export interface PublicKeyRecord {
  purpose: KeyPurpose;
  /** "A005", "A006", "X002" or "E002". */
  version: string;
  /** Base64 SHA-256 — the value on the INI letter. */
  digest: string;
  /** The same digest grouped for a human to read off a page. */
  digestFormatted: string;
  created_at: string;
}

interface KeyRow {
  purpose: KeyPurpose;
  version: string;
  private_pem_enc: string;
  public_pem: string;
  digest: string;
  created_at: string;
}

/**
 * Generate the three key pairs for a connection, in one transaction.
 *
 * Once only: a second call would orphan keys the bank has already been told
 * about, and there is no way to notice from inside this service that it
 * happened. Rotation is a different operation with its own INI letter, and it
 * is deliberately not this function.
 */
export function generateSubscriberKeys(
  db: Database.Database,
  params: {
    connectionId: number;
    keySecret: Buffer;
    esVersion?: EsVersion;
    now: string;
    /** Goes into the certificate's subject — the EBICS ids, nothing invented. */
    subject: { partnerId: string; userId: string };
  },
): PublicKeyRecord[] {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM subscriber_keys WHERE connection_id = ? AND retired_at IS NULL')
    .get(params.connectionId) as { n: number };
  if (existing.n > 0) {
    throw new KeyStoreError('this connection already has keys — generating new ones would orphan the bank’s copy');
  }

  const esVersion = params.esVersion ?? 'A005';
  const specs: { purpose: KeyPurpose; version: string }[] = [
    { purpose: 'ES', version: esVersion },
    { purpose: 'AUTH', version: 'X002' },
    { purpose: 'ENC', version: 'E002' },
  ];

  const insert = db.prepare(
    `INSERT INTO subscriber_keys
       (connection_id, purpose, version, private_pem_enc, public_pem, certificate_pem,
        modulus, exponent, digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const notBefore = new Date(params.now);
  // Ten years. EBICS subscriber certificates are self-signed containers, not
  // trust anchors — the INI letter is what binds a key to a customer — so a
  // short life buys nothing and an expiry mid-relationship costs a re-run of
  // the whole paper exchange.
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);

  return db.transaction((): PublicKeyRecord[] =>
    specs.map((spec) => {
      const pair = generateRsaKeyPair();
      const { modulus, exponent } = publicKeyParts(pair.publicPem);
      const digest = publicKeyDigest(pair.publicPem).toString('base64');
      const certificatePem = selfSignedCertificate({
        privatePem: pair.privatePem,
        purpose: spec.purpose,
        subject: { commonName: params.subject.userId, organizationName: params.subject.partnerId },
        notBefore,
        notAfter,
        serial: randomBytes(16),
      });
      insert.run(
        params.connectionId,
        spec.purpose,
        spec.version,
        encryptSecret(params.keySecret, pair.privatePem),
        pair.publicPem,
        certificatePem,
        modulus.toString('base64'),
        exponent.toString('base64'),
        digest,
        params.now,
      );
      return {
        purpose: spec.purpose,
        version: spec.version,
        digest,
        digestFormatted: formatForLetter(digest),
        created_at: params.now,
      };
    }),
  )();
}

/** Group a base64 digest as hex, the way a bank prints it on its letter. */
export function formatForLetter(base64Digest: string): string {
  const hex = Buffer.from(base64Digest, 'base64').toString('hex').toUpperCase();
  return (hex.match(/.{1,8}/g) ?? []).join(' ');
}

/**
 * The private PEM for one purpose.
 *
 * Internal to `server/`, and the only door to plaintext key material. It takes
 * the purpose rather than a key id so that a caller cannot accidentally sign an
 * order with the authentication key: the type is the safety rail.
 */
export function privatePemFor(
  db: Database.Database,
  params: { connectionId: number; purpose: KeyPurpose; keySecret: Buffer },
): { pem: string; version: string } {
  const row = db
    .prepare(
      'SELECT * FROM subscriber_keys WHERE connection_id = ? AND purpose = ? AND retired_at IS NULL',
    )
    .get(params.connectionId, params.purpose) as KeyRow | undefined;
  if (row === undefined) {
    throw new KeyStoreError(`this connection has no ${params.purpose} key — generate keys first`);
  }
  return { pem: decryptSecret(params.keySecret, row.private_pem_enc), version: row.version };
}

/**
 * The X.509 certificate for one purpose.
 *
 * EBICS 3.0 sends keys only as certificates, so INI and HIA read from here.
 * Empty for a connection whose keys predate migration 4: those cannot produce
 * a valid H005 key exchange and have to be re-initialised with the bank.
 */
export function certificatePemFor(
  db: Database.Database,
  params: { connectionId: number; purpose: KeyPurpose },
): string {
  const row = db
    .prepare(
      'SELECT certificate_pem FROM subscriber_keys WHERE connection_id = ? AND purpose = ? AND retired_at IS NULL',
    )
    .get(params.connectionId, params.purpose) as { certificate_pem: string | null } | undefined;
  if (row === undefined) throw new KeyStoreError(`this connection has no ${params.purpose} key`);
  if (row.certificate_pem === null || row.certificate_pem === '') {
    throw new KeyStoreError(
      `this connection's ${params.purpose} key has no X.509 certificate. It was generated before EBICS 3.0 ` +
        'certificate support existed; generate a new connection and re-initialise with the bank on paper.',
    );
  }
  return row.certificate_pem;
}

/** The public PEM for one purpose — safe to hand around inside the service. */
export function publicPemFor(
  db: Database.Database,
  params: { connectionId: number; purpose: KeyPurpose },
): string {
  const row = db
    .prepare('SELECT public_pem FROM subscriber_keys WHERE connection_id = ? AND purpose = ? AND retired_at IS NULL')
    .get(params.connectionId, params.purpose) as { public_pem: string } | undefined;
  if (row === undefined) throw new KeyStoreError(`this connection has no ${params.purpose} key`);
  return row.public_pem;
}

/** What the API may show: versions and digests, never key material. */
export function publicRecords(db: Database.Database, connectionId: number): PublicKeyRecord[] {
  const rows = db
    .prepare(
      `SELECT purpose, version, digest, created_at FROM subscriber_keys
       WHERE connection_id = ? AND retired_at IS NULL ORDER BY purpose`,
    )
    .all(connectionId) as Pick<KeyRow, 'purpose' | 'version' | 'digest' | 'created_at'>[];
  return rows.map((row) => ({ ...row, digestFormatted: formatForLetter(row.digest) }));
}

/**
 * Prove at boot that the configured secret still opens the store.
 *
 * An empty store passes — a fresh installation has nothing to check. One
 * undecryptable key fails the whole boot, because the alternative is a service
 * that looks healthy, accepts a payment run, and only discovers at signing time
 * that it cannot reach its own key.
 */
export function assertKeyStoreReadable(db: Database.Database, keySecret: Buffer): void {
  const row = db
    .prepare('SELECT connection_id, purpose, private_pem_enc FROM subscriber_keys WHERE retired_at IS NULL LIMIT 1')
    .get() as { connection_id: number; purpose: string; private_pem_enc: string } | undefined;
  if (row === undefined) return;

  try {
    decryptSecret(keySecret, row.private_pem_enc);
  } catch {
    throw new KeyStoreError(
      'EBICS_KEY_SECRET does not decrypt the stored keys. It was probably rotated — a re-provision ' +
        'generates a fresh value for every secret. Restore the previous EBICS_KEY_SECRET; without it ' +
        'the bank connections must be re-initialised with the bank on paper.',
    );
  }
}
