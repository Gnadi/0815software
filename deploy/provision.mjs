#!/usr/bin/env node
/**
 * Provision one customer's platform stack from a module selection.
 *
 *   node deploy/provision.mjs \
 *     --customer blaustern \
 *     --modules mod-04-invoice-billing,mod-13-offers \
 *     --domain blaustern.example.com \
 *     --out ./customers/blaustern
 *
 * Reads modules/registry.json, resolves the selection to the MINIMAL set of
 * Platform Services those modules actually reference, generates every secret
 * fresh, and writes a ready-to-run deployment: docker-compose.yml, .env,
 * Caddyfile, README.md and manifest.json. One stack per customer — see
 * docs/DEPLOYMENT-MODEL.md; this script automates that model, it does not
 * change it.
 *
 * Everything below the CLI is a pure function of the options, so
 * test/provision.test.ts can exercise resolution, secret generation and the
 * rendered artifacts offline, with no Docker.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeNameOf,
  internalUrlOf,
  modules as allModules,
  peersOf,
  resolveSelection,
  schemaVersion,
  servicesOf,
  subdomainFor,
} from '../modules/registry.mjs';
import { toYaml } from './lib/yaml.mjs';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Value written for a required setting only the customer can supply. */
export const PLACEHOLDER = 'FILL-ME-IN';

/**
 * Env vars naming a directory the module persists into. In a container they
 * must live on the mounted volume, not in the image's working directory.
 */
const VOLUME_DIRS = {
  DOCUMENTS_DIR: '/data/documents',
  EXPORTS_DIR: '/data/exports',
  STORAGE_DIR: '/data/storage',
};

/**
 * The seller identity is one fact about the customer that several modules
 * print on their documents, and each of them reads it from its own env. The
 * generated stack therefore keeps SELLER_* stack-scoped rather than
 * duplicating it per module — see docs/CUSTOMER-MASTER-DATA.md for why that
 * duplication exists in the first place.
 */
const STACK_SCOPED_ENV = (name) => name.startsWith('SELLER_');

/**
 * A service's own name for the shared machine token. It is satisfied from the
 * stack-wide PLATFORM_SERVICE_TOKEN rather than getting a per-service value —
 * see generateSecrets() for why that is forced today.
 */
const STACK_MACHINE_TOKEN = 'SERVICE_TOKEN';

/** What to tell the operator about a value they have to fill in themselves. */
const PLACEHOLDER_HINTS = {
  ACME_EMAIL: 'address the ACME CA (Let\u2019s Encrypt) mails about certificate problems',
  SELLER_ADDRESS: 'pipe-separated address lines, e.g. Beispielgasse 8/15|1010 Wien|Austria',
  SELLER_VAT_ID: 'VAT identification number, e.g. ATU12345678',
  SELLER_EMAIL: 'reply-to address printed on offers',
  SELLER_NAME: 'legal company name as it appears on invoices and offers',
  SELLER_IBAN: 'IBAN printed on invoices',
  SELLER_BIC: 'BIC printed on invoices',
};

class ProvisionError extends Error {}

