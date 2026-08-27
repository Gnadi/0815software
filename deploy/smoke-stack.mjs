#!/usr/bin/env node
/**
 * Smoke-test a PROVISIONED stack — no Docker required.
 *
 *   node deploy/smoke-stack.mjs --manifest ./customers/blaustern/manifest.json
 *   node deploy/smoke-stack.mjs --modules mod-04-invoice-billing,mod-13-offers
 *
 * `deploy/smoke.mjs` proves the ten Platform Services come up. This proves a
 * *customer's* stack comes up: exactly the services and modules in its
 * manifest, as local processes, in production mode, with freshly generated
 * secrets, and then asserts the properties an operator is actually relying on:
 *
 *   1. every service and module answers /api/health and /api/ready;
 *   2. the production boot guard really does refuse a default secret;
 *   3. every platform URL wired into a module is reachable, and a module with
 *      NO service URLs at all still boots and serves its API — the standalone
 *      guarantee this platform is built on;
 *   4. single sign-on works for the modules the registry marks supportsSso and
 *      is absent for the ones it does not;
 *   5. security headers are present on module responses, not only on services;
 *   6. the generated .env next to the manifest has no FILL-ME-IN left and no
 *      value that a boot guard would reject.
 *
 * Run it before the first `docker compose up` and after every upgrade. Exits
 * non-zero on any failure, naming what failed and why.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleById, peersOf, resolveSelection, serviceById, servicesOf } from '../modules/registry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A fresh PS-01 database seeds one organization with an owner who holds
 * platform:admin. A generated stack uses the customer's own org, but a smoke
 * boot has only the seeded one — so the SSO seam is exercised against that.
 */
const SEEDED_ORG = 'acme';
const SEEDED_OWNER = { email: 'owner@acme.test', password: 'demo-owner' };

/** Values every boot guard refuses under NODE_ENV=production. */
const KNOWN_DEFAULTS = new Set([
  'dev-secret-change-me',
  'change-me',
  'admin',
  'agent',
  'dev-service-token',
  'dev-webhook-secret',
  'dev-intake-secret',
  '0'.repeat(64),
]);

/**
 * What "the module refused this login" is allowed to look like: a rejected
 * credential (401), or a module that has no login endpoint at all (404 — the
 * storefront is a public shop and never had one).
 *
 * Deliberately NOT "anything that isn't 200". A module whose PS-01 call times
 * out also fails to sign anyone in, and the looser form reported green on a
 * stack whose identity service was unreachable — the failure hid inside a
 * passing check. 503 now means exactly that outage, and it is not a refusal:
 * nothing ever judged the credential.
 */
const REFUSED = new Set([401, 404]);

const refusalDetail = (status) =>
  status === 503
    ? 'login returned 503 — PS-01 was unreachable, so nothing rejected the credential'
    : `login returned ${status}, expected 401 (rejected) or 404 (no login endpoint)`;

/**
 * The smoke test drives every module's login from ONE IP, and each SSO module
 * login is forwarded to PS-01 as another login. A real stack spreads those over
 * one container IP per module, but here they all land in the same per-IP bucket
 * and a 14-module run would trip PS-01's default 20/min login limit — turning a
 * working stack into a red test. So the boot raises the login bucket; the
 * hardening middleware itself (headers, CORS, the general limiter) is unchanged
 * and still asserted.
 */
const SMOKE_LOGIN_RATE_LIMIT_RPM = '600';

/** Stand-ins for the values a real stack asks the customer to supply. */
const SMOKE_VALUES = {
  SELLER_NAME: 'Smoke Test GmbH',
  SELLER_ADDRESS: 'Teststrasse 1|1010 Wien|Austria',
  SELLER_VAT_ID: 'ATU99999999',
  SELLER_EMAIL: 'smoke@example.test',
  SELLER_IBAN: 'AT99 9999 9999 9999 9999',
  SELLER_BIC: 'SMOKEXX',
};

const USAGE = `Usage:
  node deploy/smoke-stack.mjs --manifest <path/to/manifest.json>
  node deploy/smoke-stack.mjs --modules <id,...> [--all-services]

Options:
  --manifest <path>   Smoke the stack a generated manifest.json describes.
  --modules <id,...>  Smoke an ad-hoc selection instead (same resolution rules).
  --all-services      With --modules: include all ten Platform Services.
  --keep-going        Report every failure instead of stopping at the first.
  --help              Show this message.`;

