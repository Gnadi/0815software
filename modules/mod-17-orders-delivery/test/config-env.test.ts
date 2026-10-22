import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../server/config.js';

/**
 * Numeric settings read from the environment.
 *
 * These used to be `Number(env.X) || fallback`, which is silent in the two
 * ways that cost you a deployment. `PORT=808O` — a letter O — is NaN, and NaN
 * is falsy, so it became the DEFAULT port: the service starts, answers its own
 * healthcheck, and is unreachable, because the compose port mapping and the
 * reverse proxy point at the 8080 nobody is listening on. Nothing in the logs
 * mentions the typo. `SESSION_TTL_HOURS=-1` is a perfectly good number and
 * minted sessions that had already expired: every login succeeding, every
 * request after it 401ing.
 *
 * So: a blank value still means "unset" (that is what an uninterpolated
 * compose variable yields), and anything else must parse and be in range or
 * the process refuses to start while a human is still watching the logs.
 *
 * This file is byte-identical in every module and service.
 */

type Config = ReturnType<typeof configFromEnv>;

/** Session TTL lives under `session` in some packages and `auth` in others. */
function ttlOf(config: Config): number {
  const shape = config as unknown as { session?: { ttlHours?: number }; auth?: { ttlHours?: number } };
  const ttl = shape.session?.ttlHours ?? shape.auth?.ttlHours;
  if (ttl === undefined) throw new Error('no ttlHours in this config shape');
  return ttl;
}

const defaults = configFromEnv({});

describe('PORT', () => {
  it('defaults to the port this package ships with', () => {
    expect(defaults.port).toBeGreaterThan(0);
    expect(Number.isInteger(defaults.port)).toBe(true);
  });

  it('reads a real value', () => {
    expect(configFromEnv({ PORT: '8080' }).port).toBe(8080);
  });

  it.each(['', '   '])('treats %o as unset and falls back', (raw) => {
    expect(configFromEnv({ PORT: raw }).port).toBe(defaults.port);
  });

  // The regression: each of these used to become the default port silently.
  it.each([
    ['808O', 'a letter O instead of a zero'],
    ['abc', 'a word'],
    ['80 80', 'a stray space'],
    ['8080x', 'trailing junk'],
  ])('refuses %o (%s) instead of quietly using the default', (raw) => {
    expect(() => configFromEnv({ PORT: raw })).toThrow(/PORT/);
  });

  it.each([
    ['0', 'not a bindable port'],
    ['-1', 'negative'],
    ['65536', 'above the range'],
    ['80.5', 'not a whole number'],
  ])('refuses the out-of-range value %o (%s)', (raw) => {
    expect(() => configFromEnv({ PORT: raw })).toThrow(/between 1 and 65535/);
  });

  it('names the offending value in the error, so the log says what to fix', () => {
    expect(() => configFromEnv({ PORT: '808O' })).toThrow(/808O/);
  });

  it('accepts the range boundaries', () => {
    expect(configFromEnv({ PORT: '1' }).port).toBe(1);
    expect(configFromEnv({ PORT: '65535' }).port).toBe(65535);
  });
});

describe('SESSION_TTL_HOURS', () => {
  it('defaults to 12 hours', () => {
    expect(ttlOf(defaults)).toBe(12);
  });

  it('reads a real value', () => {
    expect(ttlOf(configFromEnv({ SESSION_TTL_HOURS: '24' }))).toBe(24);
  });

  it('treats a blank value as unset', () => {
    expect(ttlOf(configFromEnv({ SESSION_TTL_HOURS: '' }))).toBe(12);
  });

  // A negative TTL is a number, so the old `||` let it straight through — and
  // it issues tokens whose expiry is already in the past.
  it.each(['0', '-1', '-12'])('refuses the non-positive TTL %o', (raw) => {
    expect(() => configFromEnv({ SESSION_TTL_HOURS: raw })).toThrow(/SESSION_TTL_HOURS/);
  });

  it.each(['forever', '12h', '1.5'])('refuses the unparseable TTL %o', (raw) => {
    expect(() => configFromEnv({ SESSION_TTL_HOURS: raw })).toThrow(/SESSION_TTL_HOURS/);
  });
});
