/**
 * The registry drift test.
 *
 * modules/registry.json is only useful if it is TRUE. Every fact it states
 * about a module or a service is re-derived here from that package's own
 * server/config.ts — the file that actually reads the environment — and
 * compared. Corrupt any port, service list, constraint or env var in the
 * registry and this suite fails with the exact mismatch.
 *
 * Offline by construction: it reads source files, it does not boot anything.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keywordsUsed, SUPPORTED_KEYWORDS, validate } from '../lib/json-schema.mjs';
import { modules, peersOf, registry, services, subdomainFor } from '../../modules/registry.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const schema = JSON.parse(readFileSync(`${root}/modules/registry.schema.json`, 'utf8'));

/**
 * Env vars every module reads through the same shared idiom. They are wired by
 * the generator for every module, so the registry does not repeat them
 * per entry — but the drift check must not flag them as undeclared either.
 */
const COMMON_MODULE_ENV = new Set([
  'PORT',
  'NODE_ENV',
  'DATABASE_PATH',
  'SESSION_TTL_HOURS',
  'COOKIE_SECURE',
  'ADMIN_USERNAME',
  'IDENTITY_ORG',
  'IDENTITY_PERMISSION',
  'PLATFORM_SERVICE_TOKEN',
]);

/**
 * Constraint flag -> the single env var it stands for.
 *
 * `publishesReportViews` is deliberately absent: it is a property of the
 * module's SCHEMA, not of its environment, so it is re-derived from that
 * module's server/db.ts instead (see the drift block below).
 */
const CONSTRAINT_ENV: Record<string, string> = {
  supportsSso: 'IDENTITY_URL',
  needsPublicBaseUrl: 'PUBLIC_BASE_URL',
  acceptsSourceDb: 'SOURCE_DB_PATH',
};

/** Does this module's own schema create `report_*` views? */
function createsReportViews(id: string): boolean {
  const source = readFileSync(`${root}/modules/${id}/server/db.ts`, 'utf8');
  return /\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?report_/i.test(source);
}

function configSource(group: 'modules' | 'platform', id: string): string {
  return readFileSync(`${root}/${group}/${id}/server/config.ts`, 'utf8');
}

/** Every `env.FOO` / `env.FOO!` identifier a config.ts reads. */
function envVarsRead(source: string): Set<string> {
  return new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]));
}

/**
 * The `numberFromEnv('PORT', env.PORT, 1234, …)` default a config.ts declares.
 *
 * Deliberately does NOT also accept the older `Number(env.PORT) || 1234`. That
 * shape reads a mistyped port as the default and boots a service nothing can
 * reach, so a config.ts that goes back to it should fail this guard rather
 * than be quietly understood by it.
 */
function portDefault(source: string): number {
  const match = /numberFromEnv\('PORT',\s*env\.PORT,\s*(\d+)/.exec(source);
  if (!match) {
    throw new Error("no numberFromEnv('PORT', …) default found in config.ts");
  }
  return Number(match[1]);
}

const serviceByUrlEnv = new Map(services.map((s: any) => [s.urlEnv, s]));

describe('registry document', () => {
  it('validates against modules/registry.schema.json', () => {
    expect(validate(schema, registry)).toEqual([]);
  });

  it('uses only schema keywords the validator understands', () => {
    const unsupported = [...keywordsUsed(schema)].filter((k) => !SUPPORTED_KEYWORDS.has(k));
    expect(unsupported).toEqual([]);
  });

  it('covers every module directory, exactly once, in catalogue order', () => {
    const ids = modules.map((m: any) => m.id);
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(14);
    expect([...ids].sort()).toEqual(ids);
    for (const mod of modules) expect(mod.n).toBe(`MOD-${mod.id.slice(4, 6)}`);
  });

  it('covers every Platform Service, exactly once, in catalogue order', () => {
    const ids = services.map((s: any) => s.id);
    // A lower bound rather than an exact count: the registry IS the source of
    // truth for how many services exist, so asserting the number here only
    // fails the guard when a service is ADDED — which is not drift. What the
    // guard is actually for is uniqueness, ordering and the PS-nn ↔ id match.
    expect(ids.length).toBeGreaterThanOrEqual(11);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const svc of services) expect(svc.n).toBe(`PS-${svc.id.slice(3, 5)}`);
  });

  it('gives every module a unique subdomain, port and slug', () => {
    const unique = (values: unknown[]) => new Set(values.map(String)).size === values.length;
    expect(unique(modules.map(subdomainFor))).toBe(true);
    expect(unique(modules.map((m: any) => m.defaultPort))).toBe(true);
    expect(unique(modules.map((m: any) => m.slug))).toBe(true);
  });

  it('references only known service ids, and none twice', () => {
    const known = new Set(services.map((s: any) => s.id));
    for (const mod of modules) {
      const declared = [...mod.services.required, ...mod.services.optional];
      expect(new Set(declared).size, `${mod.id} lists a service twice`).toBe(declared.length);
      for (const id of declared) expect(known, `${mod.id} -> ${id}`).toContain(id);
    }
  });

  it('names a known module, exactly once, in every peer declaration', () => {
    const known = new Set(modules.map((m: any) => m.id));
    for (const mod of modules) {
      const peers = peersOf(mod);
      const ids = peers.map((peer: any) => peer.id);
      expect(new Set(ids).size, `${mod.id} declares a peer twice`).toBe(ids.length);
      for (const id of ids) {
        expect(known, `${mod.id} -> ${id}`).toContain(id);
        expect(id, `${mod.id} declares itself as a peer`).not.toBe(mod.id);
      }
    }
  });

  it('promotes no service to required — platform coupling is opt-in', () => {
    // Every module degrades to noopPlatform when a service URL is unset
    // (server/platform.ts). If that ever stops being true for a module, this
    // assertion is the place to record it — deliberately, with a test change.
    for (const mod of modules) expect(mod.services.required, mod.id).toEqual([]);
  });

  it('gives every service a unique port, route prefix and url env var', () => {
    const unique = (values: unknown[]) => new Set(values.map(String)).size === values.length;
    expect(unique(services.map((s: any) => s.defaultPort))).toBe(true);
    expect(unique(services.map((s: any) => s.routePrefix))).toBe(true);
    expect(unique(services.map((s: any) => s.urlEnv))).toBe(true);
  });
});

