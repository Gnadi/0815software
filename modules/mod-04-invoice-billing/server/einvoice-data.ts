import type Database from 'better-sqlite3';
import { countryOfVatId, resolveAddress } from '../shared/address.js';
import {
  cancellationNumber,
  DOCUMENT_NAME,
  eInvoiceProblems,
  renderCii,
  EINVOICE_PROFILES,
  type BuyerParty,
  type EInvoiceModel,
  type EInvoiceProblem,
  type EInvoiceProfile,
  type SellerParty,
} from '../shared/einvoice.js';
import { ebInterfaceProblems, renderEbInterface, type EInvoiceFormat } from '../shared/ebinterface.js';
import { LINE_ROUNDING } from '../shared/money.js';
import type { Customer, TaxExemptionCategory } from '../shared/types.js';
import type { SellerConfig } from './config.js';
import {
  addDays,
  DomainError,
  getCreditNote,
  getCustomer,
  getInvoice,
  invoiceDetail,
  invoiceLines,
  roundingOf,
  todayIso,
} from './invoices.js';
import { issuedDocument, type IssuedDocument, type RenderedFile } from './issued-documents.js';
import { creditNoteView, layoutInvoice, type PdfCustomer } from './pdf.js';
import { buildPdfA } from './pdfa.js';

/**
 * Where an e-invoice's data comes from, and the rule that it stops moving.
 *
 * An issued invoice must keep saying what it said the day it was issued. The
 * invoice's own lines have always been immutable once sent; the parties were
 * not — the PDF read the customer row and the seller config at download time,
 * so renaming a customer or moving office quietly rewrote every old PDF. For a
 * document the recipient's software books, and that GoBD wants reproducible,
 * that will not do. So finalizing now freezes both parties into the invoice
 * row, in the same transaction that assigns the number, and everything that
 * renders an issued invoice — XRechnung, ZUGFeRD, the PDF — reads the frozen
 * copy.
 *
 * Invoices issued before this existed have no snapshot. They keep reading
 * today's master data, exactly as they always did, and say so
 * (`parties_frozen: false`) rather than pretending otherwise.
 */

/** The seller config as an e-invoice party, structure filled in from the address lines. */
export function sellerParty(seller: SellerConfig): SellerParty {
  // A config assembled by hand (tests, an embedding app) may leave the lines out.
  const lines = seller.addressLines ?? [];
  const fallbackCountry = seller.country ?? countryOfVatId(seller.vatId);
  const address = resolveAddress(
    { street: seller.street, postcode: seller.postcode, city: seller.city, country: seller.country },
    lines,
    fallbackCountry,
  );
  const opt = (value: string | undefined): string | null => (value && value.trim() !== '' ? value.trim() : null);
  return {
    name: seller.name,
    address_lines: [...lines],
    ...address,
    vat_id: opt(seller.vatId),
    tax_number: opt(seller.taxNumber),
    registration: opt(seller.registration),
    identifier: opt(seller.identifier),
    iban: seller.iban,
    bic: opt(seller.bic),
    contact_name: opt(seller.contactName),
    phone: opt(seller.phone),
    email: opt(seller.email),
    einvoice_address: opt(seller.einvoiceAddress),
  };
}

/** A customer row as an e-invoice party. */
export function buyerParty(customer: Customer): BuyerParty {
  const fallbackCountry = countryOfVatId(customer.vat_id);
  const address = resolveAddress(
    {
      street: customer.street ?? null,
      postcode: customer.postcode ?? null,
      city: customer.city ?? null,
      country: customer.country_code ?? null,
    },
    customer.address?.split('\n') ?? [],
    fallbackCountry,
  );
  return {
    name: customer.name,
    address: customer.address,
    ...address,
    vat_id: customer.vat_id,
    email: customer.email,
    einvoice_address: customer.einvoice_address ?? null,
    supplier_number: customer.supplier_number ?? null,
  };
}

/**
 * Freeze both parties into an invoice. Called by `finalizeInvoice` inside its
 * transaction; also fills the buyer reference from the customer's default when
 * the draft did not carry its own.
 */
