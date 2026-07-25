#!/usr/bin/env node
/**
 * Deployment smoke test — no Docker required.
 *
 * Boots all ten Platform Services as local processes in PRODUCTION mode with
 * freshly generated secrets (proving the boot guards pass real config), waits
 * for every /api/health, then runs one cross-service identity round-trip:
 * a PS-01 owner session (holds platform:admin) must be accepted by PS-02
 * through the seam, and a member session (no platform:admin) must be
 * rejected. Exits non-zero on any failure.
 *
 *   node deploy/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const SERVICES = [
  ['ps-01-identity', 4001],
  ['ps-02-workflow-engine', 4002],
  ['ps-03-notification-hub', 4003],
  ['ps-04-ai-platform', 4004],
  ['ps-05-integration-hub', 4005],
  ['ps-06-file-storage', 4006],
  ['ps-07-audit-log', 4007],
  ['ps-08-payments', 4008],
  ['ps-09-search', 4009],
  ['ps-10-number', 4010],
];

const dataDir = mkdtempSync(join(tmpdir(), 'platform-smoke-'));
const secrets = {
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  SERVICE_TOKEN: randomBytes(16).toString('hex'),
  WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
};

const children = [];
function shutdown() {
  // Children are spawned detached in their own process group: the tsx bin is
  // a wrapper whose node process would survive a plain child.kill().
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
}
// Never leak service processes, even when this script itself is killed.
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

function bootAll() {
  for (const [svc, port] of SERVICES) {
    const cwd = join(root, 'platform', svc);
    // Use the service's own tsx binary directly — ten concurrent `npx`
    // invocations contend on the npx cache and can stall for minutes.
    const child = spawn(join(cwd, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        ...secrets,
        NODE_ENV: 'production',
        PORT: String(port),
        DATABASE_PATH: join(dataDir, `${svc}.db`),
        IDENTITY_URL: svc === 'ps-01-identity' ? '' : 'http://localhost:4001',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {}); // drain so the child never blocks on a full pipe
    child.stderr.on('data', (d) => process.stderr.write(`[${svc}] ${d}`));
    children.push(child);
  }
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
}

try {
  // Refuse to run against leftovers: a stale service on a port would answer
  // the checks in place of the freshly booted one and invalidate the result.
  for (const [svc, port] of SERVICES) {
    const stale = await fetch(`http://localhost:${port}/api/health`).then(() => true, () => false);
    if (stale) throw new Error(`port ${port} already serving (stale ${svc}? kill it and re-run)`);
  }

  bootAll();
  for (const [svc, port] of SERVICES) {
    await waitFor(`http://localhost:${port}/api/health`);
    const ready = await fetch(`http://localhost:${port}/api/ready`);
    if (!ready.ok) {
      fail(`${svc} not ready: ${ready.status}`);
      continue;
    }
    const metrics = await fetch(`http://localhost:${port}/api/metrics`);
    if (!metrics.ok || !(await metrics.text()).includes('http_requests_total')) {
      fail(`${svc} metrics missing`);
      continue;
    }
    console.log(`[smoke] ${svc} healthy + ready on :${port}`);
  }

  // Seam round-trip. The demo seed provides owner (platform:admin via owner
  // role) and member (no platform:admin) accounts.
  const login = async (email, password) => {
    const res = await fetch('http://localhost:4001/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_slug: 'acme', email, password }),
    });
    if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
    return (await res.json()).token;
  };
  const ownerToken = await login('owner@acme.test', 'demo-owner');
  const memberToken = await login('member@acme.test', 'demo-member');

  const seamCall = (token) =>
    fetch('http://localhost:4002/api/workflows', { headers: { Authorization: `Bearer ${token}` } });

  const ownerRes = await seamCall(ownerToken);
  if (ownerRes.status !== 200) fail(`owner (platform:admin) rejected by PS-02 seam: ${ownerRes.status}`);
  else console.log('[smoke] seam accepts owner (platform:admin) ✓');

  const memberRes = await seamCall(memberToken);
  if (memberRes.status !== 401) fail(`member (no platform:admin) was NOT rejected: ${memberRes.status}`);
  else console.log('[smoke] seam rejects member (no platform:admin) ✓');

  // Security headers present in production boots.
  const head = await fetch('http://localhost:4010/api/health');
  if (head.headers.get('x-content-type-options') !== 'nosniff') fail('security headers missing');
  else console.log('[smoke] security headers present ✓');

  if (process.exitCode !== 1) console.log('\nSMOKE OK — 10 services healthy, seam RBAC verified.');
} catch (err) {
  fail(err.message);
} finally {
  shutdown();
}
