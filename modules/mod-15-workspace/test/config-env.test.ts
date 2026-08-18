import { describe, expect, it } from 'vitest';
import { configFromEnv, peerEnvIds, peersFromEnv, PEER_ENV_VARS } from '../server/config.js';
import { CATALOGUE } from '../shared/catalogue.js';
import { ACTIONS } from '../shared/actions.js';

/**
 * Reading the environment.
 *
 * The Workspace's characteristic misconfiguration is a URL that is slightly
 * wrong. Every other module fails visibly when that happens — it cannot reach
 * its database, and it says so. A dashboard does not: a mistyped peer URL makes
 * one module render as "not in this stack", which is a perfectly ordinary state
 * that nobody investigates. So the cases below are mostly about refusing to
 * boot rather than about parsing correctly.
 */

describe('defaults', () => {
  it('runs standalone with nothing set', () => {
    const config = configFromEnv({});
    expect(config.port).toBe(3015);
    expect(config.databasePath).toBe('./data.db');
    expect(config.peers).toEqual({});
    expect(config.shellOrigins).toEqual([]);
    expect(config.platform.serviceToken).toBeUndefined();
  });

  it('reads the port, and refuses one that is not a port', () => {
    expect(configFromEnv({ PORT: '4015' }).port).toBe(4015);
    expect(configFromEnv({ PORT: '' }).port).toBe(3015);
    // A letter O for a zero boots a service nothing can reach, and says nothing
    // about it in the logs.
    expect(() => configFromEnv({ PORT: '301S' })).toThrow(/PORT/);
    expect(() => configFromEnv({ PORT: '0' })).toThrow(/PORT/);
  });

  it('bounds the peer timeout', () => {
    expect(configFromEnv({}).peerTimeoutMs).toBe(5_000);
    expect(configFromEnv({ PEER_TIMEOUT_MS: '1500' }).peerTimeoutMs).toBe(1500);
    // Zero would mean "no deadline", which is exactly what the timeout exists
    // to prevent, so it is out of range rather than a way to disable it.
    expect(() => configFromEnv({ PEER_TIMEOUT_MS: '0' })).toThrow(/PEER_TIMEOUT_MS/);
    expect(() => configFromEnv({ PEER_TIMEOUT_MS: 'off' })).toThrow(/PEER_TIMEOUT_MS/);
  });
});

describe('peers', () => {
  it('counts a module as present when its internal URL is set', () => {
    const peers = peersFromEnv({ OFFERS_URL: 'http://offers:3013', OFFERS_PUBLIC_URL: 'https://offers.example' });
    expect(peers).toEqual({
      'mod-13-offers': { url: 'http://offers:3013', publicUrl: 'https://offers.example' },
    });
  });

  it('accepts an internal URL without a public one — figures, but no frames', () => {
    const peers = peersFromEnv({ CRM_URL: 'http://crm:3010' });
    expect(peers['mod-10-crm-lite']).toEqual({ url: 'http://crm:3010', publicUrl: null });
  });

  it('ignores a public URL with no internal one', () => {
    // Half a peer is not a peer: without the internal URL there is nothing to
    // read a summary from, and a tile that can only be clicked is not a widget.
    expect(peersFromEnv({ OFFERS_PUBLIC_URL: 'https://offers.example' })).toEqual({});
  });

  it('strips a trailing slash so joined paths never double one', () => {
    const peers = peersFromEnv({ OFFERS_URL: 'http://offers:3013/', OFFERS_PUBLIC_URL: 'https://offers.example/' });
    expect(peers['mod-13-offers']).toEqual({ url: 'http://offers:3013', publicUrl: 'https://offers.example' });
  });

  it('refuses a malformed URL instead of dropping the module', () => {
    // Dropping it would be indistinguishable from "this module is not licensed",
    // and nobody goes looking for a typo in a state that looks intentional.
    expect(() => peersFromEnv({ OFFERS_URL: 'offers:3013' })).toThrow(/OFFERS_URL/);
    expect(() => peersFromEnv({ OFFERS_URL: 'not a url' })).toThrow(/OFFERS_URL/);
    expect(() => peersFromEnv({ OFFERS_URL: 'ftp://offers' })).toThrow(/http or https/);
    expect(() => peersFromEnv({ OFFERS_URL: 'http://offers:3013', OFFERS_PUBLIC_URL: 'nope' })).toThrow(
      /OFFERS_PUBLIC_URL/,
    );
  });

  it('treats blank as unset, which is what an uninterpolated compose var yields', () => {
    expect(peersFromEnv({ OFFERS_URL: '' })).toEqual({});
    expect(peersFromEnv({ OFFERS_URL: '   ' })).toEqual({});
  });

  it('wires every module in the catalogue', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of CATALOGUE) {
      env[entry.urlEnv] = `http://${entry.label.toLowerCase()}:3000`;
      env[entry.publicUrlEnv] = `https://${entry.label.toLowerCase()}.example`;
    }
    expect(Object.keys(peersFromEnv(env))).toEqual(CATALOGUE.map((e) => e.id));
  });
});

