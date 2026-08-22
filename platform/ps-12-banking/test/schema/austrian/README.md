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

## How they are used

They carry their **own** target namespace — `ISO:camt.053.001.02:APC:STUZZA:payments:004`
rather than the ISO one — because the ISO namespace is what goes on the wire
and these exist solely to validate against. So `camt.test.ts` rewrites the
namespace before handing a fixture to `xmllint`. That is the documented
procedure, not a workaround, and it is what every Austrian validator does.

The code-list documents they include (`RB7.0_camt.05x_codelists.xsd`) are here
too. Between them they define ten types, all enumerations of external ISO code
lists. They were **not** reconstructed while they were missing, and the tests
skipped instead: the entire content of a code list is the exact set of values
it permits, so one written from memory would validate the wrong set while
looking authoritative.

## What the strict subset caught

Running the fixtures against these found six things about what an Austrian bank
actually sends — none of them visible in the ISO schema, none guessable, and
none of which would have thrown:

| | |
| --- | --- |
| `GrpHdr/MsgRcpt` | required |
| `Stmt/LglSeqNb`, `Ntry/BookgDt`, `Ntry/AcctSvcrRef` | required |
| `BkTxCd/Domn` **and** `BkTxCd/Prtry` | **both** required, and `Prtry/Issr` is fixed to `APC` |
| `TxDtls/Refs` and `TxDtls/AmtDtls` | both required |
| `Refs` | only `AcctSvcrRef`, `EndToEndId`, `TxId`, `MndtId`, `ChqNb` — no `MsgId`, no `PmtInfId`, no `InstrId` |
| `RmtInf/Ustrd` | a **single** line, where ISO allows many |
| `Sts` | `BOOK` only on a `camt.053`; `BOOK` or `PDNG` on a `camt.052`/`camt.054` |

Two changed the code, not just the fixtures:

- **The bank's own transaction code was being dropped.** `server/camt.ts` read
  `BkTxCd/Domn` and fell back to `BkTxCd/Prtry`. Austria makes both mandatory,
  so the fallback never fires there and the proprietary code — the one the bank
  actually keys on — was lost on every single booking. They are now read side
  by side.
- **A pending entry cannot appear on an Austrian statement at all.** The status
  enumeration says so. It reaches us on a `camt.052` instead, which is exactly
  why a query spanning both would count money that has not moved — and why
  `GET /api/entries` defaults to statements alone.

## What they were already good for
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
