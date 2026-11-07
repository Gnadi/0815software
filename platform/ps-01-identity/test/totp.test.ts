import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hotp,
  matchStep,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  totp,
} from '../server/totp.js';

// Domain law with its source (CLAUDE.md rule 7): every vector below is copied
// from the RFC that defines the algorithm, not produced by this code.

describe('base32 — RFC 4648 §10 test vectors', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];
  it.each(vectors)('encodes %j as %s and back', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('decodes what people type: lower case, spaces, no padding', () => {
    expect(base32Decode('mzxw 6ytb oi').toString()).toBe('foobar');
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('HOTP — RFC 4226 Appendix D', () => {
  const secret = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((code, counter) => [counter, code] as const))('counter %i → %s', (counter, code) => {
    expect(hotp(secret, counter)).toBe(code);
  });
});

describe('TOTP — RFC 6238 Appendix B (SHA-1, 8 digits)', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('T=%i → %s', (seconds, code) => {
    expect(totp(secret, seconds * 1000, 8)).toBe(code);
  });
});

describe('matchStep', () => {
  const secret = Buffer.from('12345678901234567890');
  const now = 1111111111_000;

  it('accepts the current step and one either side, nothing further', () => {
    const step = Math.floor(now / 30_000);
    expect(matchStep(secret, hotp(secret, step), now)).toBe(step);
    expect(matchStep(secret, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(matchStep(secret, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(matchStep(secret, hotp(secret, step - 2), now)).toBeNull();
    expect(matchStep(secret, hotp(secret, step + 2), now)).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    expect(matchStep(secret, '12345', now)).toBeNull();
    expect(matchStep(secret, '1234567', now)).toBeNull();
    expect(matchStep(secret, 'abcdef', now)).toBeNull();
  });
});

describe('secrets, URIs and recovery codes', () => {
  it('mints 160-bit secrets that decode to 20 bytes', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(s);
  });

  it('builds an otpauth URI with the issuer in label and parameter', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'Acme GmbH', 'ada@acme.test');
    expect(uri.startsWith('otpauth://totp/Acme%20GmbH:ada%40acme.test?')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(params.get('issuer')).toBe('Acme GmbH');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });

  it('recovery codes are readable off paper and normalize what was typed', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    expect(normalizeRecoveryCode(code.toUpperCase().replace('-', ' '))).toBe(code);
    expect(normalizeRecoveryCode('short')).toBeNull();
    expect(normalizeRecoveryCode('aaaaa-0aaaa')).toBeNull(); // 0 is not in the alphabet
  });
});
