import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';
import { mayAct } from './inbox.js';
import { readMatchSettings } from './receiving.js';
import { tierLabel } from './approval-config.js';

/**
 * What waits for someone in procurement, and whom which step concerns
 * (docs/NOTIFICATIONS-PLAN.md, MOD-06).
 *
 *  - Waits for an approver (`manage`): every submitted PO whose next tier has
 *    not signed yet — except a PO they submitted themselves.
 *  - Notified: a submission goes to the approvers — at once from the total
 *    the administrator set (`notify_now_from_cents`), else in the digest; the
 *    final approval or a rejection goes to whoever submitted it, now; goods
 *    arriving on their PO, in the digest.
 */

const euro = (cents: number) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;

interface Pending {
  id: number;
  number: string;
  supplier: string;
  total_cents: number;
  required_tiers: string;
  submitted_by: string | null;
  created_at: string;
  submission_no: number;
}

function pendingPos(db: Database.Database): (Pending & { next: number })[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.number, s.name AS supplier, sub.total_cents, sub.required_tiers, sub.submitted_by, sub.created_at, p.submission_no
         FROM purchase_orders p
         JOIN suppliers s ON s.id = p.supplier_id
         JOIN po_submissions sub ON sub.po_id = p.id AND sub.submission_no = p.submission_no
        WHERE p.status = 'submitted' ORDER BY sub.created_at`,
    )
    .all() as Pending[];
  return rows.flatMap((r) => {
    const signed = new Set(
      (db.prepare("SELECT tier FROM approvals WHERE po_id = ? AND submission_no = ? AND decision = 'approved'").all(r.id, r.submission_no) as { tier: number }[]).map((a) => a.tier),
    );
    const next = (JSON.parse(r.required_tiers) as number[]).find((t) => !signed.has(t));
    return next === undefined ? [] : [{ ...r, next }];
  });
}

export function collectInbox(db: Database.Database, person: string, level: AccessLevel): { count: number; items: InboxItem[] } {
  if (!mayAct(level, 'manage')) return { count: 0, items: [] };
  const items = pendingPos(db)
    .filter((p) => (p.submitted_by ?? '').toLowerCase() !== person)
    .map<InboxItem>((p) => ({
      id: p.number,
      kind: 'approval',
      title: 'A purchase order waits for approval',
      detail: `${p.number} · ${p.supplier} · ${euro(p.total_cents)} · ${tierLabel(p.next)}`,
      tone: 'neutral',
      at: p.created_at,
      href: `/pos/${p.id}`,
    }));
  return { count: items.length, items };
}

export function watchProcurement(db: Database.Database, people: People): void {
  const po = (id: number) =>
    db.prepare('SELECT p.number, s.name AS supplier FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?').get(id) as {
      number: string;
      supplier: string;
    };

  consume<{ id: number; po_id: number; total_cents: number; submitted_by: string | null; submission_no: number }>(db, 'po_submissions', 'po_submissions', (sub) => {
    const from = readMatchSettings(db).notify_now_from_cents;
    const p = po(sub.po_id);
    people.notify({
      kind: 'po-submitted',
      category: 'approvals',
      urgency: from !== null && sub.total_cents >= from ? 'now' : 'digest',
      holders: 'manage',
      actor: sub.submitted_by,
      title: 'A purchase order waits for approval',
      detail: `${p.number} · ${p.supplier} · ${euro(sub.total_cents)}`,
      href: `/pos/${sub.po_id}`,
      key: `submitted:${sub.id}`,
    });
  });

  consume<{ id: number; po_id: number; submission_no: number; tier: number; decision: string; approver: string; note: string | null }>(db, 'approvals', 'approvals', (a) => {
    const sub = db
      .prepare('SELECT submitted_by, required_tiers, total_cents FROM po_submissions WHERE po_id = ? AND submission_no = ?')
      .get(a.po_id, a.submission_no) as { submitted_by: string | null; required_tiers: string; total_cents: number } | undefined;
    if (!sub?.submitted_by) return;
    const tiers = JSON.parse(sub.required_tiers) as number[];
    const finalApproval = a.decision === 'approved' && a.tier === Math.max(...tiers);
    if (a.decision !== 'rejected' && !finalApproval) return;
    const p = po(a.po_id);
    people.notify({
      kind: a.decision === 'rejected' ? 'po-rejected' : 'po-approved',
      category: 'outcomes',
      urgency: 'now',
      recipients: [sub.submitted_by],
      actor: a.approver,
      title: a.decision === 'rejected' ? 'Your purchase order was rejected' : 'Your purchase order was approved',
      detail: `${p.number} · ${p.supplier} · ${euro(sub.total_cents)}${a.note ? ` · ${a.note}` : ''}`,
      href: `/pos/${a.po_id}`,
      key: `decision:${a.id}`,
    });
  });

  consume<{ id: number; po_id: number; number: string; kind: string; actor: string }>(db, 'goods_receipts', 'goods_receipts', (g) => {
    if (g.kind !== 'receipt') return;
    const submitter = db
      .prepare('SELECT submitted_by FROM po_submissions WHERE po_id = ? ORDER BY submission_no DESC LIMIT 1')
      .get(g.po_id) as { submitted_by: string | null } | undefined;
    const p = po(g.po_id);
    people.notify({
      kind: 'goods-received',
      category: 'outcomes',
      urgency: 'digest',
      recipients: [submitter?.submitted_by],
      actor: g.actor,
      title: 'Goods arrived for your purchase order',
      detail: `${p.number} · ${p.supplier} · ${g.number}`,
      href: `/pos/${g.po_id}`,
      key: `received:${g.id}`,
    });
  });
}