/** Fail with a message aimed at the operator, not a stack trace. */
function fail(message) {
  throw new ProvisionError(message);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node deploy/provision.mjs --customer <slug> --modules <id,...> --domain <host> --out <dir>

Required:
  --customer <slug>     Customer identifier; names the Compose project and the
                        PS-01 organization (unless --org is given).
  --modules <id,...>    Comma-separated module ids from modules/registry.json.
  --domain <host>       Public domain. Modules get one subdomain each; the
                        Platform Services keep their subpath routes.
  --out <dir>           Output directory for the generated stack.

Optional:
  --org <slug>          PS-01 organization slug (default: the customer slug).
  --acme-email <email>  Email Caddy registers with the ACME CA for TLS.
  --source-db <id>      Point a module that accepts a source database at another
                        selected module's volume (mounted read-only). Optional:
                        without it such a module runs against its own data.
                        When the named module publishes a report_* view
                        contract, the consumer is restricted to those views
                        automatically (SOURCE_VIEWS_ONLY=true).
  --all-services        Include every Platform Service, not just the ones the
                        selection references.
  --force               Overwrite a non-empty --out.
  --help                Show this message.

Module ids:
${allModules.map((m) => `  ${m.id}`).join('\n')}`;

const FLAGS = new Set(['--all-services', '--force', '--help']);
const OPTIONS = new Set(['--customer', '--modules', '--domain', '--out', '--org', '--acme-email', '--source-db']);

/** Parse argv into options. Throws a usage error on anything unrecognised. */
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS.has(arg)) {
      raw[arg] = true;
      continue;
    }
    if (OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
      raw[arg] = value;
      i += 1;
      continue;
    }
    fail(`unknown argument "${arg}"\n\n${USAGE}`);
  }
  if (raw['--help']) return { help: true };

  for (const required of ['--customer', '--modules', '--domain', '--out']) {
    if (!raw[required]) fail(`missing ${required}\n\n${USAGE}`);
  }
  const customer = raw['--customer'];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(customer)) {
    fail(`--customer "${customer}" must be a lowercase slug (a-z, 0-9, dashes)`);
  }
  const domain = raw['--domain'];
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) fail(`--domain "${domain}" is not a hostname`);
  const org = raw['--org'] ?? customer;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(org)) fail(`--org "${org}" must be a lowercase slug`);

  const moduleIds = raw['--modules']
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (moduleIds.length === 0) fail('--modules is empty');

  return {
    help: false,
    customer,
    org,
    domain,
    moduleIds,
    out: raw['--out'],
    acmeEmail: raw['--acme-email'],
    sourceDb: raw['--source-db'],
    allServices: raw['--all-services'] === true,
    force: raw['--force'] === true,
  };
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** 32 fresh random bytes as hex — the repo's standard secret strength. */
export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

/** Env-var prefix scoping a package's secrets in .env: "PS07_", "MOD04_". */
export function envPrefix(id) {
  const [kind, number] = id.split('-');
  return `${kind}${number}_`.toUpperCase();
}

/**
 * Every secret the stack needs, freshly generated. Keys are the .env variable
 * names; nothing here can be a repo default and no two calls agree.
 *
 * The machine token is the one value deliberately shared INSIDE a stack: a
 * module carries exactly one PLATFORM_SERVICE_TOKEN and every service it calls
 * compares the header against its own SERVICE_TOKEN, so per-service machine
 * tokens cannot work until PS-01-issued scoped credentials replace the shared
 * token (docs/PLATFORM-READINESS.md, item A2). It is therefore generated once
 * per stack under one name — unique to this customer, never a default — and
 * each service's SERVICE_TOKEN points at it instead of getting its own entry.
 */
export function generateSecrets({ modules, services }, secret = newSecret) {
  const env = { PLATFORM_SERVICE_TOKEN: secret() };
  for (const service of services) {
    for (const name of service.secrets) {
      if (name === STACK_MACHINE_TOKEN) continue;
      env[`${envPrefix(service.id)}${name}`] = secret();
    }
  }
  for (const mod of modules) {
    for (const name of mod.env.secrets) env[`${envPrefix(mod.id)}${name}`] = secret();
  }
  return env;
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * Turn options into everything the renderers need. Pure: no filesystem, no
 * randomness beyond the injected secret generator.
 */
export function planStack(options, { secret = newSecret, now = () => new Date() } = {}) {
  const stack = resolveSelection(options.moduleIds, { allServices: options.allServices });
  const serviceById = new Map(stack.services.map((s) => [s.id, s]));

  // A module that ACCEPTS a source database can be pointed at another module's
  // volume — optionally. Without --source-db it is provisioned standalone and
  // reports on its own data, which is the module's own documented default; the
  // generator has no business inventing a dependency the code does not have.
  const acceptsSource = stack.modules.filter((m) => m.constraints.acceptsSourceDb);
  if (options.sourceDb) {
    if (acceptsSource.length === 0) {
      fail(`--source-db was given but no selected module accepts a source database — drop the flag`);
    }
    if (!stack.modules.some((m) => m.id === options.sourceDb)) {
      fail(`--source-db "${options.sourceDb}" is not in --modules; a stack can only mount a volume it creates`);
    }
    if (acceptsSource.some((m) => m.id === options.sourceDb)) {
      fail(`--source-db "${options.sourceDb}" reports on a source database itself — pick a different module`);
    }
  }

  const sourceModule = options.sourceDb ? stack.modules.find((m) => m.id === options.sourceDb) : null;

  const secrets = generateSecrets(stack, secret);

  const placeholders = [];
  const settings = {};
  const addSetting = (name, value) => {
    settings[name] = value;
    if (value === PLACEHOLDER && !placeholders.includes(name)) placeholders.push(name);
  };
  addSetting('PLATFORM_DOMAIN', options.domain);
  addSetting('IDENTITY_ORG', options.org);
  addSetting('ACME_EMAIL', options.acmeEmail ?? PLACEHOLDER);

  const plannedModules = stack.modules.map((mod) => {
    const subdomain = subdomainFor(mod);
    const prefix = envPrefix(mod.id);
    const url = `https://${subdomain}.${options.domain}`;

    const env = {
      NODE_ENV: 'production',
      PORT: String(mod.defaultPort),
      // Caddy is the single hop in front of every module here; without this
      // the per-IP rate limiter sees only Caddy's address and throttles the
      // whole customer as one client.
      TRUST_PROXY: '1',
      PLATFORM_SERVICE_TOKEN: '${PLATFORM_SERVICE_TOKEN}',
    };
    for (const name of mod.env.secrets) env[name] = `\${${prefix}${name}}`;

    for (const service of servicesOf(mod)) {
      if (service.urlEnv === 'IDENTITY_URL' && !mod.constraints.supportsSso) continue;
      if (!serviceById.has(service.id)) continue;
      env[service.urlEnv] = internalUrlOf(service);
    }
    if (mod.constraints.supportsSso && serviceById.has('ps-01-identity')) {
      env.IDENTITY_ORG = '${IDENTITY_ORG}';
    }
    // The signed acceptance link must be the customer-facing URL, never an
    // internal container hostname.
    if (mod.constraints.needsPublicBaseUrl) env.PUBLIC_BASE_URL = url;

    for (const name of mod.env.required) {
      const varName = STACK_SCOPED_ENV(name) ? name : `${prefix}${name}`;
      addSetting(varName, PLACEHOLDER);
      env[name] = `\${${varName}}`;
    }
    for (const [name, path] of Object.entries(VOLUME_DIRS)) {
      if (mod.env.optional.includes(name)) env[name] = path;
    }

    // Only set when the operator asked for it: an unset SOURCE_DB_PATH is what
    // makes the module generate/keep its own source, so leaving it out is the
    // standalone deployment, not a missing setting.
    const sourceOf = mod.constraints.acceptsSourceDb ? (options.sourceDb ?? null) : null;
    // When the source module publishes a report_* view contract, the consumer
    // is restricted to it automatically — that pairing is the whole point of
    // the contract, and leaving it to a hand edit of .env means the default
    // deployment reads the source's private tables. Driven entirely by the
    // registry flag: no module id appears in this generator.
    const sourceViewsOnly = sourceOf !== null && sourceModule?.constraints.publishesReportViews === true;
    if (sourceOf) {
      env.SOURCE_DB_PATH = '/source/data.db';
      // config.ts reads `SOURCE_VIEWS_ONLY === 'true'`, so emit exactly that.
      if (sourceViewsOnly) env.SOURCE_VIEWS_ONLY = 'true';
    }

    return { mod, subdomain, url, prefix, env, sourceOf, sourceViewsOnly, volume: `${subdomain}-data` };
  });

  // Services refuse outbound calls into private address space, which is where
  // this whole stack lives. The hosts of the stack itself are therefore listed
  // as the exception, so a workflow may ring back into a module of the same
  // deployment while everything else internal stays out of reach. No service id
  // appears here: every service gets the list, and the ones without an outbound
  // path simply ignore it.
  const stackHosts = [...plannedModules.map((m) => m.subdomain), ...stack.services.map(composeNameOf)]
    .sort()
    .join(',');

  const plannedServices = stack.services.map((service) => {
    const name = composeNameOf(service);
    const prefix = envPrefix(service.id);
    const env = {
      NODE_ENV: 'production',
      PORT: String(service.defaultPort),
      // As for the modules: one reverse proxy (Caddy) in front of the service.
      TRUST_PROXY: '1',
      EGRESS_ALLOW_HOSTS: stackHosts,
    };
    for (const secretName of service.secrets) {
      env[secretName] =
        secretName === STACK_MACHINE_TOKEN ? '${PLATFORM_SERVICE_TOKEN}' : `\${${prefix}${secretName}}`;
    }
    if (service.id === 'ps-01-identity') {
      env.SELF_BASE_URL = `https://${options.domain}${service.routePrefix}`;
    } else if (serviceById.has('ps-01-identity')) {
      // Identity seam on: PS-01-issued sessions are accepted by this service.
      env.IDENTITY_URL = internalUrlOf(serviceById.get('ps-01-identity'));
    }
    return { service, name, prefix, env, volume: `${name}-data` };
  });

  const byId = new Map(plannedModules.map((p) => [p.mod.id, p]));
  for (const planned of plannedModules) {
    const source = planned.sourceOf ? byId.get(planned.sourceOf) : null;
    planned.sourceVolume = source ? source.volume : null;
    planned.sourceSubdomain = source ? source.subdomain : null;

    // Module-to-module wiring, declared in the registry's `peers`. Only wired
    // when the peer is in the SAME stack — a customer who did not license
    // MOD-13 gets a MOD-04 with no OFFERS_URL, which is exactly the standalone
    // behaviour.
    //
    // `urlEnv` is the INTERNAL container URL and is what a consumer calls
    // server-side. `publicUrlEnv`, when a consumer declares one, is the
    // customer-facing origin — a browser cannot reach a container name, so an
    // iframe src or a deep link needs the public one. Conflating them produces
    // a board of frames that fail to load with nothing in any log.
    planned.peers = [];
    for (const peer of peersOf(planned.mod)) {
      const target = byId.get(peer.id);
      if (!target) continue;
      planned.env[peer.urlEnv] = `http://${target.subdomain}:${target.mod.defaultPort}`;
      if (peer.publicUrlEnv) planned.env[peer.publicUrlEnv] = target.url;
      planned.peers.push({ ...peer, subdomain: target.subdomain });
    }
  }

  // SHELL_ORIGIN is the other half of the embed seam, and it points the other
  // way: a shell names its peers, and every embeddable peer must name the shell
  // back. Set here rather than in the registry because it depends on the
  // SELECTION — with no shell in the stack nothing frames anything, and every
  // module must keep its blanket X-Frame-Options: DENY.
  //
  // A shell is identified by what it DECLARES, never by its id: a module that
  // asks for a peer's public origin is precisely a module that will put that
  // peer in a browser — an iframe or a link — which is exactly the relationship
  // SHELL_ORIGIN authorises. A second shell would work with no change here.
  const shells = plannedModules.filter((p) => peersOf(p.mod).some((peer) => peer.publicUrlEnv));
  for (const shell of shells) {
    for (const planned of plannedModules) {
      if (planned === shell || !planned.mod.constraints.embeddable) continue;
      planned.env.SHELL_ORIGIN = shell.url;
    }
  }

  return {
    customer: options.customer,
    org: options.org,
    domain: options.domain,
    generatedAt: now().toISOString(),
    allServices: options.allServices,
    needsTicker: stack.needsTicker,
    tickTargets: stack.services.filter((s) => s.tickDriven),
    modules: plannedModules,
    services: plannedServices,
    secrets,
    settings,
    placeholders,
  };
}

