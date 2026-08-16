/**
 * Unit tests for deploy/provision.mjs. Offline, no Docker: everything below
 * the CLI is a pure function of the options, so the interesting behaviour —
 * which services a selection needs, when the ticker earns its place, that no
 * secret is ever a default or reused, the mod-08 source-database rules, and
 * the refusal to clobber — is tested directly.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildContextFor,
  envPrefix,
  generateSecrets,
  newSecret,
  parseArgs,
  PLACEHOLDER,
  planStack,
  renderAll,
  renderCaddyfile,
  renderCompose,
  renderEnv,
  renderManifest,
  writeStack,
} from '../provision.mjs';
import { services as registryServices } from '../../modules/registry.mjs';

/** The dev defaults every service's boot guard refuses in production. */
const KNOWN_DEFAULTS = [
  'dev-secret-change-me',
  'change-me',
  'admin',
  'agent',
  'dev-service-token',
  'dev-webhook-secret',
  'dev-intake-secret',
  '0'.repeat(64),
];

const BASE = ['--customer', 'blaustern', '--domain', 'blaustern.example.com', '--out', '/tmp/unused'];
const args = (...extra: string[]) => parseArgs([...BASE, ...extra]);
const twoModules = () => args('--modules', 'mod-04-invoice-billing,mod-13-offers');

const tmpDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provision-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('accepts the documented invocation', () => {
    const options = twoModules();
    expect(options).toMatchObject({
      customer: 'blaustern',
      org: 'blaustern',
      domain: 'blaustern.example.com',
      moduleIds: ['mod-04-invoice-billing', 'mod-13-offers'],
      allServices: false,
      force: false,
    });
  });

  it('defaults the identity org to the customer slug and allows an override', () => {
    expect(twoModules().org).toBe('blaustern');
    expect(args('--modules', 'mod-13-offers', '--org', 'blaustern-at').org).toBe('blaustern-at');
  });

  it('rejects a missing required option', () => {
    expect(() => parseArgs(['--customer', 'x'])).toThrow(/missing --modules/);
    expect(() => parseArgs(['--modules', 'mod-13-offers'])).toThrow(/missing --customer/);
  });

  it('rejects a malformed customer, domain and org', () => {
    expect(() => parseArgs(['--customer', 'Blau Stern', '--modules', 'mod-13-offers', '--domain', 'a.example', '--out', '/x'])).toThrow(
      /lowercase slug/,
    );
    expect(() => args('--modules', 'mod-13-offers') && parseArgs(['--customer', 'x', '--modules', 'mod-13-offers', '--domain', 'not-a-host', '--out', '/x'])).toThrow(
      /not a hostname/,
    );
  });

  it('rejects an unknown argument and an option with no value', () => {
    expect(() => args('--modules', 'mod-13-offers', '--nope')).toThrow(/unknown argument "--nope"/);
    expect(() => parseArgs([...BASE, '--modules'])).toThrow(/--modules needs a value/);
  });

  it('reports an unknown module id with the list of known ones', () => {
    expect(() => planStack(args('--modules', 'mod-99-nonexistent'))).toThrow(/unknown module "mod-99-nonexistent"/);
  });

  it('rejects the same module selected twice', () => {
    expect(() => planStack(args('--modules', 'mod-13-offers,mod-13-offers'))).toThrow(/selected twice/);
  });
});

