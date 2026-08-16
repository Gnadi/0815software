# PS-12 · e-Invoicing

EN 16931 structured invoices — generated, **validated against the business
rules**, and read back when somebody sends us one. Part of the
[0815software Platform Services](../README.md). MIT-licensed, self-contained,
zero runtime dependencies beyond Express and SQLite.

## Why this exists

Germany's B2B e-invoicing mandate is not optional and is not far off:

| Date | Obligation |
| ---- | ---------- |
| **2025-01-01** | Every domestic business must be able to **receive** a structured e-invoice. Already in force. |
| **2027-01-01** | Businesses with prior-year turnover above €800,000 must **issue** them. |
| **2028-01-01** | All domestic B2B transactions. |

Austria has required ebInterface or Peppol for B2G since 2014, and a B2B
mandate is expected under EU ViDA in the same window.

A PDF is not a structured e-invoice. MOD-04 Invoice & Billing produces an
excellent human-readable PDF and nothing a machine can validate, which stops
being sufficient for a German B2B customer in January 2027. This service is
where that gap is closed **once**, rather than in every module that issues a
document.

## What it does, and does not

- **Generates** EN 16931 invoices in UN/CEFACT CII syntax, in two profiles:
  the European standard itself, and the German **XRechnung** CIUS.
- **Validates** against the EN 16931 business rules and **refuses to issue**
  a document that breaks one — with the rule identifiers attached.
- **Receives** a structured invoice a third party sent, parses what it can,
  and keeps the bytes.
- It does **not** render PDFs. MOD-04 and MOD-13 keep their own PDF writers
  and stay independent of this service; ZUGFeRD/Factur-X (the CII XML embedded
  in a PDF/A-3) is a planned addition **here**, not in the modules.

## The three properties that matter

**1. Validation is a gate, not a report.** An invoice that breaks a rule is
not written, not stored and not returned — the caller gets a `422` listing
every violated rule at once. This is the whole point: an invalid e-invoice
does not fail at the sender. It is accepted, transmitted, and rejected days
later by the recipient's system, with an error the sender never sees. Refusing
at issue time is the only moment anyone can act on it.

**2. The money in the XML is the money the customer was shown.** Every amount
crosses the wire as an integer in minor units and becomes a decimal exactly
once, when the XML is written. The caller supplies its own totals and PS-12
**checks** them (BR-CO-10, -14, -15) rather than recomputing — because a
service that quietly substitutes its own answer produces an e-invoice that
disagrees with the PDF in the customer's hand, which is a dispute. Comparison
is exact integer equality; one cent out is out.

**3. Issuing is idempotent per (source, invoice number).** An invoice number
is legally unique and gapless for the business that issued it. Two different
documents under one number is not a state worth being able to reach, so a
module retrying after a timeout gets back exactly what it issued the first
time, byte for byte.

## Rule coverage

Honest about the subset, because "EN 16931 compliant" is a claim a recipient
will test:

**Covered** — BR-01…BR-16 (mandatory document content), BR-21…BR-27
(mandatory line content), BR-CO-10/-14/-15/-16/-18 (the arithmetic),
BR-S / BR-Z / BR-E / BR-AE / BR-IC / BR-G / BR-O (VAT categories: permitted
rates, whether an exemption reason is required or forbidden, and that each
category's taxable base equals the lines that fed it), BR-CL-01/-03/-04/-14/
-15/-17 (code lists), and BR-DE-1/-3/-4/-6/-8/-9/-15/-16 for the XRechnung
profile.

**Not covered** — allowances and charges (BG-20/BG-21), invoice line periods,
delivery details, preceding-invoice references, and payee or tax-representative
parties. None of these are modelled on the input contract at all, so their
rules cannot fire. A document PS-12 emits is valid **for the fields it
carries**; adding a field means adding its rules in the same commit.

### The 0 % trap

The rule family worth understanding before using this. A 0 % line is not one
thing — zero-rated (`Z`), exempt (`E`), reverse charge (`AE`),
intra-community (`K`), export (`G`) and out-of-scope (`O`) all show 0 % and
all mean different things to a tax authority. **Every one of them except `Z`
legally requires a stated exemption reason**, and emitting them as an
undifferentiated "0 %" is the most common way an e-invoice is technically
valid XML and substantively wrong. PS-12 refuses rather than guessing which
one you meant.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-12-einvoice
npm install
npm run dev:api        # API on :4012
npm test
```

Check an invoice without issuing it — worth doing while it is still a draft,
because that is the last moment a missing field is cheap to fix:

```sh
curl -sX POST localhost:4012/api/validate \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"profile":"xrechnung","invoice":{
        "number":"INV-2026-0001","issue_date":"2026-07-20","due_date":"2026-08-03",
        "buyer_reference":"991-33333TEST-33",
        "seller":{"name":"0815software GmbH","vat_id":"ATU12345678",
                  "email":"rechnung@0815software.example",
                  "address":{"street":"Teststrasse 1","postcode":"4020","city":"Linz","country_code":"AT"}},
        "buyer":{"name":"Nordwind AG","vat_id":"DE811234567",
                 "address":{"street":"Hafenstrasse 4","postcode":"20359","city":"Hamburg","country_code":"DE"}},
        "lines":[{"id":"1","name":"Consulting","quantity":2,"unit_price_cents":1234,
                  "vat_category":"S","vat_rate":20,"net_cents":2468}],
        "vat_breakdown":[{"category":"S","rate":20,"base_cents":2468,"vat_cents":494}],
        "net_cents":2468,"vat_total_cents":494,"gross_cents":2962,
        "payment":{"iban":"AT611904300234573201","bic":"BKAUATWW"}}}'
```

Issue it, then fetch the file:

```sh
curl -sX POST localhost:4012/api/documents \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"source":"mod-04-invoice-billing","profile":"xrechnung","invoice":{ ... }}'

curl -s localhost:4012/api/documents/mod-04-invoice-billing/INV-2026-0001/xml \
  -H 'X-Service-Token: dev-service-token'
```

Record one that arrived from a supplier:

```sh
curl -sX POST localhost:4012/api/inbound \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/xml' \
  --data-binary @supplier-invoice.xml
```

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/validate` | Check an invoice; store nothing. |
| `POST` | `/api/documents` | Issue. `201` new, `200` replayed, `422` invalid, `409` number reused under another profile. |
| `GET` | `/api/documents` | List issued documents (`?source=`, `?limit=`). |
| `GET` | `/api/documents/:source/:number` | One document with its XML. |
| `GET` | `/api/documents/:source/:number/xml` | The bare XML, as an attachment. |
| `POST` | `/api/inbound` | Record a received invoice (raw XML or `{xml}`). |
| `GET` | `/api/inbound` | List received invoices. |
| `GET` | `/api/health` · `/api/ready` · `/api/metrics` | Liveness, readiness, Prometheus text. |

Authentication follows every other service: `X-Service-Token` for
machine-to-machine, an admin session for a human, or a PS-01 session through
the identity seam when `IDENTITY_URL` is set.

## Security notes

**Inbound XML refuses a DOCTYPE outright** rather than trying to process one
safely. Entity expansion in a document from an unknown sender is the
billion-laughs and XXE surface, and declining the feature is the only way to be
certain neither is reachable — considerably more convincing than a limit on how
many entities may expand.

**A document that cannot be fully parsed is still stored.** It may be the only
copy, and a human can read XML. That is the opposite of the outbound direction,
where anything less than valid is refused — a document we *issue* is our claim
about our own business, and a document we *receive* is evidence.

## Retention

Issued documents are kept with their bytes and a SHA-256, because an e-invoice
is a commercial document under the same retention obligation as the paper one
(§147 AO in Germany, §132 BAO in Austria — ten and seven years). "We regenerate
it on demand" is not an answer when the generator has changed since.

## Platform integration

Consumed through [`@0815software/platform-clients`](../clients) as
`EInvoiceClient`. Modules integrate opt-in and best-effort: with `EINVOICE_URL`
unset a module behaves exactly as it does today, and with it set the same
invoice additionally exports as a structured document. Losing the service means
losing the structured format, never the invoice.

## License

MIT © 0815software — see [LICENSE](LICENSE).
