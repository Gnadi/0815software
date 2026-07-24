/**
 * PS-10 Number — wire contract shared between server and clients.
 */

export interface FieldError {
  field: string;
  message: string;
}

/** How often a scope's counter restarts at 1. */
export const PERIODS = ['none', 'year', 'month', 'day'] as const;
export type Period = (typeof PERIODS)[number];

export interface SequenceConfig {
  scope: string;
  format: string;
  period: Period;
  created_at: string;
}

export interface NextNumber {
  scope: string;
  /** The raw incrementing integer within the current period. */
  value: number;
  /** The period key the counter is scoped to (e.g. "2026"), or "" for none. */
  period_key: string;
  /** The rendered number, e.g. "INV-2026-0001". */
  formatted: string;
}
