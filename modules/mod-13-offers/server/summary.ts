import type Database from 'better-sqlite3';
import { fmtEur } from '../shared/money.js';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
  type SummaryTone,
} from '../shared/summary.js';
import { listOffers, todayIso } from './offers.js';
import type { OfferRow } from '../shared/types.js';

/**
 * What MOD-13 tells a shell about itself.
 *
 * Everything MOD-13-specific stays in this file, exactly as `transfer-export.ts`
 * keeps the export shape's internals here: the consumer gets figures, short
 * lists and paths, and nothing about statuses, revision chains or how offers
 * are stored. The numbers come from `listOffers` — the same function the
 * module's own screens read — so a widget cannot disagree with the module.
 */

export const MODULE_ID = 'mod-13-offers';

/** The context this module can narrow by. `party` needs a PS-11 link (db.ts). */
const SUPPORTED: ContextFilter[] = ['party', 'from', 'to'];

/** How many rows a list widget carries. A board shows excerpts, not tables. */
const LIST_LIMIT = 8;

/** An offer's own date for context purposes: when it went out, else when made. */
function offerDate(row: OfferRow): string {
  return (row.sent_at ?? row.created_at).slice(0, 10);
}

/**
 * Local customer ids for a PS-11 party.
 *
 * A party can map to more than one local customer — the same company entered
 * twice before PS-11 was wired, then both rows resolved to one party — so this
 * returns a set rather than an id. Empty means the shell asked about a customer
 * this module has never seen, which is a legitimate answer and renders as an
 * empty widget rather than as an unfiltered one.
 */
function customerIdsForParty(db: Database.Database, partyId: number): Set<number> {
  const rows = db.prepare('SELECT id FROM customers WHERE party_id = ?').all(partyId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function tone(row: OfferRow): SummaryTone {
  if (row.status === 'accepted') return 'good';
  if (row.status === 'rejected' || row.status === 'expired') return 'bad';
  if (row.status === 'sent') return 'warn';
  return 'neutral';
}

function toItem(row: OfferRow): SummaryItem {
  return {
    id: row.number ?? `draft-${row.id}`,
    title: `${row.number ?? 'DRAFT'} · ${row.title}`,
    subtitle: row.customer_name,
    badge: row.status.toUpperCase(),
    tone: tone(row),
    at: row.valid_until ?? row.sent_at ?? row.created_at,
    href: `/offers/${row.id}`,
  };
}

export interface SummaryOptions {
  /** Injectable clock returning "YYYY-MM-DD", as everywhere else in this module. */
  today?: string;
  /** Injectable wall clock for `generated_at`, so tests stay deterministic. */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const today = options.today ?? todayIso();
  const now = options.now ?? (() => new Date());

  // What this response was actually narrowed by. A filter counts as applied
  // when it RAN, not when it matched: `party` on a customer this module has
  // never seen yields an empty widget, and empty-because-filtered is a true
  // answer. What `applied` exists to prevent is the other case — a filter the
  // shell sent, this module ignored, and the board then labelled as narrowed.
  const applied = appliedFilters(context, SUPPORTED);

  let rows = listOffers(db, {}, today);
  if (context.party !== undefined) {
    const ids = customerIdsForParty(db, context.party);
    rows = rows.filter((r) => ids.has(r.customer_id));
  }
  if (context.from !== undefined) rows = rows.filter((r) => offerDate(r) >= context.from!);
  if (context.to !== undefined) rows = rows.filter((r) => offerDate(r) <= context.to!);

  const withStatus = (status: string): OfferRow[] => rows.filter((r) => r.status === status);
  const value = (list: OfferRow[]): number => list.reduce((acc, r) => acc + r.gross_cents, 0);

  const open = withStatus('sent');
  const accepted = withStatus('accepted');
  const rejected = withStatus('rejected');
  const expired = withStatus('expired');
  const drafts = withStatus('draft');
  const decided = accepted.length + rejected.length;

  // Sorted by validity so the ones about to lapse are the ones on the board.
  // An offer without a validity date cannot lapse and sorts last.
  const awaiting = [...open].sort((a, b) => (a.valid_until ?? '9999').localeCompare(b.valid_until ?? '9999'));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'open',
        label: 'Offers out',
        value: String(open.length),
        unit: 'awaiting',
        tone: open.length > 0 ? 'warn' : 'neutral',
        href: '/offers?status=sent',
      },
      {
        key: 'open_value',
        label: 'Value at stake',
        value: fmtEur(value(open)),
        unit: null,
        tone: 'neutral',
        href: '/offers?status=sent',
      },
      {
        key: 'accepted_value',
        label: 'Accepted',
        value: fmtEur(value(accepted)),
        unit: null,
        tone: accepted.length > 0 ? 'good' : 'neutral',
        href: '/offers?status=accepted',
      },
      {
        key: 'win_rate',
        // 0 % out of nothing is a lie a board would repeat all day, so an
        // undecided pipeline reports that it has no rate rather than a zero.
        label: 'Win rate',
        value: decided === 0 ? '—' : `${Math.round((accepted.length / decided) * 100)} %`,
        unit: decided === 0 ? null : `of ${decided}`,
        tone: 'neutral',
        href: '/offers',
      },
      {
        key: 'expired',
        label: 'Lapsed',
        value: String(expired.length),
        unit: 'unanswered',
        tone: expired.length > 0 ? 'bad' : 'neutral',
        href: '/offers?status=expired',
      },
      {
        key: 'drafts',
        label: 'Drafts',
        value: String(drafts.length),
        unit: 'unsent',
        tone: 'neutral',
        href: '/offers?status=draft',
      },
    ],
    lists: [
      {
        key: 'awaiting_decision',
        label: 'Awaiting decision',
        items: awaiting.slice(0, LIST_LIMIT).map(toItem),
        href: '/offers?status=sent',
      },
      {
        key: 'accepted_offers',
        // The shell's offer → invoice action reads this list, so it carries
        // the offer NUMBER as its id: that is what MOD-04's import takes.
        label: 'Accepted, ready to bill',
        items: accepted
          .filter((r) => r.number !== null)
          .slice(0, LIST_LIMIT)
          .map(toItem),
        href: '/offers?status=accepted',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