describe.each(modules.map((m: any) => [m.id, m] as const))('module %s does not drift', (_id, mod: any) => {
  const source = configSource('modules', mod.id);
  const read = envVarsRead(source);

  it('declares the port its config.ts actually defaults to', () => {
    expect(mod.defaultPort).toBe(portDefault(source));
  });

  it('declares exactly the platform services its config.ts reads URLs for', () => {
    const fromCode = [...read]
      .filter((name) => serviceByUrlEnv.has(name))
      .map((name) => serviceByUrlEnv.get(name)!.id)
      .sort();
    const fromRegistry = [...mod.services.required, ...mod.services.optional].sort();
    expect(fromRegistry).toEqual(fromCode);
  });

  it('declares constraints that match the env vars its config.ts reads', () => {
    for (const [flag, envName] of Object.entries(CONSTRAINT_ENV)) {
      expect(mod.constraints[flag], `${mod.id}.constraints.${flag} vs ${envName}`).toBe(read.has(envName));
    }
  });

  it('declares publishesReportViews iff its db.ts actually creates report_* views', () => {
    // The generator switches a consumer into restricted mode off this flag,
    // so a module claiming a contract it does not publish would silently
    // restrict MOD-08 to a set of views that do not exist.
    expect(
      mod.constraints.publishesReportViews,
      `${mod.id}.constraints.publishesReportViews vs CREATE VIEW report_* in server/db.ts`,
    ).toBe(createsReportViews(mod.id));
  });

  it('declares every module-specific env var its config.ts reads', () => {
    const declared = new Set<string>([
      ...mod.env.required,
      ...mod.env.optional,
      ...mod.env.secrets,
      ...COMMON_MODULE_ENV,
      ...Object.values(CONSTRAINT_ENV),
      ...[...read].filter((name) => serviceByUrlEnv.has(name)),
      ...peersOf(mod).map((peer: any) => peer.urlEnv),
    ]);
    const undeclared = [...read].filter((name) => !declared.has(name)).sort();
    expect(undeclared, `${mod.id} reads env vars the registry does not declare`).toEqual([]);
  });

  it('reads the URL of every peer module it declares', () => {
    // A declared peer is a real cross-module dependency, so the code must
    // actually read that URL — and a module with no peers declares none.
    for (const peer of peersOf(mod)) {
      expect(read, `${mod.id} declares peer ${peer.id} but never reads ${peer.urlEnv}`).toContain(peer.urlEnv);
    }
  });

  it('declares no env var its config.ts never reads', () => {
    const claimed = [...mod.env.required, ...mod.env.optional, ...mod.env.secrets];
    const phantom = claimed.filter((name: string) => !read.has(name)).sort();
    expect(phantom, `${mod.id} declares env vars no code reads`).toEqual([]);
  });
});

