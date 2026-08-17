/**
 * THE MODULE SUMMARY SHAPE — the wire contract a module offers a shell.
 *
 * MOD-15 Workspace renders a board of widgets fed by the modules in the stack.
 * This file is the whole read surface that makes that possible, and like
 * `transfer.ts` it is deliberately *neutral*: no table names, no internal ids,
 * no statuses a consumer would have to learn. A module fills it in from
 * whatever it stores; the shell renders it without knowing what a module is.
 * Every module keeps a byte-identical copy (the repo's copy-in convention).
 *
 * Four rules make it safe to render summaries from fourteen modules on one
 * screen without the shell growing per-module knowledge:
 *
 * 1. **The module formats its own values.** `value` is a display string the
 *    owning module produced — its currency, its rounding, its locale rules.
 *    The shell never re-formats a number it does not own, so a widget can
 *    never disagree with the module's own screens.
 * 2. **Links are module-relative paths, never absolute URLs.** A module does
 *    not reliably know its own public URL; the shell knows every peer's. The
 *    shell joins them, and `validateSummary` REFUSES an absolute href — a peer
 *    must not be able to point the shell's UI at an origin of its choosing.
 * 3. **Context is advertised and acknowledged.** A module declares which
 *    filters it understands and which it actually applied to this response, so
 *    the shell can say "not filtered by customer" instead of implying a filter
 *    that never ran. Silently ignoring a filter is the failure mode this
 *    prevents.
 * 4. **Keys are stable.** `key` identifies a tile or list across responses, so
 *    a saved board keeps pointing at the same widget after an upgrade. Renaming
 *    a key retires the widget; changing a `label` does not.
 */

/** Bumped only on a breaking change to the shape. Consumers must check it. */
export const SUMMARY_VERSION = 1;

/**
 * How a value should read, not what colour it is. The shell owns the palette;
 * a module owns the judgement of whether a number is fine or wants attention.
 */
export type SummaryTone = 'neutral' | 'good' | 'warn' | 'bad';

/** A single figure. */
export interface SummaryTile {
  /** Stable within the module. Identifies this tile on a saved board. */
  key: string;
  label: string;
  /** Display string, already formatted by the module that owns the number. */
  value: string;
  /** Rendered next to the value when present ("open", "EUR", "h"). */
  unit: string | null;
  tone: SummaryTone;
  /** Module-relative path to the filtered view behind this figure. */
  href: string | null;
}

/** One row of a list widget. */
export interface SummaryItem {
  /** The module's own reference — an offer number, a ticket key. */
  id: string;
  title: string;
  subtitle: string | null;
  badge: string | null;
  tone: SummaryTone;
  /** ISO date or date-time this row is anchored to, when it has one. */
  at: string | null;
  /** Module-relative path to this record. */
  href: string | null;
}

/** A short list of records — "offers awaiting acceptance", "overdue invoices". */
export interface SummaryList {
  key: string;
  label: string;
  items: SummaryItem[];
  /** Module-relative path to the full list this is an excerpt of. */
  href: string | null;
}

/** The filters the shell may pass. Extending this list is a version bump. */
export const CONTEXT_FILTERS = ['party', 'from', 'to'] as const;
export type ContextFilter = (typeof CONTEXT_FILTERS)[number];

/**
 * What this module did with the context it was handed.
 *
 * `supported` is a property of the module and does not vary per request.
 * `applied` is what this particular response was actually narrowed by — it is
 * a subset of both `supported` and what the shell sent.
 */
export interface ContextSupport {
  supported: ContextFilter[];
  applied: ContextFilter[];
}