// ── Renderers ────────────────────────────────────────────────────────────────

/**
 * Build context for the images: a path from the generated directory back to
 * this repository. Relative while the stack lives inside the repo (so the
 * directory can be committed and cloned), absolute otherwise.
 */
export function buildContextFor(outDir) {
  const abs = resolve(outDir);
  const rel = relative(abs, REPO_ROOT);
  const inside = !relative(REPO_ROOT, abs).startsWith('..');
  if (!inside) return REPO_ROOT.replace(/\/$/, '');
  return rel === '' ? '.' : rel;
}

const HEALTHCHECK = (port, path) => ({
  test: ['CMD', 'wget', '-qO-', `http://localhost:${port}${path}`],
  interval: '30s',
  timeout: '5s',
  retries: 3,
  start_period: '20s',
});

export function renderCompose(plan, buildContext) {
  const services = {};

  for (const { service, name, env, volume } of plan.services) {
    services[name] = {
      build: { context: buildContext, dockerfile: 'deploy/Dockerfile', args: { SERVICE: service.id } },
      restart: 'unless-stopped',
      environment: env,
      volumes: [`${volume}:/data`],
      healthcheck: HEALTHCHECK(service.defaultPort, '/api/ready'),
      networks: ['platform'],
      ...(env.IDENTITY_URL ? { depends_on: ['ps01'] } : {}),
    };
  }

  for (const { mod, subdomain, env, volume, sourceVolume, sourceSubdomain, peers } of plan.modules) {
    const dependsOn = [
      ...plan.services
        .filter(({ service }) => Object.values(env).includes(internalUrlOf(service)))
        .map(({ name }) => name),
      ...peers.map((peer) => peer.subdomain),
    ];
    const volumes = [`${volume}:/data`];
    if (sourceVolume) volumes.push(`${sourceVolume}:/source:ro`);
    // A module opening another module's database read-only refuses to boot
    // while the file is missing, and a fresh volume IS missing it — so wait
    // for the owning module to be healthy, which means it has created it.
    const depends = sourceSubdomain
      ? Object.fromEntries([
          ...dependsOn.map((name) => [name, { condition: 'service_started' }]),
          [sourceSubdomain, { condition: 'service_healthy' }],
        ])
      : dependsOn;
    services[subdomain] = {
      build: { context: buildContext, dockerfile: 'deploy/module.Dockerfile', args: { MODULE: mod.id } },
      restart: 'unless-stopped',
      environment: env,
      volumes,
      healthcheck: HEALTHCHECK(mod.defaultPort, '/api/ready'),
      networks: ['platform'],
      ...(dependsOn.length > 0 || sourceSubdomain ? { depends_on: depends } : {}),
    };
  }

  services.caddy = {
    image: 'caddy:2-alpine',
    restart: 'unless-stopped',
    ports: ['80:80', '443:443'],
    environment: {
      PLATFORM_DOMAIN: '${PLATFORM_DOMAIN}',
      ACME_EMAIL: '${ACME_EMAIL}',
    },
    volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config'],
    networks: ['platform'],
    depends_on: [...plan.services.map((s) => s.name), ...plan.modules.map((m) => m.subdomain)],
  };

  if (plan.needsTicker) {
    const urls = plan.tickTargets.map((s) => `${internalUrlOf(s)}/api/tick`).join(' ');
    services.ticker = {
      image: 'curlimages/curl:latest',
      restart: 'unless-stopped',
      environment: { SERVICE_TOKEN: '${PLATFORM_SERVICE_TOKEN}' },
      networks: ['platform'],
      depends_on: plan.tickTargets.map(composeNameOf),
      entrypoint: ['/bin/sh', '-c'],
      command: [
        `while true; do\n` +
          `  for url in ${urls}; do\n` +
          `    curl -fsS -X POST "$$url" -H "X-Service-Token: $$SERVICE_TOKEN" >/dev/null || echo "tick failed: $$url"\n` +
          `  done\n` +
          `  sleep 60\n` +
          `done\n`,
      ],
    };
  }

  // ── Monitoring, behind a compose profile ───────────────────────────────
  // Opt-in (`--profile monitoring`) but generated for every stack, because
  // "nobody is watching" is not a state a customer deployment should be able
  // to reach by forgetting to set something up. Prometheus scrapes the
  // services' own /api/metrics; the modules expose no Prometheus metrics, so
  // their liveness is probed through blackbox-exporter against /api/ready —
  // the same endpoint the healthchecks use.
  services.prometheus = {
    image: 'prom/prometheus:v2.53.0',
    profiles: ['monitoring'],
    restart: 'unless-stopped',
    volumes: ['./monitoring:/etc/prometheus:ro', 'prometheus-data:/prometheus'],
    command: [
      '--config.file=/etc/prometheus/prometheus.yml',
      '--storage.tsdb.path=/prometheus',
      '--storage.tsdb.retention.time=30d',
    ],
    networks: ['platform'],
  };
  services.alertmanager = {
    image: 'prom/alertmanager:v0.27.0',
    profiles: ['monitoring'],
    restart: 'unless-stopped',
    volumes: ['./monitoring/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro', 'alertmanager-data:/alertmanager'],
    networks: ['platform'],
  };
  services.blackbox = {
    image: 'prom/blackbox-exporter:v0.25.0',
    profiles: ['monitoring'],
    restart: 'unless-stopped',
    volumes: ['./monitoring/blackbox.yml:/etc/blackbox_exporter/config.yml:ro'],
    networks: ['platform'],
  };

  const volumes = {};
  for (const { volume } of plan.services) volumes[volume] = {};
  for (const { volume } of plan.modules) volumes[volume] = {};
  volumes['caddy-data'] = {};
  volumes['caddy-config'] = {};
  volumes['prometheus-data'] = {};
  volumes['alertmanager-data'] = {};

  return toYaml(
    {
      name: `0815-${plan.customer}`,
      services,
      networks: { platform: {} },
      volumes,
    },
    {
      header: [
        `GENERATED by deploy/provision.mjs on ${plan.generatedAt} — do not hand-edit.`,
        `Re-run the generator to change the selection; edit .env for values.`,
        '',
        `Customer: ${plan.customer}    Domain: ${plan.domain}`,
        `Modules:  ${plan.modules.map((m) => m.mod.id).join(', ')}`,
        `Services: ${plan.services.map((s) => s.service.n).join(', ')}${plan.needsTicker ? ' (+ ticker)' : ''}`,
        '',
        'One stack per customer — see docs/DEPLOYMENT-MODEL.md. Every container runs',
        'NODE_ENV=production, so its boot guard refuses to start on a default secret.',
      ],
    },
  );
}

