/**
 * Module permissions — `module:<slug>:<level>` — and what implies what.
 *
 * The system catalogue in `types.ts` is closed: PS-01 knows every permission it
 * enforces itself. Module permissions are the opposite: PS-01 never enforces
 * them and, by the architecture rule, knows no Business Module by name. So they
 * are a GRAMMAR rather than a list — any registry slug (or `*`), one of three
 * ordered levels — that PS-01 stores, grants, caps and returns on
 * `tokens/verify`, and each module interprets for itself.
 *
 * Identical in meaning to `platform/clients/src/access.ts`, which the modules
 * use; `platform/clients/test/access.test.ts` holds the two to the same
 * answers. No imports, so that test can load this file on its own.
 */

export const MODULE_ACCESS_LEVELS = ['view', 'edit', 'manage'] as const;
export type ModuleAccessLevel = (typeof MODULE_ACCESS_LEVELS)[number];
export type ModulePermission = `module:${string}:${ModuleAccessLevel}`;

const SLUG = /^(?:\*|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

export function parseModulePermission(permission: string): { slug: string; level: ModuleAccessLevel } | null {
  const parts = permission.split(':');
  if (parts.length !== 3 || parts[0] !== 'module') return null;
  const [, slug, level] = parts as [string, string, string];
  if (!SLUG.test(slug) || !(MODULE_ACCESS_LEVELS as readonly string[]).includes(level)) return null;
  return { slug, level: level as ModuleAccessLevel };
}

export function isModulePermission(permission: string): permission is ModulePermission {
  return parseModulePermission(permission) !== null;
}

const rank = (level: ModuleAccessLevel): number => MODULE_ACCESS_LEVELS.indexOf(level);

/**
 * Does a principal holding `held` hold `permission`?
 *
 * Exactly `Set.has` for the system catalogue. For a module permission it is
 * the implication the modules apply: the same or a higher level on the same
 * module or on `*`, or `platform:admin`, which has always meant every module.
 *
 * Used by the grant caps, not by the system-permission gates: the question
 * those caps ask — "may this caller hand out (or act on someone holding)
 * `module:crm-lite:edit`?" — has to be answered the way the module will
 * answer it, or an Administrator holding `platform:admin` could not grant the
 * very access it already has.
 */
export function holdsPermission(held: ReadonlySet<string>, permission: string): boolean {
  if (held.has(permission)) return true;
  const wanted = parseModulePermission(permission);
  if (!wanted) return false;
  if (held.has('platform:admin')) return true;
  for (const candidate of held) {
    const have = parseModulePermission(candidate);
    if (have && (have.slug === wanted.slug || have.slug === '*') && rank(have.level) >= rank(wanted.level)) {
      return true;
    }
  }
  return false;
}