// ── Reporting ────────────────────────────────────────────────────────────────

let failures = 0;
let keepGoing = false;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

class SmokeAbort extends Error {}

function pass(what) {
  console.log(`  ${c.green('✓')} ${what}`);
}

function fail(what, detail) {
  failures += 1;
  console.log(`  ${c.red('✗')} ${what}`);
  if (detail) console.log(`      ${c.red(detail)}`);
  if (!keepGoing) throw new SmokeAbort(what);
}

function check(what, ok, detail) {
  if (ok) pass(what);
  else fail(what, detail);
}

// ── Process supervision ──────────────────────────────────────────────────────

const children = [];
let dataDir;

function shutdown() {
  // Children run detached in their own process group: the tsx bin is a wrapper
  // whose node process would survive a plain child.kill().
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
process.on('SIGTERM', () => (shutdown(), process.exit(143)));
process.on('SIGINT', () => (shutdown(), process.exit(130)));

/** Spawn one package's server from source via its own tsx. */
function boot({ group, id, port, env, collectOutput = false }) {
  const cwd = join(ROOT, group, id);
  const tsx = join(cwd, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) {
    throw new Error(`${group}/${id} has no node_modules — run "npm install" in it first`);
  }
  const child = spawn(tsx, ['server/index.ts'], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_PATH: join(dataDir, `${id}-${port}.db`),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (d) => collectOutput && output.push(String(d)));
  child.stderr.on('data', (d) => {
    if (collectOutput) output.push(String(d));
    else if (/error|refus|exception/i.test(String(d))) process.stderr.write(c.dim(`[${id}] ${d}`));
  });
  children.push(child);
  return { child, output, url: `http://127.0.0.1:${port}` };
}

async function waitForHealth(label, url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} at ${url}/api/health`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function portFree(port) {
  return fetch(`http://127.0.0.1:${port}/api/health`).then(
    () => false,
    () => true,
  );
}

// ── Selection ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-services' || arg === '--keep-going' || arg === '--help') raw[arg] = true;
    else if (arg === '--manifest' || arg === '--modules') {
      raw[arg] = argv[i + 1];
      if (!raw[arg] || raw[arg].startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
    } else throw new Error(`unknown argument "${arg}"\n\n${USAGE}`);
  }
  if (raw['--help']) return { help: true };
  if (!raw['--manifest'] && !raw['--modules']) throw new Error(`give --manifest or --modules\n\n${USAGE}`);
  if (raw['--manifest'] && raw['--modules']) throw new Error('--manifest and --modules are mutually exclusive');
  return {
    help: false,
    manifest: raw['--manifest'],
    moduleIds: raw['--modules']?.split(',').map((s) => s.trim()).filter(Boolean),
    allServices: raw['--all-services'] === true,
    keepGoing: raw['--keep-going'] === true,
  };
}

/** Resolve the stack under test, from a manifest or from an ad-hoc selection. */
function loadStack(options) {
  if (!options.manifest) {
    const stack = resolveSelection(options.moduleIds, { allServices: options.allServices });
    return { ...stack, label: `ad-hoc selection (${options.moduleIds.length} modules)`, dir: null };
  }
  const path = resolve(options.manifest);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(manifest.modules) || !Array.isArray(manifest.services)) {
    throw new Error(`${path} is not a provision manifest (no modules/services arrays)`);
  }
  return {
    modules: manifest.modules.map((m) => moduleById(m.id)),
    services: manifest.services.map((s) => serviceById(s.id)),
    needsTicker: manifest.ticker === true,
    manifest,
    label: `${manifest.customer} (${manifest.domain})`,
    dir: dirname(path),
  };
}

// ── Static checks on the generated .env ──────────────────────────────────────

