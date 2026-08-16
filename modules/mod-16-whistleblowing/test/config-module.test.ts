import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../server/config.js';

/**
 * The two settings this module adds on top of the shared ones. The generic
 * numeric-parsing contract is covered by `config-env.test.ts`, which is
 * byte-identical everywhere; this file is only about MOD-16's own knobs.
 */

describe('ORGANISATION_NAME', () => {
  it('has a local-dev default so the intake page always names someone', () => {
    // § 17 Abs. 1 HinSchG: a reporter is entitled to know who is receiving
    // their report. A blank organisation on the public page is not a
    // cosmetic gap, so there is always a value.
    expect(configFromEnv({}).organisation).not.toBe('');
  });

  it('reads the configured name', () => {
    expect(configFromEnv({ ORGANISATION_NAME: 'Berger Logistik GmbH' }).organisation).toBe('Berger Logistik GmbH');
  });
});

describe('LOOKUP_RATE_LIMIT_RPM', () => {
  it('defaults to a tighter limit than the general one', () => {
    expect(configFromEnv({}).lookupRateLimitRpm).toBe(20);
  });

  it('reads a real value, and accepts 0 as "off"', () => {
    expect(configFromEnv({ LOOKUP_RATE_LIMIT_RPM: '5' }).lookupRateLimitRpm).toBe(5);
    expect(configFromEnv({ LOOKUP_RATE_LIMIT_RPM: '0' }).lookupRateLimitRpm).toBe(0);
  });

  it('refuses a value that is not a number instead of silently disabling itself', () => {
    // The failure mode this guards: a typo turning into NaN, NaN failing the
    // `> 0` check, and the throttle on the one credential-guessing endpoint
    // in the module quietly switching off.
    expect(() => configFromEnv({ LOOKUP_RATE_LIMIT_RPM: 'twenty' })).toThrow(/LOOKUP_RATE_LIMIT_RPM/);
    expect(() => configFromEnv({ LOOKUP_RATE_LIMIT_RPM: '-1' })).toThrow(/LOOKUP_RATE_LIMIT_RPM/);
  });

  it('treats blank as unset — an uninterpolated compose variable', () => {
    expect(configFromEnv({ LOOKUP_RATE_LIMIT_RPM: '' }).lookupRateLimitRpm).toBe(20);
  });
});