describe('service resolution', () => {
  const idsOf = (plan: any) => plan.services.map((s: any) => s.service.id);

  it('brings up only the services mod-04 + mod-13 reference', () => {
    expect(idsOf(planStack(twoModules()))).toEqual([
      'ps-01-identity',
      'ps-03-notification-hub',
      'ps-06-file-storage',
      'ps-07-audit-log',
      'ps-08-payments',
      'ps-10-number',
      'ps-11-customers',
      // MOD-04 references PS-12 for EN 16931 e-invoicing. Listed explicitly
      // rather than derived, because the point of this test is that a stack
      // brings up the services its modules ACTUALLY name and no others.
      'ps-12-einvoice',
    ]);
  });

  it('brings up every service with --all-services', () => {
    const all = idsOf(planStack(args('--modules', 'mod-04-invoice-billing,mod-13-offers', '--all-services')));
    expect(all).toHaveLength(registryServices.length);
    expect(all).toContain('ps-02-workflow-engine');
  });

  it('brings up one service for a one-service module', () => {
    expect(idsOf(planStack(args('--modules', 'mod-01-customer-portal')))).toEqual(['ps-07-audit-log']);
    expect(idsOf(planStack(args('--modules', 'mod-07-storefront')))).toEqual(['ps-08-payments']);
  });

  it('never pulls in PS-01 for a module that cannot use SSO', () => {
    // mod-01 and mod-07 keep their own identity model by explicit decision.
    for (const id of ['mod-01-customer-portal', 'mod-07-storefront', 'mod-09-document-management']) {
      const plan = planStack(args('--modules', id));
      expect(idsOf(plan)).not.toContain('ps-01-identity');
      expect(Object.keys(plan.modules[0].env)).not.toContain('IDENTITY_URL');
      expect(Object.keys(plan.modules[0].env)).not.toContain('IDENTITY_ORG');
    }
  });

  it('wires IDENTITY_URL for an SSO module and only then', () => {
    const plan = planStack(args('--modules', 'mod-13-offers,mod-09-document-management'));
    const [offers, documents] = plan.modules;
    expect(offers.env.IDENTITY_URL).toBe('http://ps01:4001');
    expect(offers.env.IDENTITY_ORG).toBe('${IDENTITY_ORG}');
    expect(documents.env.IDENTITY_URL).toBeUndefined();
  });

  it('points every wired URL at an internal container, not the public domain', () => {
    for (const { env } of planStack(twoModules()).modules) {
      for (const [name, value] of Object.entries(env)) {
        if (!name.endsWith('_URL') || name === 'PUBLIC_BASE_URL') continue;
        // Platform Services are ps01..ps11; a peer module is its subdomain.
        expect(value, name).toMatch(/^http:\/\/(ps\d\d|[a-z][a-z0-9-]*):\d{4}$/);
        expect(value, name).not.toContain('blaustern.example.com');
      }
    }
  });

  it('wires a declared peer module only when it is in the same stack', () => {
    const both = planStack(twoModules());
    const invoicing = both.modules.find((m: any) => m.mod.id === 'mod-04-invoice-billing')!;
    expect(invoicing.env.OFFERS_URL).toBe('http://offers:3013');
    expect(invoicing.peers.map((p: any) => p.id)).toEqual(['mod-13-offers']);

    // Licensed MOD-04 alone: no OFFERS_URL, so it behaves exactly as before.
    const alone = planStack(args('--modules', 'mod-04-invoice-billing'));
    expect(alone.modules[0].env.OFFERS_URL).toBeUndefined();
    expect(alone.modules[0].peers).toEqual([]);
    expect(renderCompose(alone, '..')).not.toContain('OFFERS_URL');
  });

  it('makes the bridged module a compose dependency', () => {
    const compose = renderCompose(planStack(twoModules()), '..');
    // invoicing depends on offers, so the bridge target is up first.
    expect(compose).toMatch(/invoicing:[\s\S]*?depends_on:[\s\S]*?- "offers"/);
  });

  it('sets PUBLIC_BASE_URL to the external URL where the registry demands one', () => {
    const plan = planStack(twoModules());
    const offers = plan.modules.find((m: any) => m.mod.id === 'mod-13-offers')!;
    const invoicing = plan.modules.find((m: any) => m.mod.id === 'mod-04-invoice-billing')!;
    expect(offers.env.PUBLIC_BASE_URL).toBe('https://offers.blaustern.example.com');
    expect(invoicing.env.PUBLIC_BASE_URL).toBeUndefined();
  });

  it('puts persisted directories on the mounted volume', () => {
    const plan = planStack(args('--modules', 'mod-09-document-management,mod-01-customer-portal'));
    const byId = new Map<string, Record<string, string>>(plan.modules.map((m: any) => [m.mod.id, m.env]));
    expect(byId.get('mod-09-document-management')!.STORAGE_DIR).toBe('/data/storage');
    expect(byId.get('mod-01-customer-portal')!.DOCUMENTS_DIR).toBe('/data/documents');
  });
});