function checkGeneratedEnv(stack) {
  if (!stack.dir) return;
  const envPath = join(stack.dir, '.env');
  if (!existsSync(envPath)) {
    console.log(`  ${c.dim('–')} no .env next to the manifest — skipping the configuration checks`);
    return;
  }
  const text = readFileSync(envPath, 'utf8');
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }

  const unfilled = [...values].filter(([, v]) => v.includes('FILL-ME-IN')).map(([k]) => k);
  check(
    '.env has no FILL-ME-IN placeholders left',
    unfilled.length === 0,
    unfilled.length > 0 ? `still unset: ${unfilled.join(', ')}` : undefined,
  );

  const defaults = [...values].filter(([, v]) => KNOWN_DEFAULTS.has(v)).map(([k]) => k);
  check(
    '.env carries no secret a boot guard would reject',
    defaults.length === 0,
    defaults.length > 0 ? `dev defaults in: ${defaults.join(', ')}` : undefined,
  );

  // Every secret the registry declares for this stack must have a real value.
  const missing = [];
  const prefix = (id) => `${id.split('-')[0]}${id.split('-')[1]}_`.toUpperCase();
  for (const service of stack.services) {
    for (const name of service.secrets) {
      if (name === 'SERVICE_TOKEN') continue; // the stack-wide PLATFORM_SERVICE_TOKEN
      const key = `${prefix(service.id)}${name}`;
      if (!values.get(key)) missing.push(key);
    }
  }
  for (const mod of stack.modules) {
    for (const name of mod.env.secrets) {
      const key = `${prefix(mod.id)}${name}`;
      if (!values.get(key)) missing.push(key);
    }
  }
  if (!values.get('PLATFORM_SERVICE_TOKEN')) missing.push('PLATFORM_SERVICE_TOKEN');
  check(
    '.env defines every secret the registry declares for this stack',
    missing.length === 0,
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
  );

  const compose = join(stack.dir, 'docker-compose.yml');
  if (existsSync(compose)) {
    const referenced = [...readFileSync(compose, 'utf8').matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]);
    const undefinedVars = [...new Set(referenced)].filter((name) => !values.has(name));
    check(
      'docker-compose.yml references no variable .env leaves undefined',
      undefinedVars.length === 0,
      undefinedVars.length > 0 ? `undefined: ${undefinedVars.join(', ')}` : undefined,
    );
  }
}

// ── Booting ──────────────────────────────────────────────────────────────────

function freshSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * A module POINTED AT another module's database opens SOURCE_DB_PATH read-only
 * and refuses to boot when the path is set but missing. In a real stack that
 * file is another container's volume; here we create an empty one with the
 * module's own better-sqlite3 so the read-only open succeeds. Only called for
 * a module the stack actually pointed somewhere — accepting a source database
 * is optional, and the standalone checks deliberately set nothing.
 */
function makeSourceDb(mod, port) {
  const path = join(dataDir, `${mod.id}-${port}-source.db`);
  execFileSync(process.execPath, ['-e', 'new (require("better-sqlite3"))(process.argv[1]).close()', path], {
    cwd: join(ROOT, 'modules', mod.id),
    stdio: 'ignore',
  });
  return path;
}

