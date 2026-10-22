/**
 * Module access levels — the multi-user contract between PS-01 Identity and
 * every Business Module.
 *
 * A module does not keep its own user table. Who a person is and what they may
 * do in a module are both answered by PS-01, as permissions of the form
 *
 *     module:<slug>:<level>        e.g. module:inventory-management:edit
 *     module:*:<level>             the same level in every module
 *
 * where `<slug>` is the module's `slug` in `modules/registry.json` and
 * `<level>` is one of three ordered levels:
 *
 *   - `view`   — read everything the module shows; change nothing.
 *   - `edit`   — the day-to-day work: create, update, delete, transition.
 *   - `manage` — the few actions a module names as consequential (money leaving
 *                the account, approvals, raw SQL, bulk deletes).
 *
 * A higher level implies the lower ones, and `platform:admin` implies `manage`
 * everywhere — which is exactly what an SSO login required before this
 * contract existed, so a deployment that has not granted a single `module:`
 * permission behaves as it always did.
 *
 * PS-01 carries an identical copy of the grammar in
 * `platform/ps-01-identity/shared/module-access.ts` (services take no
 * dependency on this package); `test/access.test.ts` holds the two to the same
 * answers.
 */

export const ACCESS_LEVELS = ['view', 'edit', 'manage'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** The permission that has always meant "everything, everywhere". */
export const PLATFORM_ADMIN = 'platform:admin';

/** Lower-case registry slug, or `*` for every module. */
const SLUG = /^(?:\*|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/** Does `held` cover `required`? */
export function permits(held: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(held) >= ACCESS_LEVELS.indexOf(required);
}

/** The PS-01 permission that grants `level` on module `slug`. */
export function modulePermission(slug: string, level: AccessLevel): string {
  if (!SLUG.test(slug)) throw new Error(`invalid module slug ${JSON.stringify(slug)}`);
  return `module:${slug}:${level}`;
}

/** Parse `module:<slug>:<level>`, or null for anything else. */
export function parseModulePermission(permission: string): { slug: string; level: AccessLevel } | null {
  const parts = permission.split(':');
  if (parts.length !== 3 || parts[0] !== 'module') return null;
  const [, slug, level] = parts as [string, string, string];
  return SLUG.test(slug) && isAccessLevel(level) ? { slug, level } : null;
}

/**
 * The highest level a set of PS-01 permissions grants on module `slug`, or
 * null when it grants none — in which case the module refuses the login.
 */
export function accessLevelFor(permissions: readonly string[], slug: string): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const permission of permissions) {
    if (permission === PLATFORM_ADMIN) return 'manage';
    const parsed = parseModulePermission(permission);
    if (!parsed || (parsed.slug !== slug && parsed.slug !== '*')) continue;
    if (best === null || permits(parsed.level, best)) best = parsed.level;
  }
  return best;
}

/**
 * One line of a module's access policy: requests matching `method` and `path`
 * need `access`. `path` is the full request path with `:param` segments, as
 * written on the route (`/api/payment-runs/:id/submit`).
 */
export interface AccessRule {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  access: AccessLevel;
}

/** Methods that only read; everything else changes state and needs `edit`. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Compile a module's rules into the function its session gate consults.
 *
 * The default is decided by the HTTP method — reading needs `view`, anything
 * else needs `edit` — so a route nobody remembered to list is protected, not
 * open. Rules only ever say where the default is wrong: a POST that merely
 * reads (`view`), or an action that deserves `manage`.
 */
export function compileAccessPolicy(rules: readonly AccessRule[]): (method: string, path: string) => AccessLevel {
  const compiled = rules.map((rule) => {
    if (!rule.path.startsWith('/')) throw new Error(`access rule path must be absolute: ${rule.path}`);
    if (!isAccessLevel(rule.access)) throw new Error(`access rule ${rule.method} ${rule.path} has no valid level`);
    const pattern = rule.path
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return { method: rule.method, test: new RegExp(`^${pattern}/?$`), access: rule.access };
  });
  return (method, path) => {
    const verb = method.toUpperCase();
    // HEAD is answered by the GET route, so it is judged by the GET rules.
    const asRouted = verb === 'HEAD' ? 'GET' : verb;
    for (const rule of compiled) if (rule.method === asRouted && rule.test.test(path)) return rule.access;
    return SAFE_METHODS.has(verb) ? 'view' : 'edit';
  };
}
