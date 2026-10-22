import { describe, expect, it } from 'vitest';
import {
  accessLevelFor,
  compileAccessPolicy,
  modulePermission,
  parseModulePermission,
  permits,
  ACCESS_LEVELS,
} from '../src/access.js';
// PS-01's own copy of the grammar. Loaded straight from the service's source:
// it has no imports, so nothing from that package needs installing.
import { holdsPermission, parseModulePermission as ps01Parse } from '../../ps-01-identity/shared/module-access.js';

describe('access levels', () => {
  it('are ordered view < edit < manage', () => {
    expect(permits('manage', 'view')).toBe(true);
    expect(permits('edit', 'edit')).toBe(true);
    expect(permits('view', 'edit')).toBe(false);
    expect(permits('edit', 'manage')).toBe(false);
  });

  it('derive from PS-01 permissions', () => {
    expect(accessLevelFor([], 'crm-lite')).toBeNull();
    expect(accessLevelFor(['org:read', 'user:read'], 'crm-lite')).toBeNull();
    expect(accessLevelFor(['module:crm-lite:view'], 'crm-lite')).toBe('view');
    expect(accessLevelFor(['module:crm-lite:view', 'module:*:edit'], 'crm-lite')).toBe('edit');
    expect(accessLevelFor(['module:offers:manage'], 'crm-lite')).toBeNull();
    expect(accessLevelFor(['module:crm-lite:view', 'platform:admin'], 'crm-lite')).toBe('manage');
  });

  it('refuse to build a permission for a malformed slug', () => {
    expect(modulePermission('crm-lite', 'edit')).toBe('module:crm-lite:edit');
    expect(() => modulePermission('CRM Lite', 'edit')).toThrow();
  });
});

describe('the module grammar matches PS-01', () => {
  const samples = [
    'module:crm-lite:view',
    'module:*:manage',
    'module:a:edit',
    'module:crm-lite:admin',
    'module:CRM:view',
    'module::view',
    'module:-x:view',
    'module:x-:view',
    'module:a:b:view',
    'platform:admin',
    'org:read',
  ];

  it('parses identically', () => {
    for (const sample of samples) expect(ps01Parse(sample)).toEqual(parseModulePermission(sample));
  });

  it('answers "may this person do <level> here" identically', () => {
    const grants = [[], ['platform:admin'], ['module:*:view'], ['module:crm-lite:edit'], ['module:offers:manage'], ['org:read']];
    for (const held of grants) {
      for (const level of ACCESS_LEVELS) {
        const viaModule = accessLevelFor(held, 'crm-lite');
        const moduleSays = viaModule !== null && permits(viaModule, level);
        expect(holdsPermission(new Set(held), `module:crm-lite:${level}`)).toBe(moduleSays);
      }
    }
  });
});

describe('access policy', () => {
  const policy = compileAccessPolicy([
    { method: 'POST', path: '/api/reports/:id/run', access: 'view' },
    { method: 'POST', path: '/api/payment-runs/:id/submit', access: 'manage' },
    { method: 'GET', path: '/api/payment-runs/:id/file', access: 'manage' },
  ]);

  it('defaults by method: reads need view, writes need edit', () => {
    expect(policy('GET', '/api/products')).toBe('view');
    expect(policy('HEAD', '/api/products')).toBe('view');
    expect(policy('POST', '/api/products')).toBe('edit');
    expect(policy('DELETE', '/api/products/7')).toBe('edit');
  });

  it('applies a rule to its method and path only', () => {
    expect(policy('POST', '/api/reports/12/run')).toBe('view');
    expect(policy('POST', '/api/payment-runs/3/submit')).toBe('manage');
    expect(policy('POST', '/api/payment-runs/3/submit/')).toBe('manage');
    expect(policy('PUT', '/api/payment-runs/3/submit')).toBe('edit');
    expect(policy('POST', '/api/payment-runs/3/submitx')).toBe('edit');
    expect(policy('POST', '/api/payment-runs/3/4/submit')).toBe('edit');
  });

  it('judges HEAD by the GET rules, since Express answers it with the GET route', () => {
    expect(policy('HEAD', '/api/payment-runs/3/file')).toBe('manage');
  });

  it('refuses a rule it cannot apply', () => {
    expect(() => compileAccessPolicy([{ method: 'POST', path: 'api/x', access: 'edit' }])).toThrow();
    expect(() => compileAccessPolicy([{ method: 'POST', path: '/api/x', access: 'root' as never }])).toThrow();
  });
});