export function freezeParties(db: Database.Database, invoiceId: number, seller: SellerConfig): void {
  const invoice = getInvoice(db, invoiceId);
  const customer = getCustomer(db, invoice.customer_id);
  db.prepare(
    `UPDATE invoices SET seller_snapshot = ?, buyer_snapshot = ?,
       buyer_reference = COALESCE(buyer_reference, ?) WHERE id = ?`,
  ).run(
    JSON.stringify(sellerParty(seller)),
    JSON.stringify(buyerParty(customer)),
    customer.buyer_reference ?? null,
    invoiceId,
  );
}

/** The parties of an invoice: frozen when it has them, live otherwise. */
export function invoiceParties(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
): { seller: SellerParty; buyer: BuyerParty; frozen: boolean } {
  const invoice = getInvoice(db, invoiceId);
  if (invoice.seller_snapshot !== null && invoice.buyer_snapshot !== null) {
    const buyer = JSON.parse(invoice.buyer_snapshot) as BuyerParty;
    // A snapshot frozen before the supplier number existed has no such key at
    // all (undefined, not null): only then is today's value the best there is —
    // for the XML and the PDF alike.
    if (buyer.supplier_number === undefined) {
      buyer.supplier_number = getCustomer(db, invoice.customer_id).supplier_number ?? null;
    }
    return { seller: JSON.parse(invoice.seller_snapshot) as SellerParty, buyer, frozen: true };
  }
  return { seller: sellerParty(liveSeller), buyer: buyerParty(getCustomer(db, invoice.customer_id)), frozen: false };
}

/** The shapes the PDF renderer has always taken, from the parties above. */
export function pdfParties(parties: { seller: SellerParty; buyer: BuyerParty }): {
  seller: SellerConfig;
  customer: PdfCustomer;
} {
  return {
    seller: {
      name: parties.seller.name,
      addressLines: parties.seller.address_lines,
      vatId: parties.seller.vat_id ?? '',
      iban: parties.seller.iban,
      bic: parties.seller.bic ?? '',
      taxNumber: parties.seller.tax_number ?? undefined,
      registration: parties.seller.registration ?? undefined,
      identifier: parties.seller.identifier ?? undefined,
    },
    customer: {
      name: parties.buyer.name,
      address: parties.buyer.address,
      vat_id: parties.buyer.vat_id,
      supplier_number: parties.buyer.supplier_number ?? null,
    },
  };
}

/** Which document of an invoice: itself, its cancellation, or one of its partial credit notes. */
export type EInvoiceDocument = 'invoice' | 'cancellation' | { creditNoteId: number };

/** Stored lines as the model's — the same for an invoice, a draft and a credit note. */
function modelLines(
  lines: { position: number; description: string; quantity: number; unit_price_cents: number; vat_rate: number }[],
): EInvoiceModel['lines'] {
  return lines.map((l) => ({
    position: l.position,
    description: l.description,
    quantity: l.quantity,
    unit_price_cents: l.unit_price_cents,
    vat_rate: l.vat_rate,
  }));
}

/** The service period of an invoice, when it has one (BG-14). */
function periodOf(invoice: { period_start: string | null; period_end: string | null }): EInvoiceModel['period'] {
  return invoice.period_start !== null && invoice.period_end !== null ? { start: invoice.period_start, end: invoice.period_end } : null;
}

function exemptionOf(invoice: {
  tax_exemption_category: TaxExemptionCategory | null;
  tax_exemption_reason: string | null;
}): EInvoiceModel['exemption'] {
  return invoice.tax_exemption_category
    ? { category: invoice.tax_exemption_category, reason: invoice.tax_exemption_reason }
    : null;
}

/**
 * The e-invoice model of an issued invoice — or of its cancellation or a
 * partial credit note, each a credit note (type 381) referring back to it.
 * Drafts have no number and are not invoices yet (409); asking for the
 * cancellation of an invoice that is not cancelled is equally a 409, and a
 * credit note is only found under the invoice it belongs to (404).
 */
