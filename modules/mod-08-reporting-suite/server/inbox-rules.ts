import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';

/**
 * Reports tell people two things (docs/NOTIFICATIONS-PLAN.md, MOD-08): a
 * scheduled report they set up is ready — or failed, which is worth knowing
 * sooner — and a figure crossed a threshold they set (server/alerts.ts).
 * Neither waits for anyone afterwards, so the inbox stays empty: a report
 * is read, not acted on.
 */

export function collectInbox(_db: Database.Database, _person: string, _level: AccessLevel): { count: number; items: InboxItem[] } {
  return { count: 0, items: [] };
}

export function watchReports(db: Database.Database, people: People): void {
  consume<{ id: number; report_id: number; schedule_id: number | null; trigger: string; status: string; row_count: number | null; error: string | null }>(
    db,
    'runs',
    'runs',
    (run) => {
      if (run.trigger !== 'scheduled' || run.schedule_id === null) return;
      const s = db
        .prepare('SELECT s.created_by, r.name FROM schedules s JOIN reports r ON r.id = s.report_id WHERE s.id = ?')
        .get(run.schedule_id) as { created_by: string | null; name: string } | undefined;
      if (!s?.created_by) return;
      const ok = run.status === 'ok';
      people.notify({
        kind: ok ? 'report-ready' : 'report-failed',
        category: ok ? 'outcomes' : 'alerts',
        urgency: ok ? 'digest' : 'now',
        recipients: [s.created_by],
        title: ok ? 'A scheduled report is ready' : 'A scheduled report failed',
        detail: ok ? `${s.name} · ${run.row_count ?? 0} rows` : `${s.name} · ${run.error ?? ''}`,
        href: `/reports/${run.report_id}`,
        key: `run:${run.id}`,
      });
    },
  );

  consume<{ id: number; alert_id: number; value: number }>(db, 'report_alert_hits', 'report_alert_hits', (hit) => {
    const a = db
      .prepare('SELECT a.owner, a.column_name, a.op, a.threshold, r.name, r.id AS report_id FROM report_alerts a JOIN reports r ON r.id = a.report_id WHERE a.id = ?')
      .get(hit.alert_id) as { owner: string; column_name: string; op: string; threshold: number; name: string; report_id: number } | undefined;
    if (!a) return;
    people.notify({
      kind: 'threshold',
      category: 'alerts',
      urgency: 'now',
      recipients: [a.owner],
      title: 'A figure you watch crossed your threshold',
      detail: `${a.name} · ${a.column_name} = ${hit.value} (${a.op} ${a.threshold})`,
      href: `/reports/${a.report_id}`,
      key: `hit:${hit.id}`,
    });
  });
}
