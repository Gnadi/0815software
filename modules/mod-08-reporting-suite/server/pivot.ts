import type { Aggregation, PivotConfig, PivotResult, QueryResult } from '../shared/types.js';
import { AGGREGATIONS } from '../shared/types.js';

/**
 * Server-side pivot over a report result. Every cell — including the row
 * totals, column totals and the grand total — is the aggregation applied
 * to the UNDERLYING set of source rows, never a combination of other
 * cells. That makes an `avg` margin a true average (not an average of
 * averages) and keeps every number hand-computable, which the tests rely
 * on.
 *
 * Semantics:
 *   sum/avg/min/max  operate on the numeric values of the measure column,
 *                    skipping null / non-numeric values.
 *   count            counts source ROWS in the cell, ignoring the measure
 *                    column (measure '*' is the idiomatic spelling).
 *   empty cell       (no source rows at that row×col) renders as null.
 */

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function labelOf(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  return String(value);
}

/** Aggregate a set of source rows into a single value (or null if empty). */
function aggregate(rows: Record<string, unknown>[], measure: string, agg: Aggregation): number | null {
  if (agg === 'count') {
    // Empty cell (no matching source rows) → null, consistent with the
    // other aggregations; a populated cell is its record count.
    return rows.length === 0 ? null : rows.length;
  }
  const nums: number[] = [];
  for (const row of rows) {
    const n = toNumber(row[measure]);
    if (n !== null) nums.push(n);
  }
  if (nums.length === 0) return null;
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

export class PivotError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function assertColumn(columns: string[], name: string, field: string): void {
  if (!columns.includes(name)) {
    throw new PivotError(422, `${field} "${name}" is not a column of the report result`);
  }
}

/** Distinct values of a column in first-seen order, labelled. */
function distinct(rows: Record<string, unknown>[], column: string): { key: string; raw: unknown }[] {
  const seen = new Map<string, unknown>();
  for (const row of rows) {
    const key = labelOf(row[column]);
    if (!seen.has(key)) seen.set(key, row[column]);
  }
  return [...seen.entries()].map(([key, raw]) => ({ key, raw }));
}

export function computePivot(result: QueryResult, config: PivotConfig): PivotResult {
  const { columns } = result;
  if (!(AGGREGATIONS as readonly string[]).includes(config.aggregation)) {
    throw new PivotError(422, `aggregation must be one of: ${AGGREGATIONS.join(', ')}`);
  }
  assertColumn(columns, config.row, 'row dimension');
  if (config.col !== null) assertColumn(columns, config.col, 'column dimension');
  if (config.aggregation !== 'count') {
    if (config.measure === '*') {
      throw new PivotError(422, "measure '*' is only valid with the count aggregation");
    }
    assertColumn(columns, config.measure, 'measure');
  } else if (config.measure !== '*') {
    assertColumn(columns, config.measure, 'measure');
  }

  const { rows } = result;
  const rowKeys = distinct(rows, config.row);

  // ── Flat pivot: no column dimension → a single value column. ─────────
  if (config.col === null) {
    const out: PivotResult = {
      columns: ['Value'],
      rows: rowKeys.map(({ key }) => {
        const subset = rows.filter((r) => labelOf(r[config.row]) === key);
        const value = aggregate(subset, config.measure, config.aggregation);
        return { key, values: [value], total: value };
      }),
      columnTotals: [aggregate(rows, config.measure, config.aggregation)],
      grandTotal: aggregate(rows, config.measure, config.aggregation),
      flat: true,
    };
    return out;
  }

  // ── Two-dimensional pivot. ───────────────────────────────────────────
  const colKeys = distinct(rows, config.col);
  const colLabels = colKeys.map((c) => c.key);

  const outRows = rowKeys.map(({ key: rk }) => {
    const rowSubset = rows.filter((r) => labelOf(r[config.row]) === rk);
    const values = colKeys.map(({ key: ck }) => {
      const cell = rowSubset.filter((r) => labelOf(r[config.col!]) === ck);
      return aggregate(cell, config.measure, config.aggregation);
    });
    const total = aggregate(rowSubset, config.measure, config.aggregation);
    return { key: rk, values, total };
  });

  const columnTotals = colKeys.map(({ key: ck }) => {
    const colSubset = rows.filter((r) => labelOf(r[config.col!]) === ck);
    return aggregate(colSubset, config.measure, config.aggregation);
  });

  return {
    columns: colLabels,
    rows: outRows,
    columnTotals,
    grandTotal: aggregate(rows, config.measure, config.aggregation),
    flat: false,
  };
}