describe('ticker inclusion', () => {
  it('runs a ticker when the stack contains a tick-driven service', () => {
    const plan = planStack(twoModules());
    expect(plan.needsTicker).toBe(true);
    // PS-03 and PS-08 tick; PS-01/06/07/10 do not.
    expect(plan.tickTargets.map((s: any) => s.n)).toEqual(['PS-03', 'PS-08']);
    expect(renderCompose(plan, '..')).toContain('ticker:');
  });

  it('runs no ticker when nothing in the stack ticks', () => {
    const plan = planStack(args('--modules', 'mod-01-customer-portal'));
    expect(plan.needsTicker).toBe(false);
    expect(plan.tickTargets).toEqual([]);
    expect(renderCompose(plan, '..')).not.toContain('ticker:');
  });

  it('ticks every tick-driven service and nothing else', () => {
    const plan = planStack(args('--modules', 'mod-13-offers', '--all-services'));
    expect(plan.tickTargets.map((s: any) => s.n)).toEqual(['PS-02', 'PS-03', 'PS-05', 'PS-08']);
    const compose = renderCompose(plan, '..');
    for (const port of [4002, 4003, 4005, 4008]) expect(compose).toContain(`:${port}/api/tick`);
    for (const port of [4001, 4004, 4006, 4007, 4009, 4010]) expect(compose).not.toContain(`:${port}/api/tick`);
  });
});

describe('secrets', () => {
  const secretValues = (plan: any) =>
    Object.entries(plan.secrets as Record<string, string>)
      .map(([, value]) => value)
      .filter((v) => !v.startsWith('${'));

  it('generates 32 bytes of hex for every secret', () => {
    for (const value of secretValues(planStack(twoModules()))) expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never emits a known dev default', () => {
    const values = new Set(secretValues(planStack(args('--modules', 'mod-12-support-tickets', '--all-services'))));
    for (const bad of KNOWN_DEFAULTS) expect(values.has(bad)).toBe(false);
  });

  it('gives every secret in one stack a distinct value', () => {
    const values = secretValues(planStack(args('--modules', 'mod-04-invoice-billing,mod-12-support-tickets', '--all-services')));
    expect(new Set(values).size).toBe(values.length);
  });

  it('shares nothing between two customers', () => {
    const a = secretValues(planStack(twoModules()));
    const b = secretValues(planStack(twoModules()));
    expect(a).toHaveLength(b.length);
    expect(a.filter((value) => b.includes(value))).toEqual([]);
  });

  it('covers every secret the registry declares for the stack', () => {
    const plan = planStack(args('--modules', 'mod-12-support-tickets', '--all-services'));
    const secrets = plan.secrets as Record<string, string>;
    // The stack machine token replaces the per-service SERVICE_TOKEN entry.
    expect(secrets.PLATFORM_SERVICE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.PS05_INTEGRATION_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.PS06_SIGNING_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.PS08_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.MOD12_INTAKE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.MOD12_ADMIN_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(secrets).filter((k) => /^PS\d\d_SERVICE_TOKEN$/.test(k))).toEqual([]);
  });

  it('names secrets by package: PS07_, MOD04_', () => {
    expect(envPrefix('ps-07-audit-log')).toBe('PS07_');
    expect(envPrefix('mod-04-invoice-billing')).toBe('MOD04_');
  });

  it('uses one fresh random value per call', () => {
    expect(newSecret()).not.toBe(newSecret());
    const plan = planStack(twoModules());
    const counted: string[] = [];
    generateSecrets(
      { modules: plan.modules.map((m: any) => m.mod), services: plan.services.map((s: any) => s.service) },
      () => {
        counted.push('x');
        return 'stub';
      },
    );
    expect(counted.length).toBeGreaterThan(5);
  });
});