// ── Monitoring ───────────────────────────────────────────────────────────────

/**
 * Alert rules that are only emitted when the stack contains the service that
 * exports the metric. A rule on a metric nobody publishes never fires, which
 * looks like health and is really silence — so the rules are derived from the
 * selection, and `deploy/test/monitoring.test.ts` checks every metric named
 * here against that service's source.
 */
const ALERT_RULES = [
  {
    service: 'ps-07-audit-log',
    metric: 'audit_chain_valid',
    name: 'AuditChainBroken',
    expr: 'audit_chain_valid == 0',
    for: '1m',
    severity: 'critical',
    summary: 'PS-07 audit chain does not verify',
    description:
      'The hash chain over the audit log is broken: an event was altered or removed, or the database is damaged. Check GET /api/verify and the last backup.',
  },
  {
    service: 'ps-03-notification-hub',
    metric: 'notification_queued_messages',
    name: 'NotificationQueueNotDraining',
    expr: 'notification_queued_messages > 0',
    for: '15m',
    severity: 'critical',
    summary: 'PS-03 has messages queued but not sending',
    description:
      'Messages have been waiting a quarter of an hour. The ticker drives sending, so this usually means the ticker container is gone — mail is silently not going out.',
  },
  {
    service: 'ps-03-notification-hub',
    metric: 'notification_dead_messages',
    name: 'NotificationDeadLetters',
    expr: 'increase(notification_dead_messages[1h]) > 0',
    for: '5m',
    severity: 'warning',
    summary: 'PS-03 gave up on a message',
    description: 'A message exhausted its retries. Someone did not get their invoice or notification.',
  },
  {
    service: 'ps-02-workflow-engine',
    metric: 'workflow_due_deliveries',
    name: 'WebhookDeliveriesNotDraining',
    expr: 'workflow_due_deliveries > 0',
    for: '15m',
    severity: 'warning',
    summary: 'PS-02 webhook deliveries are not being dispatched',
    description: 'Deliveries are due and not going out — the ticker is the usual cause.',
  },
  {
    service: 'ps-02-workflow-engine',
    metric: 'workflow_dead_deliveries',
    name: 'WebhookDeadLetters',
    expr: 'increase(workflow_dead_deliveries[1h]) > 0',
    for: '5m',
    severity: 'warning',
    summary: 'PS-02 gave up on a webhook delivery',
    description:
      'A subscription exhausted its retries, or its target was refused by the egress policy. Check last_error on GET /api/deliveries.',
  },
  {
    service: 'ps-08-payments',
    metric: 'payments_processing_intents',
    name: 'PaymentsStuckProcessing',
    expr: 'payments_processing_intents > 0',
    for: '30m',
    severity: 'warning',
    summary: 'PS-08 has payments stuck in processing',
    description: 'Intents have been processing for half an hour: the PSP webhook may not be arriving.',
  },
  {
    service: 'ps-05-integration-hub',
    metric: 'integration_failed_sync_jobs',
    name: 'IntegrationSyncFailing',
    expr: 'increase(integration_failed_sync_jobs[1h]) > 0',
    for: '5m',
    severity: 'warning',
    summary: 'PS-05 sync jobs are failing',
    description: 'A third-party sync failed — expired credentials are the usual reason.',
  },
];

