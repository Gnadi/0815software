/**
 * The readiness contract, re-derived from every package's own source.
 *
 * `/api/ready` is not `/api/health` with a different name. Health is "this
 * process is alive"; readiness is "this package can serve", and the whole stack
 * reads the answer: the generated Compose health-check polls it, the generated
 * Prometheus blackbox probe polls it, and `deploy/smoke-stack.mjs` — the
 * pre-flight an operator is told to run before the first `docker compose up`
 * and after every upgrade — asserts `body.ready === true` on it.
 *
 * Twenty-seven packages answered `{ ready: … }`. Two — the shells, the newest
 * modules, written after the idiom was established — answered `{ ok: … }`,
 * which is the health payload. Both returned 200, so their own suites (which
 * asserted only the status) were green, the containers went healthy, and the
 * only thing that noticed was the smoke test: any customer stack containing a
 * shell failed its own pre-flight, on a check that had nothing to do with the
 * stack.
 *
 * So the shape is pinned here, once, for every package at the same time —
 * the same posture `registry.test.ts` takes on the registry's claims.
 *
 * Offline by construction: it reads source files, it does not boot anything.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modules, services } from '../../modules/registry.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Every package that serves an HTTP API, as (group, id) pairs. */
const packages: { group: 'modules' | 'platform'; id: string }[] = [
  ...modules.map((m: { id: string }) => ({ group: 'modules' as const, id: m.id })),
  ...services.map((s: { id: string }) => ({ group: 'platform' as const, id: s.id })),
];

/**
 * The body of the `/api/ready` handler in a package's app.ts.
 *
 * Matched from the route registration to the next route registration rather
 * than by brace counting: every copy of this handler in the repo is a short
 * try/catch, and a looser match would silently read the wrong routes.
 */
function readyHandler(group: 'modules' | 'platform', id: string): string {
  const source = readFileSync(`${root}/${group}/${id}/server/app.ts`, 'utf8');
  const start = source.indexOf("app.get('/api/ready'");
  expect(start, `${id} serves no /api/ready`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('app.get(') >= 0 ? rest.indexOf('app.get(') : rest.indexOf('app.post(');
  return rest.slice(0, end > 0 ? end : 2_000);
}

describe('every package answers readiness in one shape', () => {
  it.each(packages)('$id reports `ready`, not `ok`', ({ group, id }) => {
    const handler = readyHandler(group, id);
    expect(handler, `${id} answers /api/ready with a payload the stack cannot read`).toMatch(
      /res\.json\(\{\s*ready:\s*true/,
    );
    expect(handler, `${id} does not report a failed readiness probe as \`ready: false\``).toMatch(
      /status\(503\)\.json\(\{\s*ready:\s*false/,
    );
    // `ok` belongs to /api/health. Finding it here means the two were confused.
    expect(handler, `${id} answers /api/ready with the /api/health payload`).not.toMatch(/\bok:\s*(true|false)\b/);
  });

  it('covers every package the registry knows about', () => {
    expect(packages).toHaveLength(modules.length + services.length);
    expect(packages.length).toBeGreaterThanOrEqual(28);
  });
});
