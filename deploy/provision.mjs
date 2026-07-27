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
import { isAbsolute, join, relative, resolve } from 'node:path';
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
    if (sourceOf) env.SOURCE_DB_PATH = '/source/data.db';

    return { mod, subdomain, url, prefix, env, sourceOf, volume: `${subdomain}-data` };
  });

  const plannedServices = stack.services.map((service) => {
    const name = composeNameOf(service);
    const prefix = envPrefix(service.id);
    const env = {
      NODE_ENV: 'production',
      PORT: String(service.defaultPort),
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
    // behaviour. Internal container URL, never the public one.
    planned.peers = [];
    for (const peer of peersOf(planned.mod)) {
      const target = byId.get(peer.id);
      if (!target) continue;
      planned.env[peer.urlEnv] = `http://${target.subdomain}:${target.mod.defaultPort}`;
      planned.peers.push({ ...peer, subdomain: target.subdomain });
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

  const volumes = {};
  for (const { volume } of plan.services) volumes[volume] = {};
  for (const { volume } of plan.modules) volumes[volume] = {};
  volumes['caddy-data'] = {};
  volumes['caddy-config'] = {};

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
      modules: plan.modules.map(({ mod, subdomain, url, sourceOf, peers }) => ({
        id: mod.id,
        n: mod.n,
        label: mod.label,
        subdomain,
        url,
        port: mod.defaultPort,
        supportsSso: mod.constraints.supportsSso,
        sourceDb: sourceOf,
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

## Backups

\`\`\`sh
<repo>/deploy/backup.sh
\`\`\`

Snapshots every service database onto its own volume (\`/data/backups\`) using
better-sqlite3's online backup API. Schedule it from the host's cron (e.g.
\`0 2 * * *\`). Module databases live on their own volumes at \`/data/data.db\`.

**Restore** = stop the container, replace \`/data/data.db\` with a snapshot,
start it again; pending schema migrations apply on boot.

Back \`.env\` up separately from the volumes — it holds the secrets, and a
restored volume is useless with the wrong \`SESSION_SECRET\`.

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
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(abs, name), contents);
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
  for (const { mod, url, sourceOf } of plan.modules) {
    const source = sourceOf
      ? `reports on ${sourceOf}`
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