describe.each(services.map((s: any) => [s.id, s] as const))('service %s does not drift', (_id, svc: any) => {
  const source = configSource('platform', svc.id);
  const read = envVarsRead(source);

  it('declares the port its config.ts actually defaults to', () => {
    expect(svc.defaultPort).toBe(portDefault(source));
  });

  it('declares tickDriven iff its config.ts reads TICK_INTERVAL_MS', () => {
    expect(svc.tickDriven).toBe(read.has('TICK_INTERVAL_MS'));
  });

  it('declares exactly the secrets its config.ts reads', () => {
    const secretish = new Set([
      'SESSION_SECRET',
      'ADMIN_PASSWORD',
      'SERVICE_TOKEN',
      'WEBHOOK_SECRET',
      'INTEGRATION_ENCRYPTION_KEY',
      'SIGNING_SECRET',
    ]);
    const fromCode = [...read].filter((name) => secretish.has(name)).sort();
    expect([...svc.secrets].sort()).toEqual(fromCode);
  });
});

describe('marketing catalogue stays in sync', () => {
  const source = readFileSync(`${root}/src/data/modules.ts`, 'utf8');

  it('has copy for every registry module and no orphans', () => {
    const keys = [...source.matchAll(/^ {2}'(mod-[a-z0-9-]+)': \{$/gm)].map((m) => m[1]);
    expect(keys).toEqual(modules.map((m: any) => m.id));
  });

  it('carries no structural field of its own', () => {
    // n / slug / folder / title / scope / source come from the registry now.
    // A stray literal here would be a second source of truth.
    // A string literal (as opposed to `n: mod.n`) would be a second source.
    for (const field of ['n', 'slug', 'folder', 'title', 'scope']) {
      const stray = source.match(new RegExp(`^ {4}${field}: ['\`]`, 'gm'));
      expect(stray, `src/data/modules.ts re-declares ${field}`).toBeNull();
    }
  });
});

/**
 * The Platform Services catalogue drifted where the module one could not: it is
 * hand-written copy with no structural tie to the registry, and it fell six
 * services behind — the public site advertised five while eleven shipped.
 * `src/data/platform.ts` now self-checks at build time; this is the same check
 * in the suite, so the failure arrives from `npm test` too and names the
 * service that was forgotten.
 */
describe('public Platform Services catalogue stays in sync', () => {
  const source = readFileSync(`${root}/src/data/platform.ts`, 'utf8');
  const listed = [...source.matchAll(/^ {4}folder: '(ps-[a-z0-9-]+)',$/gm)].map((m) => m[1]);

  it('lists every Platform Service in the registry, exactly once, in order', () => {
    expect(listed).toEqual(services.map((s: any) => s.id));
  });

  it('gives each one the port the registry declares', () => {
    const ports = [...source.matchAll(/^ {4}port: (\d+),$/gm)].map((m) => Number(m[1]));
    expect(ports).toEqual(services.map((s: any) => s.defaultPort));
  });
});

/**
 * The site translates itself by swapping `[data-i18n]` text against a
 * dictionary, and `applyLang` silently skips a key it cannot find. That makes a
 * missing translation invisible — it renders as English text, not as an error,
 * which is exactly how the catalogues stayed untranslated unnoticed. Every key
 * the catalogue pages render must therefore exist in BOTH languages.
 *
 * `api` is deliberately absent: the endpoint lists are code, identical in every
 * language, and carry no key.
 */
describe('catalogue copy is translated in every language', () => {
  const dict = readFileSync(`${root}/src/i18n/translations.ts`, 'utf8');
  const deAt = dict.indexOf('\n  de: {');
  expect(deAt).toBeGreaterThan(0);
  const blocks = { en: dict.slice(dict.indexOf('\n  en: {'), deAt), de: dict.slice(deAt) };

  const platformSource = readFileSync(`${root}/src/data/platform.ts`, 'utf8');
  const serviceSlugs = [...platformSource.matchAll(/^ {4}slug: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
  // Both lists are uniform in length; derive the counts rather than assume them.
  const respCounts = [...platformSource.matchAll(/responsibilities: \[([\s\S]*?)\n {4}\]/g)].map(
    (m) => m[1].split('\n').filter((l) => l.trim().startsWith("'")).length,
  );
  const modulesSource = readFileSync(`${root}/src/data/modules.ts`, 'utf8');
  const featCounts = [...modulesSource.matchAll(/features: \[([\s\S]*?)\n {4}\]/g)].map(
    (m) => m[1].split('\n').filter((l) => l.trim().startsWith("'")).length,
  );

  const required = [
    // Rendered by Platform.astro (landing), platform.astro and platform/[slug].
    ...serviceSlugs.flatMap((slug, i) => [
      `svc.${slug}.title`,
      `svc.${slug}.purpose`,
      `svc.${slug}.overview`,
      `svc.${slug}.consumers`,
      ...Array.from({ length: respCounts[i] ?? 0 }, (_, r) => `svc.${slug}.resp.${r}`),
    ]),
    // Rendered by Platform.astro (landing), modules.astro and modules/[slug].
    ...modules.flatMap((m: any, i: number) => [
      `mod.${m.slug}.title`,
      `mod.${m.slug}.body`,
      `mod.${m.slug}.overview`,
      `mod.${m.slug}.scope`,
      ...Array.from({ length: featCounts[i] ?? 0 }, (_, f) => `mod.${m.slug}.feat.${f}`),
    ]),
  ];

  it.each(['en', 'de'] as const)('%s has copy for every catalogue string', (lang) => {
    const missing = required.filter((key) => !blocks[lang].includes(`'${key}':`));
    expect(missing, `missing ${lang} translations`).toEqual([]);
  });

  it('derived a key set that covers all 11 services and all 14 modules', () => {
    expect(serviceSlugs).toHaveLength(services.length);
    expect(respCounts).toHaveLength(services.length);
    expect(featCounts).toHaveLength(modules.length);
    expect(respCounts.every((n) => n > 0) && featCounts.every((n) => n > 0)).toBe(true);
  });
});

/**
 * The page chrome around those catalogues — headers, card labels, detail-page
 * section titles and buttons — is translated the same way and fails the same
 * silent way. Every literal `data-i18n="…"` in the catalogue templates must
 * resolve, in both languages.
 */
describe('catalogue page chrome is translated in every language', () => {
  const dict = readFileSync(`${root}/src/i18n/translations.ts`, 'utf8');
  const deAt = dict.indexOf('\n  de: {');
  const blocks = { en: dict.slice(dict.indexOf('\n  en: {'), deAt), de: dict.slice(deAt) };

  const templates = [
    'src/components/Platform.astro',
    'src/layouts/SubPage.astro',
    'src/pages/platform.astro',
    'src/pages/modules.astro',
    'src/pages/platform/[slug].astro',
    'src/pages/modules/[slug].astro',
  ];
  // Literal keys only — the templated ones (`svc.${slug}.title`) are covered
  // by the suite above, which derives them from the data.
  const keys = new Set<string>();
  for (const file of templates) {
    const src = readFileSync(`${root}/${file}`, 'utf8');
    for (const m of src.matchAll(/data-i18n(?:-html)?="([a-zA-Z0-9._-]+)"/g)) keys.add(m[1]);
    // The i18n={{ … }} prop passed to SubPage.
    for (const m of src.matchAll(/(?:sectionName|eyebrow|heading|lead): '([a-zA-Z0-9._-]+)'/g)) keys.add(m[1]);
  }

  it('found the chrome keys at all', () => {
    expect(keys.size).toBeGreaterThan(20);
  });

  it.each(['en', 'de'] as const)('%s resolves every literal data-i18n key', (lang) => {
    const missing = [...keys].filter((key) => !blocks[lang].includes(`'${key}':`)).sort();
    expect(missing, `missing ${lang} translations`).toEqual([]);
  });
});

/**
 * The shared client package is the documented way a module reaches a service.
 * A service without a client is a service modules must hand-roll `fetch` for —
 * exactly the duplication the package exists to remove — so a new PS-xx that
 * arrives without one fails here.
 */
describe('platform clients cover the catalogue', () => {
  const index = readFileSync(`${root}/platform/clients/src/index.ts`, 'utf8');
  const exported = new Set([...index.matchAll(/export \{ (\w+Client) \}/g)].map((m) => m[1]));

  // Every client lives in platform/clients/src/<name>.ts and is re-exported
  // from index.ts. The file name is the service's subject: ps-02-workflow-engine
  // → workflow.ts, ps-06-file-storage → files.ts.
  const clientModules = [...index.matchAll(/from '\.\/(\w+)\.js'/g)].map((m) => m[1]);

  it.each(services.map((s: any) => [s.id] as const))('%s has a client module', (id) => {
    const subject = id.replace(/^ps-\d+-/, '').split('-')[0];
    expect(
      clientModules.filter((m) => m.startsWith(subject)),
      `no client module in platform/clients/src for ${id} (expected one named after "${subject}")`,
    ).not.toHaveLength(0);
  });

  it('exports exactly as many service clients as the registry has services', () => {
    expect(exported.size).toBe(services.length);
  });
});