async function bootStack(stack) {
  const serviceToken = freshSecret();
  const urls = new Map();
  const secrets = new Map();

  for (const service of stack.services) {
    const env = { SERVICE_TOKEN: serviceToken, LOGIN_RATE_LIMIT_RPM: SMOKE_LOGIN_RATE_LIMIT_RPM };
    for (const name of service.secrets) {
      if (name === 'SERVICE_TOKEN') continue;
      env[name] = freshSecret();
    }
    if (service.id !== 'ps-01-identity' && stack.services.some((s) => s.id === 'ps-01-identity')) {
      env.IDENTITY_URL = `http://127.0.0.1:${serviceById('ps-01-identity').defaultPort}`;
    }
    secrets.set(service.id, env);
    const { url } = boot({ group: 'platform', id: service.id, port: service.defaultPort, env });
    urls.set(service.id, url);
  }

  // Module-to-module bridges declared in the registry (`peers`) are wired only
  // when both modules are in this stack — the same rule the generator applies.
  const modulePorts = new Map(stack.modules.map((mod) => [mod.id, mod.defaultPort]));

  // Whether a module that ACCEPTS a source database was actually pointed at
  // one. A manifest records the operator's choice (`sourceDb`, null when the
  // module was provisioned standalone); an ad-hoc --modules run has no such
  // record, so it exercises the pointed-at-a-database configuration.
  const pointedAtSource = (mod) => {
    if (!mod.constraints.acceptsSourceDb) return false;
    if (!stack.manifest) return true;
    return stack.manifest.modules.some((m) => m.id === mod.id && m.sourceDb);
  };

  const modules = [];
  for (const mod of stack.modules) {
    const env = {
      PLATFORM_SERVICE_TOKEN: serviceToken,
      LOGIN_RATE_LIMIT_RPM: SMOKE_LOGIN_RATE_LIMIT_RPM,
      ...SMOKE_VALUES,
    };
    for (const name of mod.env.secrets) env[name] = freshSecret();
    const wired = [];
    for (const service of servicesOf(mod)) {
      if (service.urlEnv === 'IDENTITY_URL' && !mod.constraints.supportsSso) continue;
      if (!urls.has(service.id)) continue;
      env[service.urlEnv] = urls.get(service.id);
      wired.push(service);
    }
    if (mod.constraints.supportsSso && urls.has('ps-01-identity')) env.IDENTITY_ORG = SEEDED_ORG;
    if (mod.constraints.needsPublicBaseUrl) env.PUBLIC_BASE_URL = `http://127.0.0.1:${mod.defaultPort}`;
    if (pointedAtSource(mod)) {
      env.SOURCE_DB_PATH = makeSourceDb(mod, mod.defaultPort);
      // Mirror the generated stack: a manifest records whether the source
      // publishes a report_* contract, and the consumer is restricted to it.
      if (stack.manifest?.modules.some((m) => m.id === mod.id && m.sourceViewsOnly)) {
        env.SOURCE_VIEWS_ONLY = 'true';
      }
    }

    const peers = [];
    for (const peer of peersOf(mod)) {
      if (!modulePorts.has(peer.id)) continue;
      env[peer.urlEnv] = `http://127.0.0.1:${modulePorts.get(peer.id)}`;
      peers.push(peer);
    }

    const { url } = boot({ group: 'modules', id: mod.id, port: mod.defaultPort, env });
    modules.push({ mod, url, env, wired, peers, adminPassword: env.ADMIN_PASSWORD, secrets: env });
    urls.set(mod.id, url);
  }

  return { serviceToken, urls, secrets, modules };
}

// ── Assertions ───────────────────────────────────────────────────────────────

async function checkHealthAndReady(label, url) {
  await waitForHealth(label, url);
  const health = await fetch(`${url}/api/health`);
  check(`${label} answers /api/health`, health.ok, `status ${health.status}`);
  const ready = await fetch(`${url}/api/ready`);
  const body = ready.ok ? await ready.json().catch(() => ({})) : {};
  check(`${label} answers /api/ready`, ready.ok && body.ready === true, `status ${ready.status}`);
}

function checkSecurityHeaders(label, res) {
  const missing = [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'no-referrer'],
    ['strict-transport-security', null],
  ].filter(([name, expected]) => {
    const value = res.headers.get(name);
    return value === null || (expected !== null && value !== expected);
  });
  check(
    `${label} sets security headers`,
    missing.length === 0,
    missing.length > 0 ? `missing or wrong: ${missing.map(([n]) => n).join(', ')}` : undefined,
  );
}

/** Log into a Platform Service's operator console; returns its bearer token. */
async function serviceAdminToken(url, password) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return typeof body.token === 'string' ? body.token : null;
}

/** A PS-01 session token for the seeded owner, who holds platform:admin. */
async function identityOwnerToken(url) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_slug: SEEDED_ORG, ...SEEDED_OWNER }),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return typeof body.token === 'string' ? body.token : null;
}

async function login(url, credentials) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  return res.status;
}

/**
 * A module booted with no platform URLs at all must still come up and serve.
 *
 * SOURCE_DB_PATH is deliberately NOT set here either, even for a module that
 * accepts one: accepting a source database is optional, so "standalone" has to
 * mean nothing wired at all. The module generates its own source on first boot.
 */