/**
 * The catalogue and the env reader are two lists of the same fourteen modules.
 *
 * `peerEnv` names its variables literally — the registry drift test derives a
 * module's env surface by matching `env.FOO`, and a computed lookup is invisible
 * to it — so this is the check that keeps the two in step. Adding a module to
 * one and forgetting the other fails here rather than shipping a tile that can
 * never light up.
 */
describe('the catalogue and the env reader agree', () => {
  it('covers the same modules, in the same order', () => {
    expect(peerEnvIds()).toEqual(CATALOGUE.map((e) => e.id));
  });

  it('gives every module a distinct pair of env vars', () => {
    expect(new Set(PEER_ENV_VARS).size).toBe(PEER_ENV_VARS.length);
    expect(PEER_ENV_VARS).toHaveLength(CATALOGUE.length * 2);
    for (const name of PEER_ENV_VARS) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('marks exactly the three domain-user modules as unembeddable', () => {
    // MOD-01's portal customers, MOD-07's shop guests and MOD-09's matter users
    // are not staff, so the Workspace has no principal to assert in them
    // (docs/PLATFORM-READINESS.md, item C1).
    expect(CATALOGUE.filter((e) => !e.embeddable).map((e) => e.id)).toEqual([
      'mod-01-customer-portal',
      'mod-07-storefront',
      'mod-09-document-management',
    ]);
  });
});

describe('the action catalogue', () => {
  it('names only modules this Workspace knows', () => {
    const known = new Set(CATALOGUE.map((e) => e.id));
    for (const action of ACTIONS) {
      expect(known, `${action.id} source`).toContain(action.sourceModule);
      expect(known, `${action.id} target`).toContain(action.targetModule);
    }
  });

  it('gives every action a distinct id and a target path under /api', () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
    for (const action of ACTIONS) expect(action.path.startsWith('/api/')).toBe(true);
  });
});

describe('platform wiring', () => {
  it('is opt-in, one service at a time', () => {
    const config = configFromEnv({ AUDIT_URL: 'http://audit:4007', PLATFORM_SERVICE_TOKEN: 'tok' });
    expect(config.platform.auditUrl).toBe('http://audit:4007');
    expect(config.platform.customersUrl).toBeUndefined();
    expect(config.platform.serviceToken).toBe('tok');
  });

  it('reads the SSO seam exactly as every other module does', () => {
    const config = configFromEnv({ IDENTITY_URL: 'http://identity:4001', IDENTITY_ORG: 'acme' });
    expect(config.sso).toEqual({ identityUrl: 'http://identity:4001', identityOrg: 'acme', identityPermission: undefined });
  });

  it('reads SHELL_ORIGIN, so this module can itself be embedded', () => {
    expect(configFromEnv({ SHELL_ORIGIN: 'https://shell.example/' }).shellOrigins).toEqual(['https://shell.example']);
    expect(() => configFromEnv({ SHELL_ORIGIN: 'shell.example' })).toThrow(/absolute origin/);
  });
});
