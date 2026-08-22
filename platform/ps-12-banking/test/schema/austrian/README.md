# The Austrian (STUZZA) validation schemas

Published by **STUZZA** (`zv.psa.at`), edited from the SWIFTStandards-generated
ISO originals — each file carries both the SWIFT generation header and the
`Edited by Hendrik Muus, STUZZA, AT` line, which together are what identifies
them as the real thing rather than somebody's retyping. Version `004`, defined
against SEPA Rulebook 7 / 7.1.

They describe themselves precisely, and the description matters:

> Diese Definitionen sind als **Technical Validation Subset** zu verstehen.
> Alle damit validierbaren XML-Daten lassen sich ebenfalls mit dem
> zugrundeliegenden originalen Namespace der ISO validieren.

So they are **stricter** than the ISO schemas, on the same target namespace.
A document that passes one of these passes the ISO original too; the reverse
does not hold. That makes them the better check, and it is why the ISO
namespace — not a STUZZA one — still goes on the wire.

## ⚠️ These do not compile yet — six code-list files are missing

Each schema `<xd:include>`s a code-list document that was not part of the
upload:

| Schema | needs |
| --- | --- |
| `camt.052.001.02.austrian.004.xsd` | `RB7.0_camt.052_codelists.xsd` |
| `camt.053.001.02.austrian.004.xsd` | `RB7.0_camt.053_codelists.xsd` |
| `camt.054.001.02.austrian.004.xsd` | `RB7.0_camt.054_codelists.xsd` |
| `pain.008.001.02.austrian.004.xsd` | `RB7.0_pain.008_codelists.xsd` |
| `../../../../modules/mod-04-invoice-billing/test/schema/pain.001.001.03-austrian.xsd` | `RB7.1_pain.001_codelists.xsd` |
| `…/pain.001.001.03-austrian-national.xsd` | `RB7.0_pain.001.N_codelists.xsd` |

Between them they define ten types, all of them enumerations of external ISO
code lists — `AT_ExternalPurpose1Code`, `AT_ExternalReturnReason1Code`,
`AT_ExternalBankTransactionDomain1Code` and their relatives. **They are not
reconstructed here.** The entire content of a code list is the exact set of
values it permits, so writing one from memory would produce a schema that
looks authoritative and validates the wrong set — which is this repository's
recurring failure mode, not a new risk.

`camt.test.ts` and MOD-04's `sepa-schema.test.ts` therefore skip their Austrian
checks, naming the missing file, until the six documents are dropped in beside
these. Nothing else depends on them.

## What they were already good for

Reading, rather than validating. `server/camt.ts` claimed only `camt.053`
because pointing the same reader at `camt.052` and `camt.054` was a plausible
assumption with nothing behind it. These schemas settle it:

- `ReportEntry2` and `EntryTransaction2` are defined in all three files, and
  the definitions are **identical element for element**.
- What differs is two names — the envelope (`BkToCstmrStmt` / `BkToCstmrAcctRpt`
  / `BkToCstmrDbtCdtNtfctn`) and its container (`Stmt` / `Rpt` / `Ntfctn`) —
  and one omission: a notification has no `Bal`, there being no balance to
  report on a list of individual items.

That is read off the normative text, not inferred, and it is what one reader
for all three now rests on.

## `pain.008.001.02.austrian.004.xsd`

SEPA direct debit collection. **Nothing produces one yet** — it needs mandates,
which no module in this catalogue holds — so no code refers to this file. It is
here because finding it again is the hard part, and because the shape of the
work is now visible: the schema is in hand, and what is missing is the mandate
model, not the format.