export function eInvoiceModel(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument = 'invoice',
): EInvoiceModel {
  const invoice = getInvoice(db, invoiceId);
  if (invoice.status === 'draft' || invoice.number === null || invoice.issue_date === null) {
    throw new DomainError(409, 'A draft is not an invoice yet — send it first; the e-invoice carries its number');
  }
  if (document === 'cancellation' && invoice.status !== 'cancelled') {
    throw new DomainError(409, `${invoice.number} is not cancelled, so it has no cancellation document`);
  }
  const { seller, buyer, frozen } = invoiceParties(db, invoiceId, liveSeller);
  const customer = getCustomer(db, invoice.customer_id);
  const lines = modelLines(invoiceLines(db, invoiceId));
  const exemption = exemptionOf(invoice);
  const base = {
    // Without a service date of its own: the last day of the service period —
    // the day the supply was completed — and only without one the issue date.
    // An empty delivery block instead would fail ZUGFeRD 2.5's PEPPOL-EN16931-
    // R008 (still a warning there; XRechnung exempts the element).
    delivery_date: invoice.delivery_date ?? periodOf(invoice)?.end ?? invoice.issue_date,
    period: periodOf(invoice),
    payment_terms_days: invoice.payment_terms_days,
    // Frozen at finalize — NULL included: a Leitweg-ID added to the customer
    // later must not appear in an invoice that was issued without one. Only an
    // invoice issued before freezing existed falls back to the customer.
    buyer_reference: frozen ? invoice.buyer_reference : (invoice.buyer_reference ?? customer.buyer_reference ?? null),
    exemption,
    seller,
    buyer,
    lines,
    // The invoice's rule, for its credit notes too: a document states the
    // amounts the invoice's books hold.
    line_rounding: roundingOf(invoice),
  };
  if (typeof document === 'object') {
    const note = getCreditNote(db, document.creditNoteId);
    if (note.invoice_id !== invoiceId) throw new DomainError(404, 'Credit note not found');
    return {
      ...base,
      lines: modelLines(note.lines),
      type_code: '381',
      number: note.number,
      issue_date: note.issue_date,
      due_date: null,
      note: `${DOCUMENT_NAME.credit_note} zur Rechnung ${invoice.number} vom ${invoice.issue_date}: ${note.reason}`,
      preceding: { number: invoice.number, issue_date: invoice.issue_date },
    };
  }
  if (document === 'cancellation') {
    const cancelledOn = invoice.cancelled_on!;
    return {
      ...base,
      type_code: '381',
      number: cancellationNumber(invoice.number),
      issue_date: cancelledOn,
      due_date: null,
      note: `${DOCUMENT_NAME.cancellation} zur Rechnung ${invoice.number} vom ${invoice.issue_date}${
        invoice.cancellation_reason ? `: ${invoice.cancellation_reason}` : ''
      }`,
      preceding: { number: invoice.number, issue_date: invoice.issue_date },
    };
  }
  return {
    ...base,
    type_code: '380',
    number: invoice.number,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    note: invoice.note,
    preceding: null,
  };
}

/**
 * The e-invoice a DRAFT would become if it were sent now: the parties exactly
 * as `freezeParties` is about to freeze them, the issue date given (else
 * today) and the due date that follows. It has no number yet — it exists to be
 * checked, because once the draft is sent nothing in it can change any more.
 */
export function pendingEInvoiceModel(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  issueDate?: string,
): EInvoiceModel {
  const invoice = getInvoice(db, invoiceId);
  const customer = getCustomer(db, invoice.customer_id);
  const issue = issueDate ?? todayIso();
  return {
    type_code: '380',
    number: invoice.number ?? `DRAFT-${invoice.id}`,
    issue_date: issue,
    due_date: addDays(issue, invoice.payment_terms_days),
    delivery_date: invoice.delivery_date ?? periodOf(invoice)?.end ?? issue,
    period: periodOf(invoice),
    payment_terms_days: invoice.payment_terms_days,
    buyer_reference: invoice.buyer_reference ?? customer.buyer_reference ?? null,
    note: invoice.note,
    preceding: null,
    exemption: exemptionOf(invoice),
    seller: sellerParty(liveSeller),
    buyer: buyerParty(customer),
    lines: modelLines(invoiceLines(db, invoiceId)),
    line_rounding: LINE_ROUNDING,
  };
}

