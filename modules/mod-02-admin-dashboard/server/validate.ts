import type { FieldDef, ResourceDef } from '../shared/resources.js';

export interface ValidationError {
  field: string;
  message: string;
}

/** Value as stored in SQLite: booleans become 0/1, empty optionals null. */
export type StoredValue = string | number | null;

export interface ValidationResult {
  errors: ValidationError[];
  /** Normalized values keyed by field name — only set when errors is empty. */
  values: Record<string, StoredValue>;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function validateField(field: FieldDef, raw: unknown): { error?: string; value: StoredValue } {
  if (isEmpty(raw)) {
    if (field.required) return { error: 'is required', value: null };
    return { value: field.type === 'boolean' ? 0 : null };
  }

  switch (field.type) {
    case 'text':
    case 'select': {
      if (typeof raw !== 'string') return { error: 'must be a string', value: null };
      if (field.maxLength && raw.length > field.maxLength) {
        return { error: `must be at most ${field.maxLength} characters`, value: null };
      }
      if (field.pattern && !new RegExp(field.pattern).test(raw)) {
        return { error: field.patternHint ?? 'has an invalid format', value: null };
      }
      if (field.type === 'select' && field.options && !field.options.includes(raw)) {
        return { error: `must be one of: ${field.options.join(', ')}`, value: null };
      }
      return { value: raw };
    }
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (typeof raw === 'boolean' || Number.isNaN(num)) {
        return { error: 'must be a number', value: null };
      }
      if (field.min !== undefined && num < field.min) {
        return { error: `must be at least ${field.min}`, value: null };
      }
      if (field.max !== undefined && num > field.max) {
        return { error: `must be at most ${field.max}`, value: null };
      }
      return { value: num };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw ? 1 : 0 };
      if (raw === 'true' || raw === 1 || raw === '1') return { value: 1 };
      if (raw === 'false' || raw === 0 || raw === '0') return { value: 0 };
      return { error: 'must be a boolean', value: null };
    }
    case 'date': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
        return { error: 'must be a date in YYYY-MM-DD format', value: null };
      }
      return { value: raw };
    }
  }
}

/**
 * Validate a request body against a resource definition. Unknown keys are
 * ignored; every configured field is normalized (missing optionals → null).
 */
export function validateRecord(resource: ResourceDef, body: unknown): ValidationResult {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const values: Record<string, StoredValue> = {};

  for (const field of resource.fields) {
    const { error, value } = validateField(field, input[field.name]);
    if (error) errors.push({ field: field.name, message: `${field.label} ${error}` });
    else values[field.name] = value;
  }
  return { errors, values };
}