describe('mod-08 source database', () => {
  const both = 'mod-08-reporting-suite,mod-04-invoice-billing';

  it('provisions mod-08 alone, against its own source database', () => {
    // The registry says mod-08 ACCEPTS a source database, not that it needs
    // one: server/config.ts defaults SOURCE_DB_PATH to ./source.db and the
    // module generates a demo source at boot. A single-module stack is valid.
    const plan = planStack(args('--modules', 'mod-08-reporting-suite'));
    const reporting = plan.modules.find((m: any) => m.mod.id === 'mod-08-reporting-suite')!;
    expect(plan.modules).toHaveLength(1);
    expect(reporting.env.SOURCE_DB_PATH).toBeUndefined();
    expect(reporting.sourceOf).toBeNull();
    expect(reporting.sourceVolume).toBeNull();

    const compose = renderCompose(plan, '..');
    expect(compose).toContain('reporting:');
    expect(compose).not.toContain('/source:ro');
    expect(compose).not.toContain('SOURCE_DB_PATH');
    expect(JSON.parse(renderManifest(plan)).modules[0].sourceDb).toBeNull();
  });

  it('leaves the source database out of a multi-module stack when not asked for', () => {
    const plan = planStack(args('--modules', both));
    const reporting = plan.modules.find((m: any) => m.mod.id === 'mod-08-reporting-suite')!;
    expect(reporting.env.SOURCE_DB_PATH).toBeUndefined();
    expect(renderCompose(plan, '..')).not.toContain('/source:ro');
  });

  it('refuses a source module that is not in the selection', () => {
    expect(() => planStack(args('--modules', both, '--source-db', 'mod-10-crm-lite'))).toThrow(
      /not in --modules/,
    );
  });

  it('refuses mod-08 as its own source', () => {
    expect(() => planStack(args('--modules', both, '--source-db', 'mod-08-reporting-suite'))).toThrow(
      /reports on a source database itself/,
    );
  });

  it('refuses --source-db when nothing accepts one', () => {
    expect(() => planStack(args('--modules', 'mod-13-offers', '--source-db', 'mod-13-offers'))).toThrow(
      /no selected module accepts a source database/,
    );
  });

  it('mounts the source volume read-only and waits for its owner to be healthy', () => {
    const plan = planStack(args('--modules', both, '--source-db', 'mod-04-invoice-billing'));
    const reporting = plan.modules.find((m: any) => m.mod.id === 'mod-08-reporting-suite')!;
    expect(reporting.env.SOURCE_DB_PATH).toBe('/source/data.db');
    expect(reporting.sourceVolume).toBe('invoicing-data');

    const compose = renderCompose(plan, '..');
    expect(compose).toContain('"invoicing-data:/source:ro"');
    expect(compose).toMatch(/invoicing:\n {8}condition: "service_healthy"/);
  });

  it('restricts the consumer to report_* views when the source publishes a contract', () => {
    // MOD-04 declares publishesReportViews, so pointing MOD-08 at it must
    // enable the contract by itself — leaving that to a hand edit of .env
    // means the default deployment reads MOD-04's private tables.
    const plan = planStack(args('--modules', both, '--source-db', 'mod-04-invoice-billing'));
    const reporting = plan.modules.find((m: any) => m.mod.id === 'mod-08-reporting-suite')!;
    expect(reporting.env.SOURCE_DB_PATH).toBe('/source/data.db');
    // config.ts parses SOURCE_VIEWS_ONLY === 'true', so the exact string matters.
    expect(reporting.env.SOURCE_VIEWS_ONLY).toBe('true');
    expect(reporting.sourceViewsOnly).toBe(true);

    const compose = renderCompose(plan, '..');
    expect(compose).toContain('SOURCE_DB_PATH: "/source/data.db"');
    expect(compose).toContain('SOURCE_VIEWS_ONLY: "true"');

    const manifest = JSON.parse(renderManifest(plan));
    const entry = manifest.modules.find((m: any) => m.id === 'mod-08-reporting-suite');
    expect(entry).toMatchObject({ sourceDb: 'mod-04-invoice-billing', sourceViewsOnly: true });
  });

  it('leaves the consumer unrestricted when the source publishes no views', () => {
    // MOD-03 has no report_* contract. Implying one would restrict MOD-08 to
    // a surface that does not exist, so this stays exactly as it was.
    const plan = planStack(
      args(
        '--modules',
        'mod-03-inventory-management,mod-08-reporting-suite',
        '--source-db',
        'mod-03-inventory-management',
      ),
    );
    const reporting = plan.modules.find((m: any) => m.mod.id === 'mod-08-reporting-suite')!;
    expect(reporting.env.SOURCE_DB_PATH).toBe('/source/data.db');
    expect(reporting.env.SOURCE_VIEWS_ONLY).toBeUndefined();
    expect(reporting.sourceViewsOnly).toBe(false);
    expect(renderCompose(plan, '..')).not.toContain('SOURCE_VIEWS_ONLY');
  });

  it('sets no SOURCE_VIEWS_ONLY at all when there is no --source-db', () => {
    const plan = planStack(args('--modules', 'mod-08-reporting-suite'));
    const reporting = plan.modules[0]!;
    expect(reporting.env.SOURCE_VIEWS_ONLY).toBeUndefined();
    expect(reporting.sourceViewsOnly).toBe(false);
    expect(renderCompose(plan, '..')).not.toContain('SOURCE_VIEWS_ONLY');
  });

  it('drives restricted mode off the registry, naming no module in the generator', () => {
    // The pairing must follow the declared constraint, not a hard-coded id:
    // a second module that publishes a contract has to work with no change
    // to deploy/provision.mjs.
    const generator = readFileSync(
      fileURLToPath(new URL('../provision.mjs', import.meta.url)),
      'utf8',
    );
    // Comments stripped: the usage example in the file header cites real
    // module ids on purpose, and documentation cannot branch on anything.
    const code = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const mentioned = [...code.matchAll(/\bmod-\d{2}-[a-z-]+\b/g)].map((m) => m[0]);
    expect(mentioned, 'provision.mjs logic must not name a module id').toEqual([]);
    expect(code).toContain('publishesReportViews');
  });
});