export const FORMAT_LABEL: Record<EInvoiceFormat, string> = {
  xrechnung: 'XRechnung',
  zugferd: 'ZUGFeRD',
  ebinterface: 'ebInterface',
};

/** What `format` would refuse in `model` — the check behind every 422 below. */
export function problemsOf(model: EInvoiceModel, format: EInvoiceFormat): EInvoiceProblem[] {
  return format === 'ebinterface' ? ebInterfaceProblems(model) : eInvoiceProblems(model, format);
}

function readinessOf(model: EInvoiceModel): Record<EInvoiceFormat, EInvoiceProblem[]> {
  const en16931 = Object.fromEntries(EINVOICE_PROFILES.map((p) => [p, problemsOf(model, p)])) as Record<
    EInvoiceProfile,
    EInvoiceProblem[]
  >;
  return { ...en16931, ebinterface: problemsOf(model, 'ebinterface') };
}

/**
 * What each format would refuse, for the screen to show before anyone
 * downloads — and for a draft, before anyone sends it, from the data it would
 * freeze.
 */
export function eInvoiceReadiness(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
): Record<EInvoiceFormat, EInvoiceProblem[]> {
  const invoice = getInvoice(db, invoiceId);
  const model =
    invoice.status === 'draft' ? pendingEInvoiceModel(db, invoiceId, liveSeller) : eInvoiceModel(db, invoiceId, liveSeller);
  return readinessOf(model);
}

const details = (problems: EInvoiceProblem[]) => problems.map((p) => ({ field: p.field, message: `${p.term}: ${p.message}` }));
const fields = (n: number): string => `${n} field${n === 1 ? '' : 's'}`;

/**
 * Refuse with every missing field at once, as a 422 the screen can list. A
 * frozen invoice says why that is final: the fields cannot be added to it any
 * more. One issued before freezing existed still reads today's master data,
 * so there the fix is the master data.
 */
export function assertRenderable(model: EInvoiceModel, format: EInvoiceFormat, frozen: boolean): void {
  const problems = problemsOf(model, format);
  if (problems.length > 0) {
    throw new DomainError(
      422,
      `This invoice cannot be issued as ${FORMAT_LABEL[format]} — ${fields(problems.length)} missing. ` +
        (frozen
          ? 'It was sent without them and keeps its data as issued: cancel it and send a new one once the master data is complete.'
          : 'Complete the master data: this invoice predates frozen parties and reads them as they are today.'),
      details(problems),
    );
  }
}

/** Whether an issued invoice carries its parties frozen (see `freezeParties`). */
function frozenParties(db: Database.Database, invoiceId: number): boolean {
  const invoice = getInvoice(db, invoiceId);
  return invoice.seller_snapshot !== null && invoice.buyer_snapshot !== null;
}

/**
 * The check before a draft is sent. A customer set to receive an e-invoice
 * format gets the draft refused while it would not render in that format —
 * BEFORE a number is drawn (from PS-10 too, which would otherwise leave a gap),
 * because after sending, the parties and lines are frozen and the missing
 * fields could only be supplied by cancelling and issuing again.
 *
 * A customer without a format (NULL) or set to `none` is not checked: a
 * consumer or a foreign customer gets no e-invoice, and the screen shows the
 * readiness either way.
 */
export function assertIssuable(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  issueDate?: string,
): void {
  const invoice = getInvoice(db, invoiceId);
  if (invoice.status !== 'draft') return; // finalizeInvoice answers that with its own 409
  const customer = getCustomer(db, invoice.customer_id);
  const format = customer.einvoice_format;
  if (!format || format === 'none') return;
  const problems = problemsOf(pendingEInvoiceModel(db, invoiceId, liveSeller, issueDate), format);
  if (problems.length > 0) {
    throw new DomainError(
      422,
      `${customer.name} receives ${FORMAT_LABEL[format]} e-invoices, and this draft would not be one — ${fields(problems.length)} missing. ` +
        'Complete them before sending: once sent, the invoice keeps its data as issued.',
      details(problems),
    );
  }
}

