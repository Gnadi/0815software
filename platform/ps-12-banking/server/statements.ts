import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { publicId } from './connections.js';
import { readBankStatement, type AccountStatement, type StatementEntry } from './camt.js';
import { documentsIn, ZipError } from './zip.js';
import type { StatementEntryRow, StatementRow } from '../shared/types.js';

/**
 * Bookings, stored and made searchable.
 *
 * ## Where the line is drawn
 *
 * This service now READS a camt.053 — see the header of `camt.ts` for why that
 * moved here. It still does not decide what a booking MEANS. There is no
 * "match this entry to invoice 42" here and there should not be: which invoice
 * a payment settles depends on the invoices, and those live in the module that
 * issued them.
 *
 * What is offered instead is the query a matcher needs: *give me the bookings
 * on this account, in this period, with this reference or this amount.* The
 * module holds the invoices and does the matching; this holds the bank data
 * and answers questions about it. That split is the same one `payload.ts`
 * makes on the way out — format here, meaning there.
 *
 * ## Why these are rows and not re-parsed on demand
 *
 * Every other reader in this service parses on the way out, so that a better
 * reader improves files already collected. This one cannot: "was invoice 42
 * paid?" is a search across every statement ever collected, and answering it
 * by re-parsing each stored blob is a full scan dressed up as a read model.
 *
 * The bytes are still the record. `applyStatements` is driven by
 * `downloads.processed_at`, so clearing that column re-reads everything — which
 * is exactly what a parser fix needs.
 */

interface DbStatementRow {
  id: number;
  connection_id: number;
  download_id: number;
  public_id: string;
  version: string;
  message_id: string;
  statement_id: string;
  electronic_seq: number | null;
  legal_seq: number | null;
  created_at: string | null;
  from_date: string | null;
  to_date: string | null;
  account_iban: string | null;
  account_other: string | null;
  account_currency: string | null;
  account_name: string | null;
  account_owner: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  balance_currency: string | null;
  entry_count: number;
}

// ── Storing ───────────────────────────────────────────────────────────

/**
 * Read every unprocessed statement download into bookings.
 *
 * Returns how many STATEMENTS were stored — not entries, because a statement
 * is the unit a bank sends and the unit that can be a duplicate.
 *
 * A file that cannot be read marks itself processed anyway. The bytes are
 * stored and the failure is logged; leaving it unprocessed would make every
 * later tick try it again and report the same problem forever.
 */
export function applyStatements(db: Database.Database, now: () => string): number {
  const pending = db
    .prepare(
      `SELECT d.id AS download_id, d.public_id, d.connection_id
         FROM downloads d
        WHERE d.kind = 'statement' AND d.processed_at IS NULL
        ORDER BY d.id`,
    )
    .all() as { download_id: number; public_id: string; connection_id: number }[];

  let stored = 0;
  for (const row of pending) {
    const content = db.prepare('SELECT content FROM downloads WHERE id = ?').get(row.download_id) as {
      content: Buffer;
    };

    let documents: Buffer[];
    try {
      documents = documentsIn(content.content);
    } catch (err) {
      console.warn(
        `[ps-12] ${row.public_id} could not be opened as an archive: ${err instanceof ZipError ? err.message : err}`,
      );
      documents = [];
    }

    for (const document of documents) {
      const message = readBankStatement(document);
      if (message === null) {
        console.warn(`[ps-12] ${row.public_id} contains a document that is not a camt.053`);
        continue;
      }
      for (const statement of message.statements) {
        if (
          storeStatement(db, {
            connectionId: row.connection_id,
            downloadId: row.download_id,
            version: message.version,
            messageId: message.messageId,
            statement,
            at: now(),
          })
        ) {
          stored += 1;
        }
      }
    }

    db.prepare('UPDATE downloads SET processed_at = ? WHERE id = ?').run(now(), row.download_id);
  }

  return stored;
}

