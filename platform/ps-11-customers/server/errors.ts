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