describe('rendered artifacts', () => {
  const plan = planStack(twoModules());
  const files = renderAll(plan, '../..');

  it('references no environment variable that .env does not define', () => {
    // The one invariant that makes a generated stack actually start.
    const defined = new Set(
      files['.env']
        .split('\n')
        .filter((line) => /^[A-Z]/.test(line))
        .map((line) => line.split('=')[0]),
    );
    for (const artifact of ['docker-compose.yml', 'Caddyfile'] as const) {
      const referenced = [...files[artifact].matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)].map((m) => m[1]);
      const undefinedVars = [...new Set(referenced)].filter((name) => !defined.has(name)).sort();
      // $$url / $$SERVICE_TOKEN in the ticker command are shell vars escaped
      // for Compose, not interpolations.
      expect(undefinedVars.filter((n) => !['url', 'SERVICE_TOKEN'].includes(n)), artifact).toEqual([]);
    }
  });

  it('builds services and modules from their own Dockerfiles', () => {
    expect(files['docker-compose.yml']).toContain('dockerfile: "deploy/Dockerfile"');
    expect(files['docker-compose.yml']).toContain('dockerfile: "deploy/module.Dockerfile"');
    expect(files['docker-compose.yml']).not.toContain('deploy/demo/');
  });

  it('runs everything in production mode on its own named volume', () => {
    const compose = files['docker-compose.yml'];
    expect(compose.match(/NODE_ENV: "production"/g)).toHaveLength(plan.services.length + plan.modules.length);
    for (const volume of ['ps01-data', 'ps10-data', 'invoicing-data', 'offers-data']) {
      expect(compose).toContain(`${volume}:/data`);
    }
  });

  it('health-checks every service and module on /api/ready', () => {
    for (const { service } of plan.services) {
      expect(files['docker-compose.yml']).toContain(`http://localhost:${service.defaultPort}/api/ready`);
    }
    for (const { mod } of plan.modules) {
      expect(files['docker-compose.yml']).toContain(`http://localhost:${mod.defaultPort}/api/ready`);
    }
    expect(files['docker-compose.yml']).not.toContain('/api/health');
  });

  it('gives each module a subdomain and each service its subpath in the Caddyfile', () => {
    const caddy = files.Caddyfile;
    expect(caddy).toContain('invoicing.{$PLATFORM_DOMAIN} {');
    expect(caddy).toContain('reverse_proxy invoicing:3004');
    expect(caddy).toContain('offers.{$PLATFORM_DOMAIN} {');
    expect(caddy).toContain('handle_path /identity/* {');
    expect(caddy).toContain('reverse_proxy ps01:4001');
    // A service that is not in the stack gets no route.
    expect(caddy).not.toContain('/workflow/*');
    expect(caddy).toContain('email {$ACME_EMAIL}');
  });

  it('lists the values only the customer can supply, once each', () => {
    expect(plan.placeholders).toEqual([
      'ACME_EMAIL',
      'SELLER_NAME',
      'SELLER_ADDRESS',
      'SELLER_VAT_ID',
      'SELLER_EMAIL',
    ]);
    for (const name of plan.placeholders) {
      expect(files['.env'].match(new RegExp(`^${name}=`, 'gm')), name).toHaveLength(1);
      expect(files['README.md']).toContain(`\`${name}\``);
    }
    // The seller identity is one fact about the customer, so it is one value
    // in .env even though two modules read it.
    expect(files['docker-compose.yml'].match(/SELLER_NAME: "\$\{SELLER_NAME\}"/g)).toHaveLength(2);
  });

  it('records the resolved selection in the manifest', () => {
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.registrySchemaVersion).toBe(1);
    expect(manifest.customer).toBe('blaustern');
    expect(manifest.domain).toBe('blaustern.example.com');
    expect(manifest.identityOrg).toBe('blaustern');
    expect(manifest.ticker).toBe(true);
    expect(manifest.modules.map((m: any) => m.id)).toEqual(['mod-04-invoice-billing', 'mod-13-offers']);
    expect(manifest.modules[1]).toMatchObject({
      subdomain: 'offers',
      url: 'https://offers.blaustern.example.com',
      port: 3013,
      supportsSso: true,
      sourceDb: null,
    });
    // The eight services MOD-04 and MOD-13 between them reference. Derived
    // from the plan rather than repeated as a literal — this assertion is
    // about the manifest RECORDING the resolution, not about the count.
    expect(manifest.services.map((s: any) => s.id)).toEqual(plan.services.map((s: any) => s.service.id));
    expect(manifest.services[0]).toMatchObject({ id: 'ps-01-identity', internalUrl: 'http://ps01:4001' });
    expect(manifest.placeholders).toEqual(plan.placeholders);
    expect(Date.parse(manifest.generatedAt)).not.toBeNaN();
  });

  it('names the Compose project after the customer', () => {
    expect(files['docker-compose.yml']).toContain('name: "0815-blaustern"');
  });

  it('marks the generated files as generated', () => {
    for (const name of ['docker-compose.yml', '.env', 'Caddyfile', 'README.md'] as const) {
      expect(files[name], name).toContain('GENERATED by');
    }
  });

  it('renders deterministically for a fixed plan', () => {
    expect(renderCompose(plan, '../..')).toBe(files['docker-compose.yml']);
    expect(renderEnv(plan)).toBe(files['.env']);
    expect(renderCaddyfile(plan)).toBe(files.Caddyfile);
    expect(renderManifest(plan)).toBe(files['manifest.json']);
  });
});

