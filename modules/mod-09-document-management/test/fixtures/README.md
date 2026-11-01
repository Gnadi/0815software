# Text-extraction fixtures

Real files from real writers, so `test/extract.test.ts` checks the readers in
`server/extract.ts` and `server/pdf-text.ts` against what office software and a
browser actually produce — not against files written to suit the reader.

All of them carry the same German text, chosen for umlauts, ß, €, an em dash
and an ampersand:

```
Mietvertrag Wohnung Graz
Die Kaution beträgt 2.400 € und wird auf das Treuhandkonto überwiesen.
Übergabe am 1. März 2026 — Schlüssel: 3 Stück, Straße & Hausnummer: Herrengasse 16.
Kündigungsfrist drei Monate; die Wohnung ist möbliert (Küche, Bad, Schlafzimmer).
```

and the table

```
Position;Menge;Preis
Schreibtisch Eiche;2;450,00
Bürostuhl ergonomisch;4;289,90
Überspannungsschutz;6;19,99
```

| File | Made with | How |
| --- | --- | --- |
| `mietvertrag.odt` | LibreOffice 24.2 | `soffice --headless --convert-to odt mietvertrag.html` |
| `mietvertrag.docx` | LibreOffice 24.2 | `soffice --headless --convert-to docx:"MS Word 2007 XML" mietvertrag.odt` |
| `mietvertrag-libreoffice.pdf` | LibreOffice 24.2 (PDF export) | `soffice --headless --convert-to pdf:writer_pdf_Export mietvertrag.odt` — embedded TrueType subsets with ToUnicode maps, text kerned with `TJ` |
| `mietvertrag-chromium.pdf` | Chromium 141 / Skia | Playwright `page.pdf()` of the same HTML — composite (Type0, Identity-H) fonts, words moved with `Td` inside a line |
| `angebot.ods` | LibreOffice 24.2 | `soffice --headless --infilter=CSV:59,34,76 --convert-to ods angebot.csv` |
| `angebot.xlsx` | LibreOffice 24.2 | `soffice --headless --convert-to xlsx:"Calc MS Excel 2007 XML" angebot.ods` |

While writing the PDF reader its output was also compared word for word with
Poppler's `pdftotext` on PDFs from Word 2016, Adobe PDF Library 11, ReportLab
and LibreOffice (a 6-page export of this module's README) — the words differed
only in a hyphenation join and one arrow glyph. Those PDFs are not committed;
the two above are small and carry the cases that broke naive readers.
