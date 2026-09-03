import type { FieldError } from '../shared/types.js';

/**
 * A structured, HTTP-mappable error thrown by the domain layer. The
 * terminal error middleware in app.ts turns it into
 * `{ error, details }` with the right status code.
 *
 * Status conventions across every Platform Service:
 *   422 validation · 409 conflict · 404 not-found / foreign id
 *   401 no/invalid session · 403 authenticated but insufficient role
 */
export class DomainError extends Error {
  status: number;
  details: FieldError[];
  constructor(status: number, message: string, details: FieldError[] = []) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.details = details;
  }
}

export function fail(status: number, message: string, details: FieldError[] = []): never {
  throw new DomainError(status, message, details);
}

/** Collect field errors and throw a single 422 if any were recorded. */
export function failValidation(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

/** Require a non-empty trimmed string body field. */
export function reqText(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(422, 'Validation failed', [{ field, message: 'is required' }]);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new DomainError(422, 'Validation failed', [
      { field, message: `must be at most ${max} characters` },
    ]);
  }
  return trimmed;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function reqEmail(body: Record<string, unknown>, field = 'email'): string {
  const value = reqText(body, field, 320).toLowerCase();
  if (!EMAIL_RE.test(value)) {
    throw new DomainError(422, 'Validation failed', [{ field, message: 'must be a valid email' }]);
  }
  return value;
}

/**
 * Read an optional whole-number field — a `limit`, an `offset`, a TTL —
 * refusing anything that is not one.
 *
 * `Number(raw)` was trusted at these boundaries and answers two ways that both
 * cost you something. `?limit=abc` is NaN, and NaN survives every clamp
 * (`Math.min(Math.max(1, NaN), 100)` is NaN), so it reached SQLite as a bound
 * parameter and came back as `SqliteError: datatype mismatch` — a 500 on a
 * plain typo, where the caller sees "the service is broken" and the operator
 * sees an unexplained error in the logs. A value out of range is the quieter
 * one: an unbounded signed-URL TTL turns a link that is supposed to expire
 * into a permanent one, and a large enough one is not a representable date at
 * all.
 *
 * So the value must parse, be a whole number, and be in range — or the request
 * is refused with a field error naming the bound. An absent, null or blank
 * value means "not supplied" and yields `undefined`, which is what an omitted
 * query parameter and an uninterpolated form field both look like.
 */
export function optionalInt(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DomainError(422, 'Validation failed', [
      { field, message: `must be a whole number between ${min} and ${max}` },
    ]);
  }
  return value;
}