/** Rules every stack gets, whatever it contains. */
const BASE_RULES = `      - alert: ContainerDown
        expr: up{job="platform-services"} == 0
        for: 3m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.instance }} is not answering Prometheus"
          description: "The container is down, or its port is unreachable from the monitoring network."

      - alert: NotReady
        expr: probe_success == 0
        for: 3m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.instance }} is not ready"
          description: "/api/ready did not answer 200. A module or service is down, or its schema migrations have not finished."

      - alert: ServerErrors
        expr: sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) > 0
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.service }} is returning 5xx"
          description: "Requests have been failing for ten minutes. Check the container's logs — every request is logged as one JSON line with a request id."`;

export function renderPrometheus(plan) {
  const scrape = plan.services.map(({ name, service }) => `${name}:${service.defaultPort}`);
  const probes = [
    ...plan.services.map(({ name, service }) => `http://${name}:${service.defaultPort}/api/ready`),
    ...plan.modules.map(({ subdomain, mod }) => `http://${subdomain}:${mod.defaultPort}/api/ready`),
  ];
  return `# GENERATED by deploy/provision.mjs on ${plan.generatedAt} — do not hand-edit.
#
# Two jobs, because the two halves of the stack expose different things:
#   platform-services — the services publish Prometheus metrics themselves
#                       (request counters plus domain gauges: queue depths,
#                       dead letters, the audit chain verdict).
#   readiness         — the modules publish no Prometheus metrics, so their
#                       health is probed through blackbox-exporter against the
#                       same /api/ready the container healthcheck uses.
global:
  scrape_interval: 30s
  evaluation_interval: 30s

rule_files:
  - alerts.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: platform-services
    metrics_path: /api/metrics
    static_configs:
      - targets:
${scrape.map((t) => `          - '${t}'`).join('\n')}

  - job_name: readiness
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
${probes.map((t) => `          - '${t}'`).join('\n')}
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox:9115
`;
}

export function renderAlerts(plan) {
  const selected = new Set(plan.services.map((s) => s.service.id));
  const rules = ALERT_RULES.filter((rule) => selected.has(rule.service));
  const rendered = rules
    .map(
      (rule) => `
      - alert: ${rule.name}
        expr: ${rule.expr}
        for: ${rule.for}
        labels: { severity: ${rule.severity} }
        annotations:
          summary: "${rule.summary}"
          description: "${rule.description}"`,
    )
    .join('\n');

  return `# GENERATED by deploy/provision.mjs on ${plan.generatedAt} — do not hand-edit.
#
# Only rules whose service is in THIS stack are emitted: a rule watching a
# metric nobody publishes never fires, and silence that looks like health is
# worse than no rule at all.
groups:
  - name: platform
    rules:
${BASE_RULES}${rendered}
`;
}

export function renderAlertmanager(plan) {
  return `# GENERATED by deploy/provision.mjs on ${plan.generatedAt}.
#
# Fill in a receiver — this is the one file here you are expected to edit.
#
# Deliberately NOT routed through PS-03, the stack's own notification service:
# an alerting path that runs through the system it is watching goes quiet
# exactly when it is needed. Use your mail provider, or a webhook into
# whatever you already carry a pager on.
route:
  receiver: operator
  group_by: ['alertname']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h

receivers:
  - name: operator
    # Replace with a real target. Examples:
    #
    # email_configs:
    #   - to: ops@${plan.domain}
    #     from: alerts@${plan.domain}
    #     smarthost: smtp.example.com:587
    #     auth_username: alerts@${plan.domain}
    #     auth_password: ${PLACEHOLDER}
    #
    # webhook_configs:
    #   - url: https://hooks.example.com/${plan.customer}-alerts
    webhook_configs:
      - url: http://${PLACEHOLDER}
`;
}