/** Returns false when this statement was already stored. */
function storeStatement(
  db: Database.Database,
  params: {
    connectionId: number;
    downloadId: number;
    version: string;
    messageId: string;
    statement: AccountStatement;
    at: string;
  },
): boolean {
  const { statement } = params;
  const iban = statement.account.iban;

  const existing = db
    .prepare(
      `SELECT id FROM statements
        WHERE connection_id = ? AND statement_id = ?
          AND (account_iban IS ? OR (account_iban IS NULL AND ? IS NULL))`,
    )
    .get(params.connectionId, statement.statementId, iban, iban) as { id: number } | undefined;
  // The bank re-sent a statement we already hold. Storing it again would
  // double every booking on it for anything that sums them.
  if (existing !== undefined) return false;

  const balance = (type: string): string | null => {
    const found = statement.balances.find((b) => b.type === type);
    if (found === undefined) return null;
    // Kept signed HERE, unlike an entry: a closing balance is a position, and
    // a consumer comparing two of them needs the direction in the number.
    return found.credit ? found.amount : `-${found.amount}`;
  };

  db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO statements
           (download_id, connection_id, public_id, version, message_id, statement_id,
            electronic_seq, legal_seq, created_at, from_date, to_date,
            account_iban, account_other, account_currency, account_name, account_owner,
            opening_balance, closing_balance, balance_currency, entry_count, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.downloadId,
        params.connectionId,
        publicId('stm'),
        params.version,
        params.messageId,
        statement.statementId,
        statement.electronicSequence,
        statement.legalSequence,
        statement.createdAt,
        statement.fromDate,
        statement.toDate,
        iban,
        statement.account.other,
        statement.account.currency,
        statement.account.name,
        statement.account.owner,
        balance('OPBD'),
        balance('CLBD'),
        statement.balances[0]?.currency ?? null,
        statement.entries.length,
        params.at,
      );

    const statementRowId = Number(info.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO statement_entries
         (statement_id, seq, amount, amount_hundredths, currency, credit, reversal, status,
          booking_date, value_date, entry_ref, account_servicer_ref, bank_transaction_code,
          end_to_end_id, mandate_id, msg_id, payment_info_id, instruction_id,
          counterparty_name, counterparty_iban, remittance, creditor_reference, purpose,
          return_reason, additional_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of statement.entries) {
      insert.run(
        statementRowId,
        entry.seq,
        entry.amount,
        entry.amountHundredths,
        entry.currency,
        entry.credit ? 1 : 0,
        entry.reversal ? 1 : 0,
        entry.status,
        entry.bookingDate,
        entry.valueDate,
        entry.entryRef,
        entry.accountServicerRef,
        entry.bankTransactionCode,
        entry.endToEndId,
        entry.mandateId,
        entry.msgId,
        entry.paymentInfoId,
        entry.instructionId,
        entry.counterpartyName,
        entry.counterpartyIban,
        entry.remittance,
        entry.creditorReference,
        entry.purpose,
        entry.returnReason,
        entry.additionalInfo,
      );
    }
  })();

  return true;
}

// ── Reading ───────────────────────────────────────────────────────────

function toStatement(db: Database.Database, row: DbStatementRow): StatementRow {
  const connection = db.prepare('SELECT key FROM bank_connections WHERE id = ?').get(row.connection_id) as
    | { key: string }
    | undefined;
  const download = db.prepare('SELECT public_id FROM downloads WHERE id = ?').get(row.download_id) as
    | { public_id: string }
    | undefined;
  return {
    public_id: row.public_id,
    connection: connection?.key ?? '',
    download: download?.public_id ?? null,
    version: row.version,
    message_id: row.message_id,
    statement_id: row.statement_id,
    electronic_seq: row.electronic_seq,
    legal_seq: row.legal_seq,
    created_at: row.created_at,
    from_date: row.from_date,
    to_date: row.to_date,
    account: {
      iban: row.account_iban,
      other: row.account_other,
      currency: row.account_currency,
      name: row.account_name,
      owner: row.account_owner,
    },
    opening_balance: row.opening_balance,
    closing_balance: row.closing_balance,
    balance_currency: row.balance_currency,
    entry_count: row.entry_count,
  };
}

export function listStatements(
  db: Database.Database,
  opts: { connection?: string; account?: string; limit?: number } = {},
): StatementRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.connection !== undefined) {
    where.push('c.key = ?');
    args.push(opts.connection);
  }
  if (opts.account !== undefined) {
    where.push('s.account_iban = ?');
    args.push(opts.account);
  }
  const rows = db
    .prepare(
      `SELECT s.* FROM statements s JOIN bank_connections c ON c.id = s.connection_id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.id DESC LIMIT ?`,
    )
    .all(...args, opts.limit ?? 100) as DbStatementRow[];
  return rows.map((row) => toStatement(db, row));
}

export function statementDetail(
  db: Database.Database,
  publicIdValue: string,
): StatementRow & { entries: StatementEntryRow[] } {
  const row = db.prepare('SELECT * FROM statements WHERE public_id = ?').get(publicIdValue) as
    | DbStatementRow
    | undefined;
  if (row === undefined) throw new DomainError(404, `no statement ${publicIdValue}`);
  const entries = db
    .prepare('SELECT * FROM statement_entries WHERE statement_id = ? ORDER BY seq')
    .all(row.id) as Record<string, unknown>[];
  return { ...toStatement(db, row), entries: entries.map((e) => toEntry(e, row)) };
}

