# The ISO 20022 schema this module's files are checked against

`pain.001.001.03.xsd` is the official SEPA Credit Transfer Initiation schema,
published by ISO 20022 and distributed by the EPC. It is vendored here so that
`sepa-schema.test.ts` validates every file this module can emit on every run,
rather than once by hand at the time of writing.

Delete this directory and that suite skips itself — loudly, with a warning —
which is the same arrangement `platform/ps-12-banking/test/schema/` uses.
Validation also needs `xmllint` (`apt-get install libxml2-utils`).

The schema carries no licence header of its own; ISO 20022 message definitions
are published for free use by the financial industry.
