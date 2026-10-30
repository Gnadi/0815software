# Extraction fixtures

- `en16931/` — `ubl-tc434-example1.xml` and `CII_example1.xml`, the same
  invoice in both syntaxes, from the European Commission's
  [eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931)
  repository (`ubl/examples`, `cii/examples`), licensed under the EUPL 1.2
  (header kept in each file). Unmodified.
- `mod-04/` — output of MOD-04 Invoice & Billing: `standard-xrechnung.xml`,
  `storno-xrechnung.xml` and `at-standard.xml` are copies of its golden
  files (validated there against the official XSDs and schematron);
  `invoice.pdf` and `zugferd.pdf` were rendered by its API for one invoice
  (INV-2026-0001, 539.98 € net, 637.78 € gross).
