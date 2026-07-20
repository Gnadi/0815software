import type Database from 'better-sqlite3';
import type { DealDetail, DealRow, StageEvent, StageEventKind } from '../shared/types.js';
import {
  defaultStageKey,
  expectedValueCents,
  isStageKey,
  isTerminal,
  stageByKey,
} from './pipeline-config.js';
import { getCompany } from './companies.js';
import { activitiesForDeal } from './activities.js';
import { DomainError, nowIso, requireRow } from './domain.js';

interface DealStoredRow {
  id: number;
  title: string;
  company_id: number;
  primary_contact_id: number | null;
  value_cents: number;
  stage: string;
  note: string | null;
  created_at: string;
}

export interface DealInput {
  title: string;
  companyId: number;
  primaryContactId: number | null;
  valueCents: number;
  /** Optional starting stage; defaults to the first pipeline stage. */
  stage?: string;
  note: string | null;
  createdAt?: string;
}

function getDealRow(db: Database.Database, id: number): DealStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as DealStoredRow | undefined,
    'Deal',
  );
}

function toRow(db: Database.Database, deal: DealStoredRow): DealRow {
  const stage = stageByKey(deal.stage)!;
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(deal.company_id) as {
    name: string;
  };
  const contact =
    deal.primary_contact_id === null
      ? null
      : (db.prepare('SELECT name FROM contacts WHERE id = ?').get(deal.primary_contact_id) as
          | { name: string }
          | undefined) ?? null;
  return {
    id: deal.id,
    title: deal.title,
    company_id: deal.company_id,
    company_name: company.name,
    primary_contact_id: deal.primary_contact_id,
    primary_contact_name: contact ? contact.name : null,
    value_cents: deal.value_cents,
    stage: deal.stage,
    stage_label: stage.label,
    probability: stage.probability,
    expected_value_cents: expectedValueCents(deal.value_cents, deal.stage),
    terminal: stage.terminal,
    note: deal.note,
    created_at: deal.created_at,
  };
}

export function stageEvents(db: Database.Database, dealId: number): StageEvent[] {
  return db
    .prepare('SELECT * FROM deal_stage_events WHERE deal_id = ? ORDER BY id')
    .all(dealId) as StageEvent[];
}

export function listDeals(
  db: Database.Database,
  opts: { stage?: string; search?: string; companyId?: number; contactId?: number } = {},
): DealRow[] {
  const term = opts.search?.trim();
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (term) {
    where.push('d.title LIKE @s');
    params.s = `%${term}%`;
  }
  if (opts.stage) {
    where.push('d.stage = @stage');
    params.stage = opts.stage;
  }
  if (opts.companyId) {
    where.push('d.company_id = @companyId');
    params.companyId = opts.companyId;
  }
  if (opts.contactId) {
    where.push('d.primary_contact_id = @contactId');
    params.contactId = opts.contactId;
  }
  const deals = db
    .prepare(
      `SELECT d.* FROM deals d
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.created_at DESC, d.id DESC`,
    )
    .all(params) as DealStoredRow[];
  return deals.map((d) => toRow(db, d));
}

export function dealRow(db: Database.Database, id: number): DealRow {
  return toRow(db, getDealRow(db, id));
}

export function dealDetail(db: Database.Database, id: number): DealDetail {
  const deal = getDealRow(db, id);
  return {
    ...toRow(db, deal),
    stage_events: stageEvents(db, id),
    activities: activitiesForDeal(db, id),
  };
}

/**
 * Create a deal. The opening stage event is written in the same
 * transaction, so from the very first moment the invariant holds:
 * deals.stage === the latest stage event's to_stage.
 */
export function createDeal(db: Database.Database, input: DealInput): number {
  getCompany(db, input.companyId);
  if (input.primaryContactId !== null) {
    const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(input.primaryContactId);
    if (!contact) throw new DomainError(404, 'Contact not found');
  }
  const stage = input.stage ?? defaultStageKey();
  if (!isStageKey(stage)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'stage', message: `Unknown stage "${stage}"` }]);
  }
  const createdAt = input.createdAt ?? nowIso();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO deals (title, company_id, primary_contact_id, value_cents, stage, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.title, input.companyId, input.primaryContactId, input.valueCents, stage, input.note, createdAt);
    const dealId = Number(info.lastInsertRowid);
    appendStageEvent(db, dealId, null, stage, 'open', null, createdAt);
    return dealId;
  })();
}

function appendStageEvent(
  db: Database.Database,
  dealId: number,
  fromStage: string | null,
  toStage: string,
  kind: StageEventKind,
  note: string | null,
  at: string,
): void {
  db.prepare(
    `INSERT INTO deal_stage_events (deal_id, from_stage, to_stage, kind, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(dealId, fromStage, toStage, kind, note, at);
}

/** Edit a deal's descriptive fields (never its stage — that goes through moveStage). */
export function updateDeal(
  db: Database.Database,
  id: number,
  input: Omit<DealInput, 'stage'>,
): void {
  getDealRow(db, id);
  getCompany(db, input.companyId);
  if (input.primaryContactId !== null) {
    const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(input.primaryContactId);
    if (!contact) throw new DomainError(404, 'Contact not found');
  }
  db.prepare(
    'UPDATE deals SET title = ?, company_id = ?, primary_contact_id = ?, value_cents = ?, note = ? WHERE id = ?',
  ).run(input.title, input.companyId, input.primaryContactId, input.valueCents, input.note, id);
}

/**
 * Move a deal to another stage. Appends a stage event and updates the
 * cached `stage` in one transaction — so the invariant is preserved.
 *
 *   - Unknown target stage → 422.
 *   - Moving to the SAME stage → 409 (no-op, documented; no event written).
 *   - Moving a won/lost (terminal) deal → 409. A terminal deal can only
 *     leave its stage through `reopenDeal`.
 */
export function moveStage(db: Database.Database, id: number, toStage: string, note: string | null, at?: string): void {
  const deal = getDealRow(db, id);
  if (!isStageKey(toStage)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'stage', message: `Unknown stage "${toStage}"` }]);
  }
  if (isTerminal(deal.stage)) {
    throw new DomainError(
      409,
      `Deal is ${stageByKey(deal.stage)!.label.toLowerCase()} and terminal — reopen it before moving it again`,
    );
  }
  if (toStage === deal.stage) {
    throw new DomainError(409, `Deal is already at stage "${deal.stage}"`);
  }
  const when = at ?? nowIso();
  db.transaction(() => {
    appendStageEvent(db, id, deal.stage, toStage, 'move', note, when);
    db.prepare('UPDATE deals SET stage = ? WHERE id = ?').run(toStage, id);
  })();
}

/**
 * Reopen a won/lost deal back to an active stage. A distinct action that
 * appends a `reopen` stage event (recorded forever) and moves the deal
 * to a non-terminal stage. Reopening a deal that is not terminal → 409.
 */
export function reopenDeal(db: Database.Database, id: number, toStage: string, note: string | null, at?: string): void {
  const deal = getDealRow(db, id);
  if (!isTerminal(deal.stage)) {
    throw new DomainError(409, 'Only won or lost deals can be reopened');
  }
  if (!isStageKey(toStage)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'stage', message: `Unknown stage "${toStage}"` }]);
  }
  if (isTerminal(toStage)) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'stage', message: 'Reopen target must be an active (non-terminal) stage' },
    ]);
  }
  const when = at ?? nowIso();
  db.transaction(() => {
    appendStageEvent(db, id, deal.stage, toStage, 'reopen', note, when);
    db.prepare('UPDATE deals SET stage = ? WHERE id = ?').run(toStage, id);
  })();
}
