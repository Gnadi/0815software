/**
 * The backup coverage guard.
 *
 * `deploy/backup.sh` used to iterate a hardcoded list of service names. It ran
 * ps01…ps10, so PS-11 — every counterparty, VAT id and bank detail in the
 * stack — was never snapshotted, and no module was either, which is where the
 * invoices, offers and tickets live. A list nobody re-derives goes stale
 * silently, and a backup gap is invisible until the day it matters.
 *
 * So: every package that persists a database must ship the script and the npm
 * script that drives it, the script must be reached the same way in every
 * package, and the modules that keep files beside the database must copy those
 * too. Offline by construction — it reads source files, it boots nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modules, services } from '../../modules/registry.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

const packagePaths = [
  ...services.map((s) => `platform/${s.id}`),
  ...modules.map((m) => `modules/${m.id}`),
];

/** Env vars naming a directory a module persists files into, per the registry. */
function fileDirsOf(pkg: string): string[] {
  const mod = modules.find((m) => `modules/${m.id}` === pkg);
  if (!mod) return [];
  return (mod.env.optional ?? []).filter((name: string) => name.endsWith('_DIR'));
}

describe('backup coverage', () => {
  it('has a package to check', () => {
    // 11 services + 15 modules; if the registry shrinks, so does this suite,
    // and a silently empty test would defeat the whole point.
    expect(packagePaths.length).toBe(26);
  });

  for (const pkg of packagePaths) {
    describe(pkg, () => {
      const scriptPath = `${root}/${pkg}/scripts/backup.mjs`;

      it('ships scripts/backup.mjs', () => {
        expect(existsSync(scriptPath), `${pkg}/scripts/backup.mjs is missing`).toBe(true);
      });

      it('exposes it as `npm run backup`, which is what deploy/backup.sh calls', () => {
        const pkgJson = JSON.parse(readFileSync(`${root}/${pkg}/package.json`, 'utf8')) as {
          scripts: Record<string, string>;
        };
        expect(pkgJson.scripts.backup).toBe('node scripts/backup.mjs');
      });

      it('reads DATABASE_PATH and BACKUP_DIR, and uses the online backup API', () => {
        const src = readFileSync(scriptPath, 'utf8');
        expect(src).toContain('process.env.DATABASE_PATH');
        expect(src).toContain('process.env.BACKUP_DIR');
        // A plain file copy of a live SQLite database in WAL mode can be torn;
        // better-sqlite3's backup() is the consistent path.
        expect(src).toContain('.backup(');
      });

      const fileDirs = fileDirsOf(pkg);
      if (fileDirs.length > 0) {
        it(`also copies ${fileDirs.join(', ')} — the files are not in the database`, () => {
          const src = readFileSync(scriptPath, 'utf8');
          for (const dir of fileDirs) {
            expect(src, `${pkg} persists files under ${dir} but does not back them up`).toContain(
              `process.env.${dir}`,
            );
          }
        });
      }
    });
  }
});

describe('deploy/backup.sh', () => {
  const sh = readFileSync(`${root}/deploy/backup.sh`, 'utf8');

  it('discovers the running containers instead of hardcoding them', () => {
    expect(sh).toContain('docker compose ps --services');
    // The old hardcoded loop is what caused the gap this suite guards.
    expect(sh).not.toMatch(/for svc in ps01 ps02/);
  });

  it('takes the stack directory as an argument, so it can back up a customer', () => {
    // Generated stacks live outside deploy/; running it there used to target
    // the reference stack in deploy/ instead — or nothing at all.
    expect(sh).toContain('STACK_DIR="${1:-$(dirname "$0")}"');
  });

  it('fails loudly when nothing was backed up', () => {
    expect(sh).toContain('nothing was backed up');
    expect(sh).toMatch(/exit 1/);
  });
});
