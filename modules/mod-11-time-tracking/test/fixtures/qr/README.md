# QR fixtures

Made by an independent encoder, [segno](https://github.com/heuer/segno) 1.6.6,
with `generate.py` beside this file — so `test/qr.test.ts` tests the reader in
`src/scan/qr.ts` against someone else's reading of ISO/IEC 18004.

- `symbols.json` — module matrices (rows in hex) with text, version and level:
  versions 1–10 at L, M, Q and H, then 15, 20, 25, 30, 35 and 40; numeric,
  alphanumeric and UTF-8 byte content, each filled to near capacity.
- `receipt-*.png` — one Austrian till receipt code (RKSV, version 10-M) as a
  bad photo would show it: clean, rotated 17° and blurred, in perspective,
  under a shadow from the left, and small (about 2.6 pixels a module).

The decoder's tables (`src/scan/qr-tables.ts`) were compared entry by entry
with segno's own before these were made; re-run `generate.py` only with the
pinned segno version, and commit the outputs it writes.
