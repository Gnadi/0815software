# E-Rechnung — XRechnung, ZUGFeRD, ebInterface, DATEV and BMD in MOD-04

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
government (since 2014) go through e-Rechnung.gv.at as **ebInterface** or
PEPPOL UBL. This module writes **ebInterface 6.1** (see
[ebInterface](#ebinterface-the-austrian-format)); UBL is not written. An
Austrian installation uses ebInterface for the Republic and Austrian
recipients, XRechnung/ZUGFeRD for German customers, and the BMD export.

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

The **file** is frozen too, at its first delivery. The first download of a
format of a document (the invoice, its cancellation, a credit note) renders
it and stores the bytes in `issued_documents`, with their SHA-256, the
renderer version and who downloaded it; every later download serves exactly
those bytes (`server/issued-documents.ts`). Rendering again would only be
byte-identical as long as the renderer never changed, and § 14b UStG asks for
the document that was issued, kept for eight years. Until the first
download nothing has left the module, so a file first fetched after an
upgrade is rendered by the code of that day. The table refuses updates and
deletions in the schema itself. The invoice screen lists what went out.

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

### Partial credit notes (Teilgutschriften)

A correction of PART of an invoice — returned goods, a price reduction — is a
credit note of its own: type code 381, number `<invoice number>-GS<n>`
(counting per invoice), dated on its own day, with BT-25/26 naming the
invoice and only its own lines. The invoice's parties, service date, buyer
reference and VAT exemption carry over. Per VAT rate, all credit notes
together never exceed the invoice's base or VAT, so the VAT correction is
exact. Download with `?credit_note=<id>` in all three formats (ebInterface:
`CreditMemo`). The golden case `teilgutschrift` is validated by Mustang like
the others. A corrected invoice (type 384) is not produced.

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

Rates: Germany 0 / 7 / 19 %, Austria 0 / 10 / 13 / 20 %. Only the rates of
the seller's country are accepted: the editor offers no others, and the API
refuses any other rate on a draft (422) and once more at issue, so an
imported offer or a script cannot put German VAT on an Austrian invoice.

## Setting it up

### The seller (Settings screen, `manage` level)

The company is maintained on **Settings → Seller**. Everyone with a level in
the module may read it; saving needs **`manage`**
(`module:invoice-billing:manage` or `platform:admin` in PS-01, or the local
admin login; see [`ACCESS-LEVELS.md`](./ACCESS-LEVELS.md)). Below `manage`
the screen shows the same fields read-only, and the API answers 403. Each field shows
where its current value comes from: **SET HERE**, **FROM PS-11** or **FROM
ENV**. The precedence, field by field (`server/seller-settings.ts`):

1. what was saved on the Settings screen,
2. PS-11 Customers' `self` party, when `CUSTOMERS_URL` is set,
3. the `SELLER_*` environment variables, which are now only starting values.

Clearing a field on the screen falls back to the next source. While PS-11 is
wired, it stays the single authority for what it carries (name, address, VAT
id, IBAN, BIC): those fields are read-only on the screen, and the API refuses
them with 422. Every save records the person who made it (their PS-01 identity) and when. With `AUDIT_URL` set,
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
| Steuernummer | BT-32 | instead of / beside the VAT id. Printed in the PDF footer too (§ 14 Abs. 4 Nr. 2 UStG) | `SELLER_TAX_NUMBER` |
| register number | BT-30 | when there is no VAT id (BR-CO-26), and for category `O`. Printed in the PDF footer | `SELLER_REGISTRATION` |
| seller identifier | BT-29 | the third way to meet BR-CO-26 without a VAT id: `scheme:identifier` with an ISO 6523 scheme (BR-CL-10), e.g. `0088:4000001000005` for a GLN. Written as `GlobalID`, printed in the PDF footer. A Steuernummer alone does not count (review S5); a customer's supplier number does, see below | `SELLER_IDENTIFIER` |
| IBAN, BIC | BT-84, BT-86 | both (payment means 58). The IBAN is also the debtor of every payment file and is check-digit validated on save | `SELLER_IBAN`, `SELLER_BIC` |
| contact person, phone, email | BT-41, BT-42, BT-43 | **XRechnung** | `SELLER_CONTACT_NAME`, `SELLER_PHONE`, `SELLER_EMAIL` |
| e-invoice address | BT-34 | **XRechnung**. Defaults to the contact email. An email address, a Leitweg-ID, or a Peppol ID written `scheme:identifier`, the scheme from the EAS list (BR-CL-25); anything else is refused | `SELLER_EINVOICE_ADDRESS` |

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
| buyer reference | BT-10 | **XRechnung**. The **Leitweg-ID** for a public body, otherwise the reference the customer wants quoted (order number, contact). For ebInterface it is the order reference (`OrderID`) — the **Auftragsreferenz** the Austrian federal government requires. An invoice can carry its own |
| our supplier number | BT-29 | **ebInterface** `InvoiceRecipientsBillerID` — the **Lieferantennummer** the Austrian federal government assigns and requires. In XRechnung and ZUGFeRD it is the seller identifier without a scheme, which EN 16931 describes as "a previously exchanged Buyer assigned identifier of the Seller" — so it also meets BR-CO-26. Printed on the PDF. Frozen at issue like every party field |
| e-invoice address | BT-49 | **XRechnung**. Defaults to the email. One of three kinds, each sent with its scheme: an email address (`EM`), a Leitweg-ID (`0204`), or a Peppol ID written `scheme:identifier` such as `0088:4012345000009` or `9930:DE987654321`, the scheme from the EAS list (BR-CL-25). Free text ("Buchhaltung, Frau Meier") is refused on save and before every file — it used to go out as an `EM` address that reaches nobody, and no validator objects. ebInterface takes only an email here. A Leitweg-ID must carry its check digits (ISO/IEC 7064 MOD 97-10, Formatspezifikation Leitweg-ID 2.0.2): the customer is refused on save, and so is its buyer reference when that is a Leitweg-ID with the wrong digits. The message does not suggest the right ones — the typo may be anywhere |
| e-invoice format | — | The format this customer receives: XRechnung, ZUGFeRD, ebInterface, or none. Set, a draft for the customer is **refused at finalize** until it renders in it (see below). Empty means nobody decided, and nothing is checked |

### Per invoice (editor)

Service date (Leistungsdatum, BT-72; empty means the issue date), service
period (Leistungszeitraum, BG-14: first and last day, both or neither — a
monthly fee, a maintenance contract), buyer reference, and, for 0 % lines,
the VAT category and exemption text. With a period and no service date of its
own, BT-72 is the period's last day — EN 16931 has it as the day the supply was
"made or completed", and an empty delivery block draws ZUGFeRD 2.5's
PEPPOL-EN16931-R008 (a warning there for now). The PDF shows the period as
*SERVICE FROM* / *SERVICE TO*, ebInterface as *Delivery/Period*. Recurring
invoices fill the period of each run.

### Before the first one goes out

Already on the **draft**, the invoice screen lists per format exactly what is
still missing, with its business term, computed from the data sending would
freeze. That matters, because after sending nothing in the invoice can be
completed: a missing postcode or buyer reference could then only be supplied
by cancelling the invoice and issuing a new one. A customer set to an
e-invoice format therefore gets the draft **refused at finalize** (422,
listing the fields) until it renders in that format — before a number is
drawn, from PS-10 too, so a refusal leaves no gap.

Nothing can be downloaded in a state that would fail validation. Send one
invoice to the customer and ask them to confirm their system accepted it.

## Validation

Validation happens in three layers, and the first two run in every test run:

1. **Golden files.** `test/fixtures/einvoice/` holds the XML of the cases
   in `test/einvoice-cases.ts` (standard DE, `AE`, `K`, `G`, `E`, `Z`, `O`,
   exempt mixed with taxed lines, seller with Steuernummer only,
   cancellation, partial credit note, public buyer by Leitweg-ID, a
   four-decimal quantity with texts long enough to wrap), in both profiles.
   The renderer must reproduce them byte for byte.
2. **Schema.** Every case is checked against the Factur-X EN16931 XSD
   (`test/schema/cii-en16931/`) with `xmllint` — and so is every case of the
   **matrix** in `test/einvoice-matrix.ts` that the module does not refuse:
   nine VAT situations × six ways the seller is identified × seven buyers,
   plus credit notes (387 models, about half of them accepted per profile).
   The review's probes that used to be served although invalid are pinned in
   `test/einvoice-rules.test.ts`.
3. **External rules.** `npm run einvoice:validate`
   (`scripts/validate-einvoice.sh`, needs Java and `MUSTANG_JAR`) renders the
   golden cases with a ZUGFeRD PDF each, and every accepted matrix case in
   both profiles, and runs them through
   [Mustang](https://www.mustangproject.org/) 2.26.0: the EN 16931 schematron
   1.3.16, the XRechnung schematron 2.4.0 (XRechnung 3.0.2, KoSIT rules
   BR-DE-*) and veraPDF for PDF/A-3b. All files go through one JVM
   (`scripts/MustangBatch.java`, Mustang's own validator class): about 20
   seconds for the 476 files, where starting the CLI per file took minutes.
   The rule is one-directional: what the module refuses is never served, so
   only what it accepts must be valid. The workflow
   `.github/workflows/einvoice-validation.yml` runs it on every MOD-04
   change, with the Mustang jar pinned by SHA-256 — the only CI job that
   downloads anything.

**Line amounts** are quantity × unit price, rounded half up to the cent, in
integers from the quantity's four decimals — the definition of BT-131, and
what Peppol checks (PEPPOL-EN16931-R120); the CEN and XRechnung artefacts do
not. A quantity takes at most four decimals, the number the XML states.
Invoices issued before this rule keep the floating-point rounding they were
issued with (see the module README, Money).

A change to `shared/einvoice.ts` breaks the golden test on purpose. Run the
external check, then `npm run einvoice:fixtures`, then commit. Regenerated
golden files also fail the renderer fingerprint in
`test/issued-documents.test.ts` until `RENDERER_VERSION`
(`server/issued-documents.ts`) is bumped: the stored files name the renderer
that produced them.

**Version watch** (as of 22 October 2026). XRechnung 3.0.2 is current and
stays in force until at least 31 July 2027. KoSIT published a pre-release of
XRechnung 4.0.0 on 15 September 2026, not for production use; the final
release is expected in spring 2027 and implements EN 16931-1:2026, which CEN
adopted in March 2026 and which is not backwards compatible. ZUGFeRD is at
2.5 / Factur-X 1.09 (June 2026, based on CII D22B and backwards compatible
with the D16B this module writes). The BMF added a third letter on
e-invoices on 15 October 2026. When XRechnung 4.0 is final, the
specification identifier and the rules change, and this document and the
golden files need a new pass. The sources, and the gaps in the standards
themselves, are in [`E-RECHNUNG-REVIEW.md`](./E-RECHNUNG-REVIEW.md).

## ebInterface, the Austrian format

**ebInterface 6.1** (AUSTRIAPRO / WKO) — `GET /api/invoices/:id/ebinterface.xml`,
`?document=cancellation` for the credit note. It is the format the Republic of
Austria accepts through e-Rechnung.gv.at besides PEPPOL UBL, and what many
Austrian recipients read. It is not an EN 16931 syntax, so it has its own
renderer (`shared/ebinterface.ts`) — over the **same** `EInvoiceModel`, the
same frozen parties and the same money:

- **Tax categories** as the specification recommends: `S` for the seller
  country's standard rate (20 % in AT, 19 % in DE), `AA` for a reduced one
  (10 %, 13 %, 7 %), and at 0 % the invoice's exemption category, which
  already uses the same UN/CEFACT 5305 codes (`E`, `AE`, `K`, `G`, `Z`, `O`).
  The exemption reason goes into the 0 % tax item's comment.
- **Amounts.** Each line carries its net amount and category; the tax is
  stated once per (rate, category) in the summary, rounded the way this
  module rounds it. `TotalGrossAmount = Σ LineItemAmount + Σ TaxAmount =
  PayableAmount` — asserted for every case.
- **No VAT id** (Kleinunternehmer, a public body): `ATU00000000`, as the
  specification prescribes; it needs no register number in its place.
- **The Republic's two identifiers.** The customer's *supplier number* is
  written as `Biller/InvoiceRecipientsBillerID` (Lieferantennummer), the buyer
  reference as `InvoiceRecipient/OrderReference/OrderID` (Auftragsreferenz).
  Both are written whenever known; the module does not decide which recipient
  requires them. For an invoice to a federal body, fill in both.
- **Cancellation** = `DocumentType="CreditMemo"` with positive amounts (which
  the specification defines as a credit note), `CancelledOriginalDocument`
  naming the invoice, and no payment instructions.
- **Register number**: `FN …` → `FurtherIdentification IdentificationType="FN"`,
  anything else → `FR`; a Steuernummer → `FASTNR`.

**Validation.** `test/schema/ebinterface-6p1/Invoice.xsd` is the official 6.1
schema from AUSTRIAPRO's standards repository; every case (the four Austrian
ones in `test/ebinterface-cases.ts` and every EN 16931 case) is checked
against it with `xmllint` on every test run. The schema's own sample passes
and its deliberately broken sample fails, which proves the check looks. The
Austrian cases have golden files (`npm run ebinterface:fixtures` regenerates
them). Not done yet: a run through the federal test system (test.erb.gv.at),
which also checks the identifiers against the Republic's records — do that
with a real supplier number before the first live invoice.

## DATEV export

Someone with the `manage` level enters the DATEV settings on **Settings →
DATEV**: Beraternummer,
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
| partial credit note, per VAT rate | debtor | same | its gross at that rate | **H** | credit note date | `<number>-GS<n>` |
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
the way BMD books an outgoing credit note; a partial credit note likewise,
for its own amounts, with its own number in `extbelegnr`. The date format (TT.MM.JJJJ or
JJJJMMTT), the booking symbol (default `AR`) and the first debtor account
(default 200000) are settings.

The **Steuercode** comes from the client's NTCS tax code table and differs
between installations. Someone with the `manage` level enters it per revenue group on **Settings →
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
- **UBL.** The PEPPOL UBL syntax is not written; it would be a new renderer
  over the same `EInvoiceModel`, as ebInterface is.
- **Allowances, charges, discounts, units.** Lines carry no allowances or
  charges and are always in unit `C62` (piece). Skonto terms are not encoded.
- **Every alphabet in the PDF.** The PDF is written in WinAnsi
  (Windows-1252): German and the other Western European languages, Š, Ž and
  Œ included. A letter outside it is shown without its accent (Łódź as
  Lódz), a script without Latin letters as question marks. The XML is UTF-8
  and carries every name exactly; the PDF would need a Unicode font
  (Identity-H) to do the same.
- **Archiving beyond the module.** Issued e-invoices are stored as
  delivered, with their SHA-256, append-only (see *The invoice as issued*),
  but not signed, not timestamped by a third party and not copied to an
  archive outside the module's database; backups carry them. PS-06 archives
  the plain PDF when wired. Revision-proof long-term storage is still open
  (`docs/PLATFORM-READINESS.md`, D2).
- **Debtor master data for DATEV / BMD.** Only bookings are exported. The
  adviser creates or imports the personal accounts.