export function renderBlackbox(plan) {
  return `# GENERATED by deploy/provision.mjs on ${plan.generatedAt} — do not hand-edit.
#
# One probe: does /api/ready answer 200? That is what "this module is usable"
# means here — the endpoint reports 503 while schema migrations are pending.
modules:
  http_2xx:
    prober: http
    timeout: 10s
    http:
      valid_status_codes: [200]
      preferred_ip_protocol: ip4
`;
}

export function renderEnv(plan) {
  const lines = [
    `# GENERATED by deploy/provision.mjs on ${plan.generatedAt}.`,
    `# Secrets for the "${plan.customer}" stack — freshly generated, unique to it.`,
    '#',
    "# This file is the stack's key material. Keep it out of version control and",
    '# back it up separately from the volumes: losing it costs you the sessions',
    '# and the machine token, not the data.',
    '',
    '# ── Customer settings ────────────────────────────────────────────────',
  ];
  for (const [name, value] of Object.entries(plan.settings)) {
    const hint = value === PLACEHOLDER ? PLACEHOLDER_HINTS[name] : undefined;
    if (hint) lines.push(`# ${hint}`);
    lines.push(`${name}=${value}`);
  }

  lines.push(
    '',
    '# ── Machine token (module → service, ticker → service) ───────────────',
    '# One value per stack: a module carries exactly one PLATFORM_SERVICE_TOKEN',
    '# and each service compares it against its own SERVICE_TOKEN. Rotate by',
    '# replacing it here and restarting the stack.',
    `PLATFORM_SERVICE_TOKEN=${plan.secrets.PLATFORM_SERVICE_TOKEN}`,
  );

  for (const { service, prefix } of plan.services) {
    lines.push('', `# ── ${service.n} ${service.label} ──`);
    for (const name of service.secrets) {
      if (name === STACK_MACHINE_TOKEN) continue; // the one stack-wide value, above
      lines.push(`${prefix}${name}=${plan.secrets[`${prefix}${name}`]}`);
    }
  }
  for (const { mod, prefix } of plan.modules) {
    if (mod.env.secrets.length === 0) continue;
    lines.push('', `# ── ${mod.n} ${mod.title} ──`);
    for (const name of mod.env.secrets) lines.push(`${prefix}${name}=${plan.secrets[`${prefix}${name}`]}`);
  }

  if (plan.placeholders.length > 0) {
    lines.push(
      '',
      `# ── ${PLACEHOLDER}: ${plan.placeholders.length} value(s) above still need you ──`,
      `# ${plan.placeholders.join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderCaddyfile(plan) {
  const lines = [
    `# GENERATED by deploy/provision.mjs on ${plan.generatedAt} — do not hand-edit.`,
    '#',
    '# Caddy terminates TLS and provisions certificates automatically for every',
    '# name below; DNS for the platform domain AND each module subdomain must',
    '# point at this host before the first start.',
    '',
    '{',
    '\temail {$ACME_EMAIL}',
    '}',
    '',
  ];

  for (const { mod, subdomain } of plan.modules) {
    lines.push(
      `# ${mod.n} ${mod.title}`,
      `${subdomain}.{$PLATFORM_DOMAIN} {`,
      `\treverse_proxy ${subdomain}:${mod.defaultPort}`,
      '}',
      '',
    );
  }

  lines.push('# Platform Services, on subpaths of the bare domain.', '{$PLATFORM_DOMAIN} {');
  for (const { service, name } of plan.services) {
    lines.push(`\thandle_path ${service.routePrefix}/* {`, `\t\treverse_proxy ${name}:${service.defaultPort}`, '\t}');
  }
  lines.push(`\trespond "0815software platform — ${plan.customer}" 200`, '}', '');
  return lines.join('\n');
}

export function renderManifest(plan) {
  return `${JSON.stringify(
    {
      generator: 'deploy/provision.mjs',
      generatedAt: plan.generatedAt,
      registrySchemaVersion: schemaVersion,
      customer: plan.customer,
      domain: plan.domain,
      identityOrg: plan.org,
      allServices: plan.allServices,
      ticker: plan.needsTicker,
      modules: plan.modules.map(({ mod, subdomain, url, sourceOf, sourceViewsOnly, peers }) => ({
        id: mod.id,
        n: mod.n,
        label: mod.label,
        subdomain,
        url,
        port: mod.defaultPort,
        supportsSso: mod.constraints.supportsSso,
        sourceDb: sourceOf,
        sourceViewsOnly,
        peers: peers.map((peer) => ({ id: peer.id, urlEnv: peer.urlEnv })),
      })),
      services: plan.services.map(({ service, name }) => ({
        id: service.id,
        n: service.n,
        composeName: name,
        port: service.defaultPort,
        routePrefix: service.routePrefix,
        internalUrl: internalUrlOf(service),
        tickDriven: service.tickDriven,
      })),
      placeholders: plan.placeholders,
    },
    null,
    2,
  )}\n`;
}

export function renderReadme(plan) {
  const table = (rows) => rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
  const credRows = plan.modules
    .filter(({ mod }) => mod.env.secrets.includes('ADMIN_PASSWORD'))
    .map(({ mod, url, prefix }) => [
      `${mod.n} ${mod.title}`,
      `<${url}>`,
      '`admin`',
      `\`${prefix}ADMIN_PASSWORD\` in \`.env\``,
    ]);
  const ssoModules = plan.modules.filter(({ mod }) => mod.constraints.supportsSso);
  const localModules = plan.modules.filter(({ mod }) => !mod.constraints.supportsSso);

  return `# ${plan.customer} — platform stack

GENERATED by \`deploy/provision.mjs\` on ${plan.generatedAt}. The selection lives
in [\`manifest.json\`](./manifest.json); re-run the generator to change it and
edit \`.env\` to change values. \`docker-compose.yml\` and \`Caddyfile\` are
generated artifacts — hand edits are lost on the next run.

One stack for one customer — see
[\`docs/DEPLOYMENT-MODEL.md\`](../../docs/DEPLOYMENT-MODEL.md).

## What is in this stack

**Modules (${plan.modules.length})**

${table([
  ['Module', 'URL', 'Sign-in'],
  ['---', '---', '---'],
  ...plan.modules.map(({ mod, url }) => [
    `${mod.n} ${mod.title}`,
    `<${url}>`,
    mod.constraints.supportsSso ? 'PS-01 single sign-on' : 'own local login',
  ]),
])}

**Platform Services (${plan.services.length}${plan.allServices ? ', all of them by --all-services' : ' — only what the modules reference'})**

${table([
  ['Service', 'Route', 'Internal'],
  ['---', '---', '---'],
  ...plan.services.map(({ service, name }) => [
    `${service.n} ${service.label}`,
    `\`https://${plan.domain}${service.routePrefix}\``,
    `\`${name}:${service.defaultPort}\``,
  ]),
])}

