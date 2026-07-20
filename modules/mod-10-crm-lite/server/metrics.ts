import type Database from 'better-sqlite3';
import type { Metrics, StageMetric, WinRate } from '../shared/types.js';
import { expectedValueCents, LOST_KEY, STAGES, WON_KEY } from './pipeline-config.js';

interface DealValueRow {
  stage: string;
  value_cents: number;
}

/**
 * All pipeline metrics are DERIVED here from the deals table and the one
 * pipeline config — nothing is read from a stored summary. Per-stage: a
 * live count, sum of value and sum of expected value (each deal's value ×
 * its stage probability, rounded per deal then summed). Win rate: won /
 * (won + lost) restricted to deals that CLOSED inside the given date
 * range (the date of the latest stage event that put them in won/lost).
 */
export function computeMetrics(db: Database.Database, range: { from?: string; to?: string } = {}): Metrics {
  const deals = db.prepare('SELECT stage, value_cents FROM deals').all() as DealValueRow[];

  const stages: StageMetric[] = STAGES.map((stage) => {
    const inStage = deals.filter((d) => d.stage === stage.key);
    const value = inStage.reduce((sum, d) => sum + d.value_cents, 0);
    const expected = inStage.reduce((sum, d) => sum + expectedValueCents(d.value_cents, stage.key), 0);
    return {
      key: stage.key,
      label: stage.label,
      probability: stage.probability,
      terminal: stage.terminal,
      count: inStage.length,
      value_cents: value,
      expected_value_cents: expected,
    };
  });

  const totals = stages.reduce(
    (acc, s) => ({
      count: acc.count + s.count,
      value_cents: acc.value_cents + s.value_cents,
      expected_value_cents: acc.expected_value_cents + s.expected_value_cents,
    }),
    { count: 0, value_cents: 0, expected_value_cents: 0 },
  );

  return { stages, totals, win_rate: computeWinRate(db, range) };
}

export function computeWinRate(db: Database.Database, range: { from?: string; to?: string } = {}): WinRate {
  const from = range.from ?? null;
  const to = range.to ?? null;
  // The latest stage event per deal is the one that set its current
  // stage (invariant). For terminal deals that is the closing event; its
  // date is the deal's close date.
  const rows = db
    .prepare(
      `SELECT e.to_stage AS stage, substr(e.created_at, 1, 10) AS closed_on
       FROM deal_stage_events e
       JOIN (SELECT deal_id, MAX(id) AS mid FROM deal_stage_events GROUP BY deal_id) m
         ON m.mid = e.id
       JOIN deals d ON d.id = e.deal_id
       WHERE d.stage IN (@won, @lost)`,
    )
    .all({ won: WON_KEY, lost: LOST_KEY }) as { stage: string; closed_on: string }[];

  let won = 0;
  let lost = 0;
  for (const row of rows) {
    if (from !== null && row.closed_on < from) continue;
    if (to !== null && row.closed_on > to) continue;
    if (row.stage === WON_KEY) won += 1;
    else if (row.stage === LOST_KEY) lost += 1;
  }
  const closed = won + lost;
  return { from, to, won, lost, rate: closed === 0 ? null : won / closed };
}