describe('build context', () => {
  // Everything here is derived from where this file actually is, never from what
  // the checkout is called: these have to hold after `git clone <url> anything`,
  // in a fork under a different name, and on a CI runner's own path.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

  it('is relative while the stack lives inside the repository', () => {
    // <repo>/customers/demo -> two levels up is the repository root.
    expect(buildContextFor(join(repoRoot, 'customers', 'demo'))).toBe('../..');
    expect(buildContextFor(join(repoRoot, 'a', 'b', 'c'))).toBe('../../..');
    // The root itself is the context "." rather than an empty string.
    expect(buildContextFor(repoRoot)).toBe('.');
  });

  it('is the absolute repository root when the stack lives outside it', () => {
    // A sibling of the repository root is outside it wherever the repo lives.
    const outside = buildContextFor(resolve(repoRoot, '..', 'stack-outside-the-repo'));
    expect(isAbsolute(outside)).toBe(true);
    expect(outside).toBe(repoRoot);
    // No trailing slash: it goes straight into `build.context` in the compose file.
    expect(outside.endsWith('/')).toBe(false);
  });

  it('resolves a relative --out against the working directory, not the repo', () => {
    // provision.mjs is run from anywhere; a relative --out must mean what the
    // shell meant by it. Compare against cwd rather than hardcoding a path.
    expect(buildContextFor('customers/demo')).toBe(buildContextFor(resolve(process.cwd(), 'customers/demo')));
  });
});

