import type Database from 'better-sqlite3';
import { Page, buildPdf, A4 } from './pdf.js';
import { formatForLetter, publicPemFor, publicRecords } from './keystore.js';
import { publicKeyParts } from './ebics/crypto.js';
import { connectionDetail } from './connections.js';
import { DomainError } from './errors.js';
import type { ConnectionDetail } from '../shared/types.js';

/**
 * The INI and HIA letters.
 *
 * This is the piece of paper the whole security model rests on, so it is worth
 * being blunt about why it exists. INI and HIA are **unsecured** EBICS
 * messages: the bank has no key of ours to verify them against, so anyone who
 * can reach the bank's endpoint can send a subscriber's ids and their own
 * public keys. What stops that is entirely out of band — a printed letter
 * carrying the key digests, signed by hand by someone the bank has a specimen
 * signature for, and posted. The bank compares the digests on the paper with
 * the ones it received electronically, and only then switches the subscriber on.
 *
 * Two letters, because they are two different acts:
 *
 * - **INI** carries the electronic-signature key (A005/A006) — the key that
 *   authorises payments. This is the one that matters.
 * - **HIA** carries the identification and encryption keys (X002, E002).
 *
 * They are rendered as one PDF, two pages, because they go in one envelope.
 *
 * The hash printed here is the EBICS public-key digest: SHA-256 over the ASCII
 * string `"<exponent hex> <modulus hex>"`, lower case, leading zeros trimmed —
 * **not** over the DER or the PEM. An implementation that hashes the wrong
 * thing produces a plausible value that never matches the bank's own, and the
 * only symptom is a bank that will not activate the subscriber.
 */

const M = 56;
const R = A4.width - M;

/** Hex, upper case, in groups a human can read off a page without losing place. */
function hexBlock(data: Buffer): string[] {
  const hex = data.toString('hex').toUpperCase();
  const groups = hex.match(/.{1,2}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 16) lines.push(groups.slice(i, i + 16).join(' '));
  return lines;
}

interface LetterKey {
  /** "A005", "X002", "E002". */
  version: string;
  /** What the key is for, in words the reader can check against the form. */
  label: string;
  modulus: Buffer;
  exponent: Buffer;
  digestFormatted: string;
}

export interface LetterInput {
  connection: Pick<ConnectionDetail, 'display_name' | 'host_id' | 'partner_id' | 'user_id' | 'ebics_version'>;
  keys: LetterKey[];
  /** The letter's own date — passed in, so the output is reproducible. */
  date: string;
}

function heading(page: Page, title: string, subtitle: string): number {
  page.text('F2', 16, M, 70, title);
  page.text('F1', 9, M, 88, subtitle, 0.35);
  page.line(M, 100, R, 0.7, 0.3);
  return 128;
}

function field(page: Page, y: number, label: string, value: string): number {
  page.text('F1', 8, M, y, label, 0.45);
  page.text('F3', 10, M + 130, y, value);
  return y + 18;
}

function keyBlock(page: Page, y: number, key: LetterKey): number {
  page.text('F2', 10, M, y, `${key.label} (${key.version})`);
  y += 16;

  page.text('F1', 8, M, y, 'Exponent', 0.45);
  y += 12;
  for (const line of hexBlock(key.exponent)) {
    page.text('F3', 8, M + 12, y, line);
    y += 11;
  }
  y += 4;

  page.text('F1', 8, M, y, 'Modulus', 0.45);
  y += 12;
  for (const line of hexBlock(key.modulus)) {
    page.text('F3', 8, M + 12, y, line);
    y += 11;
  }
  y += 6;

  // The digest is what the bank actually compares. It gets its own box.
  page.line(M, y, R, 0.5, 0.6);
  y += 14;
  page.text('F2', 8, M, y, 'SHA-256 hash', 0.2);
  y += 13;
  page.text('F4', 9, M + 12, y, key.digestFormatted.slice(0, 35));
  y += 13;
  page.text('F4', 9, M + 12, y, key.digestFormatted.slice(36));
  y += 12;
  page.line(M, y, R, 0.5, 0.6);
  return y + 24;
}

function signatureBlock(page: Page, y: number): void {
  page.text('F1', 8, M, y, 'Place, date', 0.45);
  page.line(M, y + 26, M + 200, 0.5, 0.4);
  page.text('F1', 8, M + 240, y, 'Signature of the account holder', 0.45);
  page.line(M + 240, y + 26, R, 0.5, 0.4);
}

/**
 * Lay the letters out. Pure — same input, same bytes, which is what lets a test
 * assert the digests really reached the page.
 */
export function renderLetterPages(input: LetterInput): Page[] {
  const es = input.keys.filter((k) => k.version.startsWith('A'));
  const rest = input.keys.filter((k) => !k.version.startsWith('A'));
  const pages: Page[] = [];

  for (const [title, subtitle, keys] of [
    [
      'EBICS INI Letter',
      'Electronic signature key — the key that authorises payments',
      es,
    ],
    [
      'EBICS HIA Letter',
      'Identification, authentication and encryption keys',
      rest,
    ],
  ] as const) {
    if (keys.length === 0) continue;
    const page = new Page();
    let y = heading(page, title, subtitle);

    y = field(page, y, 'Bank connection', input.connection.display_name);
    y = field(page, y, 'Host ID', input.connection.host_id);
    y = field(page, y, 'Partner ID (customer)', input.connection.partner_id);
    y = field(page, y, 'User ID (subscriber)', input.connection.user_id);
    y = field(page, y, 'EBICS version', input.connection.ebics_version);
    y = field(page, y, 'Date', input.date);
    y += 12;

    for (const key of keys) y = keyBlock(page, y, key);

    page.text(
      'F1',
      8,
      M,
      y,
      'I confirm the above keys are mine and request their activation for the EBICS access named above.',
      0.35,
    );
    signatureBlock(page, y + 30);
    pages.push(page);
  }

  return pages;
}

/** Read a connection's own keys and render its letters. */
export function renderIniLetter(db: Database.Database, connectionKey: string, date: string): Buffer {
  const detail = connectionDetail(db, connectionKey);
  const records = publicRecords(db, rowIdOf(db, connectionKey));
  if (records.length === 0) {
    throw new DomainError(409, 'this connection has no keys yet — generate them before printing the letter');
  }

  const labels: Record<string, string> = {
    ES: 'Electronic signature key',
    AUTH: 'Identification and authentication key',
    ENC: 'Encryption key',
  };

  const keys: LetterKey[] = records.map((record) => {
    const { modulus, exponent } = publicKeyParts(
      publicPemFor(db, { connectionId: rowIdOf(db, connectionKey), purpose: record.purpose }),
    );
    return {
      version: record.version,
      label: labels[record.purpose] ?? record.purpose,
      modulus,
      exponent,
      digestFormatted: formatForLetter(record.digest),
    };
  });

  return buildPdf(renderLetterPages({ connection: detail, keys, date }));
}

function rowIdOf(db: Database.Database, key: string): number {
  const row = db.prepare('SELECT id FROM bank_connections WHERE key = ?').get(key) as { id: number } | undefined;
  if (row === undefined) throw new DomainError(404, `no bank connection named "${key}"`);
  return row.id;
}
