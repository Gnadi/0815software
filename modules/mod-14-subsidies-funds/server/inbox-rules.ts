import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { mayAct } from './inbox.js';

/**
 * Deadlines in subsidies and funds — who must know, and when
 * (docs/NOTIFICATIONS-PLAN.md, MOD-14). The person responsible for an
 * application is whoever opened it (its `created` event names them).
 *
 *  - Waits: their open obligations (reporting, proof of use, call-off) due
 *    within 14 days or overdue, and their drafts whose programme closes for
 *    applications within 14 days. Someone at `manage` also sees everyone's
 *    OVERDUE obligations.
 *  - Notified: 14 and 3 days before a deadline, in the digest; once it has
 *    passed, now, to the responsible person and to the `manage` holders.
 */

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function ownerOf(db: Database.Database, applicationId: number): string | null {
  const row = db
    .prepare("SELECT actor FROM application_events WHERE application_id = ? AND type = 'created' ORDER BY id LIMIT 1")
    .get(applicationId) as { actor: string } | undefined;
  return row?.actor.toLowerCase() ?? null;
}

interface Due {
  kind: 'obligation' | 'application';
  id: number;
  application_id: number;
  ref: string;
  title: string;
  due: string;
}

function deadlines(db: Database.Database, upTo: string): Due[] {
  const obligations = db
    .prepare(
      `SELECT 'obligation' AS kind, o.id, o.application_id, a.ref, o.title, o.due_date AS due
         FROM obligations o JOIN applications a ON a.id = o.application_id
        WHERE o.done = 0 AND a.status = 'approved' AND o.due_date <= ? ORDER BY o.due_date`,
    )
    .all(upTo) as Due[];
  const drafts = db
    .prepare(
      `SELECT 'application' AS kind, a.id, a.id AS application_id, a.ref, a.title || ' · ' || p.name AS title, p.application_deadline AS due
         FROM applications a JOIN programs p ON p.id = a.program_id
        WHERE a.status = 'draft' AND p.application_deadline IS NOT NULL AND p.application_deadline <= ? ORDER BY p.application_deadline`,
    )
    .all(upTo) as Due[];
  return [...obligations, ...drafts];
}

export function collectInbox(db: Database.Database, person: string, level: AccessLevel, nowMs = Date.now()): { count: number; items: InboxItem[] } {
  const today = day(nowMs);
  const items = deadlines(db, day(nowMs + 14 * DAY))
    .filter((d) => ownerOf(db, d.application_id) === person || (mayAct(level, 'manage') && d.due < today))
    .map<InboxItem>((d) => ({
      id: `${d.kind}-${d.id}`,
      kind: 'deadline',
      title: d.kind === 'obligation' ? (d.due < today ? 'A funding obligation is overdue' : 'A funding obligation is due soon') : 'A funding programme closes for applications soon',
      detail: `${d.ref} · ${d.title} · ${d.due}`,
      tone: d.due < today ? 'bad' : 'warn',
      at: d.due,
      href: `/applications/${d.application_id}`,
    }));
  return { count: items.length, items };
}

export function watchSubsidies(db: Database.Database, people: People, nowMs: number): void {
  const today = day(nowMs);
  const in14 = day(nowMs + 14 * DAY);
  const in3 = day(nowMs + 3 * DAY);
  for (const d of deadlines(db, in14)) {
    const owner = ownerOf(db, d.application_id);
    const what = d.kind === 'obligation' ? 'A funding obligation' : 'A funding programme deadline';
    const detail = `${d.ref} · ${d.title} · ${d.due}`;
    const href = `/applications/${d.application_id}`;
    if (d.due < today) {
      people.notify({
        kind: 'deadline-passed',
        category: 'deadlines',
        urgency: 'now',
        recipients: [owner],
        holders: 'manage',
        title: `${what} has passed`,
        detail,
        href,
        key: `passed:${d.kind}:${d.id}:${d.due}`,
      });
    } else {
      // Ranges, not exact days: a server that was down on the day still tells.
      const near = d.due <= in3 ? 3 : 14;
      people.notify({
        kind: 'deadline-near',
        category: 'deadlines',
        urgency: 'digest',
        recipients: [owner],
        title: `${what} is ${near === 3 ? 'at most 3' : 'at most 14'} days away`,
        detail,
        href,
        key: `near:${d.kind}:${d.id}:${d.due}:${near}`,
      });
    }
  }
}
