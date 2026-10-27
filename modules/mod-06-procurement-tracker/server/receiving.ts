import type Database from 'better-sqlite3';
import type { FieldError, GoodsReceipt, InvoicedLine, LineVerdict, MatchSettings, MatchVerdict, PoDetail } from '../shared/types.js';
import { DomainError, nowIso, poDetail, receiptsOf, receivedByLine, requireRow } from './purchase-orders.js';

/**
 * Receiving and the three-way match — the PO's side of it.
 *
 * - **What arrived** is recorded here, against an ordered PO, as goods
 *   receipts: append-only, a miscount corrected by a correction receipt with
 *   a reason. How much of a line has arrived is derived from them; a line
 *   never takes more than was ordered, nor goes below nothing.
 * - **What may be invoiced** is answered here too (`matchVerdict`), because
 *   this module knows what was ordered, at which price, and what arrived. The
 *   invoice itself lives where it is paid (MOD-04), which asks with the net
 *   amount invoiced against the PO so far; this module stores no invoices.
 *
 *   matched           invoiced ≤ received value + tolerance
 *   awaiting_receipt  more than has arrived, not more than was ordered (+ tolerance)
 *   over_invoiced     more than was ordered (+ tolerance)
 *   not_ordered       the PO was never ordered — nothing can be owed on it
 *
 *   tolerance = min(received value × percent, cap) — the small differences
 *   (rounding, a freight line) a person should not have to release by hand.
 *
 * - **Line by line** (`lineVerdicts`), when MOD-04 sends the invoice's lines:
 *   the amount can match while the goods do not — ten widgets invoiced, ten
 *   bolts received, the same money. Each invoiced line is matched to a PO
 *   line by SKU (the supplier's article number), else by its exact
 *   description, and its quantity is held against what arrived and what was
 *   ordered, its unit price against the PO price plus the tolerance percent.
 *   A line not on the PO holds the invoice only above the tolerance cap — a
 *   freight line is normal. The header verdict is unchanged; `line_issues`
 *   says how many lines hold it on their own.
 */

export const DEFAULT_MATCH_SETTINGS: MatchSettings = { tolerance_percent: 2, tolerance_cap_cents: 5000, receiving_warehouse: null, line_matching: true };

export function readMatchSettings(db: Database.Database): MatchSettings {
  const row = db.prepare('SELECT settings FROM procurement_settings WHERE id = 1').get() as { settings: string } | undefined;
  return row ? { ...DEFAULT_MATCH_SETTINGS, ...(JSON.parse(row.settings) as Partial<MatchSettings>) } : { ...DEFAULT_MATCH_SETTINGS };
}

