import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The published spec, against the routes that actually exist.
 *
 * Nothing checked `openapi.yaml` at all: it was possible to break the file's
 * YAML outright — an unterminated quoted string — and watch the entire suite
 * stay green. A spec nobody parses is a document, not an interface, and this
 * one is what a consumer builds against.
 *
 * Drift is the more valuable half. A route added without a spec entry is
 * invisible to every consumer; an entry left behind after a route is removed
 * sends them at a 404. Both are silent, and both are found by comparing the
 * two lists rather than by reading either.
 *
 * The parsing here is deliberately small — no YAML dependency for a file this
 * regular — and it is strict about the shape it expects, so a spec reformatted
 * beyond it fails loudly rather than quietly matching nothing.
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'server/app.ts'), 'utf8');
const spec = readFileSync(join(ROOT, 'openapi.yaml'), 'utf8');

type Route = `${string} ${string}`;

/** What `app.ts` registers, with `:param` written the way the spec writes it. */
function registeredRoutes(): Set<Route> {
  const found = new Set<Route>();
  for (const match of app.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    const path = match[2]!.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    found.add(`${match[1]!} ${path}`);
  }
  return found;
}

/** What the spec documents, as method/path pairs. */
function documentedRoutes(): Set<Route> {
  const found = new Set<Route>();
  let path: string | null = null;
  for (const line of spec.split('\n')) {
    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine) {
      path = pathLine[1]!;
      continue;
    }
    const verb = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (verb && path !== null) found.add(`${verb[1]!} ${path}`);
  }
  return found;
}

describe('openapi.yaml', () => {
  it('is well-formed enough to read — every quoted scalar is closed', () => {
    // The failure that started this: a `description: '…` with no closing quote
    // swallowed the following lines and made the whole document unparseable.
    const unbalanced: string[] = [];
    spec.split('\n').forEach((line, index) => {
      const scalar = /^\s*[A-Za-z_][\w-]*:\s+'(.*)$/.exec(line);
      if (scalar && !scalar[1]!.endsWith("'")) unbalanced.push(`${index + 1}: ${line.trim()}`);
    });
    expect(unbalanced).toEqual([]);
  });

  it('finds routes on both sides, so a broken parser cannot pass silently', () => {
    expect(registeredRoutes().size).toBeGreaterThan(40);
    expect(documentedRoutes().size).toBeGreaterThan(40);
  });

  it('documents every route the service registers', () => {
    const undocumented = [...registeredRoutes()].filter((r) => !documentedRoutes().has(r)).sort();
    expect(undocumented).toEqual([]);
  });

  it('registers every route the spec documents', () => {
    const phantom = [...documentedRoutes()].filter((r) => !registeredRoutes().has(r)).sort();
    expect(phantom).toEqual([]);
  });
});