/** The context a shell asks for. Every field is optional. */
export interface SummaryContext {
  /** PS-11 Customers party id. The only cross-module customer identity. */
  party?: number;
  /** Inclusive ISO date bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

export interface ModuleSummary {
  summary_version: number;
  /** The producing module's registry id, e.g. "mod-13-offers". */
  module: string;
  generated_at: string;
  tiles: SummaryTile[];
  lists: SummaryList[];
  context: ContextSupport;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a summary context off a request query, ignoring anything malformed.
 *
 * Deliberately lenient where `config.ts` is strict: a context is a VIEW
 * preference, not configuration. A shell that sends `from=yesterday` should get
 * an unfiltered summary that says so in `context.applied`, not a 400 that
 * blanks a widget — and `applied` is what makes that honest rather than silent.
 * A range whose end precedes its start is dropped whole, since honouring half
 * of it would narrow the answer in a direction nobody asked for.
 */
export function parseSummaryContext(query: Record<string, unknown>): SummaryContext {
  const context: SummaryContext = {};

  const party = Number(query.party);
  if (Number.isInteger(party) && party > 0) context.party = party;

  const from = typeof query.from === 'string' && ISO_DATE.test(query.from) ? query.from : undefined;
  const to = typeof query.to === 'string' && ISO_DATE.test(query.to) ? query.to : undefined;
  if (from !== undefined && to !== undefined && from > to) return context;
  if (from !== undefined) context.from = from;
  if (to !== undefined) context.to = to;

  return context;
}

/** The filters actually present in a parsed context, in declaration order. */
export function appliedFilters(context: SummaryContext, supported: readonly ContextFilter[]): ContextFilter[] {
  return CONTEXT_FILTERS.filter((f) => supported.includes(f) && context[f] !== undefined);
}

/**
 * Is this a link the shell may join to a peer's public origin?
 *
 * Only a rooted, single-slash path, and it has to survive a URL PARSER rather
 * than just a string comparison — the two disagree in ways that decide origin:
 *
 * - `https://elsewhere/x` and `//elsewhere/x` are plainly other origins. A peer
 *   that could return one would choose where the shell's UI navigates, which is
 *   the whole reason links are relative here. `javascript:` is script in a link.
 * - **`/\elsewhere/x` is also another origin.** For http(s) the URL standard
 *   treats a backslash exactly as a forward slash, so a browser reads this as
 *   `//elsewhere/x` — while `startsWith('//')` says it is fine. Any backslash
 *   is refused; no real module path contains one.
 * - **Tabs, newlines and other C0 controls are STRIPPED before parsing**, so
 *   `/<tab>/elsewhere` becomes `//elsewhere` after the parser is done with it.
 *   A prefix check run on the raw string never sees the second slash.
 * - A relative `x/y` resolves against whatever the shell's current path happens
 *   to be, so the same summary would point somewhere different depending on
 *   which board you were on.
 *
 * `server/handoff.ts:isRedeemPath` enforces the identical rule on the other
 * side of the seam, where the value becomes a `Location` header. Keep them the
 * same: a path this accepts and that one refuses is a widget whose link works
 * until someone clicks it.
 */
export function isModulePath(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  if (!href.startsWith('/')) return false;
  if (/[\u0000-\u001F\u007F]/.test(href)) return false;
  if (href.includes('\\')) return false;
  return !href.startsWith('//');
}

export interface SummaryProblem {
  field: string;
  message: string;
}

/**
 * Validate a summary as the shell must: the version, the shape, stable keys,
 * and that every href is a path this module may hand out. Returns an empty
 * array when the summary is safe to render.
 *
 * The shell treats a non-empty result as "this peer is broken" and renders the
 * widget in an error state — it never renders a partially valid summary, since
 * a half-drawn board is harder to read than an honest failure.
 */
export function validateSummary(value: unknown): SummaryProblem[] {
  const problems: SummaryProblem[] = [];
  const push = (field: string, message: string): void => void problems.push({ field, message });

  if (value === null || typeof value !== 'object') {
    return [{ field: 'summary', message: 'must be an object' }];
  }
  const s = value as Partial<ModuleSummary>;

  if (s.summary_version !== SUMMARY_VERSION) {
    push('summary_version', `must be ${SUMMARY_VERSION}, got ${String(s.summary_version)}`);
    return problems; // nothing below can be trusted across a version break
  }
  if (typeof s.module !== 'string' || !/^mod-\d{2}-[a-z0-9-]+$/.test(s.module)) {
    push('module', 'must be a module registry id');
  }
  if (typeof s.generated_at !== 'string' || Number.isNaN(Date.parse(s.generated_at))) {
    push('generated_at', 'must be an ISO timestamp');
  }

  const keys = new Set<string>();
  const checkKey = (field: string, key: unknown): void => {
    if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      push(field, 'must be a lowercase stable key');
      return;
    }
    // A board stores `${module}:${key}`, so a duplicate would make two widgets
    // indistinguishable and the second one unrestorable.
    if (keys.has(key)) push(field, `duplicate key "${key}"`);
    keys.add(key);
  };
  const checkHref = (field: string, href: unknown): void => {
    if (href !== null && !isModulePath(href)) push(field, 'must be null or a module-relative path starting with "/"');
  };

  if (!Array.isArray(s.tiles)) push('tiles', 'must be an array');
  else {
    s.tiles.forEach((tile, i) => {
      const at = (f: string): string => `tiles[${i}].${f}`;
      checkKey(at('key'), tile?.key);
      if (typeof tile?.label !== 'string' || tile.label.trim() === '') push(at('label'), 'is required');
      if (typeof tile?.value !== 'string') push(at('value'), 'must be a preformatted string');
      checkHref(at('href'), tile?.href);
    });
  }

  if (!Array.isArray(s.lists)) push('lists', 'must be an array');
  else {
    s.lists.forEach((list, i) => {
      const at = (f: string): string => `lists[${i}].${f}`;
      checkKey(at('key'), list?.key);
      if (typeof list?.label !== 'string' || list.label.trim() === '') push(at('label'), 'is required');
      checkHref(at('href'), list?.href);
      if (!Array.isArray(list?.items)) push(at('items'), 'must be an array');
      else {
        list.items.forEach((item, j) => {
          const iat = (f: string): string => `lists[${i}].items[${j}].${f}`;
          if (typeof item?.id !== 'string' || item.id === '') push(iat('id'), 'is required');
          if (typeof item?.title !== 'string' || item.title.trim() === '') push(iat('title'), 'is required');
          checkHref(iat('href'), item?.href);
        });
      }
    });
  }

  const context = s.context;
  if (!context || typeof context !== 'object') push('context', 'is required');
  else {
    for (const field of ['supported', 'applied'] as const) {
      const list = context[field];
      if (!Array.isArray(list) || list.some((f) => !CONTEXT_FILTERS.includes(f))) {
        push(`context.${field}`, `must be a list of ${CONTEXT_FILTERS.join(' | ')}`);
      }
    }
    if (Array.isArray(context.supported) && Array.isArray(context.applied)) {
      const unsupported = context.applied.filter((f) => !context.supported.includes(f));
      if (unsupported.length > 0) {
        push('context.applied', `claims to have applied unsupported filters: ${unsupported.join(', ')}`);
      }
    }
  }

  return problems;
}
