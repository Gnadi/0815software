import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Properties of the source itself, not of what it does.
 *
 * This suite exists because of one defect that no amount of behavioural
 * testing would have found: `server/chain.ts` shipped with a literal NUL byte
 * in a string, written by accident. Every test passed — the byte worked
 * perfectly well as a separator — but git classifies a file containing NUL as
 * binary, so `git diff` reported `Bin 13211 -> 13741 bytes` and showed
 * nothing at all.
 *
 * The most security-sensitive file in the change would have reached a pull
 * request with no reviewable diff, and the reviewer would have had no way to
 * notice from the pull request that this had happened.
 *
 * A control character in source is never intentional here. Where a test needs
 * one it writes an escape (`'\\u0000'`), which is ordinary text.
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIRECTORIES = ['server', 'shared', 'test', 'scripts'];
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.json', '.md', '.yaml', '.yml'];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      // Vendored schemas and fixtures are data, not source: a .p12 or a
      // binary example belongs there and is not this suite's business.
      if (entry === 'node_modules' || entry === 'fixtures' || entry === 'schema') continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
    }
  };
  walk(dir);
  return found;
}

const FILES = DIRECTORIES.flatMap((d) => {
  try {
    return sourceFiles(join(ROOT, d));
  } catch {
    return []; // an optional directory this package does not have
  }
});

describe('the source files themselves', () => {
  it('finds files to check, so a broken walk cannot pass silently', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('contains no NUL byte — one makes the file binary to git and its diff invisible', () => {
    const offenders = FILES.filter((f) => readFileSync(f).includes(0x00)).map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('contains no other stray control characters', () => {
    // Tab, newline and carriage return are ordinary. Everything else below
    // 0x20 is a typo somebody will never see.
    const allowed = new Set([0x09, 0x0a, 0x0d]);
    const offenders: string[] = [];
    for (const file of FILES) {
      const bytes = readFileSync(file);
      for (const byte of bytes) {
        if (byte < 0x20 && !allowed.has(byte)) {
          offenders.push(`${file.slice(ROOT.length + 1)} (0x${byte.toString(16).padStart(2, '0')})`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
