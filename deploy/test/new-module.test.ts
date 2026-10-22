/**
 * The module generator (scripts/new-module.mjs) and the copy-in files it
 * relies on.
 *
 * The generator's promise is that a new module starts from the catalogue's
 * conventions — multi-user access included — rather than from whichever module
 * someone copied last. That only holds while the files it copies are still the
 * ones every module carries, so this suite checks both: what the generator
 * writes, and that the shared files have not drifted apart between modules.
 * Offline by construction: it writes into a temp directory and installs nothing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { COPY_IN, registryEntry, renumber, scaffold, tokensFor } from '../../scripts/new-module.mjs';
import { modules } from '../../modules/registry.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const options = {
  n: 42,
  slug: 'example-module',
  title: 'Example Module',
  label: 'Example',
  description: 'An example.',
  port: 3042,
  scope: '2–3 WKS',
};

const scratch = mkdtempSync(join(tmpdir(), 'new-module-'));
const out = join(scratch, 'mod-42-example-module');
const written: string[] = scaffold(options, out);
const read = (rel: string) => readFileSync(join(out, rel), 'utf8');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('what the generator writes', () => {
  it('fills every template token', () => {
    for (const rel of written) expect(read(rel), rel).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('leaves nothing of the reference module behind', () => {
    for (const rel of written) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/mod-03|mod03|MOD-03|inventory/i);
    }
  });

  it('names the module consistently', () => {
    const tokens = tokensFor(options);
    expect(JSON.parse(read('package.json')).name).toBe(`@0815software/${tokens.ID}`);
    expect(JSON.parse(read('package-lock.json')).name).toBe(`@0815software/${tokens.ID}`);
    expect(read('server/access.ts')).toContain(`export const MODULE_SLUG = '${options.slug}';`);
    expect(read('server/summary.ts')).toContain(`export const MODULE_ID = '${tokens.ID}';`);
    expect(read('server/auth.ts')).toContain(`'mod42_session'`);
    expect(read('server/config.ts')).toContain(`env.PORT, ${options.port},`);
  });

  it('starts multi-user: sessions carry a level and the gate enforces the policy', () => {
    expect(read('server/auth.ts')).toContain("import { accessPolicy } from './access.js';");
    expect(read('server/auth.ts')).toMatch(/requireAuth\(config: AuthConfig, policy/);
    expect(read('server/sso.ts')).toContain('accessLevelFor(perms, MODULE_SLUG)');
    expect(read('server/app.ts')).toContain('access: accessOf(res)');
    expect(read('src/components/ItemsView.tsx')).toContain('canManage');
    expect(read('test/access.test.ts')).toBe(readFileSync(join(root, 'modules/mod-03-inventory-management/test/access.test.ts'), 'utf8'));
  });

  it('writes no single-admin wording into the new README', () => {
    expect(read('README.md')).not.toMatch(/one staff admin|single admin login by design/i);
    expect(read('README.md')).toContain('## Users and access levels');
  });

  it('proposes a registry entry with no structural field the drift suite would refuse', () => {
    const entry = registryEntry(options);
    const existing = modules[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(Object.keys(existing).sort());
    expect(entry.services.required).toEqual([]);
  });
});

describe('the copy-in files are still shared', () => {
  // Every module that carries one of these must carry exactly what the
  // generator would write for it — the reference copy, renumbered — or
  // "copied from the reference" would quietly mean "copied from one variant".
  // Files some modules legitimately vary (LICENSE years, a few module-specific
  // test suites) are left out; these are the ones that must not.
  const SHARED = [
    '.npmrc',
    'tsconfig.json',
    'tsconfig.server.json',
    'server/handoff.ts',
    'server/hardening.ts',
    'server/guard.ts',
    'shared/summary.ts',
    'test/access.test.ts',
    'test/transport-hardening.test.ts',
    'src/access.tsx',
  ];
  const reference = (rel: string) => readFileSync(join(root, 'modules/mod-03-inventory-management', rel), 'utf8');

  for (const rel of SHARED) {
    it(`${rel} is the reference copy in every module that has it`, () => {
      expect(COPY_IN).toContain(rel);
      const drifted: string[] = [];
      for (const mod of modules as { id: string; n: string; slug: string; title: string; label: string; defaultPort: number }[]) {
        let text: string;
        try {
          text = readFileSync(join(root, 'modules', mod.id, rel), 'utf8');
        } catch {
          continue;
        }
        const tokens = tokensFor({ n: Number(mod.n.slice(4)), slug: mod.slug, title: mod.title, label: mod.label, description: '', port: mod.defaultPort });
        if (renumber(reference(rel), { ...tokens, ID: mod.id }) !== text) drifted.push(mod.id);
      }
      expect(drifted, `${rel} has drifted`).toEqual([]);
    });
  }

  it('lists only files the reference module has', () => {
    const files = walk(join(root, 'modules/mod-03-inventory-management')).filter((p) => !p.includes('node_modules'));
    for (const rel of COPY_IN) expect(files).toContain(join(root, 'modules/mod-03-inventory-management', rel));
  });
});