export function matchSettingsStamp(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM procurement_settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

export function validateMatchSettings(input: Record<string, unknown>): MatchSettings {
  const errors: FieldError[] = [];
  const percent = Number(input.tolerance_percent ?? DEFAULT_MATCH_SETTINGS.tolerance_percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 20) errors.push({ field: 'tolerance_percent', message: 'tolerance_percent is 0 to 20' });
  const cap = Number(input.tolerance_cap_cents ?? DEFAULT_MATCH_SETTINGS.tolerance_cap_cents);
  if (!Number.isInteger(cap) || cap < 0 || cap > 10_000_000) errors.push({ field: 'tolerance_cap_cents', message: 'tolerance_cap_cents is whole cents, 0 or more' });
  const raw = input.receiving_warehouse;
  let warehouse: string | null = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string' || raw.trim().length > 30) errors.push({ field: 'receiving_warehouse', message: 'receiving_warehouse is a MOD-03 warehouse code' });
    else warehouse = raw.trim();
  }
  const lineMatching = input.line_matching ?? DEFAULT_MATCH_SETTINGS.line_matching;
  if (typeof lineMatching !== 'boolean') errors.push({ field: 'line_matching', message: 'line_matching is true or false' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { tolerance_percent: percent, tolerance_cap_cents: cap, receiving_warehouse: warehouse, line_matching: lineMatching as boolean };
}

export function writeMatchSettings(db: Database.Database, settings: MatchSettings, actor: string): void {
  db.prepare(
    `INSERT INTO procurement_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), nowIso(), actor);
}

// ── Receipts ────────────────────────────────────────────────────────────

export function getReceipt(db: Database.Database, id: number): GoodsReceipt {
  const row = requireRow(db.prepare('SELECT po_id FROM goods_receipts WHERE id = ?').get(id) as { po_id: number } | undefined, 'Goods receipt');
  return receiptsOf(db, row.po_id).find((r) => r.id === id)!;
}

export interface ReceiptInput {
  kind: 'receipt' | 'correction';
  receivedOn: string;
  note: string | null;
  lines: { poLineId: number; quantity: number }[];
}

/** Record what arrived against an ordered PO. Returns the new receipt. */
export function receiveGoods(db: Database.Database, poId: number, input: ReceiptInput, actor: string): GoodsReceipt {
  return db.transaction((): GoodsReceipt => {
    const po = requireRow(
      db.prepare('SELECT id, number, status FROM purchase_orders WHERE id = ?').get(poId) as { id: number; number: string; status: string } | undefined,
      'Purchase order',
    );
    if (po.status !== 'ordered') {
      throw new DomainError(409, po.status === 'closed' ? 'This PO is closed — nothing more arrives on it' : 'Goods are received only on an ordered PO');
    }
    const errors: FieldError[] = [];
    if (input.lines.length === 0) errors.push({ field: 'lines', message: 'A receipt receives at least one line' });
    if (input.kind === 'correction' && !input.note) errors.push({ field: 'note', message: 'A correction says why' });
    const ordered = new Map(
      (db.prepare('SELECT id, position, quantity FROM po_lines WHERE po_id = ?').all(poId) as { id: number; position: number; quantity: number }[]).map((l) => [l.id, l]),
    );
    const received = receivedByLine(db, poId);
    const seen = new Set<number>();
    input.lines.forEach((line, i) => {
      const poLine = ordered.get(line.poLineId);
      if (!poLine) {
        errors.push({ field: `lines[${i}].po_line_id`, message: 'That line is not on this PO' });
        return;
      }
      if (seen.has(line.poLineId)) errors.push({ field: `lines[${i}].po_line_id`, message: 'Each line once per receipt' });
      seen.add(line.poLineId);
      if (input.kind === 'receipt' && line.quantity <= 0) {
        errors.push({ field: `lines[${i}].quantity`, message: 'A receipt counts goods in — correct a miscount with a correction' });
        return;
      }
      const after = Math.round(((received.get(line.poLineId) ?? 0) + line.quantity) * 1000) / 1000;
      if (after > poLine.quantity) {
        errors.push({ field: `lines[${i}].quantity`, message: `Line ${poLine.position}: only ${Math.round((poLine.quantity - (received.get(line.poLineId) ?? 0)) * 1000) / 1000} still to arrive` });
      } else if (after < 0) {
        errors.push({ field: `lines[${i}].quantity`, message: `Line ${poLine.position}: only ${received.get(line.poLineId) ?? 0} have arrived` });
      }
    });
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

    const n = (db.prepare('SELECT COUNT(*) AS n FROM goods_receipts WHERE po_id = ?').get(poId) as { n: number }).n + 1;
    const info = db
      .prepare('INSERT INTO goods_receipts (po_id, number, kind, received_on, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(poId, `${po.number}/WE-${n}`, input.kind, input.receivedOn, input.note, actor, nowIso());
    const id = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO goods_receipt_lines (receipt_id, po_line_id, quantity) VALUES (?, ?, ?)');
    for (const line of input.lines) insert.run(id, line.poLineId, line.quantity);
    return getReceipt(db, id);
  })();
}

/** Record what MOD-03 answered when the receipt was booked as stock. */
export function recordStockOutcome(db: Database.Database, id: number, status: 'booked' | 'failed' | 'not_booked', warehouse: string | null, error: string | null): void {
  db.prepare('UPDATE goods_receipts SET stock_status = ?, stock_warehouse = ?, stock_error = ? WHERE id = ?').run(status, warehouse, error, id);
}

// ── The match ───────────────────────────────────────────────────────────

const q3 = (n: number) => Math.round(n * 1000) / 1000;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The invoice's lines (everything invoiced against the PO so far) against the PO's lines. */
export function lineVerdicts(po: PoDetail, settings: MatchSettings, invoiced: InvoicedLine[]): LineVerdict[] {
  const bySku = new Map(po.lines.filter((l) => l.sku).map((l) => [norm(l.sku!), l]));
  // A description shared by two PO lines says nothing about which one is meant.
  const descCount = new Map<string, number>();
  for (const l of po.lines) descCount.set(norm(l.description), (descCount.get(norm(l.description)) ?? 0) + 1);
  const byDesc = new Map(po.lines.filter((l) => descCount.get(norm(l.description)) === 1).map((l) => [norm(l.description), l]));

  // Several invoice lines (two bills, a spelling variant) can be one PO line: summed per PO line.
  const groups = new Map<string, { line: PoDetail['lines'][number] | null; matchedBy: LineVerdict['matched_by']; item: InvoicedLine; quantity: number | null; net: number }>();
  for (const inv of invoiced) {
    const sku = inv.item_id ? bySku.get(norm(inv.item_id)) : undefined;
    const line = sku ?? byDesc.get(norm(inv.description)) ?? null;
    const key = line ? `po:${line.id}` : `x:${norm(inv.item_id ?? '')}|${norm(inv.description)}`;
    const group = groups.get(key);
    if (group) {
      group.quantity = group.quantity === null || inv.quantity === null ? null : q3(group.quantity + inv.quantity);
      group.net += inv.net_cents;
    } else {
      groups.set(key, { line, matchedBy: line ? (sku ? 'sku' : 'description') : null, item: inv, quantity: inv.quantity, net: inv.net_cents });
    }
  }

  const eur = (c: number) => (c / 100).toFixed(2);
  return [...groups.values()].map(({ line, matchedBy, item, quantity, net }): LineVerdict => {
    const unitPrice = quantity !== null && quantity > 0 ? Math.round(net / quantity) : null;
    const base = {
      item_id: item.item_id,
      description: item.description,
      po_position: line?.position ?? null,
      matched_by: matchedBy,
      invoiced_quantity: quantity,
      received_quantity: line?.received_quantity ?? null,
      ordered_quantity: line?.quantity ?? null,
      invoiced_net_cents: net,
      invoiced_unit_price_cents: unitPrice,
      ordered_unit_price_cents: line?.unit_price_cents ?? null,
    };
    const name = item.item_id ? `${item.description} (${item.item_id})` : item.description;
    if (!line) {
      const issue = net > settings.tolerance_cap_cents;
      return { ...base, result: 'not_on_po', issue, message: `${name}: not on ${po.number}${issue ? ` — ${eur(net)} is more than the ${eur(settings.tolerance_cap_cents)} a line may add` : ''}` };
    }
    const at = `PO line ${line.position}`;
    if (quantity === null) return { ...base, result: 'unchecked', issue: false, message: `${name}: ${at}, no quantity on the invoice to compare` };
    if (quantity > line.quantity) {
      return { ...base, result: 'over_ordered', issue: true, message: `${name}: ${quantity} invoiced, ${line.quantity} ordered (${at})` };
    }
    if (quantity > line.received_quantity) {
      return { ...base, result: 'awaiting_receipt', issue: true, message: `${name}: ${quantity} invoiced, ${line.received_quantity} received so far (${at})` };
    }
    const limit = Math.round(line.unit_price_cents * (1 + settings.tolerance_percent / 100));
    if (unitPrice !== null && unitPrice > limit) {
      return { ...base, result: 'price_above', issue: true, message: `${name}: ${eur(unitPrice)} a unit invoiced, ${eur(line.unit_price_cents)} on the PO (${at})` };
    }
    return { ...base, result: 'ok', issue: false, message: `${name}: ${quantity} invoiced, ${line.received_quantity} received (${at})` };
  });
}

/**
 * May `invoicedCents` (net, everything invoiced against the PO so far) be
 * paid? With `invoicedLines`, also line by line (see the header comment).
 */
export function matchVerdict(db: Database.Database, poNumber: string, invoicedCents: number, invoicedLines: InvoicedLine[] = []): MatchVerdict {
  const row = db.prepare('SELECT id FROM purchase_orders WHERE number = ?').get(poNumber) as { id: number } | undefined;
  if (!row) throw new DomainError(404, `There is no purchase order ${poNumber}`);
  const po = poDetail(db, row.id);
  const settings = readMatchSettings(db);
  const tolerance = (value: number) => Math.min(Math.round((value * settings.tolerance_percent) / 100), settings.tolerance_cap_cents);
  const ordered = po.total_cents;
  const received = po.received_cents;
  const base = {
    po_number: po.number,
    supplier_name: po.supplier_name,
    po_status: po.status,
    ordered_cents: ordered,
    received_cents: received,
    invoiced_cents: invoicedCents,
    tolerance_cents: tolerance(received),
    difference_cents: invoicedCents - received,
  };
  const eur = (c: number) => (c / 100).toFixed(2);
  const lines = settings.line_matching && invoicedLines.length > 0 && (po.status === 'ordered' || po.status === 'closed') ? lineVerdicts(po, settings, invoicedLines) : [];
  const issues = lines.filter((l) => l.issue);
  const lineNote = issues.length === 0 ? '' : ` · ${issues.length} line${issues.length === 1 ? '' : 's'} do${issues.length === 1 ? 'es' : ''} not match: ${issues.map((l) => l.message).join('; ')}`;
  const withLines = { lines, line_issues: issues.length };
  if (po.status !== 'ordered' && po.status !== 'closed') {
    return { ...base, ...withLines, result: 'not_ordered', message: `${po.number} has not been ordered (${po.status}) — nothing is owed on it` };
  }
  if (invoicedCents <= received + tolerance(received)) {
    return { ...base, ...withLines, result: 'matched', message: `${eur(invoicedCents)} invoiced against ${eur(received)} received${lineNote}` };
  }
  if (invoicedCents <= ordered + tolerance(ordered)) {
    return { ...base, ...withLines, result: 'awaiting_receipt', message: `${eur(invoicedCents)} invoiced but only ${eur(received)} received so far — pay once the goods have arrived${lineNote}` };
  }
  return { ...base, ...withLines, tolerance_cents: tolerance(ordered), result: 'over_invoiced', message: `${eur(invoicedCents)} invoiced against ${eur(ordered)} ordered${lineNote}` };
}
