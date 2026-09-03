/**
 * The real entry point, booted as a real process.
 *
 * `server/index.ts` is where configuration, the production boot guard, the
 * database, the seed, the hardening middleware and `listen` are finally wired
 * together — and it was the one file in this package with no test at all,
 * along with `server/guard.ts`, the A1 control it calls. The guard was
 * exercised only by `deploy/smoke-stack.mjs`, which boots the whole stack: a
 * useful check, and much too far away to be the only one. A refusal that stops
 * working would have been caught a directory away from the person who broke it.
 *
 * These cases spawn the actual entry point with `tsx`, the way the container
 * does, and read what it says. Nothing is mocked; the assertions are on stdout,
 * stderr, the exit code and an HTTP response from the port it opened.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../server/index.ts', import.meta.url));
const CWD = fileURLToPath(new URL('..', import.meta.url));
/**
 * `tsx` directly, not through `npx`.
 *
 * `npx` runs the real binary as a GRANDCHILD, so `child.kill()` reaps the
 * wrapper and leaves the server holding the port. The next case then failed to
 * bind, exited, and its assertions hit the leaked process from the run before —
 * a test that passes or fails depending on what the previous one left behind.
 */
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** An ephemeral port the OS has just confirmed is free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcessWithoutNullStreams | null = null;

afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
});

interface BootResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Boot the entry point and resolve once it either exits or prints its listening
 * line. `DATABASE_PATH=:memory:` keeps every case off the filesystem.
 */
function boot(env: Record<string, string>, waitForListen: boolean): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TSX, [ENTRY], {
      cwd: CWD,
      env: { ...process.env, DATABASE_PATH: ':memory:', ...env },
    });
    child = proc;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`boot timed out\nout: ${stdout}\nerr: ${stderr}`)), 30_000);
    const done = (code: number | null): void => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // The startup warnings go to stderr from the same `listen` callback, so
      // give the other stream a moment to arrive before reading either.
      if (waitForListen && stdout.includes('identity API on')) setTimeout(() => done(null), 250);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('exit', (code) => done(code));
    proc.on('error', reject);
  });
}


/** Poll until the server answers — `listen` logs a moment before it accepts. */
async function fetchWhenUp(url: string, attempts = 20): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last;
}

describe('the production boot guard refuses an unusable secret', () => {
  it('refuses the shipped default', async () => {
    const PORT = String(await freePort());
    const res = await boot({ NODE_ENV: 'production', SESSION_SECRET: 'dev-secret-change-me', PORT }, false);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/refusing to start in production with unusable secrets/);
    expect(res.stderr).toMatch(/still set to a shipped default: SESSION_SECRET/);
  }, 40_000);

  it('refuses a blank one — the uninterpolated-compose-variable case', async () => {
    const PORT = String(await freePort());
    const res = await boot({ NODE_ENV: 'production', SESSION_SECRET: '', PORT }, false);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/empty or blank: SESSION_SECRET/);
  }, 40_000);

  it('refuses one that is only whitespace', async () => {
    const PORT = String(await freePort());
    const res = await boot({ NODE_ENV: 'production', SESSION_SECRET: '   ', PORT }, false);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/empty or blank/);
  }, 40_000);

  it('names the fix rather than only the problem', async () => {
    const PORT = String(await freePort());
    const res = await boot({ NODE_ENV: 'production', SESSION_SECRET: 'change-me', PORT }, false);
    expect(res.stderr).toMatch(/openssl rand -hex 32/);
  }, 40_000);
});

describe('a correctly configured boot', () => {
  it('starts, serves, and refuses an anonymous request', async () => {
    const port = await freePort();
    const res = await boot(
      {
        NODE_ENV: 'production',
        SESSION_SECRET: 'a'.repeat(64),
        OAUTH_ALLOW_MOCK: 'false',
        PORT: String(port),
      },
      true,
    );
    expect(res.stdout).toContain(`identity API on http://localhost:${port}`);

    const health = await fetchWhenUp(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    // Hardening is mounted on a real boot, unlike in these unit suites.
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(health.headers.get('strict-transport-security')).toContain('max-age=');

    const guarded = await fetchWhenUp(`http://127.0.0.1:${port}/api/users`);
    expect(guarded.status).toBe(401);
  }, 40_000);

  it('warns out loud when the offline mock IdP is left enabled', async () => {
    // Development posture: no NODE_ENV, so the mock is on and the guard is off.
    const res = await boot({ SESSION_SECRET: 'b'.repeat(64), PORT: String(await freePort()) }, true);
    expect(res.stderr).toMatch(/mock IdP is enabled/);
    expect(res.stderr).toMatch(/without any credential/);
  }, 40_000);

  it('warns about the default secret outside production instead of refusing', async () => {
    const res = await boot({ SESSION_SECRET: 'dev-secret-change-me', PORT: String(await freePort()) }, true);
    expect(res.stdout).toContain('identity API on');
    expect(res.stderr).toMatch(/using the default SESSION_SECRET/);
  }, 40_000);

  it('refuses to start on a port that is not one, rather than silently taking the default', async () => {
    // A letter O for a zero: the service would otherwise come up on 4001 and be
    // unreachable at whatever the compose file mapped.
    const res = await boot({ SESSION_SECRET: 'c'.repeat(64), PORT: '473O1' }, false);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/PORT must be a whole number/);
  }, 40_000);
});

describe('the seed CLI', () => {
  it('provisions a usable database from an empty file, and is a no-op the second time', async () => {
    // `npm run seed` is a documented operator command and the only path that
    // reaches the CLI block at the bottom of server/seed.ts.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ps01-seed-'));
    const dbPath = join(dir, 'seeded.db');
    const SEED = fileURLToPath(new URL('../server/seed.ts', import.meta.url));

    const run = (): Promise<BootResult> =>
      new Promise((resolve, reject) => {
        const proc = spawn(TSX, [SEED], { cwd: CWD, env: { ...process.env, DATABASE_PATH: dbPath } });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
        proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        proc.on('error', reject);
        proc.on('exit', (code) => resolve({ code, stdout, stderr }));
      });

    try {
      const first = await run();
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('inserted 2 organizations, 4 users');
      // The API key is shown exactly once, at creation, and never again.
      expect(first.stdout).toMatch(/psk_[0-9a-f]{12}\.[0-9a-f]{48}/);
      expect(first.stdout).toContain(`database at ${dbPath}`);

      const second = await run();
      expect(second.code).toBe(0);
      // Re-running must not duplicate the tenants or mint a second key.
      expect(second.stdout).not.toContain('inserted 2 organizations');
      expect(second.stdout).not.toMatch(/psk_[0-9a-f]{12}\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
