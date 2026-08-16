import { describe, expect, it } from 'vitest';
import { generateCode, hashCode, looksLikeCode, normalizeCode, sameHash } from '../server/codes.js';

/**
 * The access code is the only link between a whistleblower and their case,
 * and the only credential this module cannot reissue. These tests are about
 * that: entropy, transcription tolerance, and the fact that the code itself
 * never survives anywhere the organisation can read it.
 */

describe('generateCode', () => {
  it('is 20 symbols in five readable groups', () => {
    expect(generateCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  });

  it('never emits I, L, O or U', () => {
    // Crockford's alphabet. A reporter may be copying this off a screen onto
    // paper under stress, and 0/O and 1/I/L are the pairs that get
    // transcribed wrong — which would cost them their only way back in.
    const sample = Array.from({ length: 200 }, () => generateCode()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('does not repeat itself', () => {
    // 100 bits of entropy: a collision in 5,000 draws would mean the CSPRNG
    // is not one. This is a smoke check on the source, not a statistical
    // claim about the space.
    const codes = new Set(Array.from({ length: 5_000 }, () => generateCode()));
    expect(codes.size).toBe(5_000);
  });

  it('draws from the whole alphabet', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()).join('').replace(/-/g, ''));
    expect(seen.size).toBe(32);
  });
});

describe('normalizeCode', () => {
  it('folds case, dashes and spaces — a transcription slip is not a lockout', () => {
    const code = 'AB12-CD34-EF56-GH78-JK90';
    const typed = ['ab12cd34ef56gh78jk90', 'AB12 CD34 EF56 GH78 JK90', 'ab12-CD34 ef56-GH78 jk90'];
    for (const variant of typed) expect(normalizeCode(variant)).toBe(normalizeCode(code));
  });

  it('hashes every one of those to the same digest', () => {
    expect(hashCode('ab12 cd34 ef56 gh78 jk90')).toBe(hashCode('AB12-CD34-EF56-GH78-JK90'));
  });
});

describe('looksLikeCode', () => {
  it('accepts a freshly generated code', () => {
    expect(looksLikeCode(generateCode())).toBe(true);
  });

  it('rejects the wrong length, the wrong alphabet and the wrong type', () => {
    expect(looksLikeCode('AB12-CD34')).toBe(false);
    expect(looksLikeCode('ILOU-ILOU-ILOU-ILOU-ILOU')).toBe(false);
    expect(looksLikeCode(null)).toBe(false);
    expect(looksLikeCode(12345)).toBe(false);
    expect(looksLikeCode('')).toBe(false);
  });
});

describe('hashCode', () => {
  it('is a sha-256 hex digest', () => {
    expect(hashCode(generateCode())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the code — a database copy yields hashes, not codes', () => {
    const code = generateCode();
    expect(hashCode(code)).not.toContain(normalizeCode(code));
  });

  it('separates codes that differ by one symbol', () => {
    expect(hashCode('AB12-CD34-EF56-GH78-JK90')).not.toBe(hashCode('AB12-CD34-EF56-GH78-JK91'));
  });
});

describe('sameHash', () => {
  it('matches a digest with itself and nothing else', () => {
    const digest = hashCode(generateCode());
    expect(sameHash(digest, digest)).toBe(true);
    expect(sameHash(digest, hashCode(generateCode()))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    expect(sameHash(hashCode('x'), 'abcd')).toBe(false);
  });
});
