// Small process orchestrator for the demo: boots Platform Services and business
// modules as real child processes (each via its own tsx, exactly as it would run
// in production), waits for health, and tears the whole tree down cleanly.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const dataDir = mkdtempSync(join(tmpdir(), 'platform-demo-'));
const children = [];

/** Colours make the narrated transcript easy to skim in a terminal. */
export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/**
 * Spawn one service or module. `group` is 'platform' or 'modules', `name` the
 * directory, `port` its listen port, and `env` any extra configuration.
 */
export function boot({ group, name, port, env = {}, tag }) {
  const cwd = join(ROOT, group, name);
  const child = spawn(join(cwd, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(dataDir, `${name}.db`),
      // Dev mode: boot guards stay silent and adapters use their console/mock
      // fallbacks, so the whole demo runs offline with no vendor keys.
      NODE_ENV: 'development',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); // drain
  child.stderr.on('data', (d) => {
    const line = d.toString();
    // Surface genuine errors; suppress routine startup warnings so the
    // narrated transcript stays clean.
    if (/error|exception|throw/i.test(line)) process.stderr.write(c.dim(`[${tag ?? name}] ${line}`));
  });
  children.push(child);
  return `http://127.0.0.1:${port}`;
}

export function shutdown() {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
}
process.on('SIGTERM', () => (shutdown(), process.exit(143)));
process.on('SIGINT', () => (shutdown(), process.exit(130)));

export async function waitForHealth(services, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (const [label, url] of Object.entries(services)) {
    for (;;) {
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} at ${url}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** A tiny HTTP helper that keeps a cookie jar per client (for module sessions). */
export function client(baseUrl) {
  let cookie = null;
  return {
    baseUrl,
    cookie: () => cookie,
    async req(method, path, { body, token, serviceToken, headers = {} } = {}) {
      const h = { 'content-type': 'application/json', ...headers };
      if (cookie) h.cookie = cookie;
      if (token) h.authorization = `Bearer ${token}`;
      if (serviceToken) h['x-service-token'] = serviceToken;
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return { status: res.status, ok: res.ok, body: json };
    },
    get(path, opts) {
      return this.req('GET', path, opts);
    },
    post(path, body, opts) {
      return this.req('POST', path, { ...opts, body });
    },
  };
}
