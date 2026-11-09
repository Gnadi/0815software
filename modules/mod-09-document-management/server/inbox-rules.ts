import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { retentionInfo } from './retention.js';

/**
 * Documents past their retention period wait for a decision — keep, put on
 * hold, or dispose of (docs/NOTIFICATIONS-PLAN.md, MOD-09). The decision is
 * the matter owners'. This module signs its own users in, so a person is
 * matched by their user name where that is their email address; the shell
 * asks with the PS-01 email.
 *
 *  - Waits: the documents due for disposal in matters the person owns.
 *  - Notified: once per document and due date, in the digest.
 */

interface Due {
  id: number;
  title: string;
  matter: string;
  matter_id: number;
  due_from: string;
}

function dueDocuments(db: Database.Database, nowMs: number): Due[] {
  const docs = db
    .prepare(
      `SELECT d.id, d.title, m.name AS matter, m.id AS matter_id FROM documents d JOIN matters m ON m.id = d.matter_id
        WHERE d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM disposals x WHERE x.document_id = d.id)`,
    )
    .all() as Omit<Due, 'due_from'>[];
  return docs.flatMap((d) => {
    const info = retentionInfo(db, d.id, nowMs);
    return info.due && info.due_from ? [{ ...d, due_from: info.due_from }] : [];
  });
}

function owners(db: Database.Database, matterId: number): string[] {
  return (
    db
      .prepare("SELECT lower(u.username) AS u FROM matter_members mm JOIN users u ON u.id = mm.user_id WHERE mm.matter_id = ? AND mm.role = 'owner'")
      .all(matterId) as { u: string }[]
  )
    .map((r) => r.u)
    .filter((u) => u.includes('@'));
}

export function collectInbox(db: Database.Database, person: string, _level: AccessLevel, nowMs = Date.now()): { count: number; items: InboxItem[] } {
  const items = dueDocuments(db, nowMs)
    .filter((d) => owners(db, d.matter_id).includes(person))
    .map<InboxItem>((d) => ({
      id: `doc-${d.id}`,
      kind: 'retention',
      title: 'A document is past its retention period',
      detail: `${d.matter} · ${d.title} · since ${d.due_from}`,
      tone: 'warn',
      at: d.due_from,
      href: `/documents/${d.id}`,
    }));
  return { count: items.length, items };
}

export function watchDocuments(db: Database.Database, people: People, nowMs: number): void {
  for (const d of dueDocuments(db, nowMs)) {
    people.notify({
      kind: 'retention-due',
      category: 'deadlines',
      urgency: 'digest',
      recipients: owners(db, d.matter_id),
      title: 'A document is past its retention period',
      detail: `${d.matter} · ${d.title} · since ${d.due_from}`,
      href: `/documents/${d.id}`,
      key: `retention:${d.id}:${d.due_from}`,
    });
  }
}
