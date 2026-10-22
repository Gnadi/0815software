# E-Rechnung — XRechnung, ZUGFeRD, DATEV and BMD in MOD-04

How MOD-04 Invoice & Billing issues e-invoices and hands its invoices to the
tax adviser: what the law asks for, what the module produces, what an
installation has to configure, how the output is validated, and what is
deliberately left out.

## Why now

The Wachstumschancengesetz made the structured e-invoice the normal invoice
for domestic B2B supplies in Germany (§ 14 UStG; transition in § 27 Abs. 38
UStG):

| Since / from | Who | What |
| ------------ | --- | ---- |
| 1 January 2025 | every business in Germany | must be able to **receive** e-invoices |
| until 31 December 2026 | everyone | may still issue paper or plain PDF invoices (PDF only with the recipient's consent) |
| **1 January 2027** | businesses with **more than €800,000** total turnover in the previous year | must **issue** e-invoices for domestic B2B supplies |
| 1 January 2028 | all remaining businesses | must issue e-invoices (EDI under the old rules ends) |

Exempt throughout: small-amount invoices up to €250 (§ 33 UStDV), travel
tickets, and Kleinunternehmer under § 19 UStG as issuers. B2C invoices are
not covered by the mandate.

An e-invoice is an invoice in a **structured format that conforms to
EN 16931** and can be processed electronically. A PDF sent by email is not one.
XRechnung qualifies, and so does ZUGFeRD from profile EN 16931 (formerly
"COMFORT") up. The MINIMUM and BASIC WL profiles do not, so this module never
writes them.

Austria has no general B2B mandate. Invoices to the Austrian federal
government go through e-Rechnung.gv.at as ebInterface or PEPPOL UBL, and
neither is produced here (see [Not covered](#not-covered)). An Austrian
installation uses this for German customers, and for the BMD export.

## What the module produces

| | XRechnung | ZUGFeRD |
| --- | --- | --- |
| Standard | EN 16931 + German CIUS, **XRechnung 3.0** (`urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`) | **ZUGFeRD 2.x / Factur-X**, profile **EN 16931** (`urn:cen.eu:en16931:2017`) |
| Syntax | UN/CEFACT CII D16B | UN/CEFACT CII D16B, embedded as `factur-x.xml` |
| Container | the bare XML | PDF/A-3b, `/AFRelationship /Alternative`, Factur-X XMP extension |
| Typical recipient | German public bodies (Leitweg-ID), any B2B recipient | any B2B recipient. People read the PDF, software reads the XML |
| Route | `GET /api/invoices/:id/xrechnung.xml` | `GET /api/invoices/:id/zugferd.pdf` |

Both come from one model (`shared/einvoice.ts`, `EInvoiceModel`) and one
renderer (`renderCii`). The only differences are the ones the two
specifications define: the specification identifier, the PEPPOL business
process (BT-23, XRechnung only), and the fields XRechnung makes mandatory.

### The invoice as issued

`POST /api/invoices/:id/finalize` freezes the **seller** (from `SELLER_*` or
the PS-11 `self` party) and the **buyer** (the customer row) into the invoice,
in the same transaction that assigns the number. The plain PDF, the
XRechnung and the ZUGFeRD file all render from that copy, so downloading an
invoice again years later gives the same content, whatever happened to the
master data since. GoBD and § 14 UStG expect exactly that.

Invoices issued before this release have no frozen copy. They read today's
master data, as they always did, and the API reports `parties_frozen: false`.

The ZUGFeRD PDF always shows the invoice **as issued**: no payments, not
marked cancelled. Its two halves must say the same thing, and the XML is the
invoice that was sent.

### Cancellations

Cancelling keeps the invoice and its number (unchanged module rule), and the
original e-invoice stays downloadable as it was. The cancellation itself is a
**credit note**: type code 381, number `<invoice number>-ST`, dated on the day
of cancellation, with BT-25/26 referring to the cancelled invoice and the
payment means set to 97 (settled between the parties). It is available for
both formats with `?document=cancellation`.

A partial correction is a cancellation plus a new invoice, as before. A
corrected invoice (type 384) is not produced.

### Tax categories

Lines above 0 % are category `S`. Lines at 0 % carry the invoice's
**`tax_exemption_category`**, chosen in the editor whenever a 0 % line exists:

| Code | Meaning | Default exemption text (BT-120) | VATEX (BT-121) | Also required |
| ---- | ------- | ------------------------------- | -------------- | ------------- |
| `E` | exempt (§ 4 UStG, § 6 UStG-AT, § 19 UStG Kleinunternehmer …) | none, **you must state the legal ground** | — | — |
| `AE` | reverse charge | Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge) | VATEX-EU-AE | both VAT ids |
| `K` | intra-EU supply of goods | Steuerfreie innergemeinschaftliche Lieferung | VATEX-EU-IC | both VAT ids. The buyer address is written as the delivery address |
| `G` | export outside the EU | Steuerfreie Ausfuhrlieferung | VATEX-EU-G | — |
| `Z` | zero-rated | — | — | — |
| `O` | not subject to VAT | Nicht steuerbarer Umsatz | VATEX-EU-O | the seller register number (VAT ids must then be absent). Cannot be mixed with taxed lines |

`tax_exemption_reason` overrides the default text. The text is printed on the
PDF as well, because the law requires it on the document.

Rates: Germany 0 / 7 / 19 %, Austria 0 / 10 / 13 / 20 %. The editor offers
the rates of the seller's country only.

## Setting it up

### The seller (Settings screen, admin)

The admin maintains the company on **Settings → Seller**. Each field shows
where its current value comes from: **SET HERE**, **FROM PS-11** or **FROM
ENV**. The precedence, field by field (`server/seller-settings.ts`):

1. what was saved on the Settings screen,
2. PS-11 Customers' `self` party, when `CUSTOMERS_URL` is set,
3. the `SELLER_*` environment variables, which are now only starting values.

Clearing a field on the screen falls back to the next source. While PS-11 is
wired, it stays the single authority for what it carries (name, address, VAT
id, IBAN, BIC): those fields are read-only on the screen, and the API refuses
them with 422. Every save records who made it and when. With `AUDIT_URL` set,
the save is also logged on PS-07 as `settings.seller_changed`, with the field
names but not their values. Invoices issued earlier never change, because
they carry the seller frozen at issue.

| Field | Business term | Needed for | Starting value |
| ----- | ------------- | ---------- | -------------- |
| company name | BT-27 | both | `SELLER_NAME` |
| address (printed) | — | both. Street, postcode and city are **read from it** ("Street / PLZ Ort / Country") unless set below | `SELLER_ADDRESS` |
| street, postcode, city | BT-35, BT-38, BT-37 | both, when the address does not read cleanly | `SELLER_STREET`, `SELLER_POSTCODE`, `SELLER_CITY` |
| country (ISO) | BT-40 | both. Defaults to the address's country line, else the VAT id prefix | `SELLER_COUNTRY` |
| VAT id | BT-31 | both. The shipped placeholder `ATU00000000` is refused | `SELLER_VAT_ID` |
| Steuernummer | BT-32 | instead of / beside the VAT id | `SELLER_TAX_NUMBER` |
| register number | BT-30 | when there is no VAT id (BR-CO-26), and for category `O` | `SELLER_REGISTRATION` |
| IBAN, BIC | BT-84, BT-86 | both (payment means 58). The IBAN is also the debtor of every payment file and is check-digit validated on save | `SELLER_IBAN`, `SELLER_BIC` |
| contact person, phone, email | BT-41, BT-42, BT-43 | **XRechnung** | `SELLER_CONTACT_NAME`, `SELLER_PHONE`, `SELLER_EMAIL` |
| e-invoice address | BT-34 | **XRechnung**. Defaults to the contact email | `SELLER_EINVOICE_ADDRESS` |

Below the fields, the screen shows whether XRechnung and ZUGFeRD are
**READY**, or what is still missing. The API is `GET` / `PUT
/api/settings/seller`.

### The customer (Customers screen)

All optional. An empty structured field is read from the printed address,
and the country falls back to the VAT id's prefix.

| Field | Business term | Needed for |
| ----- | ------------- | ---------- |
| street / postcode / city / country (ISO) | BT-50, BT-53, BT-52, BT-55 | country for both. City and postcode for XRechnung |
| VAT id | BT-48 | reverse charge, intra-EU supply |
| buyer reference | BT-10 | **XRechnung**. The **Leitweg-ID** for a public body, otherwise the reference the customer wants quoted (order number, contact). An invoice can carry its own |
| e-invoice address | BT-49 | **XRechnung**. Defaults to the email. A Leitweg-ID here is sent with scheme `0204`, an email with `EM` |

### Per invoice (editor)

Service date (Leistungsdatum, BT-72; empty means the issue date), buyer
reference, and, for 0 % lines, the VAT category and exemption text.

### Before the first one goes out

The invoice detail screen lists, per format, exactly what is still missing,
with its business term. Nothing can be downloaded in a state that would fail
validation. Send one invoice to the customer and ask them to confirm their
system accepted it.

## Validation

Validation happens in three layers, and the first two run in every test run:

1. **Golden files.** `test/fixtures/einvoice/` holds the XML of the eleven
   cases in `test/einvoice-cases.ts` (standard DE, `AE`, `K`, `G`, `E`, `Z`,
   `O`, exempt mixed with taxed lines, seller with Steuernummer only,
   cancellation, public buyer by Leitweg-ID), in both profiles. The renderer
   must reproduce them byte for byte.
2. **Schema.** Every case is checked against the Factur-X EN16931 XSD
   (`test/schema/cii-en16931/`) with `xmllint`.
3. **External rules, before a golden file is changed.**
   `npm run einvoice:validate` (`scripts/validate-einvoice.sh`, needs Java and
   `MUSTANG_JAR`) renders every case, plus a ZUGFeRD PDF of each, and runs
   them through [Mustang](https://www.mustangproject.org/) 2.26.0. That covers
   the EN 16931 schematron, the XRechnung 3.0 schematron (KoSIT rules BR-DE-*)
   and veraPDF for PDF/A-3b. All 22 XML files and 11 PDFs passed when this
   was written. So did the files the API itself serves: an invoice with
   0.333 × €999.99, a reverse-charge invoice, and both of their cancellations.

A change to `shared/einvoice.ts` breaks the golden test on purpose. Run the
external check, then `npm run einvoice:fixtures`, then commit.

**Version watch.** XRechnung 3.0.x is current. KoSIT is preparing
XRechnung 4.0 alongside the revised EN 16931, which is not backwards
compatible. When it is published, the specification identifier and the
rules change, and this document and the golden files need a new pass.

## DATEV export

The admin enters the DATEV settings on **Settings → DATEV**: Beraternummer,
Mandantennummer, chart of accounts, account length, fiscal-year start, debtor
numbering, bank account and revenue accounts. Each save records who made it
and when, and is logged on PS-07 as `settings.accounting_changed` when wired.
An export that needs something missing refuses with the list and a link to
Settings.

`GET /api/exports/datev.csv?from=YYYY-MM-DD&to=YYYY-MM-DD[&payments=1]` (also
on **Exports**) returns a DATEV-Format **Buchungsstapel**: header `EXTF`,
version 700, category 21, format version 13, all 125 columns in DATEV's own
spelling, Windows-1252, CRLF.

| Booking | Konto | Gegenkonto | Umsatz | S/H | Belegdatum | Belegfeld 1 |
| ------- | ----- | ---------- | ------ | --- | ---------- | ----------- |
| invoice, per VAT rate | debtor | revenue account of the rate / category | gross of that rate | S | issue date | invoice number |
| cancellation, per VAT rate | debtor | same | same | **H** | cancellation date | `<number>-ST` |
| payment (optional) | bank account | debtor | amount | S | payment date | invoice number (OPOS) |

- **Revenue accounts.** The suggestions are the SKR03 / SKR04 automatic
  accounts (19 % 8400 / 4400, 7 % 8300 / 4300, exempt 8100 / 4100, reverse
  charge EU 8336 / 4336, intra-EU supply 8125 / 4125, export 8120 / 4120).
  DATEV takes the VAT out of an automatic account itself, so no BU-Schlüssel
  is written. Configure one only for a non-automatic account. Austrian rates
  and `Z` / `O` have no suggestion.
- **Debtors.** The customer's own debtor account, else `first debtor account
  + customer id`. Its length is checked against the Sachkontenlänge + 1.
- **Header.** Beraternummer, Mandantennummer, fiscal-year start, account
  length, period, chart. A batch must lie inside one fiscal year, and the
  export refuses one that does not.
- **EU-Land u. UStID** is filled for reverse charge and intra-EU supply.
- **Leistungsdatum is left empty** on purpose. DATEV pairs it with "Datum
  Zuord. Steuerperiode", which decides which VAT return the booking lands
  in. That is the adviser's decision.
- **Festschreibung** is off unless enabled in the settings.
- Payments are off by default, because most advisers import the bank
  statement directly and would get them twice.

The golden file `test/fixtures/datev/march-2026.csv` was checked with an
independent EXTF validator (`@seamless-engineering/datev-extf` 0.1.0, rules
and headings from DATEV's sample files) and had no findings.

## BMD export

`GET /api/exports/bmd.csv?from=&to=` returns a booking file for the BMD NTCS
import, with named columns, `;`, comma decimals and Windows-1252:

```
satzart;konto;gkonto;belegnr;belegdat;buchsymbol;buchcode;prozent;steuercode;betrag;steuer;text;extbelegnr;zziel
```

One row per invoice and VAT rate: `satzart` 0, the debtor as the leading
account, the gross `betrag` with the `steuer` opposite in sign, `buchcode` 1.
`belegnr` is the numeric part of the invoice number (`INV-2026-0001` →
`20260001`), because BMD document numbers are numeric. The full number goes
in `extbelegnr`. A cancellation is the same rows with the signs inverted,
the way BMD books an outgoing credit note. The date format (TT.MM.JJJJ or
JJJJMMTT), the booking symbol (default `AR`) and the first debtor account
(default 200000) are settings.

The **Steuercode** comes from the client's NTCS tax code table and differs
between installations. The admin enters it per revenue group on **Settings →
BMD NTCS**, next to the revenue account. Only the Austrian standard rates ship with a
suggestion (accounts 4000 / 4010 / 4013, code 1). Every other group refuses
until it is configured. Map the columns once in the NTCS import template, and
check the first file in its preview.

## Not covered

Each of these is out of scope on purpose. Each one is a contained addition
if a customer needs it.

- **Sending.** There is no PEPPOL access point and no email delivery of the
  XML. With PS-03 wired, issuing still emails the plain PDF. Delivering
  e-invoices over a channel is a separate integration.
- **Receiving.** The bills side does not read incoming XRechnung or ZUGFeRD.
  The receiving obligation is met by any mailbox that keeps the XML; reading
  it into a bill is a feature still to build.
- **ebInterface and UBL.** Neither the Austrian government format nor the UBL
  syntax is written. Both are new renderers over the same `EInvoiceModel`.
- **Allowances, charges, discounts, units.** Lines carry no allowances or
  charges and are always in unit `C62` (piece). Skonto terms are not encoded.
- **Archiving.** The module stores the data, not the issued bytes. The files
  are reproducible (byte-identical on every download) but not signed or
  archived. PS-06 archives the plain PDF when wired. GoBD-compliant
  long-term storage is still open (`docs/PLATFORM-READINESS.md`, D2).
- **Debtor master data for DATEV / BMD.** Only bookings are exported. The
  adviser creates or imports the personal accounts.