describe('writeStack', () => {
  it('writes the stack and its monitoring config', () => {
    const dir = scratch();
    const written = writeStack(planStack(twoModules()), dir);
    expect(written.files.sort()).toEqual([
      '.env',
      'Caddyfile',
      'README.md',
      'docker-compose.yml',
      'manifest.json',
      'monitoring/alertmanager.yml',
      'monitoring/alerts.yml',
      'monitoring/blackbox.yml',
      'monitoring/prometheus.yml',
    ]);
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toContain('mod-13-offers');
    // The nested directory has to be created, not assumed.
    expect(readFileSync(join(dir, 'monitoring', 'prometheus.yml'), 'utf8')).toContain('job_name: platform-services');
  });

  it('creates the directory when it does not exist', () => {
    const dir = join(scratch(), 'nested', 'deeper');
    expect(writeStack(planStack(twoModules()), dir).dir).toBe(dir);
  });

  it('refuses to clobber a non-empty directory', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'something-precious.txt'), 'keep me');
    expect(() => writeStack(planStack(twoModules()), dir)).toThrow(/is not empty — pass --force/);
    expect(readFileSync(join(dir, 'something-precious.txt'), 'utf8')).toBe('keep me');
  });

  it('overwrites with --force', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'docker-compose.yml'), 'stale');
    writeStack(planStack(twoModules()), dir, { force: true });
    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toContain('GENERATED by');
  });

  it('does not treat an empty existing directory as a clobber', () => {
    const dir = scratch();
    expect(() => writeStack(planStack(twoModules()), dir)).not.toThrow();
  });
});

describe('PLACEHOLDER value', () => {
  it('is obvious enough that nobody ships it by accident', () => {
    expect(PLACEHOLDER).toBe('FILL-ME-IN');
  });
});