${
  plan.needsTicker
    ? `A **ticker** sidecar POSTs \`/api/tick\` once a minute to ${plan.tickTargets
        .map((s) => s.n)
        .join(', ')} — the tick-driven services in this stack.`
    : 'No **ticker** sidecar: no service in this stack is tick-driven.'
}

## Before you start

${
  plan.placeholders.length > 0
    ? `\`.env\` contains ${plan.placeholders.length} \`${PLACEHOLDER}\` value(s) that only you can supply:

${plan.placeholders
        .map((name) => `- \`${name}\`${PLACEHOLDER_HINTS[name] ? ` — ${PLACEHOLDER_HINTS[name]}` : ''}`)
        .join('\n')}

Every container runs \`NODE_ENV=production\`, so a service whose secret is still
a default refuses to boot — but a \`${PLACEHOLDER}\` seller VAT id will happily
print itself onto an invoice. Fill them in first.`
    : 'Nothing is left blank — every value in `.env` is set.'
}

Point DNS at this host for \`${plan.domain}\` and for every module subdomain
above; Caddy provisions the certificates on first start.

## Verify before going live

\`\`\`sh
cd <repo>/deploy && npm run predeploy -- --manifest <path to this directory>/manifest.json
\`\`\`

(or directly: \`node <repo>/deploy/smoke-stack.mjs --manifest ./manifest.json\`)

Boots exactly this stack as local processes in production mode with generated
secrets — no Docker — and asserts every service and module answers
\`/api/health\` and \`/api/ready\`, every platform URL a module is wired to is
reachable, each module still boots standalone with no service URLs at all,
single sign-on works where the registry says it should and is absent where it
should not, security headers are present on module responses, the boot guard
really does refuse a default secret, and this directory's \`.env\` has no
\`${PLACEHOLDER}\` left in it. Run it before the first \`docker compose up\` and
after every upgrade.

## Bring-up

\`\`\`sh
docker compose up -d --build
docker compose ps            # every container should become healthy
\`\`\`

## Credentials

${
  credRows.length > 0
    ? table([['Module', 'URL', 'User', 'Password'], ['---', '---', '---', '---'], ...credRows])
    : 'No module in this stack has its own admin login.'
}

${
  ssoModules.length > 0
    ? `${ssoModules
        .map(({ mod }) => mod.n)
        .join(
          ', ',
        )} delegate login to PS-01 when it is reachable: create users in the \`${plan.org}\` organization and grant them \`platform:admin\`. The local passwords above stay valid as the break-glass path when PS-01 is down.`
    : ''
}${
    localModules.length > 0
      ? `\n\n${localModules.map(({ mod }) => mod.n).join(', ')} keep their own identity model and do not use PS-01 (docs/PLATFORM-READINESS.md, item C1).`
      : ''
  }

