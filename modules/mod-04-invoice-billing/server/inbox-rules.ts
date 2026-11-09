import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';
import { mayAct } from './inbox.js';
import { listBills } from './bills.js';
import { listInvoices, todayIso } from './invoices.js';

/**
 * What waits for someone in invoicing, and whom which step concerns
 * (docs/NOTIFICATIONS-PLAN.md, MOD-04).
 *
 *  - Waits for someone who may release and pay (`manage`): incoming invoices
 *    the three-way match holds, and payment runs someone ELSE prepared that
 *    have not gone to the bank — a second pair of eyes before money leaves.
 *  - Waits for the accounting desk (`edit`): incoming invoices due within two
 *    days and not yet in a run, and outgoing invoices that are overdue (one
 *    entry, with how many).
 *  - Notified: a held incoming invoice and a prepared payment run go to the
 *    `manage` holders in the digest; an incoming invoice due tomorrow, in the
 *    digest of everyone at `edit`.
 *
 * Not here, because this module does not record it: a failed e-invoice
 * delivery (sending is the customer's mail or portal, not ours to watch).
 */

const euro = (cents: number) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function collectInbox(db: Database.Database, person: string, level: AccessLevel, today = todayIso()): { count: number; items: InboxItem[] } {
  const items: InboxItem[] = [];
  if (!mayAct(level, 'edit')) return { count: 0, items };
  const bills = listBills(db, {}, today);

  if (mayAct(level, 'manage')) {
    for (const b of bills.filter((x) => x.status === 'open' && x.match.state === 'held')) {
      items.push({ id: `held-${b.id}`, kind: 'approval', title: 'An incoming invoice is held by the three-way match', detail: `${b.creditor_name} · ${b.reference} · ${euro(b.amount_cents)}`, tone: 'warn', at: b.due_date, href: `/bills/${b.id}` });
    }
    const runs = db
      .prepare('SELECT id, message_id, execution_date, created_by, created_at FROM payment_runs WHERE executed_at IS NULL AND discarded_at IS NULL ORDER BY created_at')
      .all() as { id: number; message_id: string; execution_date: string; created_by: string | null; created_at: string }[];
    for (const r of runs.filter((x) => (x.created_by ?? '').toLowerCase() !== person)) {
      items.push({ id: `run-${r.id}`, kind: 'approval', title: 'A payment run waits to go to the bank', detail: `${r.message_id} · execution ${r.execution_date}`, tone: 'neutral', at: r.created_at, href: `/payment-runs/${r.id}` });
    }
  }

  const soon = addDays(today, 2);
  for (const b of bills.filter((x) => x.status === 'open' && x.payment_run_id === null && x.due_date <= soon)) {
    items.push({ id: `due-${b.id}`, kind: 'due', title: b.overdue ? 'An incoming invoice is overdue' : 'An incoming invoice is due', detail: `${b.creditor_name} · ${b.reference} · ${euro(b.amount_cents)} · due ${b.due_date}`, tone: b.overdue ? 'bad' : 'warn', at: b.due_date, href: `/bills/${b.id}` });
  }
  const overdue = listInvoices(db, {}, today).filter((i) => i.status !== 'cancelled' && i.overdue);
  if (overdue.length > 0) {
    items.push({ id: 'overdue-invoices', kind: 'due', title: `${overdue.length} invoice${overdue.length === 1 ? ' is' : 's are'} overdue`, detail: `${euro(overdue.reduce((s, i) => s + i.open_cents, 0))} open`, tone: 'bad', at: null, href: '/invoices?status=overdue' });
  }
  return { count: items.length, items };
}

export function watchInvoicing(db: Database.Database, people: People, nowMs: number): void {
  consume<{ id: number; bill_id: number; result: string; message: string; actor: string }>(db, 'bill_match_checks', 'bill_match_checks', (c) => {
    if (c.result === 'matched') return;
    const b = db.prepare('SELECT b.reference, b.amount_cents, c.name FROM bills b JOIN creditors c ON c.id = b.creditor_id WHERE b.id = ?').get(c.bill_id) as {
      reference: string;
      amount_cents: number;
      name: string;
    };
    people.notify({ kind: 'bill-held', category: 'approvals', urgency: 'digest', holders: 'manage', title: 'An incoming invoice is held by the three-way match', detail: `${b.name} · ${b.reference} · ${euro(b.amount_cents)} · ${c.message}`, href: `/bills/${c.bill_id}`, key: `held:${c.id}` });
  });

  consume<{ id: number; message_id: string; execution_date: string; created_by: string | null }>(db, 'payment_runs', 'payment_runs', (r) => {
    people.notify({ kind: 'payment-run', category: 'approvals', urgency: 'digest', holders: 'manage', actor: r.created_by, title: 'A payment run waits to go to the bank', detail: `${r.message_id} · execution ${r.execution_date}`, href: `/payment-runs/${r.id}`, key: `run:${r.id}` });
  });

  // Due tomorrow and not yet scheduled: once per bill and due date.
  const tomorrow = addDays(new Date(nowMs).toISOString().slice(0, 10), 1);
  for (const b of listBills(db, {}).filter((x) => x.status === 'open' && x.payment_run_id === null && x.due_date <= tomorrow && x.due_date >= new Date(nowMs).toISOString().slice(0, 10))) {
    people.notify({ kind: 'bill-due', category: 'deadlines', urgency: 'digest', holders: 'edit', title: 'An incoming invoice is due tomorrow', detail: `${b.creditor_name} · ${b.reference} · ${euro(b.amount_cents)}`, href: `/bills/${b.id}`, key: `due:${b.id}:${b.due_date}` });
  }
}