async function checkStandalone(mod, port) {
  const env = { ...SMOKE_VALUES, ADMIN_PASSWORD: freshSecret(), SESSION_SECRET: freshSecret() };
  for (const name of mod.env.secrets) env[name] = freshSecret();
  const { url } = boot({ group: 'modules', id: mod.id, port, env });
  try {
    await waitForHealth(`${mod.n} standalone`, url, 45_000);
    const ready = await fetch(`${url}/api/ready`);
    const body = ready.ok ? await ready.json().catch(() => ({})) : {};
    check(
      `${mod.n} boots standalone with no service URLs and serves its API`,
      ready.ok && body.ready === true,
      `/api/ready returned ${ready.status}`,
    );
  } catch (err) {
    fail(`${mod.n} boots standalone with no service URLs and serves its API`, err.message);
  }
}

/** The boot guard must refuse a well-known dev default in production. */
async function checkBootGuard({ group, id, label, port, env }) {
  const { child, output } = boot({
    group,
    id,
    port,
    env: { ...env, SESSION_SECRET: 'dev-secret-change-me' },
    collectOutput: true,
  });
  const code = await new Promise((done) => {
    child.on('exit', (exitCode) => done(exitCode ?? 1));
    setTimeout(() => done(null), 20_000);
  });
  const text = output.join('');
  check(
    `${label} refuses to boot on a default SESSION_SECRET`,
    // Matched against what the guards actually print. This read "default
    // secrets" while all 28 of them say "unusable secrets — still set to a
    // shipped default", so the check could never pass: the guard fired
    // correctly every time and the smoke test called it a failure. Found by
    // running docs/TEST-PLAN-PS-12.md; the drift predates that branch.
    code !== null && code !== 0 && /refusing to start in production with unusable secrets/.test(text),
    code === null
      ? 'it was still running after 20s — the guard did not fire'
      : `exit ${code}; output: ${text.trim().split('\n').slice(-2).join(' ') || '(none)'}`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  keepGoing = options.keepGoing;

  const stack = loadStack(options);
  console.log(c.bold(`\n  Stack smoke test — ${stack.label}`));
  console.log(
    c.dim(
      `  ${stack.services.length} service(s): ${stack.services.map((s) => s.n).join(', ') || 'none'}\n` +
        `  ${stack.modules.length} module(s): ${stack.modules.map((m) => m.n).join(', ')}\n`,
    ),
  );

  console.log(c.cyan('  Configuration'));
  checkGeneratedEnv(stack);

  // Never let a stale listener answer in place of a freshly booted process.
  const ports = [
    ...stack.services.map((s) => [s.n, s.defaultPort]),
    ...stack.modules.map((m) => [m.n, m.defaultPort]),
  ];
  for (const [label, port] of ports) {
    if (!(await portFree(port))) {
      throw new Error(`port ${port} is already serving (stale ${label}? stop it and re-run)`);
    }
  }

  dataDir = mkdtempSync(join(tmpdir(), 'stack-smoke-'));
  console.log(`\n${c.cyan('  Boot')}`);
  const booted = await bootStack(stack);

  for (const service of stack.services) {
    await checkHealthAndReady(`${service.n} ${service.label}`, booted.urls.get(service.id));
  }
  for (const { mod, url } of booted.modules) {
    await checkHealthAndReady(`${mod.n} ${mod.title}`, url);
  }

  console.log(`\n${c.cyan('  Platform wiring')}`);
  for (const { mod, wired } of booted.modules) {
    if (wired.length === 0) {
      pass(`${mod.n} references no Platform Service — nothing to wire`);
      continue;
    }
    const unreachable = [];
    for (const service of wired) {
      const ok = await fetch(`${booted.urls.get(service.id)}/api/health`).then((r) => r.ok, () => false);
      if (!ok) unreachable.push(service.n);
    }
    check(
      `${mod.n} reaches all ${wired.length} service(s) it is wired to (${wired.map((s) => s.n).join(', ')})`,
      unreachable.length === 0,
      unreachable.length > 0 ? `unreachable: ${unreachable.join(', ')}` : undefined,
    );
  }
  for (const { mod, peers } of booted.modules) {
    if (peers.length === 0) continue;
    const unreachable = [];
    for (const peer of peers) {
      const ok = await fetch(`${booted.urls.get(peer.id)}/api/health`).then((r) => r.ok, () => false);
      if (!ok) unreachable.push(peer.id);
    }
    check(
      `${mod.n} reaches the module(s) it bridges to (${peers.map((p) => `${p.id} via ${p.urlEnv}`).join(', ')})`,
      unreachable.length === 0,
      unreachable.length > 0 ? `unreachable: ${unreachable.join(', ')}` : undefined,
    );
  }

  if (booted.urls.has('ps-11-customers')) {
    const url = booted.urls.get('ps-11-customers');
    const resolve = (payload) =>
      fetch(`${url}/api/parties/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': booted.serviceToken },
        body: JSON.stringify(payload),
      });

    const first = await resolve({ name: 'Smoke Party GmbH', vat_id: 'ATU00000001' });
    const firstBody = first.ok ? await first.json().catch(() => ({})) : {};
    check(
      'PS-11 resolves a party with the stack machine token',
      first.ok && typeof firstBody?.party?.id === 'number',
      `status ${first.status}`,
    );

    // The property the whole service exists for: two consumers, one record.
    const again = await resolve({
      name: 'Smoke Party',
      vat_id: 'atu 0000 0001',
      source: 'smoke-stack',
      external_id: '1',
    });
    const againBody = again.ok ? await again.json().catch(() => ({})) : {};
    check(
      'PS-11 converges a second consumer onto the same party',
      again.ok && againBody?.party?.id === firstBody?.party?.id && againBody?.matched_on === 'vat_id',
      `status ${again.status}, matched_on ${againBody?.matched_on}`,
    );

    // A supplier with the SAME vat id must stay a separate relationship.
    const supplier = await resolve({ kind: 'supplier', name: 'Smoke Party GmbH', vat_id: 'ATU00000001' });
    const supplierBody = supplier.ok ? await supplier.json().catch(() => ({})) : {};
    check(
      'PS-11 keeps a supplier separate from a customer with the same VAT id',
      supplier.ok && supplierBody?.created === true && supplierBody?.party?.id !== firstBody?.party?.id,
      `status ${supplier.status}`,
    );
  }

  if (booted.urls.has('ps-07-audit-log')) {
    const url = booted.urls.get('ps-07-audit-log');
    const token = await serviceAdminToken(url, booted.secrets.get('ps-07-audit-log').ADMIN_PASSWORD);
    if (!token) {
      fail('PS-07 accepts its generated operator password', 'login did not return a token');
    } else {
      pass('PS-07 accepts its generated operator password');
      const verify = await fetch(`${url}/api/verify`, { headers: { Authorization: `Bearer ${token}` } });
      const body = verify.ok ? await verify.json().catch(() => ({})) : {};
      check(
        'PS-07 audit chain verifies (tamper-evident log intact)',
        verify.ok && body.valid === true,
        `status ${verify.status}`,
      );
    }
  }

  // The seller letterhead: with PS-11 in the stack, setting the `self` party is
  // what a module must pick up — the duplicated SELLER_* env is only a fallback.
  const sellerModules = booted.modules.filter(({ mod }) => mod.env.required.some((name) => name.startsWith('SELLER_')));
  if (booted.urls.has('ps-11-customers') && sellerModules.length > 0) {
    const url = booted.urls.get('ps-11-customers');
    const res = await fetch(`${url}/api/self`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': booted.serviceToken },
      body: JSON.stringify({ name: 'Smoke Seller GmbH', vat_id: 'ATU00000002', address_lines: ['Rauchweg 1'] }),
    });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    check(
      `PS-11 stores the seller identity that ${sellerModules.map(({ mod }) => mod.n).join(', ')} print`,
      res.ok && body?.party?.kind === 'self',
      `status ${res.status}`,
    );
    // A fresh PS-11 must NOT invent one, or it would silently replace a
    // customer's configured letterhead the moment it joined their stack.
    check(
      'PS-11 ships no seeded seller that could override a configured letterhead',
      body?.party?.name === 'Smoke Seller GmbH',
      `self party is ${JSON.stringify(body?.party?.name)}`,
    );
  }

  console.log(`\n${c.cyan('  Security')}`);
  for (const { mod, url } of booted.modules) {
    checkSecurityHeaders(`${mod.n} ${mod.title}`, await fetch(`${url}/api/health`));
  }
  for (const service of stack.services.slice(0, 1)) {
    checkSecurityHeaders(`${service.n} ${service.label}`, await fetch(`${booted.urls.get(service.id)}/api/health`));
  }

  console.log(`\n${c.cyan('  Single sign-on')}`);
  const hasIdentity = booted.urls.has('ps-01-identity');
  for (const { mod, url } of booted.modules) {
    const status = await login(url, {
      org_slug: SEEDED_ORG,
      username: SEEDED_OWNER.email,
      email: SEEDED_OWNER.email,
      password: SEEDED_OWNER.password,
    });
    if (mod.constraints.supportsSso && hasIdentity) {
      check(`${mod.n} accepts a PS-01 session through the SSO seam`, status === 200, `login returned ${status}`);
    } else {
      check(
        `${mod.n} has no SSO seam and rejects PS-01 credentials (by design)`,
        REFUSED.has(status),
        refusalDetail(status),
      );
    }
  }
  for (const { mod, url } of booted.modules) {
    // A DIFFERENT bogus account per module. An SSO module forwards this to
    // PS-01 as a login, and PS-01 deliberately makes repeated guesses at one
    // account slow (throttle.ts: 1s doubling to 30s). Reusing one name here
    // meant the 14 modules sprayed a single account: by the last few the
    // backoff exceeded the client's 10s timeout, so the module reported its
    // identity service as unreachable and the check went green anyway on the
    // old `status !== 200`. What this asserts is that a wrong credential is
    // refused; that guessing at one account gets expensive is PS-01's own
    // throttle test.
    const bogus = `wrong-${mod.n.toLowerCase()}@invalid.test`;
    const status = await login(url, { username: bogus, email: bogus, password: 'definitely-wrong' });
    check(`${mod.n} rejects wrong credentials`, REFUSED.has(status), refusalDetail(status));
  }
  // The service-to-service seam: a PS-01 principal holding platform:admin is
  // accepted by the other services in the stack, so one identity spans it.
  const downstream = stack.services.find((s) => s.id !== 'ps-01-identity');
  if (hasIdentity && downstream) {
    const token = await identityOwnerToken(booted.urls.get('ps-01-identity'));
    if (!token) {
      fail('PS-01 issues a session for the seeded owner', 'login did not return a token');
    } else {
      const res = await fetch(`${booted.urls.get(downstream.id)}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      check(`${downstream.n} accepts a PS-01 platform:admin session through the seam`, res.ok, `status ${res.status}`);
    }
  }

  console.log(`\n${c.cyan('  Standalone guarantee')}`);
  // A high offset keeps these off the stack's own ports.
  let offset = 0;
  for (const mod of stack.modules) {
    await checkStandalone(mod, mod.defaultPort + 2000 + offset);
    offset += 1;
  }

  console.log(`\n${c.cyan('  Boot guard')}`);
  const guardModule = stack.modules[0];
  await checkBootGuard({
    group: 'modules',
    id: guardModule.id,
    label: `${guardModule.n} ${guardModule.title}`,
    port: guardModule.defaultPort + 2500,
    // No SOURCE_DB_PATH even for a module that accepts one: the production
    // boot guard runs before any source handling, and a source database is
    // not a precondition for booting.
    env: { ...SMOKE_VALUES, ADMIN_PASSWORD: freshSecret() },
  });
  if (stack.services.length > 0) {
    await checkBootGuard({
      group: 'platform',
      id: stack.services[0].id,
      label: `${stack.services[0].n} ${stack.services[0].label}`,
      port: stack.services[0].defaultPort + 2500,
      env: { SERVICE_TOKEN: freshSecret(), ADMIN_PASSWORD: freshSecret() },
    });
  }
}

const started = Date.now();
try {
  await main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof SmokeAbort)) {
    failures += 1;
    console.log(`  ${c.red('✗')} ${err.message}`);
  }
} finally {
  shutdown();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures === 0) {
    console.log(`\n  ${c.green(c.bold('STACK SMOKE OK'))} — in ${seconds}s\n`);
  } else {
    console.log(`\n  ${c.red(c.bold(`STACK SMOKE FAILED`))} — ${failures} check(s) in ${seconds}s\n`);
    process.exitCode = 1;
  }
}
