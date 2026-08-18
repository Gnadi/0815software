import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listTickets } from './tickets.js';
import type { TicketRow } from '../shared/types.js';

/**
 * What MOD-12 tells a shell about itself.
 *
 * Everything MOD-12-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about the timeline, channels or how an SLA leg is
 * computed. The numbers come from `listTickets` — the same function the
 * module's own screens read — so a widget cannot disagree with the module.
 */

export const MODULE_ID = 'mod-12-support-tickets';

/**
 * The context this module can narrow by.
 *
 * `party` is deliberately absent: a requester is an email address, not a PS-11
 * party, so there is no id to filter on. Claiming it and quietly ignoring it is
 * exactly what `context.applied` exists to prevent.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

/** Open in the sense that matters to a board: someone still owes a reply. */
function isOpen(ticket: TicketRow): boolean {
  return ticket.status === 'new' || ticket.status === 'open' || ticket.status === 'pending';
}

function breached(ticket: TicketRow): boolean {
  return ticket.sla.first_response.breached || ticket.sla.resolution.breached;
}

function ticketItem(ticket: TicketRow): SummaryItem {
  return {
    id: ticket.ref,
    title: `${ticket.ref} · ${ticket.subject}`,
    subtitle: [ticket.requester_name, ticket.assignee_name ?? 'unassigned'].join(' · '),
    badge: breached(ticket) ? 'SLA BREACHED' : ticket.priority.toUpperCase(),
    tone: breached(ticket) ? 'bad' : ticket.priority === 'urgent' || ticket.priority === 'high' ? 'warn' : 'neutral',
    at: ticket.created_at,
    href: `/tickets/${ticket.id}`,
  };
}

export interface SummaryOptions {
  /** Injectable epoch millis, so SLA state is deterministic in tests. */
  now?: number;
  /** Injectable wall clock for `generated_at`. */
  clock?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const nowMs = options.now ?? Date.now();
  const clock = options.clock ?? (() => new Date());

  const applied = appliedFilters(context, SUPPORTED);

  let tickets = listTickets(db, {}, nowMs);
  if (context.from !== undefined) tickets = tickets.filter((t) => t.created_at.slice(0, 10) >= context.from!);
  if (context.to !== undefined) tickets = tickets.filter((t) => t.created_at.slice(0, 10) <= context.to!);

  const open = tickets.filter(isOpen);
  const unassigned = open.filter((t) => t.assignee_id === null);
  const breaching = open.filter(breached);
  const resolved = tickets.filter((t) => t.status === 'resolved' || t.status === 'closed');

  // Oldest first: the point of the widget is what has been waiting longest,
  // and newest-first would bury exactly those.
  const byAge = [...open].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: clock().toISOString(),
    tiles: [
      {
        key: 'open',
        label: 'Open tickets',
        value: String(open.length),
        unit: 'awaiting',
        tone: open.length > 0 ? 'warn' : 'good',
        href: '/tickets?status=open',
      },
      {
        key: 'unassigned',
        label: 'Unassigned',
        value: String(unassigned.length),
        unit: 'no agent',
        tone: unassigned.length > 0 ? 'bad' : 'good',
        href: '/tickets?status=new',
      },
      {
        key: 'sla_breached',
        label: 'SLA breached',
        value: String(breaching.length),
        unit: 'open',
        tone: breaching.length > 0 ? 'bad' : 'good',
        href: '/tickets?status=open',
      },
      {
        key: 'resolved',
        label: 'Resolved',
        value: String(resolved.length),
        unit: null,
        tone: 'good',
        href: '/tickets?status=resolved',
      },
    ],
    lists: [
      {
        key: 'oldest_open',
        label: 'Waiting longest',
        items: byAge.slice(0, LIST_LIMIT).map(ticketItem),
        href: '/tickets?status=open',
      },
      {
        key: 'breaching',
        label: 'Past their SLA',
        items: breaching.slice(0, LIST_LIMIT).map(ticketItem),
        href: '/tickets?status=open',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