Platform Service operator consoles use \`admin\` with the per-service
\`PS**_ADMIN_PASSWORD\` from \`.env\`.

## Hardening knobs

Every service and module ships security headers, a default-deny CORS policy and
per-IP rate limits (\`server/hardening.ts\`). HSTS is on automatically because
these containers run \`NODE_ENV=production\`. To tune them, add to \`.env\` and
reference from \`docker-compose.yml\`:
\`RATE_LIMIT_RPM\` (default 600), \`LOGIN_RATE_LIMIT_RPM\` (20),
\`CORS_ORIGINS\` (empty = same-origin only), \`REQUEST_TIMEOUT_MS\` (30000).

Optional per-module settings with working defaults are listed in each module's
\`.env.example\`; a value absent from this stack's \`.env\` simply keeps its
default.

## Monitoring

\`\`\`sh
$EDITOR monitoring/alertmanager.yml     # put a real receiver in first
docker compose --profile monitoring up -d
\`\`\`

Prometheus, Alertmanager and blackbox-exporter are generated into
\`monitoring/\` and start only with that profile, so they cost nothing until you
want them. What they watch:

- **every service's own metrics** (\`/api/metrics\`): request counters plus the
  domain gauges — queue depths, dead letters, and PS-07's chain verdict;
- **every service AND module's readiness** (\`/api/ready\`, probed through
  blackbox-exporter, since the modules publish no Prometheus metrics).

The rules in \`monitoring/alerts.yml\` are generated for THIS selection — a rule
watching a metric no service here publishes would never fire, and silence that
looks like health is worse than no rule. They cover a container being down or
unready, sustained 5xx, and the failures that are otherwise invisible: a queue
that stops draining (the ticker died and mail is quietly not going out), dead
letters, payments stuck in processing, and an audit chain that no longer
verifies.

\`monitoring/alertmanager.yml\` is the one file here you are meant to edit: it
ships with a placeholder receiver. Point it at your mail provider or a webhook
you actually carry a pager on — deliberately **not** at PS-03 in this stack,
because an alerting path that runs through the system it watches goes quiet
exactly when you need it.

Neither Prometheus nor Alertmanager is exposed through Caddy. Reach them over
an SSH tunnel (\`ssh -L 9090:localhost:9090\`) — they have no authentication of
their own.

## Backups

\`\`\`sh
<repo>/deploy/backup.sh "$(pwd)"     # run from THIS directory
\`\`\`

Pass this stack's directory. Without it the script backs up the reference
stack inside the repository instead of yours. Schedule it from the host's
cron, e.g.

\`\`\`
0 2 * * *  <repo>/deploy/backup.sh <this directory> >> backup.log 2>&1
\`\`\`

It asks the stack which containers are running and snapshots every one that
can back itself up — the services AND the modules, which is where this
customer's invoices, offers and tickets actually are. Each snapshot is
online-consistent (better-sqlite3's backup API, never a file copy of a live
database) and lands in \`/data/backups\` on that container's own volume. A
module that keeps files beside its database copies those alongside.

**Restore** = stop the container, replace \`/data/data.db\` with a snapshot (and
the files directory beside it, where there is one), start it again; pending
schema migrations apply on boot.

Two steps this does not do for you, and both matter:

- **Copy the snapshots off this host.** They sit on the same volumes as the
  originals — which survives a bad deploy, not a lost disk. Add an rsync or
  restic job to another machine; that is what makes this a backup.
- **Back \`.env\` up separately.** It holds the secrets, and a restored volume
  is useless with the wrong \`SESSION_SECRET\`.

## Upgrades

\`\`\`sh
cd <repo> && git pull
cd ${'`'}dirname this file${'`'} && docker compose up -d --build
\`\`\`

Migrations are append-only and idempotent and apply on boot, so rolling this
customer forward is pull + rebuild + restart. If the module selection changed,
re-run \`deploy/provision.mjs\` with \`--force\` — it regenerates
\`docker-compose.yml\` and \`Caddyfile\` — then reconcile \`.env\` by hand so the
secrets you are already running with survive.

## Decommissioning

\`\`\`sh
docker compose down -v
\`\`\`

All of this customer's data is on those volumes, so that is the whole erasure.
`;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function renderAll(plan, buildContext) {
  return {
    'docker-compose.yml': renderCompose(plan, buildContext),
    '.env': renderEnv(plan),
    Caddyfile: renderCaddyfile(plan),
    'README.md': renderReadme(plan),
    'manifest.json': renderManifest(plan),
    'monitoring/prometheus.yml': renderPrometheus(plan),
    'monitoring/alerts.yml': renderAlerts(plan),
    'monitoring/alertmanager.yml': renderAlertmanager(plan),
    'monitoring/blackbox.yml': renderBlackbox(plan),
  };
}

/** Write a planned stack into `outDir`. Refuses a non-empty directory. */
export function writeStack(plan, outDir, { force = false } = {}) {
  const abs = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);
  if (existsSync(abs) && readdirSync(abs).length > 0 && !force) {
    fail(`${abs} is not empty — pass --force to overwrite it`);
  }
  mkdirSync(abs, { recursive: true });
  const files = renderAll(plan, buildContextFor(abs));
  for (const [name, contents] of Object.entries(files)) {
    const target = join(abs, name);
    if (name.includes('/')) mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { dir: abs, files: Object.keys(files) };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/** Whichever of the relative and absolute path reads better in a shell hint. */
function shorterPath(target) {
  const rel = relative(process.cwd(), target) || '.';
  return rel.startsWith('..') ? target : rel;
}

function summarize(plan, written) {
  const out = [];
  out.push('');
  out.push(`  Provisioned "${plan.customer}" into ${written.dir}`);
  out.push('');
  out.push(`  Modules   ${plan.modules.length}`);
  for (const { mod, url, sourceOf, sourceViewsOnly } of plan.modules) {
    const source = sourceOf
      ? sourceViewsOnly
        ? `reports on ${sourceOf} (report_* views only)`
        : `reports on ${sourceOf} (full schema — it publishes no report_* views)`
      : mod.constraints.acceptsSourceDb
        ? 'reports on its own source db (no --source-db given)'
        : '';
    out.push(`    ${mod.n}  ${url.padEnd(44)} ${source}`.trimEnd());
  }
  out.push(`  Services  ${plan.services.length}${plan.allServices ? ' (--all-services)' : ' (minimal set)'}`);
  out.push(`    ${plan.services.map(({ service }) => service.n).join(', ')}`);
  out.push(`  Ticker    ${plan.needsTicker ? `yes — ${plan.tickTargets.map((s) => s.n).join(', ')}` : 'not needed'}`);
  const wired = plan.modules.flatMap(({ mod, peers }) =>
    peers.map((peer) => `${mod.n} → ${peer.id} (${peer.urlEnv})`),
  );
  if (wired.length > 0) out.push(`  Bridges   ${wired.join(', ')}`);
  out.push(`  Files     ${written.files.join(', ')}`);
  out.push('');
  if (plan.placeholders.length > 0) {
    out.push(`  ${plan.placeholders.length} value(s) still need filling in .env:`);
    for (const name of plan.placeholders) out.push(`    ${name}=${PLACEHOLDER}`);
    out.push('');
  }
  const rel = shorterPath(written.dir);
  out.push('  Next:');
  if (plan.placeholders.length > 0) out.push(`    $EDITOR ${join(rel, '.env')}`);
  out.push(`    node ${relative(process.cwd(), join(REPO_ROOT, 'deploy/smoke-stack.mjs'))} --manifest ${join(rel, 'manifest.json')}`);
  out.push(`    docker compose -f ${join(rel, 'docker-compose.yml')} up -d --build`);
  out.push('');
  return out.join('\n');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const plan = planStack(options);
  const written = writeStack(plan, options.out, { force: options.force });
  console.log(summarize(plan, written));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ProvisionError) {
      console.error(`provision: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
