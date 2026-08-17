import type Database from 'better-sqlite3';
import { fmtEur } from '../shared/money.js';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listApplications } from './applications.js';
import { listPrograms } from './programs.js';
import type { ApplicationRow, ProgramRow } from '../shared/types.js';

/**
 * What MOD-14 tells a shell about itself.
 *
 * Everything MOD-14-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about tranches, obligations or how a funding cap is
 * derived. The numbers come from `listApplications` and `listPrograms` — the
 * same functions the module's own screens read — so a widget cannot disagree
 * with the module.
 */

export const MODULE_ID = 'mod-14-subsidies-funds';

/**
 * The context this module can narrow by.
 *
 * `party` is deliberately absent: the counterparty here is a FUNDING BODY, not
 * a customer, and it is not resolved against PS-11. Claiming the filter and
 * quietly ignoring it is exactly what `context.applied` exists to prevent.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

/** Still in play: neither decided nor abandoned. */
function isOpen(app: ApplicationRow): boolean {
  return app.status === 'draft' || app.status === 'submitted' || app.status === 'under_review';
}

function applicationItem(app: ApplicationRow): SummaryItem {
  return {
    id: app.ref,
    title: `${app.ref} · ${app.title}`,
    subtitle: `${app.program_name} · ${fmtEur(app.requested_amount_cents)}`,
    badge: app.status.replace(/_/g, ' ').toUpperCase(),
    tone: app.status === 'approved' ? 'good' : app.status === 'rejected' ? 'bad' : 'warn',
    at: app.submission_date ?? app.created_at,
    href: `/applications/${app.id}`,
  };
}

function programItem(program: ProgramRow): SummaryItem {
  return {
    id: String(program.id),
    title: program.name,
    subtitle: `${program.funding_body} · up to ${fmtEur(program.max_grant_cents)}`,
    badge: program.application_deadline ? `DUE ${program.application_deadline}` : 'ROLLING',
    tone: 'warn',
    at: program.application_deadline,
    href: `/programs/${program.id}`,
  };
}

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

  let applications = listApplications(db);
  if (context.from !== undefined) {
    applications = applications.filter((a) => (a.submission_date ?? a.created_at).slice(0, 10) >= context.from!);
  }
  if (context.to !== undefined) {
    applications = applications.filter((a) => (a.submission_date ?? a.created_at).slice(0, 10) <= context.to!);
  }

  const open = applications.filter(isOpen);
  const approved = applications.filter((a) => a.status === 'approved');
  const awaitingMoney = approved.filter((a) => !a.fully_disbursed);

  const requested = open.reduce((acc, a) => acc + a.requested_amount_cents, 0);
  const secured = approved.reduce((acc, a) => acc + (a.approved_amount_cents ?? 0), 0);
  const outstanding = approved.reduce((acc, a) => acc + (a.remaining_cents ?? 0), 0);

  // A deadline that has passed is not a deadline to chase. Programs are the
  // module's own filter of what is still open, so this only sorts them.
  const deadlines = listPrograms(db)
    .filter((p) => p.status === 'open' && p.application_deadline !== null)
    .sort((a, b) => (a.application_deadline ?? '9999').localeCompare(b.application_deadline ?? '9999'));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'open_applications',
        label: 'Applications in play',
        value: String(open.length),
        unit: 'undecided',
        tone: 'neutral',
        href: '/applications',
      },
      {
        key: 'requested',
        label: 'Requested',
        value: fmtEur(requested),
        unit: null,
        tone: 'neutral',
        href: '/applications',
      },
      {
        key: 'secured',
        label: 'Approved funding',
        value: fmtEur(secured),
        unit: null,
        tone: secured > 0 ? 'good' : 'neutral',
        href: '/applications?status=approved',
      },
      {
        key: 'outstanding',
        label: 'Awaiting payout',
        value: fmtEur(outstanding),
        unit: `${awaitingMoney.length} grants`,
        tone: outstanding > 0 ? 'warn' : 'good',
        href: '/applications?status=approved',
      },
    ],
    lists: [
      {
        // Not `open_applications`: that key is already a tile, and keys are
        // unique across a module's whole summary so a saved board can never
        // point at two different widgets.
        key: 'applications_in_play',
        label: 'Applications in play',
        items: open.slice(0, LIST_LIMIT).map(applicationItem),
        href: '/applications',
      },
      {
        key: 'upcoming_deadlines',
        label: 'Deadlines coming up',
        items: deadlines.slice(0, LIST_LIMIT).map(programItem),
        href: '/programs',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
