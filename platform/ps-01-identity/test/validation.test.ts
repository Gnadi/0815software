/**
 * The shared validators, and the branches nothing had ever taken.
 *
 * `server/errors.ts` is copy-in and byte-identical across all twelve Platform
 * Services, so a case here is a case for all of them — and it was the least
 * covered file in the package: the rejection paths of `reqText`, `reqEmail` and
 * `optionalInt` are exactly the branches a caller reaches by getting something
 * wrong, which is to say the ones that run in production.
 *
 * `optionalInt` in particular is the validator the platform-wide review added
 * after three services answered 500 to `?limit=abc`. PS-01 has no paged route
 * to use it on, so without this file the canonical copy would ship untested.
 */
import { describe, expect, it } from 'vitest';
import { DomainError, failValidation, optionalInt, reqEmail, reqText } from '../server/errors.js';
import { runMigrations, type Migration } from '../server/migrations.js';
import { isOrgStatus, isPermission, isUserStatus, PERMISSIONS } from '../shared/types.js';
import Database from 'better-sqlite3';

/** Run `fn` and return the DomainError it threw. */
function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return err as DomainError;
  }
  throw new Error('expected a DomainError, nothing was thrown');
}

describe('reqText', () => {
  it('accepts and trims', () => {
    expect(reqText({ name: '  Ada  ' }, 'name')).toBe('Ada');
  });

  it('refuses a missing, blank or non-string value with a field error', () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: null }, { name: ['Ada'] }]) {
      const err = thrown(() => reqText(body as Record<string, unknown>, 'name'));
      expect(err.status).toBe(422);
      expect(err.details).toEqual([{ field: 'name', message: 'is required' }]);
    }
  });

  it('refuses an over-long value and names the bound', () => {
    const err = thrown(() => reqText({ name: 'x'.repeat(201) }, 'name', 200));
    expect(err.details[0]!.message).toBe('must be at most 200 characters');
  });

  it('measures the TRIMMED length, so trailing spaces do not fail a legal value', () => {
    expect(reqText({ name: `${'x'.repeat(200)}   ` }, 'name', 200)).toHaveLength(200);
  });
});

describe('reqEmail', () => {
  it('lower-cases a valid address', () => {
    expect(reqEmail({ email: '  Ada@ACME.test ' })).toBe('ada@acme.test');
  });

  it('refuses what is not an address', () => {
    for (const email of ['ada', 'ada@', '@acme.test', 'ada@acme', 'a b@acme.test', 'ada@@acme.test']) {
      const err = thrown(() => reqEmail({ email }));
      expect(err.details, email).toEqual([{ field: 'email', message: 'must be a valid email' }]);
    }
  });

  it('reports the field it was asked about, not always "email"', () => {
    const err = thrown(() => reqEmail({ contact: 'nope' }, 'contact'));
    expect(err.details[0]!.field).toBe('contact');
  });
});

describe('failValidation', () => {
  it('collects several field errors into one 422', () => {
    const err = thrown(() =>
      failValidation([
        { field: 'a', message: 'is required' },
        { field: 'b', message: 'is required' },
      ]),
    );
    expect(err.status).toBe(422);
    expect(err.message).toBe('Validation failed');
    expect(err.details).toHaveLength(2);
  });
});

describe('optionalInt', () => {
  it('reads a number and a numeric string alike', () => {
    expect(optionalInt({ limit: 50 }, 'limit', 1, 100)).toBe(50);
    expect(optionalInt({ limit: '50' }, 'limit', 1, 100)).toBe(50);
  });

  it('treats absent, null and blank as "not supplied"', () => {
    expect(optionalInt({}, 'limit', 1, 100)).toBeUndefined();
    expect(optionalInt({ limit: null }, 'limit', 1, 100)).toBeUndefined();
    expect(optionalInt({ limit: '' }, 'limit', 1, 100)).toBeUndefined();
  });

  it('refuses what is not a whole number — the NaN that used to reach SQLite', () => {
    for (const limit of ['abc', 'off', '1.5', 1.5, '1e', {}, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = thrown(() => optionalInt({ limit }, 'limit', 1, 100));
      expect(err.status, String(limit)).toBe(422);
      expect(err.details[0]!.field).toBe('limit');
    }
  });

  it('refuses a value outside the range and names the bound', () => {
    const err = thrown(() => optionalInt({ limit: 101 }, 'limit', 1, 100));
    expect(err.details[0]!.message).toBe('must be a whole number between 1 and 100');
    expect(() => optionalInt({ limit: 0 }, 'limit', 1, 100)).toThrow();
    expect(() => optionalInt({ limit: -1 }, 'limit', 1, 100)).toThrow();
  });

  it('accepts both boundaries', () => {
    expect(optionalInt({ limit: 1 }, 'limit', 1, 100)).toBe(1);
    expect(optionalInt({ limit: 100 }, 'limit', 1, 100)).toBe(100);
  });
});

describe('the migration runner refuses a malformed ledger', () => {
  const up = (): void => {};

  it('refuses a non-positive or non-integer id', () => {
    for (const id of [0, -1, 1.5]) {
      expect(() => runMigrations(new Database(':memory:'), [{ id, name: 'x', up }] as Migration[])).toThrow(
        /positive integer/,
      );
    }
  });

  it('refuses a duplicate id — two migrations claiming one slot', () => {
    expect(() =>
      runMigrations(new Database(':memory:'), [
        { id: 1, name: 'a', up },
        { id: 1, name: 'b', up },
      ]),
    ).toThrow(/duplicate migration id/);
  });

  it('refuses ids out of order, so replay order is the declared order', () => {
    expect(() =>
      runMigrations(new Database(':memory:'), [
        { id: 2, name: 'b', up },
        { id: 1, name: 'a', up },
      ]),
    ).toThrow(/ascending order/);
  });
});

describe('the shared type guards', () => {
  it('recognize what the schema allows and nothing else', () => {
    expect(isOrgStatus('active')).toBe(true);
    expect(isOrgStatus('suspended')).toBe(true);
    expect(isOrgStatus('deleted')).toBe(false);

    expect(isUserStatus('active')).toBe(true);
    expect(isUserStatus('disabled')).toBe(true);
    expect(isUserStatus('pending')).toBe(false);

    for (const perm of PERMISSIONS) expect(isPermission(perm), perm).toBe(true);
    expect(isPermission('org:delete')).toBe(false);
    expect(isPermission('')).toBe(false);
  });
});
