# The Austrian (STUZZA) pain.001 validation schemas

Published by **STUZZA** (`zv.psa.at`), edited from the SWIFTStandards-generated
ISO originals — each carries both the SWIFT generation header and the
`Edited by Hendrik Muus, STUZZA, AT` line. Version `004`.

| File | Defined against |
| --- | --- |
| `pain.001.001.03-austrian.xsd` | SEPA Rulebook 7.1 plus the Austrian options |
| `pain.001.001.03-austrian-national.xsd` | Austrian national use (the `.N` variant) |

They are a **Technical Validation Subset**: stricter than the ISO schema on the
same target namespace, so a file passing one of these passes the ISO original
too. That makes them the better check on what this module puts in front of a
bank — `buildPain001` produces the file that moves money, and until now nothing
outside this repository had ever looked at it.

## How they are used

They carry their **own** target namespace — `ISO:pain.001.001.03:APC:STUZZA:payments:004`
rather than the ISO one — because the ISO namespace is what goes on the wire
and these exist solely to validate against. `sepa-schema.test.ts` rewrites the
namespace before handing a file to `xmllint`. That is the documented procedure.

The code lists they include are here too. While they were missing the test
skipped rather than reconstructing them: the entire content of a code list is
the exact set of values it permits, so one written from memory would validate
the wrong set while looking authoritative.

## The result

**`buildPain001` passes the Austrian SEPA schema** — ordinary run, batch-booked
run, single payment without a BIC, and a Finanzamtszahlung with its
per-transaction `Purp/Cd`. That is the first time anything outside this
repository has looked at the file this module puts in front of a bank.

## The `.N` variant is a different product

`pain.001.001.03-austrian-national.xsd` is **not** a stricter SEPA check and is
deliberately not used to validate this module's output. Its service-level codes
are `NURG` / `SDVA` / `URGP` — the Austrian domestic priority codes — and
`SEPA` is not among them. It describes the national non-SEPA credit transfer,
which this module does not produce.

A file from `buildPain001` therefore *fails* it, correctly. There is a test
asserting exactly that failure, with its message, so that nobody later reads
the omission as a gap and "fixes" it.