function toEntry(raw: Record<string, unknown>, statement: DbStatementRow): StatementEntryRow {
  return {
    statement: statement.public_id,
    account_iban: statement.account_iban,
    seq: raw.seq as number,
    amount: raw.amount as string,
    amount_hundredths: raw.amount_hundredths as number | null,
    currency: raw.currency as string,
    credit: raw.credit === 1,
    reversal: raw.reversal === 1,
    status: raw.status as string,
    booking_date: raw.booking_date as string | null,
    value_date: raw.value_date as string | null,
    entry_ref: raw.entry_ref as string | null,
    account_servicer_ref: raw.account_servicer_ref as string | null,
    bank_transaction_code: raw.bank_transaction_code as string | null,
    end_to_end_id: raw.end_to_end_id as string | null,
    mandate_id: raw.mandate_id as string | null,
    msg_id: raw.msg_id as string | null,
    payment_info_id: raw.payment_info_id as string | null,
    instruction_id: raw.instruction_id as string | null,
    counterparty_name: raw.counterparty_name as string | null,
    counterparty_iban: raw.counterparty_iban as string | null,
    remittance: raw.remittance as string | null,
    creditor_reference: raw.creditor_reference as string | null,
    purpose: raw.purpose as string | null,
    return_reason: raw.return_reason as string | null,
    additional_info: raw.additional_info as string | null,
  };
}

/** What a consumer looking for a payment can narrow by. */
export interface EntryQuery {
  connection?: string;
  account?: string;
  /** Inclusive, on the BOOKING date — the date the money actually moved. */
  from?: string;
  to?: string;
  /** True for money in, false for money out; omitted for both. */
  credit?: boolean;
  /** `BOOK` by default: a pending entry is not money and is easy to double-pay. */
  status?: string;
  endToEndId?: string;
  /** Matched against the structured creditor reference, exactly. */
  reference?: string;
  /** Exact amount in hundredths — see `camt.ts` on why it is not "minor". */
  amountHundredths?: number;
  /** Substring of the remittance text or the counterparty name. */
  search?: string;
  /** Exclude reversals, which undo an earlier booking. */
  excludeReversals?: boolean;
  limit?: number;
}

/**
 * The query a matcher needs.
 *
 * `status` defaults to `BOOK` on purpose. A `PDNG` entry is money the bank has
 * seen and not booked; treating it as a payment is how an invoice gets marked
 * settled against a transaction that later vanishes. A caller that genuinely
 * wants them has to ask.
 */
export function findEntries(db: Database.Database, query: EntryQuery = {}): StatementEntryRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (clause: string, ...values: unknown[]): void => {
    where.push(clause);
    args.push(...values);
  };

  if (query.connection !== undefined) add('c.key = ?', query.connection);
  if (query.account !== undefined) add('s.account_iban = ?', query.account);
  if (query.from !== undefined) add('e.booking_date >= ?', query.from);
  if (query.to !== undefined) add('e.booking_date <= ?', query.to);
  if (query.credit !== undefined) add('e.credit = ?', query.credit ? 1 : 0);
  add('e.status = ?', query.status ?? 'BOOK');
  if (query.endToEndId !== undefined) add('e.end_to_end_id = ?', query.endToEndId);
  if (query.reference !== undefined) add('e.creditor_reference = ?', query.reference);
  if (query.amountHundredths !== undefined) add('e.amount_hundredths = ?', query.amountHundredths);
  if (query.excludeReversals === true) add('e.reversal = 0');
  if (query.search !== undefined) {
    // LIKE with escaped wildcards: a reference containing % must not turn into
    // a query that matches everything.
    const needle = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    add(
      "(e.remittance LIKE ? ESCAPE '\\' OR e.counterparty_name LIKE ? ESCAPE '\\')",
      needle,
      needle,
    );
  }

  const rows = db
    .prepare(
      `SELECT e.*, s.public_id AS statement_public_id, s.account_iban AS statement_iban
         FROM statement_entries e
         JOIN statements s ON s.id = e.statement_id
         JOIN bank_connections c ON c.id = s.connection_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.booking_date DESC, e.id DESC
        LIMIT ?`,
    )
    .all(...args, query.limit ?? 200) as Record<string, unknown>[];

  return rows.map((raw) =>
    toEntry(raw, {
      public_id: raw.statement_public_id as string,
      account_iban: raw.statement_iban as string | null,
    } as DbStatementRow),
  );
}

/** Re-read stored statement downloads, e.g. after a fix to the parser. */
export function reparseStatements(db: Database.Database, connectionKey?: string): number {
  const args: unknown[] = [];
  let clause = "kind = 'statement'";
  if (connectionKey !== undefined) {
    clause += ' AND connection_id = (SELECT id FROM bank_connections WHERE key = ?)';
    args.push(connectionKey);
  }
  // The statements go too: they are derived, and leaving the old rows beside
  // the new ones would leave a consumer reading whichever it found first.
  db.prepare(
    `DELETE FROM statements WHERE download_id IN (SELECT id FROM downloads WHERE ${clause})`,
  ).run(...args);
  return db.prepare(`UPDATE downloads SET processed_at = NULL WHERE ${clause}`).run(...args).changes;
}

export type { StatementEntry };
