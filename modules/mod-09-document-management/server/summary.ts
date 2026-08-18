import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
} from '../shared/summary.js';

/**
 * What MOD-09 tells a shell about itself.
 *
 * **Counts only — deliberately no lists.**
 *
 * Access here is per MATTER: a user sees the matters they are a member of, and
 * `listMatters`/`listDocuments` both take the user whose membership decides
 * what comes back. A shell holding the stack's machine token has no such user,
 * so any list it could be handed would be assembled across every matter at
 * once — including ones nobody on the board is a member of. Matter names and
 * document titles are exactly the kind of thing that must not leak that way, so
 * a board gets totals and nothing else.
 *
 * It is also why this module is not embeddable: its users are matter users, not
 * staff (docs/PLATFORM-READINESS.md, item C1). The Workspace shows these
 * figures and links out, where the module's own access control applies again.
 */

export const MODULE_ID = 'mod-09-document-management';

/**
 * The context this module can narrow by.
 *
 * `party` is absent: a matter's participants are this module's own users, not
 * PS-11 parties. Dates are honoured against the document's own timestamp.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

export interface SummaryOptions {
  /** Injectable wall clock for `generated_at`, so tests stay deterministic. */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const now = options.now ?? (() => new Date());
  const applied = appliedFilters(context, SUPPORTED);

  const where: string[] = [];
  const params: string[] = [];
  if (context.from !== undefined) {
    where.push('substr(created_at, 1, 10) >= ?');
    params.push(context.from);
  }
  if (context.to !== undefined) {
    where.push('substr(created_at, 1, 10) <= ?');
    params.push(context.to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Soft-deleted documents are excluded: they are hidden from every one of
  // this module's own screens, and a board counting them would be the only
  // place in the stack that disagreed.
  const deletedClause = clause === '' ? 'WHERE deleted_at IS NULL' : `${clause} AND deleted_at IS NULL`;
  const documents = (db.prepare(`SELECT COUNT(*) AS n FROM documents ${deletedClause}`).get(...params) as { n: number })
    .n;
  const versions = (db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as { n: number }).n;
  const matters = (db.prepare('SELECT COUNT(*) AS n FROM matters').get() as { n: number }).n;

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'matters',
        label: 'Matters',
        value: String(matters),
        unit: null,
        tone: 'neutral',
        href: '/',
      },
      {
        key: 'documents',
        label: 'Documents',
        value: String(documents),
        unit: null,
        tone: 'neutral',
        href: '/',
      },
      {
        key: 'versions',
        label: 'Versions stored',
        value: String(versions),
        unit: null,
        tone: 'neutral',
        href: '/',
      },
    ],
    lists: [],
    context: { supported: SUPPORTED, applied },
  };
}
