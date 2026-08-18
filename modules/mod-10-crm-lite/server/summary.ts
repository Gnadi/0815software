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
import { listFollowUps } from './activities.js';
import { listDeals } from './deals.js';
import { WON_KEY } from './pipeline-config.js';
import type { DealRow, FollowUp } from '../shared/types.js';

/**
 * What MOD-10 tells a shell about itself.
 *
 * Everything MOD-10-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about stages, probabilities or how deals are stored.
 * The numbers come from `listDeals` and `listFollowUps` — the same functions the
 * module's own screens read — so a widget cannot disagree with the module.
 */

export const MODULE_ID = 'mod-10-crm-lite';

/** The context this module can narrow by. `party` needs a PS-11 link (db.ts). */
const SUPPORTED: ContextFilter[] = ['party', 'from', 'to'];

/** How many rows a list widget carries. A board shows excerpts, not tables. */
const LIST_LIMIT = 8;

/**
 * Local company ids for a PS-11 party. A party can map to more than one local
 * company — the same firm entered twice, then both rows resolved to one party —
 * so this is a set. Empty means the shell asked about a customer this module
 * has never recorded, which renders as an empty widget rather than an
 * unfiltered one.
 */
function companyIdsForParty(db: Database.Database, partyId: number): Set<number> {
  const rows = db.prepare('SELECT id FROM companies WHERE party_id = ?').all(partyId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function dealTone(deal: DealRow): SummaryTone {
  if (deal.stage === WON_KEY) return 'good';
  if (deal.terminal) return 'bad';
  return 'neutral';
}

function dealItem(deal: DealRow): SummaryItem {
  return {
    id: String(deal.id),
    title: deal.title,
    subtitle: `${deal.company_name} · ${fmtEur(deal.value_cents)}`,
    badge: deal.stage_label.toUpperCase(),
    tone: dealTone(deal),
    at: deal.created_at,
    href: `/deals/${deal.id}`,
  };
}

function followUpItem(followUp: FollowUp): SummaryItem {
  return {
    id: String(followUp.id),
    title: followUp.subject,
    subtitle: [followUp.contact_name, followUp.deal_title].filter(Boolean).join(' · ') || null,
    badge: followUp.overdue ? 'OVERDUE' : followUp.type.toUpperCase(),
    tone: followUp.overdue ? 'bad' : 'warn',
    at: followUp.due_date,
    href: '/activities',
  };
}

export interface SummaryOptions {
  /**
   * Injectable wall clock for `generated_at`.
   *
   * There is deliberately no date to inject: this module derives `overdue`
   * inside `listFollowUps`, and taking a second date here would let a widget
   * disagree with the module's own screens about what is late.
   */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const now = options.now ?? (() => new Date());

  // What this response was narrowed by. A filter counts as applied when it
  // RAN, not when it matched — empty-because-filtered is a true answer, and
  // what this echo prevents is a filter the shell sent, this module ignored,
  // and the board then labelled as narrowed.
  const applied = appliedFilters(context, SUPPORTED);

  let deals = listDeals(db);
  let followUps = listFollowUps(db);

  if (context.party !== undefined) {
    const ids = companyIdsForParty(db, context.party);
    deals = deals.filter((d) => ids.has(d.company_id));
    // A follow-up reaches a company through its deal. One with neither a deal
    // nor a contact cannot be attributed to a customer, so a customer-filtered
    // board leaves it out rather than showing it under everyone.
    const dealIds = new Set(deals.map((d) => d.id));
    followUps = followUps.filter((f) => f.deal_id !== null && dealIds.has(f.deal_id));
  }
  if (context.from !== undefined) {
    deals = deals.filter((d) => d.created_at.slice(0, 10) >= context.from!);
    followUps = followUps.filter((f) => (f.due_date ?? '') >= context.from!);
  }
  if (context.to !== undefined) {
    deals = deals.filter((d) => d.created_at.slice(0, 10) <= context.to!);
    followUps = followUps.filter((f) => (f.due_date ?? '') <= context.to!);
  }

  const open = deals.filter((d) => !d.terminal);
  const won = deals.filter((d) => d.stage === WON_KEY);
  const lost = deals.filter((d) => d.terminal && d.stage !== WON_KEY);
  const overdue = followUps.filter((f) => f.overdue);
  const decided = won.length + lost.length;

  // Weighted, not raw: the module already derives `expected_value_cents` from
  // the stage probability, and a board showing the raw sum next to MOD-04's
  // real receivables would invite reading a pipeline as money in hand.
  const weighted = open.reduce((acc, d) => acc + d.expected_value_cents, 0);

  const byDue = [...followUps].sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
  const byValue = [...open].sort((a, b) => b.value_cents - a.value_cents);

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'open_deals',
        label: 'Deals in play',
        value: String(open.length),
        unit: 'open',
        tone: 'neutral',
        href: '/deals',
      },
      {
        key: 'weighted_pipeline',
        label: 'Weighted pipeline',
        value: fmtEur(weighted),
        unit: null,
        tone: 'neutral',
        href: '/deals',
      },
      {
        key: 'won_value',
        label: 'Won',
        value: fmtEur(won.reduce((acc, d) => acc + d.value_cents, 0)),
        unit: null,
        tone: won.length > 0 ? 'good' : 'neutral',
        href: `/deals?stage=${WON_KEY}`,
      },
      {
        key: 'win_rate',
        // 0 % out of nothing is a figure a board would repeat all day, so an
        // undecided pipeline reports that it has no rate rather than a zero.
        label: 'Win rate',
        value: decided === 0 ? '—' : `${Math.round((won.length / decided) * 100)} %`,
        unit: decided === 0 ? null : `of ${decided}`,
        tone: 'neutral',
        href: '/deals',
      },
      {
        key: 'overdue_followups',
        label: 'Follow-ups late',
        value: String(overdue.length),
        unit: 'overdue',
        tone: overdue.length > 0 ? 'bad' : 'good',
        href: '/activities',
      },
    ],
    lists: [
      {
        key: 'due_followups',
        label: 'Follow-ups due',
        items: byDue.slice(0, LIST_LIMIT).map(followUpItem),
        href: '/activities',
      },
      {
        // Not `open_deals`: that key is already a tile, and keys are unique
        // across a module's whole summary so a saved board can never point at
        // two different widgets.
        key: 'top_deals',
        label: 'Biggest open deals',
        items: byValue.slice(0, LIST_LIMIT).map(dealItem),
        href: '/deals',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
