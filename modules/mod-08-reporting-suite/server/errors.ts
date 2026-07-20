import type { FieldError } from '../shared/types.js';

/** Domain / validation error carrying an HTTP status and optional field details. */
export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: FieldError[] = [],
  ) {
    super(message);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
