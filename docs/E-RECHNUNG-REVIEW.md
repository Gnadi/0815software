# Review: E-Rechnung in MOD-04 und Lücken im Standard

*Code-Review der XRechnung-/ZUGFeRD-Implementierung in MOD-04 Invoice & Billing
(Stand Commit `8674744`), mit externer Validierung der erzeugten Dateien und
einer Recherche zum Stand von Norm, CIUS, ZUGFeRD und Verwaltungsauffassung.
Stand der Recherche: 22. Oktober 2026. Das ist eine technische Einschätzung,
keine Steuer- oder Rechtsberatung.*

Pfade ohne Präfix sind relativ zu `modules/mod-04-invoice-billing/`. Die
Prüffälle (A–Q) sind in [Anhang A](#anhang-a-prüffälle) mit Eingaben und
Ergebnis aufgeführt. Zeilenangaben beziehen sich auf den Stand des Reviews.

## Stand der Umsetzung

Nachgetragen am 22.10.2026, nachdem `main` (ebInterface 6.1, Teilgutschriften,
wiederkehrende Rechnungen, Mahnwesen) in den Branch übernommen war; M1 bis M8
und N1 bis N5 am 23.10.2026:

| Befund | Stand | Belegt durch |
| --- | --- | --- |
| **H3** | **Behoben.** Die erste Auslieferung eines Formats (Rechnung, Storno, Teilgutschrift; XRechnung, ZUGFeRD, ebInterface) speichert die Datei mit SHA-256, Renderer-Version und Person in `issued_documents`; danach werden nur noch diese Bytes ausgeliefert. Trigger verweigern Ändern und Löschen. Die Renderer-Version ist an die Golden Files gekoppelt. | `test/issued-documents.test.ts` |
| **H1** | **Behoben.** Kunden haben ein Zielformat (XRechnung, ZUGFeRD, ebInterface, keins). Ist eines gesetzt, lehnt das Festschreiben den Entwurf mit 422 ab, solange er darin nicht erzeugbar ist, bevor eine Nummer gezogen wird (auch bei PS-10). Der Entwurf zeigt die fehlenden Felder je Format, eingefrorene Rechnungen sagen, dass nur Storno und Neuausstellung helfen. | `test/einvoice-readiness.test.ts` (Fall A) |
| **H2** | **Behoben.** Ergänzt: Ländercodes gegen die Liste des CEN-Schematrons (BR-CL-14), Länderpräfix der USt-IdNr. (BR-CO-09), Verkäufer-Kennung je Steuerkategorie (BR-S/Z/E/AE-02, BR-G-02, BR-IC-02, BR-DE-16), echte Kalenderdaten, Texte, die nach dem Bereinigen leer wären. Eine Matrix aus 279 Modellen wird bei jeder MOD-04-Änderung in CI mit Mustang validiert, soweit das Modul sie annimmt. Lokaler Lauf am 22.10.2026: 327 von 327 Dateien gültig (36 Golden-Dateien, 291 aus der Matrix). | `test/einvoice-rules.test.ts` (Fälle J, K, O, P, Q), `.github/workflows/einvoice-validation.yml` |
| **M1** | **Weitgehend behoben.** Das PDF bricht Positionstext, Notiz, Befreiungsgrund, Gutschriftgrund, Käuferreferenz und Kundennamen nach gemessener Breite um (Metriken der Liberation-Schriften, die beide PDF-Varianten nutzen) und setzt auf der nächsten Seite fort, statt zu kürzen. Mengen stehen mit den vier Nachkommastellen des XML im deutschen Format (`1.234,5`). Seit N4 erscheinen auch Š, Ž, Œ und Ÿ, andere Buchstaben ohne Akzent statt als „?“. Offen: Beim Festschreiben geht weiter das einfache PDF hinaus, auch an Verkäufer in der Ausstellungspflicht (dafür fehlt eine Einstellung). | `test/einvoice-pdf.test.ts`, Golden-Fall `long` (Fall C) |
| **M2** | **Behoben.** Die Fußzeile des PDF nennt alle Kennungen, die auch das XML trägt: USt-IdNr., Steuernummer, Registernummer. Ein leeres „VAT“ gibt es nicht mehr. Offen bleiben die Geschäftsbriefangaben nach § 35a GmbHG, dafür fehlen noch Felder. | `test/einvoice-pdf.test.ts` |
| **M3** | **Behoben.** Zeilenbeträge werden ganzzahlig aus der Menge in Zehntausendsteln gerechnet und kaufmännisch gerundet (BT-131). Mengen haben höchstens vier Nachkommastellen (API und Festschreiben). Report-Views, DATEV/BMD-Export, Gutschriften und Client-Vorschau rechnen gleich. Jede Rechnung behält die Rundung, unter der sie festgeschrieben wurde (`line_rounding`): Bestehende Rechnungen bleiben bei der alten Gleitkomma-Rundung, ihre Beträge ändern sich nicht. Fall C ergibt jetzt 446,63 €, wie Mustang nachrechnet. Ein Import, dessen Zeilennetto die neue Rundung nicht trifft, wird centgenau übernommen. | `test/money.test.ts` (160.000 Kombinationen gegen BigInt, Upgrade-Fall), Golden-Fall `long` |
| **M4** | **Behoben.** Eine elektronische Adresse ist eine E-Mail-Adresse (`EM`), eine Leitweg-ID (`0204`) oder eine Peppol-ID in der Form `Schema:Kennung` (`0088:…`, `9930:DE…`), das Schema aus der EAS-Codeliste des CEN-Schematrons (BR-CL-25). Freitext wird beim Speichern von Kunde und Verkäufer und vor jeder Datei abgelehnt (Fälle C und M). ebInterface erhält dort nur eine E-Mail-Adresse. | `test/einvoice-rules.test.ts` (Fälle R, S), Matrix-Käufer `peppol` |
| **M5** | **Behoben.** Die Prüfziffer einer Leitweg-ID wird geprüft, nach der Formatspezifikation 2.0.2 (Kap. 2.4, deren Beispiel ist Testfall): beim Speichern von Kunde und Verkäufer und vor jeder Datei, in der elektronischen Adresse und in der Käuferreferenz eines so adressierten Käufers. Eine Bestellnummer gleicher Form (`4711-01`) bei anderen Käufern bleibt unberührt. Die Testdaten tragen gültige IDs. | `test/einvoice-rules.test.ts` (Fall F) |
| **M6** | **Behoben** mit H2: Die API nimmt nur noch echte Kalenderdaten an. | `test/einvoice-rules.test.ts` |
| **M7** | **Behoben.** Entwürfe haben einen Leistungszeitraum (BG-14: erster und letzter Tag, beide oder keiner; BR-29). Er steht im XML, in ebInterface als `Delivery/Period` und im PDF. Ohne eigenes Leistungsdatum ist BT-72 der letzte Tag des Zeitraums, so bleibt der Lieferblock nicht leer (ZUGFeRD 2.5 warnt sonst nach PEPPOL-EN16931-R008). Wiederkehrende Rechnungen tragen den Zeitraum ihres Laufs ein, statt des fiktiven Datums mit Freitext. | `test/einvoice-rules.test.ts` (M7), `test/recurring.test.ts`, Golden-Fall `period` |
| **M8** | **Behoben.** BR-CO-26 lässt sich ohne USt-IdNr. und Registernummer auf zwei Wegen erfüllen: mit einer Verkäuferkennung (BT-29) mit ISO-6523-Schema aus den Einstellungen, etwa einer GLN (`0088:…`, `GlobalID`), oder mit der Lieferantennummer, die der Kunde vergeben hat (`ram:ID` ohne Schema). EN 16931 nennt Letztere ausdrücklich als Beispiel für BT-29. Beide stehen auch im PDF. | `test/einvoice-rules.test.ts` (Fälle T, U), Matrix-Verkäufer `taxno_gln` |
| **N4** | **Behoben bis auf die Unicode-Schrift.** Das PDF schlägt jedes Zeichen in derselben CP1252-Tabelle nach, mit der das PDF/A seine Schriften einbettet: Š, Ž, Œ, Ÿ, š, ž, œ und ™ erscheinen richtig. Ein Buchstabe, den WinAnsi nicht hat, erscheint ohne Akzent („Łódź“ als „Lódz“, „Čech“ als „Cech“) statt als „?“; das XML trägt den Namen genau. Offen: eine Unicode-Schrift (Identity-H) im PDF, erst dann stehen Ł, ź und nichtlateinische Schriften dort wie im XML. | `test/einvoice-pdf.test.ts` (N4), Golden-Fall `k` (Käufer in Polen) |
| **N2** | **Behoben.** Vor jeder Rechnung, in allen drei Formaten, muss die IBAN eine SEPA-IBAN mit stimmender Prüfsumme sein (BT-84, `ibanProblem` wie beim Speichern), ein gesetzter BIC ein BIC (BT-86), geschrieben wie die IBAN ohne Leerzeichen und in Großbuchstaben (das ebInterface-Schema lehnt „BYLA DEM1 001“ ab). Die Vorgaben aus `config.ts`, `AT00 0000 0000 0000 0000` und `EXAMPLEX`, werden mit eigenem Text abgelehnt; `EXAMPLEX` hat die Form eines BIC. Ein Storno nennt kein Konto und wird darauf nicht geprüft, damit eine Rechnung mit Platzhalter-Konto storniert werden kann. Für XRechnung braucht die Telefonnummer mindestens drei Ziffern (BR-DE-27), auch beim Speichern der Einstellungen. | `test/einvoice-rules.test.ts` (Fälle H, V, W, M; N2) |
| **N1** | **Behoben.** Geschäftsdaten sind Tage in der Zeitzone `BUSINESS_TIMEZONE` (Vorgabe Europe/Berlin; eine unbekannte Zone verhindert den Start): Rechnungsdatum ohne Eingabe, damit das Jahr des Nummernkreises, Fälligkeit, Zahlungen ohne Buchungsdatum, Mahnungen, Überfälligkeit. Das Stornodatum wird beim Stornieren als `cancelled_on` gespeichert, wie ein Rechnungsdatum; es datiert das Storno-Dokument (BT-2), die Gegenbuchung im DATEV/BMD-Export und den Kontoauszug, auch eine spätere Änderung der Zone verschiebt es nicht. Ältere Stornos behalten den UTC-Tag, den sie immer zeigten. Die Report-Views zählen `days_overdue` in derselben Zone; SQLite kennt keine IANA-Zonen, darum trägt die View die Offsets der Zone mit den Umstellungszeitpunkten für 30 Jahre und wird bei jedem Start neu gebaut. Der Client zeigt Zeitstempel in der Ortszeit des Betrachters. | `test/business-date.test.ts` (Neujahrsnacht, Storno um 00:30, SQL gegen `Intl` an den Zeitumstellungen von sieben Zonen, Migration) |
| **N5** | **Behoben.** Der Storno heißt „Stornorechnung“ (BT-22 „Stornorechnung zur Rechnung … vom …“, Titel des PDF/A), die Teilgutschrift „Rechnungskorrektur“. BT-20 nennt für beide keinen Dokumentnamen mehr, nur „Wird mit offenen Beträgen verrechnet oder erstattet.“ Die Namen stehen an einer Stelle (`DOCUMENT_NAME`). Intern (Oberfläche, DATEV/BMD-Buchungstext) bleibt „Gutschrift“, das geht an keinen Empfänger. | `test/einvoice.test.ts`, `test/credit-notes.test.ts`, Golden-Fälle `storno`, `teilgutschrift`, `at-storno`, `at-teilgutschrift` |
| **N3** | **Behoben.** Eine Zeile „PLZ Ort“ wird nur im Format des Landes der Adresse gelesen (Länderfeld, sonst Länderzeile, Buchstabenpräfix, USt-IdNr.), für 23 Länder mit bekanntem Format: „1012 LG Amsterdam“ ergibt PLZ `1012 LG` und Ort Amsterdam, „90-001 Łódź“ PLZ `90-001`. Ohne Land, bei einem Land ohne hinterlegtes Format (GB, IE …) oder einer PLZ, die nicht ins Format passt, bleiben PLZ und Ort leer, und die Datei wird mit Verweis auf die Felder abgelehnt. | `test/einvoice.test.ts` (N3) |
| N6–N8 | Offen. | – |

Beim Umsetzen von H2 fiel ein weiterer Fall auf: Ein Text nur aus
Steuerzeichen (etwa eine eingefügte Notiz) wurde zu einem leeren Element, das
XRechnung (PEPPOL-EN16931-R008) und ZUGFeRD 2.5 (CII R74) ablehnen. Prüfung
und Renderer behandeln solche Texte jetzt als fehlend.

## Kurzfassung

- **Das Fundament stimmt.** Ein Modell, ein Renderer, ganzzahlige Cent,
  Umsatzsteuer je Satz, bytegleiche Wiederholbarkeit, Parteien beim
  Festschreiben eingefroren, fehlende Felder mit ihrem Business Term. Die
  Behauptung der Doku ließ sich reproduzieren: alle 33 Golden Files (22 XML,
  11 PDF/A-3) bestehen Mustang 2.26.0 mit dem EN-16931-Schematron 1.3.16, dem
  KoSIT-Schematron 2.4.0 für XRechnung 3.0.2 und veraPDF. `npm test`: 24
  Dateien, 478 Tests, grün.
- **Drei Befunde sollten vor dem ersten Einsatz für E-Rechnungspflichtige
  (1.1.2027) behoben sein** (inzwischen behoben, siehe
  [Stand der Umsetzung](#stand-der-umsetzung)):
  1. **Festschreiben prüft die E-Rechnung nicht, und das Einfrieren macht
     jeden Mangel endgültig** (H1). Eine Rechnung, deren Kunde beim
     Festschreiben keine PLZ, E-Mail oder Käuferreferenz hatte, wird nie
     mehr zur XRechnung, auch nicht nach Korrektur des Kunden.
  2. **„Nur ausliefern, wenn es validiert“ gilt nicht** (H2). Das Modul
     liefert ungültige Dateien aus: USt-IdNr. des Käufers ohne Länderpräfix
     (BR-CO-09), Ländercode `UK` (BR-CL-14), Ausfuhr ohne USt-IdNr. des
     Verkäufers (BR-G-02), steuerfreie Rechnung ohne Steuer-ID (BR-E-02).
  3. **Ausgestellte E-Rechnungen werden nicht gespeichert, sondern bei jedem
     Download neu erzeugt** (H3). Jede Änderung am Renderer, auch die Fixes
     aus diesem Review und der Wechsel auf XRechnung 4.0, verändert damit
     rückwirkend Rechnungen, die längst versandt sind.
- **Dazu acht mittlere Befunde**, u. a.: PDF und XML sagen nicht dasselbe
  (Kürzungen nach 46 bzw. 100 Zeichen, andere Mengengenauigkeit), die
  Steuernummer fehlt auf dem PDF, die Zeilenrundung ist in ca. 0,13 % der
  Fälle um einen Cent falsch, jede elektronische Adresse, die keine
  Leitweg-ID ist, wird als E-Mail (`EM`) ausgegeben, Leitweg-IDs werden ohne
  Prüfziffer akzeptiert (die Testdaten des Repos sind selbst ungültig),
  der 31. Februar wird als Rechnungsdatum angenommen.
- **Stand der Standards:** XRechnung 3.0.2 gilt bis mindestens 31.07.2027.
  XRechnung 4.0 liegt seit 15.09.2026 als Vorversion vor (final
  voraussichtlich Frühjahr 2027) und setzt die im März 2026 angenommene
  EN 16931-1:2026 um. ZUGFeRD ist bei 2.5 / Factur-X 1.09 (Juni 2026). Das
  BMF hat am 15.10.2026 ein drittes Schreiben zur E-Rechnung veröffentlicht.
- **Lücken im Standard**, die das Modul direkt betreffen: Die CEN- und
  XRechnung-Artefakte prüfen weder die Zeilenarithmetik (die prüft nur
  Peppol, als PEPPOL-EN16931-R120 mit ±0,02 €) noch die Gültigkeit von
  Kalenderdaten, und sie tolerieren bei der Steuer ±1,00 € (BR-CO-17).
  Storno und Rechnungskorrektur sind technisch nicht festgelegt. Die
  Steuernummer zählt nicht zur Identifikation des Verkäufers (BR-CO-26).
  Für Skonto, Bruttopreise und Schlussrechnungen fehlen in EN 16931:2017
  passende Strukturen, das BMF hilft mit Nichtbeanstandungsregeln aus.
  Details in [Abschnitt 5](#5-lücken-und-unklarheiten-im-standard).

## 1. Umfang und Vorgehen

**Gelesen:** `shared/einvoice.ts`, `server/einvoice-data.ts`,
`server/pdfa.ts`, `server/pdf.ts`, `server/ttf.ts`, `shared/address.ts`,
`shared/money.ts`, `server/invoices.ts`, die E-Rechnungs-Routen und
Validierungen in `server/app.ts`, `server/seller-settings.ts`,
`server/seller.ts`, `server/config.ts`, das Schema in `server/db.ts`, die
Bildschirme `InvoiceDetail.tsx` und `InvoiceEditor.tsx`, die Tests
`test/einvoice.test.ts` und `test/einvoice-cases.ts`, die Golden Files, die
Skripte `einvoice-fixtures.mts` und `validate-einvoice.sh`, außerdem
[`E-RECHNUNG.md`](./E-RECHNUNG.md) und die README des Moduls. DATEV und BMD
sind nicht Gegenstand dieses Reviews.

**Ausgeführt:**

- `npm test` in MOD-04: 24 Testdateien, 478 Tests, alle grün.
- Externe Validierung mit **Mustang-CLI 2.26.0** von Maven Central (SHA-1
  `8755fc333032f802ad7dcf3930201edfe64014e2`, stimmt mit der Prüfsumme auf
  Maven Central überein). Mustang bringt mit: EN-16931-CII-Schematron
  **1.3.16** (Stand 30.03.2026), KoSIT-Schematron **2.4.0 für XRechnung
  3.0.2**, die Artefakte von **ZUGFeRD 2.5** (`ZF_250`) und **veraPDF
  1.30.2**. Der KoSIT-Validator selbst war nicht erreichbar (GitHub ist in
  dieser Umgebung gesperrt); Mustang verwendet dieselben XRechnung-Schematrons.
- Alle Golden Files (`npm run einvoice:fixtures -- <dir> pdf`):
  **33 von 33 gültig**, keine Warnung.
- Zum Vergleich gelesen (nicht ausgeführt): die Peppol-BIS-Billing-Regeln
  aus `phive-rules-peppol` 4.6.3 (Maven Central, OpenPeppol-Regeln 2026.5).
- 17 Prüffälle über die echte API (In-Memory-Datenbank, `supertest`) bzw.
  direkt über `renderCii`, jeweils mit Mustang validiert. Ergebnisse in
  [Anhang A](#anhang-a-prüffälle).

**Recherchiert:** KoSIT (xeinkauf.de), FeRD/ZUGFeRD-Community, CEN-
Veröffentlichungen, Fachbeiträge zu den BMF-Schreiben vom 15.10.2024,
15.10.2025 und 15.10.2026, GoBD, BEG IV und e-Rechnung.gv.at. Die
Originaltexte auf bundesfinanzministerium.de ließen sich aus dieser Umgebung
nicht abrufen (Bot-Schutz). Aussagen zu den BMF-Schreiben stützen sich
deshalb auf die in [Abschnitt 7](#7-quellen) genannten Fachquellen und
sind dort, wo nur eine Sekundärquelle vorliegt, so gekennzeichnet.

## 2. Was gut ist

- **Ein Modell, ein Renderer.** XRechnung und ZUGFeRD unterscheiden sich nur
  dort, wo die Spezifikationen es tun (BT-24, BT-23, Pflichtfelder).
  `shared/einvoice.ts` ist rein und deterministisch.
- **Geld richtig modelliert.** Ganzzahlige Cent, Rundung je Zeile, Steuer
  einmal je Satz auf die Bemessungsgrundlage. Das ist genau die Rechnung, die
  BR-CO-10, BR-CO-17 und BR-S-08 nachrechnen (bis auf den
  Gleitkommafehler in M3).
- **Eingefroren beim Festschreiben**, in derselben Transaktion wie die
  Nummer, einschließlich BT-10. Das ist die richtige Antwort auf GoBD und
  § 14 UStG, und es gibt Tests dafür.
- **Ablehnung statt kaputter Datei, mit Business Term.** Das Konzept ist
  richtig, es ist nur unvollständig umgesetzt (H1, H2).
- **Steuerkategorien sorgfältig.** `E`, `AE`, `K`, `G`, `Z`, `O` mit
  VATEX-Codes. Die Sonderfälle bei `O` sind richtig gelöst: keine USt-IdNr.
  (BR-O-02), kein Satz in der Zeile (BR-O-05), aber ein Satz in der
  Aufschlüsselung, weil XRechnung ihn dort verlangt (BR-DE-14).
- **Storno als eigener Beleg** (Typ 381, BG-3 mit Nummer und Datum,
  Zahlungsart 97). Besteht XRechnung und EN 16931.
- **Handgeschriebenes PDF/A-3b, das veraPDF besteht**, auch mehrseitig (60
  Positionen) und mit Sonderzeichen; eingebettete Schrift-Subsets,
  generiertes ICC-Profil, korrekte Factur-X-XMP-Erweiterung,
  `AFRelationship /Alternative`. Ohne neue Laufzeitabhängigkeit.

## 3. Befunde

Schwere: **H** = vor Produktivbetrieb für E-Rechnungspflichtige beheben,
**M** = zeitnah beheben, **N** = niedrig. Jeder Befund nennt Ort, Beleg,
Relevanz und einen Vorschlag.

### H1 · Festschreiben prüft die E-Rechnung nicht, und das Einfrieren macht den Mangel endgültig

*Status: behoben, siehe [Stand der Umsetzung](#stand-der-umsetzung).*

**Wo:** `server/app.ts:696–736` (Finalize prüft Steuersätze, vergibt die
Nummer und friert ein, ruft aber nie `eInvoiceProblems` auf);
`server/einvoice-data.ts:93–105` (`freezeParties`, auch BT-10);
`server/app.ts:894–907` (der Bereitschafts-Endpunkt antwortet für Entwürfe
nur `available: false`); `src/components/InvoiceDetail.tsx:32` (die Liste
fehlender Felder erscheint erst nach dem Festschreiben).

**Beleg (Fall A):** Kunde mit Adresse „Kundenweg 5 / Berlin“ (ohne PLZ), ohne
E-Mail und ohne Käuferreferenz. Festschreiben: 200. Danach meldet die
Rechnung für XRechnung BT-52, BT-53, BT-49 und BT-10. Der Kunde wird
vollständig korrigiert (PLZ, E-Mail, E-Rechnungsadresse, Käuferreferenz).
Die Rechnung meldet **dieselben vier Felder** weiter, die XRechnung bleibt
422. Der Bildschirm nennt als Ort der Korrektur `customer.postcode` usw.,
dort wirkt eine Korrektur aber nicht mehr.

**Warum relevant:** Ab 2027 bzw. 2028 ist für Inlandsumsätze zwischen
Unternehmern die E-Rechnung die Rechnung (§ 14 Abs. 1, § 27 Abs. 38 UStG).
Eine festgeschriebene Nummer, die nicht als E-Rechnung erzeugt werden kann,
lässt nur Storno und Neuausstellung zu. Auch der Storno-Beleg (381) liest
dieselben eingefrorenen Parteien und ist als XRechnung ebenso gesperrt. Ein
öffentlicher Auftraggeber erhält gar nichts Gültiges.

**Vorschlag:**

1. Pro Kunde ein Zielformat hinterlegen (`xrechnung`, `zugferd`, `none` für
   B2C, Kleinbeträge oder Österreich).
2. Vor dem Festschreiben das Modell aus Entwurf und aktuellen Stammdaten
   bauen und `eInvoiceProblems` für das Zielformat prüfen. Bei Problemen
   mit 422 ablehnen, in derselben Form wie heute beim Download.
3. Das Panel „E-INVOICE“ auch im Entwurf zeigen. Nach dem Festschreiben die
   Meldung ehrlich formulieren: „eingefroren, nur per Storno und neuer
   Rechnung korrigierbar“.
4. Test: Rechnung festschreiben, Kunden korrigieren, erwarten, dass das
   Festschreiben schon vorher abgelehnt hätte.

### H2 · „Nur ausliefern, wenn es validiert“ gilt nicht

*Status: behoben, siehe [Stand der Umsetzung](#stand-der-umsetzung).*

README („Refused rather than wrong“) und `E-RECHNUNG.md` („Before the first
one goes out“) versprechen, dass keine
Datei ausgeliefert wird, die die Validierung nicht besteht. Die Vorprüfung
in `shared/einvoice.ts:181–269` bildet aber nur einen Teil der Regeln ab,
und die Eingaben werden nicht so geprüft, dass die übrigen Regeln immer
halten.

**Beleg:**

| Fall | Eingabe | Modul | Mustang 2.26.0 |
| --- | --- | --- | --- |
| J | USt-IdNr. des Käufers `123456789` | XRechnung 200 | **ungültig**, BR-CO-09 |
| K | Ländercode des Käufers `UK` | XRechnung 200 | **ungültig**, BR-CL-14 |
| P | Ausfuhr (`G`), Verkäufer nur mit Steuernummer und HRB | 0 Probleme | **ungültig**, BR-G-02 |
| Q | nur steuerfreie Positionen (`E`), Verkäufer ohne USt-IdNr. und ohne Steuernummer | 0 Probleme | **ungültig**, BR-E-02, BR-DE-16 |
| O | Rechnungsdatum 2026-02-31, Leistungsdatum 2026-02-30 | XRechnung 200 | gültig (siehe M6 und S2) |

Ursachen: `server/app.ts:162–196` prüft die USt-IdNr. des Kunden nur auf
Länge und den Ländercode nur auf zwei Großbuchstaben. `eInvoiceProblems`
prüft die Steuer-ID des Verkäufers nur, wenn es Positionen mit Steuersatz
gibt (`hasStandard`), und kennt die kategoriespezifischen Regeln nicht:
`S`, `Z`, `E`, `AE` verlangen USt-IdNr. **oder** Steuernummer (BR-S-02,
BR-Z-02, BR-E-02, BR-AE-02, BR-DE-16), `G` und `K` verlangen die
**USt-IdNr.** (BR-G-02, BR-IC-02).

**Warum relevant:** Öffentliche Empfänger weisen solche Dateien ab. Nach dem
BMF-Schreiben vom 15.10.2025 sind Geschäftsregelfehler umsatzsteuerlich
erheblich, sobald sie eine Pflichtangabe nach § 14 Abs. 4 oder § 14a UStG
betreffen (Rz. 35a, nach Pelekies/taxpunk). Die USt-IdNr. des Käufers bei
§ 14a und die Anschrift gehören dazu.

**Vorschlag:**

1. Die fehlenden Prüfungen ergänzen: USt-IdNr. des Käufers wie die des
   Verkäufers, Ländercodes gegen die EN-16931-Codeliste (ISO 3166-1 plus
   `XI` und `1A`, siehe S13), die kategoriespezifischen Verkäufer-IDs,
   echte Kalenderdaten (M6).
2. Strukturell: Die Nachbildung der Regeln darf nicht unbemerkt von den
   Artefakten abweichen. Eine generierte Matrix von Modellen
   (Kategorien × Verkäufer-Identifikation × Käuferdaten) in einem CI-Job
   rendern und mit Mustang oder dem KoSIT-Validator prüfen (Jar mit fester
   Version und Prüfsumme, Java ist auf den GitHub-Runnern vorhanden). Die
   Golden Files decken heute nur elf Gutfälle ab.
3. Bis dahin gilt die Einschränkung, die dieses Review in README und
   `E-RECHNUNG.md` vermerkt hat.

### H3 · Ausgestellte E-Rechnungen werden nicht gespeichert, sondern neu erzeugt

*Status: behoben, siehe [Stand der Umsetzung](#stand-der-umsetzung).*

**Wo:** `server/einvoice-data.ts:236–283` (XML und PDF/A werden bei jedem
Request aus Daten und Code erzeugt); offen auch in
[`PLATFORM-READINESS.md`](./PLATFORM-READINESS.md) D2.

**Beleg:** Die Bytegleichheit gilt nur, solange Code, Schriften und
Codelisten unverändert bleiben. Jeder Fix in diesem Review ändert die
Ausgabe für alte Rechnungen. Beispiel Fall L: heute steht im XML die
Zeilensumme 0,14 €, nach dem Rundungsfix (M3) stünde dort 0,15 €. Der
Wechsel auf XRechnung 4.0 ändert die Spezifikationskennung in jeder alten
Rechnung, wenn sie erneut heruntergeladen wird.

**Warum relevant:** § 14b Abs. 1 UStG verlangt ein Doppel jeder
ausgestellten Rechnung, seit dem BEG IV acht Jahre lang. Nach den
BMF-Schreiben ist die E-Rechnung in ihrem ursprünglichen Format so
aufzubewahren, dass Echtheit der Herkunft, Unversehrtheit des Inhalts und
Lesbarkeit gewährleistet sind (nach Haufe). Ein Dokument, das heute anders
aussieht als das versandte, ist kein Doppel.

**Vorschlag:** Die Bytes beim ersten Ausstellen einfrieren. Beim
Festschreiben (nach H1 ist die Datei dann erzeugbar) XML und ZUGFeRD-PDF
append-only mit SHA-256 und Renderer-Version speichern, danach nur noch die
gespeicherten Bytes ausliefern, optional nach PS-06 archivieren.
Renderer-Änderungen wirken dann nur auf neue Rechnungen. **Das sollte vor
allen anderen Renderer-Fixes kommen.**

### M1 · PDF und XML sagen nicht dasselbe

*Status: weitgehend behoben (Umbruch, Mengen, mit N4 die Zeichen); offen ist
der Versand des einfachen PDF an Verkäufer in der Ausstellungspflicht.*

**Wo:** `server/pdf.ts:264` (Positionstext nach 46 Zeichen abgeschnitten),
`:309` (Notiz nach 100), `:317` (Befreiungsgrund nach 100), `:237`
(Käuferreferenz nach 24), `:145` (Menge mit 3 Nachkommastellen) gegenüber
`shared/einvoice.ts:291` (4 Nachkommastellen) und einer Eingabe ohne
Begrenzung; `server/pdf.ts:30–36` (Zeichen ohne Eintrag werden „?“, siehe
N4).

**Beleg (Fall C):** Positionstext „Wartung der Heizungsanlage gemäß
Wartungsvertrag Nr. 2026-117, inkl. Abgasmessung, …“ erscheint im PDF als
„Wartung der Heizungsanlage gemäß Wartungsvert…“. Der Befreiungsgrund
„Steuerfrei nach § 4 Nr. 14 Buchst. a UStG (Heilbehandlung … durch Ärzte,
Zahnärzte, Heilpraktiker)“ endet nach „Ärzte, …“. Menge 0,33333: XML
`0.3333`, PDF `0.333`. Das XML enthält jeweils den vollen Text.

**Warum relevant:** Bei hybriden Formaten ist der XML-Teil führend.
Signifikante Abweichungen zwischen Bildteil und XML können nach dem
BMF-Schreiben vom 15.10.2025 eine weitere Rechnung begründen, mit dem Risiko
doppelter Steuerschuld (nach Haufe). Beim einfachen PDF, das bis zur
Ausstellungspflicht, für B2C und in Österreich die Rechnung ist, fehlen
dann Teile von „Art und Umfang der Leistung“ (§ 14 Abs. 4 Satz 1 Nr. 5 UStG)
und des Hinweises auf die Steuerbefreiung (Nr. 8).

Dazu kommt der Versand: Beim Festschreiben verschickt PS-03 das **einfache
PDF** (`server/app.ts:720–725`). Für einen Verkäufer in der
Ausstellungspflicht ist das ab 2027 keine Rechnung mehr. Geht es neben der
E-Rechnung mit abweichendem Inhalt hinaus, kommt das § 14c-Risiko hinzu.

**Vorschlag:** Umbrechen statt kürzen (Positionstext, Notiz,
Befreiungsgrund, Käuferreferenz). Menge in PDF und XML mit derselben
Genauigkeit ausgeben und die Eingabe auf diese Genauigkeit begrenzen (M3).
Für Verkäufer in der Ausstellungspflicht (Einstellung) die ZUGFeRD-Datei
statt des einfachen PDF versenden, oder das PDF als „Kopie, keine Rechnung“
kennzeichnen.

### M2 · Die Steuernummer fehlt auf dem PDF

*Status: behoben, bis auf die Geschäftsbriefangaben (siehe Vorschlag).*

**Wo:** `server/einvoice-data.ts:125–139` (`pdfParties` übernimmt nur
`vat_id`, nicht `tax_number` und `registration`); `server/pdf.ts:334`
(Fußzeile `VAT ${seller.vatId}`).

**Beleg (Fall B):** Verkäufer nur mit Steuernummer 143/123/45678. Das XML
enthält sie korrekt (`schemeID="FC"`), das PDF zeigt in der Fußzeile
„Beispiel GmbH · VAT “ mit leerem Wert. Eine Steuer-ID steht nirgends auf
dem PDF.

**Warum relevant:** Steuernummer oder USt-IdNr. ist Pflichtangabe (§ 14 Abs.
4 Satz 1 Nr. 2 UStG). Das einfache PDF ist ohne sie keine ordnungsgemäße
Rechnung, das ZUGFeRD-Bild weicht vom XML ab.

**Vorschlag:** Steuernummer und Registernummer in die Fußzeile, wenn
vorhanden. Bei Kapitalgesellschaften fehlen außerdem die
Geschäftsbriefangaben (Rechtsform, Sitz, Registergericht, Geschäftsführer;
§ 35a GmbHG, § 80 AktG); dafür gibt es noch kein Feld.

### M3 · Geldrechnung: Gleitkomma-Rundung und Mengengenauigkeit

*Status: behoben.* Anders als hier vorgeschlagen reicht es nicht, die neue
Rechnung erst nach dem Speichern der Bytes (H3) einzuführen: Auch Salden,
Zahlungsstatus, Mahnungen und Exporte ausgestellter Rechnungen hätten sich um
einen Cent verschoben. Deshalb trägt jede Rechnung ihre Rundungsregel, und
alles vor der Umstellung Ausgestellte behält die alte.

**Wo:** `shared/money.ts:49–51` (`Math.round(quantity * unit_price_cents)`),
dieselbe Formel in den Report-Views `server/db.ts:433–462`; `server/app.ts`
nimmt jede positive Menge bis 1.000.000 mit beliebig vielen Nachkommastellen
an; `shared/einvoice.ts:291–293` schreibt 4 Nachkommastellen, das PDF 3.

**Beleg:**

- Von 160.000 Kombinationen (Mengen 0,001 bis 10,000 in Schritten von
  0,001, 16 typische Preise) runden **200 (0,13 %) einen Cent zu niedrig**,
  weil das Gleitkommaprodukt knapp unter dem halben Cent liegt, z. B.
  0,29 × 0,50 € = 0,145 € → 0,14 €, 0,57 × 1,50 € = 0,855 € → 0,85 €,
  1,005 × 1,00 € → 1,00 €.
- Fall L: XML-Bruttosumme 1,36 €, Mustang rechnet 1,38 € nach (Warnung
  „Arithmetical issue“).
- Fall C: Menge 0,33333 × 999,99 €. Das XML sagt Menge 0.3333, Preis 999.99,
  Zeilensumme 333.33 (richtig wäre für die angegebene Menge 333.30). Mustang
  warnt: 446,66 € gegen nachgerechnete 446,63 €.

**Warum relevant:** `money.ts` verspricht kaufmännische Rundung, und die
Doku verspricht, dass das XML die Zahlen des PDF auf den Cent genau nennt.
Nach der Definition von BT-131 ist die Zeilensumme Menge × Preis ÷
Preisbasismenge. CEN- und XRechnung-Artefakte prüfen das nicht (S1), Peppol
schon: PEPPOL-EN16931-R120 ist fatal bei mehr als 0,02 € Abweichung. Fall C
(0,03 €) würde dort abgewiesen, Fall L (0,01 €) nicht. Empfänger, die
nachrechnen, sehen beide Abweichungen.

**Vorschlag:** Mengen auf 4 Nachkommastellen begrenzen (API und Editor) und
ganzzahlig rechnen: Zehntausendstel × Preis in Cent mit BigInt, dann
kaufmännisch auf Cent runden (ein `Number`-Zwischenprodukt würde bei 10¹⁰ ×
10⁸ die 2⁵³ überschreiten). Dieselbe Rechnung in den Report-Views, damit
MOD-08 nichts anderes zeigt. Wegen H3 erst nach dem Speichern der
ausgestellten Bytes einführen.

### M4 · Elektronische Adressen: alles, was keine Leitweg-ID ist, wird „EM“

*Status: behoben.* Schema und Wert stehen in einem Feld, in der Form, in der
Peppol-Teilnehmer ihre Kennung weitergeben (`0088:4012345000009`); getrennte
Felder hätten Stammdaten und Snapshots verdoppelt.

**Wo:** `shared/einvoice.ts:162–167` (`addressScheme`: Leitweg-Muster →
`0204`, alles andere → `EM`); `server/app.ts:183` (Kunden-Feld
`einvoice_address` nur auf Länge geprüft); `server/seller-settings.ts:273`
(Verkäuferadresse nur geprüft, wenn sie ein „@“ enthält).

**Beleg:** Fall C: Käuferadresse „Buchhaltung, Frau Meier“ wird zu
`<ram:URIID schemeID="EM">Buchhaltung, Frau Meier</ram:URIID>`. Fall M: Die
Einstellungen nehmen „Rechnungseingang Buchhaltung“ als Verkäuferadresse an.
Beide Dateien sind laut Mustang gültig, denn die XRechnung-Regeln
PEPPOL-EN16931-R010/R020 prüfen nur, dass eine Adresse da ist (S7).

**Warum relevant:** BT-34 und BT-49 sind in XRechnung Pflicht und dienen der
Zustellung. Peppol-Teilnehmerkennungen (z. B. `0088` GLN, `9930` deutsche
USt-IdNr.) lassen sich gar nicht ausdrücken, obwohl Peppol der übliche
Zustellweg für Bund und viele B2B-Empfänger ist.

**Vorschlag:** Schema und Wert getrennt speichern (EAS-Codeliste), `EM` nur
für syntaktisch gültige E-Mail-Adressen, `0204` nur mit gültiger
Prüfziffer (M5), Peppol-Formate zulassen, Freitext ablehnen.

### M5 · Leitweg-ID ohne Prüfziffer, Testdaten mit ungültigen IDs

*Status: behoben.* Die Formatspezifikation 2.0.2 (Fassung vom 28.07.2021)
ließ sich später doch abrufen; ihr Kapitel 2.4 bestätigt das unten
beschriebene Verfahren, ihr Beispiel `04011000-1234512345-06` ist Testfall.

**Wo:** `shared/einvoice.ts:162` (`LEITWEG_RE` prüft nur das Format); Tests
`test/einvoice-cases.ts:49`, `test/einvoice.test.ts:233, 282, 484`.

**Beleg:** Die Prüfziffer der Leitweg-ID wird nach ISO/IEC 7064 MOD 97-10
gebildet, so die Formatspezifikation Leitweg-ID der KoSIT (v2.0.2; den Text
selbst konnte ich nicht abrufen, das Verfahren nennen mehrere
Sekundärquellen). Buchstaben zählen wie bei der IBAN als Zahlen. So
nachgerechnet stimmen die Test-Leitweg-ID der ZRE `991-33333TEST-33` und das
KoSIT-Beispiel `04011000-1234512345-06`.
Die IDs im Repo sind ungültig: `04011000-12345-67` (richtig wäre `-03`),
`991-12345-06` (richtig wäre `-73`). Fall F (`04011000-1234512345-99`):
ausgeliefert, laut Mustang gültig. Das XRechnung-Schematron prüft die
Prüfziffer nicht (S7).

**Warum relevant:** Eine Leitweg-ID mit Tippfehler fällt erst beim
Rechnungseingang der Behörde auf, nach dem Versand.

**Vorschlag:** Prüfziffer beim Speichern von Kunde und Entwurf prüfen,
Testdaten korrigieren.

### M6 · Unmögliche Kalenderdaten werden angenommen

*Status: behoben mit H2.*

**Wo:** `server/app.ts:134–141` (`optDate` prüft mit `Date.parse`, das
2026-02-30 stillschweigend in den 2. März umrechnet).

**Beleg (Fall O):** Leistungsdatum 2026-02-30, Rechnungsdatum 2026-02-31.
Festschreiben 200, Fälligkeit 2026-03-17 (von der umgerechneten Zahl aus
berechnet), im XML stehen `20260231` und `20260230`. Mustang meldet
**gültig**.

**Vorschlag:** Rundlaufprüfung: Ein Datum ist gültig, wenn
`new Date(raw + 'T00:00:00Z').toISOString().slice(0, 10) === raw`.

### M7 · Kein Leistungszeitraum (BG-14)

*Status: behoben* (siehe Tabelle oben). Beim Umsetzen fiel auf, dass ZUGFeRD
2.5 einen leeren Lieferblock nach PEPPOL-EN16931-R008 als Warnung meldet,
während das XRechnung-Schematron genau dieses Element ausnimmt. Ein Zeitraum
ohne BT-72 ist damit als XRechnung sauber, als ZUGFeRD nicht ganz.

**Wo:** Das Datenmodell kennt nur `delivery_date` (BT-72), keinen
Abrechnungszeitraum (BG-14, BT-73/74) und keinen Zeitraum je Position
(BG-26).

**Warum relevant:** § 14 Abs. 4 Satz 1 Nr. 6 UStG verlangt den Zeitpunkt der
Leistung, bei Dauerleistungen und Abrechnungszeiträumen den Zeitraum. Nach
dem BMF-Schreiben vom 15.10.2025 gehören Leistungsdatum und
Leistungszeitraum in den strukturierten Teil (nach Haufe). Eine
Monatspauschale bekommt heute entweder ein fiktives Datum oder den Zeitraum
als Freitext in BT-22. Das XRechnung-Schematron empfiehlt BT-72, BG-14 oder
BG-26 in jeder Position (BR-DE-TMP-32).

**Vorschlag:** Abrechnungszeitraum im Entwurf, als BG-14 im XML und im PDF.

### M8 · Ohne USt-IdNr. und ohne Registereintrag keine E-Rechnung (BT-29 fehlt)

*Status: behoben,* über eine Verkäuferkennung mit Schema und über die
Lieferantennummer beim Kunden (siehe Tabelle oben). Eine Kennung „Steuernummer“
gibt es weiterhin nicht (S5).

**Wo:** `shared/einvoice.ts:202–211`; der Renderer schreibt für den
Verkäufer weder `ram:ID` noch `ram:GlobalID`.

**Beleg:** BR-CO-26 akzeptiert im CEN-Schematron `ram:ID` (BT-29),
`ram:GlobalID`, die Registernummer (BT-30) oder die USt-IdNr. (BT-31), nicht
aber die Steuernummer. Das Modul bietet nur BT-30 an.

**Warum relevant:** Freiberufler, Einzelunternehmer und Kleinunternehmer mit
nur einer Steuernummer und ohne Handelsregister können mit dem Modul keine
E-Rechnung erzeugen, oder sie tragen eine erfundene „Registernummer“ ein.

**Vorschlag:** BT-29 (Kennung des Verkäufers, optional mit Schema) als Feld
anbieten und die Meldung entsprechend formulieren. Hintergrund in S5.

### N1 · Geschäftsdaten in UTC

*Status: behoben (siehe Tabelle oben).*

`server/invoices.ts:34–41, 337, 385`, `server/einvoice-data.ts:187`; die
Oberfläche sendet beim Festschreiben kein Datum. Zwischen 0 und 1 Uhr (MEZ)
bzw. 0 und 2 Uhr (MESZ) bekommen Rechnung und Storno das Datum des Vortags.
In der Neujahrsnacht landet die Rechnung im Nummernkreis des alten Jahres.
Vorschlag: Zeitzone für Geschäftsdaten konfigurierbar (Europe/Berlin,
Europe/Vienna).

### N2 · Platzhalter-IBAN und Telefonnummer werden nicht geprüft

*Status: behoben (siehe Tabelle oben).*

`server/config.ts:134–135` setzt `AT00 0000 0000 0000 0000` und `EXAMPLEX`
als Vorgabe, `shared/einvoice.ts:201` prüft die IBAN nur auf leer. Fall H:
Die XRechnung mit der Platzhalter-IBAN wird ausgeliefert, Mustang warnt nur
(BR-DE-19 ist eine Soll-Regel). Fall M: Telefon „n/a“ wird angenommen
(Warnung BR-DE-27). Die Platzhalter-USt-IdNr. wird dagegen schon
abgelehnt. Vorschlag: IBAN-Prüfsumme in `eInvoiceProblems` (`ibanProblem`
aus `shared/sepa.ts` gibt es schon), Platzhalter ablehnen, Telefon mit
mindestens drei Ziffern.

### N3 · Das Adresslesen rät bei niederländischen Postleitzahlen

*Status: behoben (siehe Tabelle oben).*

`shared/address.ts:78`. Fall D: „1012 LG Amsterdam“ wird zu PLZ `1012` und
Ort `LG Amsterdam`. Das widerspricht dem Grundsatz der Datei („reported as
missing rather than guessed“). Vorschlag: nur Länder mit bekanntem Muster
lesen (DE, AT, CH, LI, …), sonst als fehlend melden.

### N4 · Š, Ž, š, ž, Œ, œ, Ÿ werden im PDF zu „?“

*Status: behoben bis auf die Unicode-Schrift (Identity-H).*

`server/pdf.ts:30–36`. Fall E: „Škoda Žalec Łódź s.r.o.“ erscheint als
„?koda ?alec ?ód? s.r.o.“. Š und Ž gibt es in WinAnsi (0x8A, 0x8E), und die
Tabelle in `server/pdfa.ts` kennt sie auch, nur `HIGH` nicht. Ł und ź gibt
es in WinAnsi nicht. Vorschlag: Tabelle vervollständigen, auf Dauer eine
Unicode-Schrift (Identity-H) im PDF/A.

### N5 · Der Storno heißt „Gutschrift“

*Status: behoben (siehe Tabelle oben).*

`server/einvoice-data.ts:278` (Titel des PDF/A), `shared/einvoice.ts:311`
(Text in BT-20). „Gutschrift“ ist im Umsatzsteuerrecht die Abrechnung durch
den Leistungsempfänger (§ 14 Abs. 2 Satz 2, Abs. 4 Satz 1 Nr. 10 UStG). Das
Wort allein auf einer kaufmännischen Gutschrift löst keine Steuer nach
§ 14c UStG aus (Abschn. 14c.1 Abs. 3 UStAE), verwirrt aber Empfänger, die
echte Gutschriften verarbeiten. Vorschlag: „Stornorechnung zu Rechnung …“.
Siehe S3.

### N6 · Reverse Charge strenger als nötig

`shared/einvoice.ts:253–256` verlangt bei `AE` beide USt-IdNrn. BR-AE-02
akzeptiert beim Verkäufer auch die Steuernummer und beim Käufer auch die
Registernummer (BT-47). Für Inlandsfälle nach § 13b UStG (z. B.
Bauleistungen) ist die USt-IdNr. nicht vorgeschrieben. Folge: Solche
Rechnungen sind ohne USt-IdNr. nicht möglich. Niedrig, weil der häufige
Fall (EU-Dienstleistung) beide USt-IdNrn. braucht.

### N7 · Einheit immer C62 („Stück“)

`shared/einvoice.ts:441–442`. „3 × Beratungstag“ wird als 3 Stück
übermittelt. Formal gültig, fachlich falsch für Stunden (`HUR`) und Tage
(`DAY`). In `E-RECHNUNG.md` als Lücke benannt.

### N8 · Doku und Testdaten

- README und `E-RECHNUNG.md`: Die Zusage „nur, wenn es validiert“ stimmte
  nicht (H2). Mit H2 behoben, die Texte beschreiben jetzt auch die Matrix.
- `E-RECHNUNG.md` Z. 27: „ZUGFeRD from profile EN 16931 up“. Das BMF schließt
  nur MINIMUM und BASIC-WL aus (nach PwC). Ob BASIC genügt, wird in der
  Literatur unterschiedlich gesehen (S12).
- `shared/einvoice.ts:8–9` („ZUGFeRD 2.3 / Factur-X 1.07“) ist überholt,
  siehe Abschnitt 4. Den Absatz „Version watch“ in `E-RECHNUNG.md` hat
  dieses Review auf den Stand Oktober 2026 gebracht.
- `shared/einvoice.ts:24` nennt „BR-LIN-04“. Eine solche Regel gibt es in
  EN 16931:2017 nicht; die Zeilenformel steht in der Definition von BT-131
  und wird nur von Peppol geprüft (PEPPOL-EN16931-R120, S1).
- `test/einvoice-cases.ts`: Leitweg-IDs ungültig (M5, inzwischen korrigiert). Mehrere Fälle setzen
  das Land auf DE, behalten aber Adresse „Ring 5, 1010 Wien“ und
  `ATU12345678`. Den Validatoren ist das egal, Lesern nicht.
- Es fehlen Tests für den Weg „festschreiben, dann Kunde korrigieren“ (H1)
  und für ungültige Stammdaten gegen das Schematron (H2).

## 4. Stand der Standards (Oktober 2026)

| Gegenstand | Stand | Folge für MOD-04 |
| --- | --- | --- |
| **EN 16931-1** | Fassung 2017 (+A1:2019) noch maßgeblich für XRechnung 3.0.x. **EN 16931-1:2026** von CEN im März 2026 angenommen (Definitive Text 17./18.03.2026). Laut einem Anbieter-Blog (factora) über 50 neue Business Terms, u. a. strukturierte Skonti, mehrere Käuferreferenzen, mehrere Bestell- und Lieferreferenzen, XML-Anhänge. Nicht abwärtskompatibel. | Neue Pflichten erst mit XRechnung 4.0. Neue Strukturen lösen mehrere Lücken aus Abschnitt 5 (Skonto, Referenzen). |
| **CEN-Validierungsartefakte** | CII-Schematron 1.3.16 (30.03.2026) für die Fassung 2017. Artefakte für 2026 stehen laut factora noch aus. | Gegen die neue Norm kann noch niemand validieren. |
| **XRechnung** | **3.0.2** in Kraft, Bugfix-Bundles bis 31.08.2026, Visualisierungs-Bugfix 13.10.2026. Im Sommer 2026 kein normatives Release, daher gilt 3.0 **bis mindestens 31.07.2027**. **4.0.0 Vorversion seit 15.09.2026**, ausdrücklich nicht für den Produktivbetrieb, final voraussichtlich **Frühjahr 2027**. Parallelbetrieb alter und neuer Norm laut einer Quelle bis März 2029, die KoSIT legt die Fristen erst mit dem finalen Release fest. | Kennung `xrechnung_3.0` ist richtig. 4.0 heißt: neue Kennung, neue Regeln, neue Golden Files. Wegen H3 vorher die Bytes speichern. |
| **ZUGFeRD / Factur-X** | **2.4 / 1.08** veröffentlicht 04.12.2025, gültig ab 15.01.2026: CII D22B, abwärtskompatibel zu D16B, Unterpositionen in EXTENDED, maschinenlesbares Leistungsdatum in der Validierung, leere Elemente verpönt. **2.5 / 1.09** veröffentlicht 10./11.06.2026, empfohlen ab 01.07.2026: Codelisten und Artefakte aktualisiert, leere Elemente ein Fehler (CII R74), Bruttopreis-Funktion in einer späteren Stufe. | Das Modul schreibt D16B mit Profil EN 16931, das ist weiter gültig, und die Golden Files bestehen die 2.5-Artefakte. Codelisten ändern sich halbjährlich, die Validierung gehört deshalb in CI (H2). |
| **Deutschland: Gesetz** | § 14 UStG i. d. F. des Wachstumschancengesetzes. Empfang seit 01.01.2025, Ausstellung ab 01.01.2027 bei Vorjahresumsatz über 800.000 €, ab 01.01.2028 für alle (§ 27 Abs. 38 UStG). Aufbewahrung von Rechnungen **acht Jahre** (BEG IV, § 14b Abs. 1 UStG, § 147 Abs. 3 AO). | Wie in `E-RECHNUNG.md` beschrieben, ergänzt um die Frist. |
| **Deutschland: BMF** | **15.10.2024** (BStBl I S. 1320), **15.10.2025** (BStBl I S. 1806): Fehlerarten Formatfehler (Rz. 6a, sonstige Rechnung), Geschäftsregelfehler (Rz. 6b), Inhaltsfehler (Rz. 35a); alle Pflichtangaben im strukturierten Teil; bei hybriden Formaten führt der XML-Teil. **15.10.2026** (III C 5 – S 7287-a/00019/021/017), nach Ebner Stolz und Haufe: Berichtigung einer E-Rechnung muss E-Rechnung sein, technische Festlegung für ersetzende oder kumulierende Berichtigung fehlt; Geschäftsregelfehler ohne Pflichtangaben-Bezug lassen die E-Rechnung bestehen; Leistungsbeschreibung im strukturierten Teil, Zuordnungstabellen von KoSIT/FeRD; Bruttopreisrechnungen bis 31.12.2027 und Schlussrechnungen (BT-113 + BT-22) bis 30.06.2030 nicht beanstandet; E-Rechnungen bis 31.12.2026 nach den Schreiben 2024/2025 werden nicht beanstandet. | Siehe H1, M1, M7 und S3, S9, S11. |
| **Deutschland: GoBD** | Änderungsschreiben vom 14.07.2025: Für E-Rechnungen genügt der strukturierte Teil, der Bildteil eines hybriden Formats muss nur aufbewahrt werden, wenn er zusätzliche Informationen trägt (nach Sekundärquellen). | Für H3 genügt das gespeicherte XML, das PDF/A ist eine Ergänzung. |
| **Österreich** | Keine allgemeine B2B-Pflicht (Stand Oktober 2026). Bund (B2G) seit 2014 über e-Rechnung.gv.at, die Formatseite nennt ebInterface und UBL, Zustellung per Webservice oder Peppol. CII, XRechnung und ZUGFeRD werden dort nicht genannt. ViDA: Pflicht für innergemeinschaftliche B2B-Umsätze ab 01.07.2030. | Für österreichische Bundesstellen erzeugt das Modul nichts Brauchbares (in `E-RECHNUNG.md` benannt). |

## 5. Lücken und Unklarheiten im Standard

Jeder Punkt nennt, was Norm oder Verwaltung sagen, was offen bleibt, wie
MOD-04 heute damit umgeht und was zu tun ist.

### S1 · Rundung und Rechenregeln

- **Norm:** Die Zeilensumme ist in der Definition von BT-131 beschrieben
  (Preis × Menge ÷ Preisbasismenge + Zuschläge − Abschläge), aber als
  Geschäftsregel nur für die Summen festgelegt: BR-CO-10/13/15 (Summen),
  BR-CO-17 (Steuer = Bemessungsgrundlage × Satz ÷ 100, „rounded to two
  decimals“), BR-DEC-23 (Zeilensumme mit höchstens zwei Nachkommastellen).
  Das deutsche Recht verlangt den Steuerbetrag „auf den Cent genau und
  kaufmännisch gerundet“ (Abschn. 14.5 Abs. 20 UStAE).
- **Offen:**
  - Die Rundungsart legt die Norm nicht fest (kaufmännisch oder
    mathematisch).
  - **Die Zeilenarithmetik prüft kein CEN- und kein XRechnung-Artefakt.**
    Das CII-Schematron 1.3.16 enthält keine Regel dafür; das
    XRechnung-Schematron übernimmt einige Peppol-Regeln (R001, R010, R020
    u. a.), die Zeilenregel R120 aber nicht. Fall C und L gelten als
    gültig. Peppol BIS Billing 3.0 prüft dieselbe Formel als
    PEPPOL-EN16931-R120, fatal, mit ±0,02 € Toleranz (OpenPeppol-Regeln
    2026.5). Je nach Zustellweg ist dieselbe Rechnung also gültig oder
    abgewiesen.
  - **BR-CO-17 toleriert im Artefakt ±1,00 Währungseinheit**
    (`abs(CalculatedAmount) - 1 <= round(...)`). Das ist weit lockerer als
    der Normtext und das deutsche Recht.
  - Zeilenweise Steuerberechnung (Einzelhandel) und Bruttopreise lassen
    sich nicht abbilden (S11).
  - Preise dürfen beliebig viele Nachkommastellen haben, Zeilensummen
    zwei. Wann gerundet wird, sagt die Norm nicht.
- **Folge:** „Gültig“ sagt nichts über die Richtigkeit der Rechnung.
  Empfänger, die nachrechnen, kommen zu anderen Ergebnissen (die
  Mustang-Warnungen in C und L).
- **MOD-04:** Zeilenrundung und Steuer je Satz sind der richtige Ansatz, der
  Gleitkommafehler (M3) nicht.
- **Empfehlung:** Eine eigene, exakte Nachrechnung der Zeilensummen
  (BT-131) und von BR-CO-17 ohne Toleranz im Test, statt sich auf die
  Validatoren zu verlassen.

### S2 · Datumsangaben

- **Offen:**
  - **Die Kalendergültigkeit von Datumsangaben im Format 102 prüft weder
    das XSD noch ein Schematron** (Fall O: `20260231` gilt als gültig).
  - BT-72 ist ein einzelnes Datum für die ganze Rechnung. Zeiträume gehen
    über BG-14, Zeiträume je Position über BG-26. Ein eigenes Lieferdatum
    je Position (Sammelrechnung) gibt es in EN 16931:2017 nicht.
  - XRechnung verlangt kein Leistungsdatum, empfiehlt es aber
    (BR-DE-TMP-32, Warnung). ZUGFeRD ab 2.4 verlangt laut Mustang-Projekt in
    der Validierung ein maschinenlesbares Leistungsdatum oder einen
    Zeitraum. Eine Rechnung ohne beides kann als XRechnung gültig und als
    ZUGFeRD ungültig sein.
  - BT-7 (Steuerentstehung) neben BT-72 wird in Deutschland kaum genutzt;
    das Verhältnis zum „Zeitpunkt der Leistung“ ist nicht beschrieben.
  - Nachgetragen mit M7: Eine Rechnung, die nur einen Zeitraum (BG-14) und
    kein BT-72 nennt, hat in CII einen leeren Lieferblock
    (`ApplicableHeaderTradeDelivery`). Das XRechnung-Schematron nimmt genau
    dieses Element von PEPPOL-EN16931-R008 („keine leeren Elemente“) aus, das
    ZUGFeRD-2.5-Schematron nicht: Es meldet eine Warnung, ausdrücklich „still
    status warning“. Dieselbe Rechnung ist so als XRechnung einwandfrei, als
    ZUGFeRD nur mit Warnung.
- **MOD-04:** schreibt immer BT-72 (gut), prüft Daten aber nicht richtig
  (M6) und kennt keinen Zeitraum (M7).

### S3 · Korrektur, Storno und „Gutschrift“

- **Norm:** BT-3 aus UNTDID 1001; XRechnung erlaubt 326, 380, 381, 384, 389,
  875, 876, 877 (BR-DE-17). BG-3 (BT-25/26) verweist auf die ursprüngliche
  Rechnung; XRechnung verlangt BG-3 nur bei 384 (BR-DE-26).
- **Offen:**
  - **Vorzeichen:** CII hat nur eine Nachricht. Ob eine Gutschrift (381)
    positive Beträge trägt und der Typcode die Richtung angibt, oder ob eine
    Rechnung (380) mit negativen Beträgen gleichwertig ist, legt die Norm
    nicht fest. Ratgeber widersprechen sich.
  - **Welcher Typ für welchen Fall** (Vollstorno, Teilkorrektur, ersetzende
    oder kumulierende Berichtigung): Das BMF verlangt seit 15.10.2026, dass
    die Berichtigung einer E-Rechnung wieder eine E-Rechnung ist, legt aber
    die Technik ausdrücklich noch nicht fest (nach Ebner Stolz). In der
    Gesamtschau von Ursprungs- und Korrekturbeleg müssen Menge und Art der
    Leistung zweifelsfrei sein.
  - **Begriff:** „Gutschrift“ meint umsatzsteuerlich die Abrechnung durch
    den Empfänger (dafür UNTDID 389 bzw. 261), UNTDID 381 „Credit note“ ist
    kaufmännisch eine Rechnungskorrektur. Seit dem Schreiben vom 15.10.2026
    darf die Berichtigung bei vorheriger Vereinbarung auch als Gutschrift
    des Empfängers erfolgen.
- **MOD-04:** Vollstorno als 381 mit positiven Beträgen, BG-3, Zahlungsart
  97; Teilkorrektur als Storno plus neue Rechnung; 384 wird nicht
  verwendet. Das ist eine vertretbare Lesart. Benennung siehe N5.
- **Empfehlung:** Die gewählte Lesart in `E-RECHNUNG.md` begründen, eine
  ersetzende Berichtigung (384 mit BG-3) als Erweiterung vormerken, die
  KoSIT/FeRD-Festlegung beobachten.

### S4 · Zahlungsangaben bei Gutschriften

BR-DE-1 verlangt BG-16 in jeder XRechnung, auch in einer Gutschrift.
EN 16931 sagt nicht, wer bei einer Gutschrift wem zahlt und welches Konto
anzugeben ist. Die IBAN des Verkäufers mit Code 58 wäre für eine Erstattung
an den Käufer sachlich falsch. MOD-04 verwendet 97 („Verrechnung zwischen
den Partnern“). Das ist gültig, deckt aber eine Erstattung per Überweisung
nicht ab.

### S5 · Identifikation des Verkäufers

- **Norm:** BR-CO-26 verlangt BT-29, BT-30 oder BT-31. Die Steuernummer
  (BT-32) zählt nicht, obwohl sie nach § 14 Abs. 4 Satz 1 Nr. 2 UStG der
  USt-IdNr. gleichsteht.
- **Offen:** Wer nur eine Steuernummer hat, muss auf BT-29 ausweichen, für
  das es kein Schema „Steuernummer“ gibt. Eine offizielle Empfehlung der
  KoSIT dazu habe ich nicht gefunden.
- **Zusätzlich:** Die Kategorien sind uneinheitlich. `S`, `Z`, `E`, `AE`
  lassen die Steuernummer genügen, `G` (Ausfuhr) und `K` verlangen die
  USt-IdNr. (BR-G-02, BR-IC-02). Für eine Ausfuhrlieferung verlangt das
  deutsche Recht keine USt-IdNr.; die Norm ist hier strenger als das Gesetz.
- **MOD-04:** siehe M8 und H2 (Fall P).

### S6 · Käuferreferenz (BT-10) im B2B

XRechnung macht BT-10 für jede Rechnung zur Pflicht (BR-DE-15), auch im
B2B. Was dort stehen soll, wenn es keine Leitweg-ID gibt, regelt die
Spezifikation nicht („geeigneter Bezeichner“). Nach dem BMF-Schreiben vom
15.10.2025 ist eine fehlende Käuferreferenz ein Geschäftsregelfehler ohne
umsatzsteuerliche Bedeutung. In ZUGFeRD (Profil EN 16931) ist BT-10
optional. Zusätzlich empfiehlt `E-RECHNUNG.md`, in BT-10 auch eine
Bestellnummer einzutragen, für die EN 16931 ein eigenes Feld hat (BT-13).
Eine öffentliche Stelle braucht in BT-10 aber die Leitweg-ID, eine
Bestellnummer hat dann keinen Platz. MOD-04 lehnt die XRechnung ohne BT-10
ab, das ist folgerichtig. Empfehlung: im B2B ohne Referenz ZUGFeRD
empfehlen, BT-13 als eigenes Feld ergänzen.

### S7 · Elektronische Adressen und Leitweg-ID

- XRechnung 3.0 übernimmt die Peppol-Regeln PEPPOL-EN16931-R010 und R020
  (BT-49 und BT-34 Pflicht, fatal) und R001 (BT-23 Pflicht). Geprüft wird
  nur, dass die Elemente vorhanden sind und das Schema in der EAS-Codeliste
  steht.
- Der Inhalt von `EM`-Adressen wird nicht geprüft. BR-DE-28 prüft nur die
  Kontakt-E-Mail BT-43, und das auch nur als Soll-Regel.
- Die Prüfziffer der Leitweg-ID prüft kein Schematron.
- `EM` ist in der EAS-Codeliste erlaubt, im Peppol-Netz aber nicht
  zustellbar. Welches Schema im B2B ohne Peppol zu verwenden ist, lässt die
  Spezifikation offen.
- **MOD-04:** siehe M4 und M5.

### S8 · Steuerkategorien für deutsche und österreichische Fälle

- EN 16931 legt nicht fest, welche Kategorie zu welchem nationalen Fall
  gehört. Offene oder umstrittene Fälle:
  - Kleinunternehmer (§ 19 UStG): seit 2025 steuerfrei, damit `E` mit
    Hinweistext. Früher wurde zwischen `E` und `O` geschwankt.
  - Nicht im Inland steuerbare Leistungen an Drittlandskunden: `O` oder
    `AE`? Bei `O` verbietet BR-O-02 jede USt-IdNr., auch die eigene.
  - Inländisches Reverse Charge (§ 13b UStG): `AE` wie das
    innergemeinschaftliche, mit anderen Pflichtangaben (N6).
  - Differenzbesteuerung (§ 25a) und Reiseleistungen (§ 25): nur über `E`
    mit VATEX-Codes, ohne eigene Kategorie.
- **Genau eine Aufschlüsselung je Kategorie** (z. B. BR-E-01): Zwei
  verschiedene Befreiungsgründe auf einer Rechnung (etwa § 4 Nr. 14 und
  § 4 Nr. 21 UStG) lassen sich nicht getrennt ausweisen, nur als
  gemeinsamer Text in BT-120.
- **MOD-04:** eine Befreiungskategorie je Rechnung, damit innerhalb dieser
  Grenze konsistent.

### S9 · Pflichtangaben ohne eigenes Feld

EN 16931 kennt § 14 UStG nicht. Für Angaben wie den Hinweis auf die
Aufbewahrungspflicht des Empfängers (§ 14 Abs. 4 Satz 1 Nr. 9 UStG), den
Kleinunternehmer-Hinweis oder die Geschäftsbriefangaben gibt es kein Feld;
sie landen in Freitext (BT-22, BT-33, BT-120). Die Zuordnungstabellen von
KoSIT und FeRD, auf die das BMF verweist, sind nicht normativ, und ihr
Versionsstand ist uneinheitlich dokumentiert. Empfehlung: die Tabelle als
Prüfliste neben `eInvoiceProblems` legen.

### S10 · Skonto, Rabatte, Boni

EN 16931:2017 hat keine Struktur für Skonto. XRechnung behilft sich mit einer
Textkonvention in BT-20 (`#SKONTO#TAGE=14#PROZENT=2.00#`, deren Syntax
BR-DE-18 per regulärem Ausdruck prüft), die nicht Teil der Norm ist. ZUGFeRD EXTENDED hat eine eigene
Struktur, EN 16931-1:2026 führt eine ein. Nach dem BMF-Schreiben vom
15.10.2026 genügt für vorab vereinbarte Minderungen ein allgemeiner Hinweis
auf die Vereinbarung. MOD-04 kennt kein Skonto und schreibt „ohne Abzug“,
das ist konsistent.

### S11 · Bruttopreise und Schlussrechnungen

Das Kernmodell kann keine Rechnung abbilden, die von Bruttobeträgen ausgeht;
das BMF beanstandet bis 31.12.2027 nicht, wenn dann nur Summen je Steuersatz
strukturiert und die Positionen als Anhang übermittelt werden. Für
Schlussrechnungen mit abgezogenen Anzahlungen genügt bis 30.06.2030 die
Summe in BT-113 mit Erläuterung in BT-22. Beides betrifft MOD-04 heute
nicht (Nettopreise, keine Anzahlungsrechnungen), wohl aber eine künftige
Erweiterung um Anzahlungen.

### S12 · Hybride Formate

- **Vorrang:** Der XML-Teil führt. Ab wann eine Abweichung des Bildteils
  „signifikant“ ist und eine weitere Rechnung begründet, ist nicht definiert.
- **Darstellung:** Factur-X/ZUGFeRD schreibt nicht vor, wie vollständig das
  PDF das XML wiedergeben muss. `AFRelationship` darf `Data`, `Source` oder
  `Alternative` sein, mit unterschiedlicher Bedeutung, geprüft wird das von
  keinem Validator.
- **Profile:** Unstrittig ausgeschlossen sind MINIMUM und BASIC-WL. Ob BASIC
  genügt, beurteilen Fachquellen unterschiedlich.
- **MOD-04:** Profil EN 16931 mit `Alternative` ist die sichere Wahl. Die
  Abweichungen in M1 sollten trotzdem verschwinden, weil „signifikant“
  offen ist.

### S13 · Ländercodes

BR-CL-14 verlangt ISO 3166-1, die EN-16931-Codeliste enthält aber zusätzlich
`XI` (Nordirland) und `1A` (Kosovo). Eine Prüfung gegen reines ISO 3166
lehnt also gültige Rechnungen ab, eine Prüfung nur auf zwei Großbuchstaben
(wie heute im Modul) lässt `UK` durch. Richtig ist die Codeliste der
Artefakte.

### S14 · Versionen und Übergänge

Norm, CIUS und ZUGFeRD laufen auseinander: XRechnung 3.0.2 bleibt mindestens
bis 31.07.2027, 4.0 setzt EN 16931-1:2026 um, die CEN-Artefakte für 2026
fehlen noch, ZUGFeRD veröffentlicht halbjährlich neue Codelisten. Die
Übergangsfristen für 4.0 legt die KoSIT erst mit dem finalen Release fest.
Für einen Hersteller heißt das: Validierung mit fester Artefakt-Version in
CI, Renderer mit Versionskennung, gespeicherte Bytes für Altfälle (H3).

### S15 · Archivierung: Original oder reproduzierbar?

Das BMF verlangt die Aufbewahrung im ursprünglichen Format. Ob ein
Aussteller sein Doppel aus den Daten bytegleich neu erzeugen darf, statt
die Datei zu speichern, ist nirgends geregelt. Bei einem Renderer, der sich
weiterentwickelt, ist das nicht beweisbar. Empfehlung: Bytes speichern (H3).

### S16 · Österreich

Österreich hat keine B2B-Pflicht. Für den Bund verlangt e-Rechnung.gv.at
ebInterface oder UBL, die Formatseite nennt CII, XRechnung und ZUGFeRD
nicht. Österreichische Pflichtangaben ohne Gegenstück in EN 16931, etwa die
UID des Empfängers bei Rechnungen über 10.000 € brutto (§ 11 Abs. 1 Z 3
lit. i UStG), müssen wie in Deutschland über Freitext oder vorhandene
Felder laufen. Mit ViDA kommt ab 01.07.2030 die Pflicht für
innergemeinschaftliche Umsätze. Für eine österreichische Installation ist
ein UBL- oder ebInterface-Renderer über demselben `EInvoiceModel` der
nächste Schritt.

## 6. Empfohlene Reihenfolge

1. **H3, Bytes speichern**, weil jeder spätere Fix die Ausgabe ändert.
2. **H1, Prüfung beim Festschreiben**, mit Zielformat je Kunde.
3. **H2, Vorprüfung vervollständigen** und gegen die Artefakte in CI testen.
   Die Fälle aus Anhang A als Regressionstests übernehmen.
4. **M2 und M1**, damit PDF und XML dasselbe sagen und der Versand ab 2027
   stimmt.
5. **M3, M6**, Rechnen und Daten.
6. **M4, M5, M8, M7**, Adressen, Leitweg-ID, Verkäufer-ID, Zeitraum.
7. **N1–N8** nach Bedarf, die Doku-Korrekturen (N8) zusammen mit den Fixes.
8. **XRechnung 4.0** einplanen, sobald das finale Bundle im Frühjahr 2027
   erscheint.

## 7. Quellen

Spezifikationen und Artefakte:

- KoSIT, [XRechnung – Versionen und Bundles](https://xeinkauf.de/xrechnung/versionen-und-bundles/) (3.0.2, Bugfix-Bundles, Vorversion 4.0 vom 15.09.2026)
- KoSIT, [XRechnung](https://xeinkauf.de/xrechnung/)
- Mustang-CLI 2.26.0, [Maven Central](https://repo1.maven.org/maven2/org/mustangproject/Mustang-CLI/2.26.0/) (darin EN-16931-Schematron 1.3.16, XRechnung-Schematron 2.4.0, ZUGFeRD-2.5-Artefakte, veraPDF 1.30.2)
- phive-rules-peppol 4.6.3, [Maven Central](https://repo1.maven.org/maven2/com/helger/phive/rules/phive-rules-peppol/4.6.3/) (OpenPeppol-Regeln 2026.5, darin PEPPOL-EN16931-R120)
- OpenPeppol, [PEPPOL-EN16931-R120](https://docs.peppol.eu/tdd/sk/tdd-sk/trn-tdd/businessrule/PEPPOL-EN16931-R120/)
- ZUGFeRD-Community, [FeRD veröffentlicht ZUGFeRD 2.4 / Factur-X 1.08](https://www.zugferd-community.net/en/blog/2025-12-05-ferd_veroeffentlicht_zugferd_2_4_factur-x_1_08)
- ZUGFeRD-Community, [ZUGFeRD 2.5 veröffentlicht](https://www.zugferd-community.net/en/blog/2026-06-11-zugferd_2_5_veroeffentlicht)
- FeRD, [Pressemeldung ZUGFeRD 2.5 / Factur-X 1.09](https://www.ferd-net.de/fileadmin/user_upload/FeRD/f%C3%BCr_FeRD-Meldungen/20260610_ZUGFeRD_2_5_Factur-X_1_09_Press_Release_DE.pdf)
- Mustang-Projekt, [What's new in ZUGFeRD 2.4](https://www.mustangproject.org/whats-new-in-zugferd-2-4-and-else/)
- VATupdate, [CEN approves EN 16931-1:2026](https://www.vatupdate.com/2026/04/02/cen-approves-en-16931-12026-updating-the-european-einvoicing-standard-for-vida/)
- iTeh Standards, [EN 16931-1:2026](https://standards.iteh.ai/catalog/standards/cen/c35d3391-5de8-4cd3-bc67-92368f6be54d/en-16931-1-2026)
- factora (Anbieter-Blog), [XRechnung 4.0: Vorabversion da, Release 2027](https://factora.software/blog/xrechnung-4-0-aenderungen/)
- e-Rechnung.gv.at, [Formate](https://www.erechnung.gv.at/erb?p=info_formate)

Verwaltungsauffassung und Recht (Sekundärquellen, das BMF selbst war nicht abrufbar):

- Haufe, [BMF-Schreiben v. 15.10.2025 zur E-Rechnung](https://www.haufe.de/finance/steuern-finanzen/bmf-schreiben-v-15102025-zur-e-rechnung_190_669628.html)
- taxpunk / Pelekies, [Formatfehler, Geschäftsregelfehler und Inhaltsfehler](https://www.taxpunk.de/magazin/artikel/54/bmf-schreiben-zur-e-rechnung-was-formatfehler-geschaeftsregelfehler-und-inhaltsfehler-wirklich-bed/)
- IHK Köln, [BMF-Schreiben zur E-Rechnung vom 15.10.2025](https://www.ihk.de/koeln/hauptnavigation/recht-steuern/steuern/bmf-schreiben-zur-e-rechnung-vom-15-10-2025-6774012)
- PwC Newsletter, [BMF zur E-Rechnung (2024)](https://newsletter.pwc.de/umsatzsteuer/nl0029-2024-10-29/bmf-e-rechnung)
- RSM Ebner Stolz, [Drittes BMF-Schreiben zur E-Rechnung](https://www.ebnerstolz.de/de/unser-angebot/leistungen/steuerberatung/umsatzsteuer/drittes-bmf-schreiben-e-rechnung-114492.html)
- Haufe, [BMF: Ergänzende Regelungen zur E-Rechnung](https://www.haufe.de/steuern/finanzverwaltung/bmf-ergaenzende-regelungen-zur-e-rechnung_164_700638.html)
- PwC, [BMF: Ergänzende Regelungen zur elektronischen Rechnung](https://blogs.pwc.de/en/steuern-und-recht/article/257354/bmf-ergaenzende-regelungen-zur-elektronischen-rechnung)
- drweb, [GoBD-Update: wenn der XML-Datensatz künftig reicht](https://www.drweb.de/gobd-update-wenn-der-xml-datensatz-kuenftig-reicht/)
- Haufe, [Viertes Bürokratieentlastungsgesetz](https://www.haufe.de/steuern/gesetzgebung-politik/viertes-buerokratieentlastungsgesetz_168_613390.html)
- Sonntag & Partner, [Begriff „Gutschrift“ (BMF 25.10.2013)](https://www.sonntag-partner.de/wp-content/uploads/2018/10/Sonderinformation_Begriff_Gutschrift_2013.pdf)

## Anhang A: Prüffälle

Verkäufer in allen Fällen, wenn nicht anders angegeben: Beispiel GmbH,
Hauptstraße 1, 80331 München, DE123456789, IBAN DE02120300000000202051,
Kontakt, Telefon und E-Mail gesetzt. Rechnungsdatum 2026-10-21. Validiert
mit Mustang-CLI 2.26.0 (`--action validate --no-notices`).

| Fall | Eingabe | Ergebnis im Modul | Mustang | Befund |
| --- | --- | --- | --- | --- |
| Golden | 11 Fälle aus `test/einvoice-cases.ts`, beide Profile, je ein ZUGFeRD-PDF | – | 33 × gültig | – |
| A | Kunde „Kundenweg 5 / Berlin“, ohne E-Mail und BT-10; festschreiben, dann Kunde korrigieren | vor und nach der Korrektur BT-52, BT-53, BT-49, BT-10 offen; XRechnung 422 | – | H1 |
| B | Verkäufer ohne USt-IdNr., Steuernummer 143/123/45678, HRB 12345 | XML mit `FC`; PDF-Fußzeile „VAT “ leer | gültig | M2 |
| C | Menge 0,33333 × 999,99 € (19 %), 1 × 50,00 € (0 %, `E`), langer Positionstext und Befreiungsgrund, Käuferadresse „Buchhaltung, Frau Meier“ | XML 0.3333 / 333.33, PDF 0.333; Texte im PDF gekürzt; `schemeID="EM"` mit Freitext | gültig, Warnung 446,66 € gegen 446,63 € | M1, M3, M4 |
| D | Kunde „Damrak 1 / 1012 LG Amsterdam / Netherlands“ | PLZ 1012, Ort „LG Amsterdam“ | gültig | N3 |
| D′ | Kunde mit USt-IdNr. `XI123456789` ohne Land | Land `XI` | gültig | S13 |
| E | Kundenname „Škoda Žalec Łódź s.r.o.“ | PDF „?koda ?alec ?ód? s.r.o.“ | PDF/A gültig | N4 |
| F | Leitweg-ID `04011000-1234512345-99` (richtig: `-06`) | ausgeliefert | gültig | M5 |
| G | Storno von C | 381 mit BG-3 | gültig, Warnung wie C | – |
| H | IBAN `AT00 0000 0000 0000 0000`, BIC `EXAMPLEX` (Vorgabe aus `config.ts`) | ausgeliefert | gültig, Warnung BR-DE-19 | N2 |
| I | 60 Positionen, mehrseitig, Sonderzeichen „ “ – | ausgeliefert | XML und PDF/A gültig | – |
| J | USt-IdNr. des Käufers `123456789` | ausgeliefert | **ungültig**, BR-CO-09 | H2 |
| K | Ländercode des Käufers `UK`, Ausfuhr | ausgeliefert | **ungültig**, BR-CL-14 | H2 |
| L | 0,29 × 0,50 € und 1,005 × 1,00 € | Zeilen 0,14 € und 1,00 € (richtig 0,15 € und 1,01 €) | gültig, Warnung 1,36 € gegen 1,38 € | M3 |
| M | Einstellungen: Telefon „n/a“, E-Rechnungsadresse „Rechnungseingang Buchhaltung“ | angenommen, `EM` mit Freitext | gültig, Warnung BR-DE-27 | M4, N2 |
| O | Leistungsdatum 2026-02-30, Rechnungsdatum 2026-02-31 | ausgeliefert, Fälligkeit 2026-03-17 | gültig | M6, S2 |
| P | Ausfuhr (`G`), Verkäufer nur mit Steuernummer und HRB | `eInvoiceProblems`: keine | **ungültig**, BR-G-02 | H2, S5 |
| Q | nur `E`-Positionen, Verkäufer nur mit HRB | `eInvoiceProblems`: keine | **ungültig**, BR-E-02, BR-DE-16 | H2 |

Stand nach den Fixes vom 22. und 23.10.2026: A wird schon beim
Festschreiben abgelehnt, wenn der Kunde XRechnung erhält (H1). B nennt
Steuernummer und HRB in der Fußzeile (M2). C zeigt die Texte vollständig und
0,3333, rechnet 446,63 € ohne Warnung (M1, M3) und lehnt die Freitextadresse
ab (M4); G folgt C. E zeigt „Škoda Žalec Lódz s.r.o.“ (N4). F, J, K, O, P
und Q werden mit dem jeweiligen Business Term abgelehnt (M5, H2, M6). L
ergibt 0,15 € und 1,01 € (M3). H wird als Rechnung in jedem Format
abgelehnt, bei Kunden mit Zielformat schon beim Festschreiben; der Storno
bleibt möglich (N2). M wird beim Speichern abgelehnt, Adresse wie Telefon
(M4, N2). D ergibt PLZ „1012 LG“ und Ort „Amsterdam“ (N3). D′ und I gelten
unverändert.
