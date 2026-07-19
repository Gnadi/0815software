import type { FieldError } from '../shared/types.js';

/** Error with an HTTP status and optional per-field details. */
export class DomainError extends Error {
  status: number;
  details: FieldError[];

  constructor(status: number, message: string, details: FieldError[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** ISO timestamp without milliseconds, e.g. "2026-07-19T09:25:00Z". */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}
