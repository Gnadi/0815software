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

## ⚠️ These do not compile yet — two code-list files are missing

`pain.001.001.03-austrian.xsd` includes `RB7.1_pain.001_codelists.xsd`, and the
national variant includes `RB7.0_pain.001.N_codelists.xsd`. Neither was part of
the upload, and they are **deliberately not reconstructed**: a code list's whole
content is the exact set of values it permits, so one written from memory would
validate the wrong set while looking authoritative.

`sepa-schema.test.ts` skips, naming the missing file, until they are dropped in
here. It is the only test that refers to them.
