import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { watchReports } from '../server/inbox-rules.js';
import { checkAlerts, createAlert, deleteAlert, listAlerts } from '../server/alerts.js';

/** MOD-08's notification rules: a scheduled report ready or failed, and a figure across someone's threshold. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO reports (id, name, sql, created_at, updated_at) VALUES (1, 'Receivables', 'SELECT 1', ?, ?)").run(T, T);
  db.prepare("INSERT INTO schedules (id, report_id, interval, format, enabled, created_at, created_by) VALUES (1, 1, 'daily', 'csv', 1, ?, 'ada@acme.test')").run(T);
  sent = [];
  watchReports(db, people);
});

const run = (status: 'ok' | 'error', trigger = 'scheduled') =>
  Number(
    db
      .prepare('INSERT INTO runs (report_id, schedule_id, trigger, status, started_at, finished_at, row_count, error) VALUES (1, 1, ?, ?, ?, ?, 3, ?)')
      .run(trigger, status, T, T, status === 'error' ? 'no such view' : null).lastInsertRowid,
  );

describe('MOD-08', () => {
  it('who scheduled a report hears it is ready in the digest, that it failed now — not of runs by hand', () => {
    run('ok');
    run('error');
    run('ok', 'manual');
    watchReports(db, people);
    expect(sent.map((e) => [e.kind, e.urgency, e.recipients])).toEqual([
      ['report-ready', 'digest', ['ada@acme.test']],
      ['report-failed', 'now', ['ada@acme.test']],
    ]);
  });

  it('a threshold is the owner’s, checked on the first row, and told when crossed', () => {
    const alert = createAlert(db, 1, 'ada@acme.test', { column: 'open_cents', op: 'above', threshold: 5000000 }, T);
    expect(listAlerts(db, 1, 'bob@acme.test')).toEqual([]);
    expect(() => deleteAlert(db, alert.id, 'bob@acme.test')).toThrow();
    expect(() => createAlert(db, 1, 'ada@acme.test', { column: '', op: 'sideways', threshold: 'x' }, T)).toThrow();
    const id = run('ok', 'manual');
    checkAlerts(db, 1, id, { open_cents: 4_000_000 }, T);
    checkAlerts(db, 1, id, { open_cents: 6_000_000 }, T);
    checkAlerts(db, 1, id, { open_cents: 'n/a' }, T);
    watchReports(db, people);
    expect(sent.filter((e) => e.kind === 'threshold')).toEqual([
      expect.objectContaining({ recipients: ['ada@acme.test'], urgency: 'now', detail: 'Receivables · open_cents = 6000000 (above 5000000)' }),
    ]);
  });
});
