import type Database from 'better-sqlite3';
import { countryOfVatId, resolveAddress } from '../shared/address.js';
import {
  cancellationNumber,
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
import type { Customer } from '../shared/types.js';
import type { SellerConfig } from './config.js';
import { DomainError, getCreditNote, getCustomer, getInvoice, invoiceDetail, invoiceLines } from './invoices.js';
import { creditNoteView, layoutInvoice } from './pdf.js';
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
    return {
      seller: JSON.parse(invoice.seller_snapshot) as SellerParty,
      buyer: JSON.parse(invoice.buyer_snapshot) as BuyerParty,
      frozen: true,
    };
  }
  return { seller: sellerParty(liveSeller), buyer: buyerParty(getCustomer(db, invoice.customer_id)), frozen: false };
}

/** The shapes the PDF renderer has always taken, from the parties above. */
export function pdfParties(parties: { seller: SellerParty; buyer: BuyerParty }): {
  seller: SellerConfig;
  customer: Pick<Customer, 'name' | 'address' | 'vat_id'>;
} {
  return {
    seller: {
      name: parties.seller.name,
      addressLines: parties.seller.address_lines,
      vatId: parties.seller.vat_id ?? '',
      iban: parties.seller.iban,
      bic: parties.seller.bic ?? '',
    },
    customer: { name: parties.buyer.name, address: parties.buyer.address, vat_id: parties.buyer.vat_id },
  };
}

/** Which document of an invoice: itself, its cancellation, or one of its partial credit notes. */
export type EInvoiceDocument = 'invoice' | 'cancellation' | { creditNoteId: number };

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
  const parties = invoiceParties(db, invoiceId, liveSeller);
  const { seller, frozen } = parties;
  const customer = getCustomer(db, invoice.customer_id);
  // A snapshot frozen before the supplier number existed has no such key at
  // all (undefined, not null): only then is today's value the best there is.
  const buyer =
    parties.buyer.supplier_number === undefined
      ? { ...parties.buyer, supplier_number: customer.supplier_number ?? null }
      : parties.buyer;
  const lines = invoiceLines(db, invoiceId).map((l) => ({
    position: l.position,
    description: l.description,
    quantity: l.quantity,
    unit_price_cents: l.unit_price_cents,
    vat_rate: l.vat_rate,
  }));
  const exemption = invoice.tax_exemption_category
    ? { category: invoice.tax_exemption_category, reason: invoice.tax_exemption_reason }
    : null;
  const base = {
    delivery_date: invoice.delivery_date ?? invoice.issue_date,
    payment_terms_days: invoice.payment_terms_days,
    // Frozen at finalize — NULL included: a Leitweg-ID added to the customer
    // later must not appear in an invoice that was issued without one. Only an
    // invoice issued before freezing existed falls back to the customer.
    buyer_reference: frozen ? invoice.buyer_reference : (invoice.buyer_reference ?? customer.buyer_reference ?? null),
    exemption,
    seller,
    buyer,
    lines,
  };
  if (typeof document === 'object') {
    const note = getCreditNote(db, document.creditNoteId);
    if (note.invoice_id !== invoiceId) throw new DomainError(404, 'Credit note not found');
    return {
      ...base,
      lines: note.lines.map((l) => ({
        position: l.position,
        description: l.description,
        quantity: l.quantity,
        unit_price_cents: l.unit_price_cents,
        vat_rate: l.vat_rate,
      })),
      type_code: '381',
      number: note.number,
      issue_date: note.issue_date,
      due_date: null,
      note: `Gutschrift zur Rechnung ${invoice.number} vom ${invoice.issue_date}: ${note.reason}`,
      preceding: { number: invoice.number, issue_date: invoice.issue_date },
    };
  }
  if (document === 'cancellation') {
    const cancelledOn = invoice.cancelled_at!.slice(0, 10);
    return {
      ...base,
      type_code: '381',
      number: cancellationNumber(invoice.number),
      issue_date: cancelledOn,
      due_date: null,
      note: `Storno der Rechnung ${invoice.number} vom ${invoice.issue_date}${
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

/** What each profile would refuse, for the screen to show before anyone downloads. */
export function eInvoiceReadiness(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
): Record<EInvoiceFormat, EInvoiceProblem[]> {
  const model = eInvoiceModel(db, invoiceId, liveSeller);
  const en16931 = Object.fromEntries(EINVOICE_PROFILES.map((p) => [p, eInvoiceProblems(model, p)])) as Record<
    EInvoiceProfile,
    EInvoiceProblem[]
  >;
  return { ...en16931, ebinterface: ebInterfaceProblems(model) };
}

/** Refuse with every missing field at once, as a 422 the screen can list. */
export function assertRenderable(model: EInvoiceModel, profile: EInvoiceProfile): void {
  const problems = eInvoiceProblems(model, profile);
  if (problems.length > 0) {
    throw new DomainError(
      422,
      `This invoice cannot be issued as ${profile === 'xrechnung' ? 'XRechnung' : 'ZUGFeRD'} yet — ${problems.length} field${problems.length === 1 ? '' : 's'} missing`,
      problems.map((p) => ({ field: p.field, message: `${p.term}: ${p.message}` })),
    );
  }
}

/** The XRechnung of an issued invoice (or of its cancellation): the bare XML. */
export function xrechnungFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument = 'invoice',
): { filename: string; xml: string } {
  const model = eInvoiceModel(db, invoiceId, liveSeller, document);
  assertRenderable(model, 'xrechnung');
  return { filename: `${model.number}_xrechnung.xml`, xml: renderCii(model, 'xrechnung') };
}

/**
 * The ebInterface 6.1 XML of an issued invoice (or of its cancellation, a
 * CreditMemo naming the cancelled invoice) — the Austrian e-invoice.
 */
export function ebInterfaceFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument = 'invoice',
): { filename: string; xml: string } {
  const model = eInvoiceModel(db, invoiceId, liveSeller, document);
  const problems = ebInterfaceProblems(model);
  if (problems.length > 0) {
    throw new DomainError(
      422,
      `This invoice cannot be issued as ebInterface yet — ${problems.length} field${problems.length === 1 ? '' : 's'} missing`,
      problems.map((p) => ({ field: p.field, message: `${p.term}: ${p.message}` })),
    );
  }
  return { filename: `${model.number}_ebinterface.xml`, xml: renderEbInterface(model) };
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
export function zugferdFile(
  db: Database.Database,
  invoiceId: number,
  liveSeller: SellerConfig,
  document: EInvoiceDocument = 'invoice',
): { filename: string; pdf: Buffer } {
  const model = eInvoiceModel(db, invoiceId, liveSeller, document);
  assertRenderable(model, 'zugferd');
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
    title: `${document === 'invoice' ? 'Rechnung' : 'Gutschrift'} ${model.number}`,
    author: model.seller.name,
    date: model.issue_date,
  });
  return { filename: `${model.number}_zugferd.pdf`, pdf };
}