/** The XRechnung of an issued invoice (or of its cancellation): the bare XML. */
function xrechnungFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument,
): { number: string; filename: string; xml: string } {
  const model = eInvoiceModel(db, invoiceId, liveSeller, document);
  assertRenderable(model, 'xrechnung', frozenParties(db, invoiceId));
  return { number: model.number, filename: `${model.number}_xrechnung.xml`, xml: renderCii(model, 'xrechnung') };
}

/**
 * The ebInterface 6.1 XML of an issued invoice (or of its cancellation, a
 * CreditMemo naming the cancelled invoice) — the Austrian e-invoice.
 */
function ebInterfaceFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument,
): { number: string; filename: string; xml: string } {
  const model = eInvoiceModel(db, invoiceId, liveSeller, document);
  assertRenderable(model, 'ebinterface', frozenParties(db, invoiceId));
  return { number: model.number, filename: `${model.number}_ebinterface.xml`, xml: renderEbInterface(model) };
}

/**
 * The ZUGFeRD invoice: the PDF a person reads, as PDF/A-3, with the EN 16931
 * XML embedded as `factur-x.xml`.
 *
 * The PDF shows the document AS ISSUED — a ZUGFeRD file's two halves must say
 * the same thing, and the XML is the invoice as it was sent, before any
 * payment or cancellation. A cancellation is its own document (a credit note)
 * with its own PDF and XML.
 */
function zugferdFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument,
): { number: string; filename: string; pdf: Buffer } {
  const model = eInvoiceModel(db, invoiceId, liveSeller, document);
  assertRenderable(model, 'zugferd', frozenParties(db, invoiceId));
  const xml = renderCii(model, 'zugferd');
  const parties = pdfParties(invoiceParties(db, invoiceId, liveSeller));
  const detail = invoiceDetail(db, invoiceId);
  const credit = typeof document === 'object' ? getCreditNote(db, document.creditNoteId) : null;
  const pages =
    credit !== null
      ? layoutInvoice(creditNoteView(detail, credit), parties.customer, parties.seller, {
          number: model.number,
          date: model.issue_date,
          reason: credit.reason,
        })
      : document === 'cancellation'
      ? layoutInvoice(detail, parties.customer, parties.seller, { number: model.number, date: model.issue_date })
      : layoutInvoice(
          { ...detail, status: 'sent', paid_cents: 0, open_cents: detail.gross_cents, cancellation_reason: null },
          parties.customer,
          parties.seller,
        );
  const pdf = buildPdfA(pages, {
    xml,
    title: `${DOCUMENT_NAME[typeof document === 'object' ? 'credit_note' : document]} ${model.number}`,
    author: model.seller.name,
    date: model.issue_date,
  });
  return { number: model.number, filename: `${model.number}_zugferd.pdf`, pdf };
}

/** Render one format of one document — what `eInvoiceFile` stores on first delivery. */
function renderFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  format: EInvoiceFormat,
  document: EInvoiceDocument,
): RenderedFile {
  if (format === 'zugferd') {
    const file = zugferdFile(db, invoiceId, liveSeller, document);
    return { number: file.number, filename: file.filename, contentType: 'application/pdf', content: file.pdf };
  }
  const file =
    format === 'xrechnung'
      ? xrechnungFile(db, invoiceId, liveSeller, document)
      : ebInterfaceFile(db, invoiceId, liveSeller, document);
  return {
    number: file.number,
    filename: file.filename,
    contentType: 'application/xml; charset=utf-8',
    content: Buffer.from(file.xml, 'utf8'),
  };
}

/**
 * An e-invoice file as delivered: the stored bytes when this format of this
 * document went out before, otherwise rendered now (with every refusal the
 * renderers make) and stored on the way out — see server/issued-documents.ts.
 */
export function eInvoiceFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  format: EInvoiceFormat,
  document: EInvoiceDocument,
  actor: string,
): IssuedDocument {
  return issuedDocument(db, invoiceId, document, format, actor, () => renderFile(db, invoiceId, liveSeller, format, document));
}
