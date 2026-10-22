# Odoo-Vergleich: Lücken, Erweiterungen, neue Module

*Abgleich der Odoo-Editions-Matrix (https://www.odoo.com/page/editions,
Community vs. Enterprise) mit den 16 Modulen und 12 Platform Services dieses
Repos. Stand: Oktober 2026.*

## Kurzfassung

- **0815software ist kein ERP, sondern ein Baukasten aus Fachanwendungen.**
  Odoo hat ~45 Apps auf *einer* Datenbank und *einem* ORM. 0815 hat 16 Module
  mit je eigener SQLite-Datei, die über Platform Services und
  Peer-Verträge (`OFFERS_URL`, `report_*`-Views, Shell-Contract) verbunden
  sind. Das ist ein bewusster Unterschied, kein Mangel, prägt aber jede
  Lückenbewertung: Was in Odoo „ein Feld mehr“ ist, ist hier oft ein
  Vertrag zwischen zwei Paketen.
- **Die größte Lücke ist kein Feature, sondern Mehrbenutzerfähigkeit.**
  Fast jedes Modul hat „one staff admin by design“. PS-01 Identity existiert,
  wird aber nur als SSO-Einstieg genutzt, nicht für Rollen pro Modul. Jedes
  Odoo-Feature, das man übernimmt, setzt mehrere Nutzer voraus.
- **Fachlich fehlt vor allem die Mitte der Wertschöpfungskette:**
  Auftrag/Lieferschein zwischen Angebot (MOD-13) und Rechnung (MOD-04),
  wiederkehrende Rechnungen, Mahnwesen, E-Rechnung und ein Buchhaltungsexport
  (BMD/DATEV).
- **Sinnvollste neue Module:** Projekte & Aufgaben, Abwesenheiten,
  Terminbuchung, Spesen, Formulare/Umfragen, Wissensdatenbank. Nicht bauen:
  Finanzbuchhaltung, Lohnverrechnung, Kasse (RKSV), MRP, Website-Builder,
  VoIP, IoT, Social Marketing.
- **„Open Source + AI“ trägt — für dieses Repo sogar besser als für Odoo**,
  aber aus einem anderen Grund als Odoo behauptet (siehe letzter Abschnitt).

## 1. Abgleich Kategorie für Kategorie

Legende: ✅ vorhanden · 🟡 teilweise · ❌ fehlt · ⛔ bewusst nicht bauen.
„E“ = in Odoo nur Enterprise.

### Finance

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Invoicing | ✅ MOD-04 (Positionen, USt je Zeile, PDF, Debitorenkonto) | Kern solide, Lücken unten |
| Payments | ✅ PS-08 (Mock + Stripe), MOD-07 Checkout | ok |
| Bankabgleich (E) | ✅ PS-12 EBICS, camt.053 → Zuordnung zu offenen Rechnungen | **stärker als Odoo Community**, real-bank-ungetestet |
| SEPA-Zahlungen | ✅ MOD-04 pain.001, Finanzamtszahlung, EACT | DACH-Vorsprung |
| Hauptbuch, Analytik, Budgets, Konsolidierung (E) | ❌ | ⛔ Volle FiBu nicht bauen — Steuerberater nutzt BMD/DATEV. Stattdessen **Export** (siehe 2.) |
| Vendor-Bill-OCR (E) | ❌ (PS-04 hat kein OCR/Extraktion) | 🔜 als PS-04-Fähigkeit, dann in MOD-04 Bills |
| Expenses (E: OCR) | ❌ | 🔜 **neues Modul** (siehe 3.) |
| Documents (E) | 🟡 MOD-09 (Matters, Versionen) | Vorschau, Volltextsuche via PS-09, Freigabelinks fehlen |
| Spreadsheet/BI (E) | 🟡 MOD-08 (SQL-Reports, Pivot, SVG-Charts) | ⛔ kein Spreadsheet nachbauen; XLSX-Export ergänzen |
| Sign (E) | 🟡 MOD-13 Annahme per signiertem Link | 🔜 einfache E-Signatur als Platform Service; qualifiziert (ID Austria) über PS-05 |
| ESG (E) | ❌ | ⛔ |

### Sales

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| CRM | ✅ MOD-10 (Pipeline, Aktivitäten, Übergabe an MOD-13) | Mehrbenutzer, Web-Lead-Formular, CSV-Import fehlen; Philosophie „no AI“ ist ein Verkaufsargument, beibehalten |
| Sales (Angebot → Auftrag) | 🟡 MOD-13 Angebote → MOD-04 Rechnung | ❌ **Auftrag/Lieferschein fehlt** — größte fachliche Lücke im Kernprozess |
| Point of Sale | ❌ | ⛔ in AT RKSV-pflichtig (Signatureinheit, DEP, FinanzOnline) — Haftungsrisiko ohne Lizenzertrag |
| Subscriptions (E) | ❌ | 🔜 als **Erweiterung von MOD-04** (wiederkehrende Rechnungen), nicht als Modul |
| Rental (E) | ❌ | ⛔ Nische; über Terminbuchung + MOD-03 abbildbar |
| Amazon-Connector (E) | ❌ | ⛔ PS-05 ist der Haken, Auftragsarbeit |

### Websites

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Website Builder, Blog, Forum | ❌ (Marketing-Site ist Astro) | ⛔ Astro/Headless-CMS sind besser; Kunden-Website ist Auftragsarbeit |
| eCommerce | ✅ MOD-07 | Varianten, Gutscheine, Versandregeln, MOD-03-Bestandskopplung prüfen |
| Live Chat | ❌ | 🟡 optional als Intake-Kanal von MOD-12 |
| eLearning | ❌ | ⛔ (Moodle/ILIAS existieren, Open Source) |

### Supply Chain

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Inventory | ✅ MOD-03 (Ledger, Lager, PO-Wareneingang, Inventur) | Lagerplätze, Reservierungen/Kommissionierung, Bewertung (gleitender Ø) fehlen |
| Barcode (E) | ❌ | 🔜 in MOD-03: Kamera-Scan im Browser (BarcodeDetector), Etikettendruck — hoher Nutzen, kleiner Aufwand |
| Purchase | ✅ MOD-06 (RFQ, PO, Freigabestufen, ERP-CSV) | 3-Way-Match mit MOD-03/MOD-04, Lieferanten-Mail via PS-03 |
| Manufacturing/MRP, PLM, Quality (E) | ❌ | ⛔ eigener Markt; höchstens ein schlankes Stücklisten-/Fertigungsauftragsmodul auf Anfrage |
| Maintenance | ❌ | 🟡 **neues kleines Modul „Anlagen & Wartung“** (Geräte, Intervalle, Prüfprotokolle) — passt zum Ethos (Fälligkeit abgeleitet, nie gespeichert) |

### Human Resources

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Employees | ✅ MOD-05 (Verzeichnis, Org-Baum, Onboarding-Liste) | Mitarbeiter-Self-Service fehlt |
| Time Off | ❌ | 🔜 **neues Modul** — höchste HR-Priorität |
| Recruitment | ❌ | 🟡 neues Modul, mittlere Priorität (DSGVO-Löschfristen für Bewerbungen sind der Kern) |
| Appraisals, Referrals (E) | ❌ | ⛔ |
| Fleet | ❌ | 🟡 im Modul „Anlagen & Wartung“ mit abdecken (Fahrzeug = Anlage) |
| Payroll (E) | ❌ | ⛔ niemals — Lohnverrechnung AT/DE ist Haftung; MOD-11 exportiert bereits |

### Marketing

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Email Marketing | ❌ (PS-03 kann zustellen) | 🟡 neues Modul „Newsletter“ mit Double-Opt-in und Abmeldelink — rechtlich der eigentliche Wert |
| SMS Marketing | ❌ (PS-03 kann SMS) | Teil des Newsletter-Moduls |
| Marketing Automation (E) | ❌ (PS-02 kann Abläufe) | ⛔ als Modul; PS-02-Vorlagen reichen |
| Events | ❌ | 🟡 über Terminbuchung + Formulare abdecken |
| Surveys | ❌ | 🔜 **neues Modul „Formulare & Umfragen“** — dient auch CSAT in MOD-12, Lead-Formular für MOD-10, Antrag für MOD-14 |
| Social Marketing (E) | ❌ | ⛔ |

### Services

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Project | ❌ (MOD-11 hat Projekte nur als Buchungsziel) | 🔜 **neues Modul „Projekte & Aufgaben“** — die fehlende Klammer zwischen MOD-13, MOD-11 und MOD-04 |
| Timesheet (Timer, Erinnerung, Freigabe) | 🟡 MOD-11 (Tageserfassung, Wochenfreigabe) | Timer, Mitarbeiter-Login „meine Zeiten“ ergänzen |
| Helpdesk (E) | ✅ MOD-12 | Anhänge (PS-06), Textbausteine, Geschäftszeiten-SLA, CSAT, IMAP-Brücke |
| Planning (E) | ❌ | 🟡 in „Projekte & Aufgaben“ als Ressourcenansicht, nicht separat |
| Appointments (E) | ❌ | 🔜 **neues Modul „Terminbuchung“** — für KMU (Arzt, Handwerk, Beratung) einer der greifbarsten Nutzen |
| Field Service (E) | ❌ | 🟡 später: Projekte + Terminbuchung + Mobile-Ansicht |

### Productivity

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Discuss | ❌ | ⛔ Matrix/Mattermost; PS-03 hat Slack/Teams |
| Approvals (E) | 🟡 MOD-06 (Freigabestufen), PS-02 | 🟡 generische Freigaben als Workspace-Aktion (MOD-15) auf PS-02 statt eigenem Modul |
| To-Do | ❌ | in „Projekte & Aufgaben“ |
| Calendar | ❌ | 🟡 CalDAV/iCal-Feeds aus Terminbuchung, Abwesenheiten, MOD-14-Fristen |
| VoIP, IoT (E) | ❌ | ⛔ |
| Knowledge (E) | ❌ | 🟡 **neues Modul „Wissen“** (Markdown-Wiki, Versionen, PS-09-Suche, PS-04-RAG) — liefert auch die Wissensdatenbank für MOD-12 |

### Customization / Plattform

| Odoo | 0815 heute | Bewertung |
| --- | --- | --- |
| Studio (E) | 🟡 MOD-02 (config-getriebenes CRUD) | Benutzerdefinierte Felder fehlen in allen Fachmodulen — als **Konvention** (`custom_fields`-JSON + Schema in Config) einführen |
| Mobile Apps (E) | ❌ | 🟡 PWA-Manifest + responsive Views reichen; keine nativen Apps |
| Versions-Upgrades (E) | ✅ strukturell: kein Upgrade-Zwang, MIT | Vorteil — aber Forks driften; Migrationsskripte pro Modul fehlen |
| Hosting / Odoo.sh | ✅ `deploy/` (Compose, Caddy, provision, smoke, backup) | gut; Staging-Branches à la Odoo.sh fehlen |

## 2. Erweiterungen bestehender Module (priorisiert)

Reihenfolge nach Nutzen ÷ Aufwand. Alles bleibt opt-in, wie im Repo üblich.

1. **Mehrbenutzer & Rollen über PS-01 in allen Fachmodulen.** Voraussetzung
   für fast alles darunter. Vorschlag: einheitliches Rollenmodell
   (`viewer/editor/admin` pro Modul) als Claim aus PS-01, lokaler
   Single-Admin bleibt der Standalone-Modus. Ein gemeinsames Paket statt
   16 Einzelumsetzungen.
2. ✅ **MOD-04: E-Rechnung.** XRechnung/ZUGFeRD (DE, PR #37) und
   ebInterface 6.1 (AT, Bund), jeweils gegen das offizielle Schema geprüft
   (`docs/E-RECHNUNG.md`). Offen: UBL/PEPPOL-Versand, Eingangsrechnungen lesen.
3. **MOD-04: Wiederkehrende Rechnungen** (= Odoo Subscriptions light),
   **Teilgutschriften** als eigener Belegtyp (die Storno-Gutschrift gibt es
   seit PR #37), **Mahnstufen** über PS-02 + PS-03.
4. ✅ **MOD-04: Buchhaltungsexport** BMD (AT) und DATEV-Buchungsstapel (DE)
   (PR #37). Offen: Belegverknüpfung zu PS-06.
5. **Neue Belegart „Auftrag/Lieferschein“** — entweder in MOD-13 (Angebot →
   Auftragsbestätigung) oder als kleines eigenes Modul zwischen MOD-13,
   MOD-03 (Reservierung, Warenausgang) und MOD-04 (Teil-/Schlussrechnung).
6. **MOD-03: Barcode, Lagerplätze, Reservierungen, Bewertung.**
7. **MOD-11: Timer + Mitarbeiter-Self-Service.**
8. **MOD-12: Anhänge (PS-06), Textbausteine, Geschäftszeiten, CSAT,
   IMAP-Brücke über PS-05.**
9. **MOD-06: 3-Way-Match** Bestellung ↔ Wareneingang (MOD-03) ↔
   Eingangsrechnung (MOD-04 Bills).
10. **PS-04: Dokumentextraktion** (Rechnung/Beleg → strukturierte Felder),
    mit Mock-Provider wie die übrigen Fähigkeiten. Konsumenten: MOD-04 Bills,
    Spesen, MOD-09.
11. **MOD-08: XLSX-Export, Parameter, weitere Charttypen.**
12. **MOD-09: Vorschau, Volltext via PS-09, Freigabelinks, Löschfristen.**

## 3. Neue Module (Vorschlag)

| # | Modul | Odoo-Pendant | Warum | Grobe Größe | Platform Services |
| --- | --- | --- | --- | --- | --- |
| MOD-17 | **Projekte & Aufgaben** | Project, To-Do, Planning | Klammer Angebot → Arbeit → Zeit → Rechnung; Kanban + Meilensteine + Ressourcenblick | 4–5 Wo | 01, 02, 03, 07 |
| MOD-18 | **Abwesenheiten** | Time Off | Jedes KMU braucht es; Resturlaub abgeleitet aus Anspruch − Buchungen (Ledger-Idiom wie MOD-03); Feiertage AT/DE | 2–3 Wo | 01, 02, 03 |
| MOD-19 | **Terminbuchung** | Appointments | Öffentliche Buchungsseite, Ressourcen, iCal; kein Doppelbuchen als bewiesene Invariante | 3–4 Wo | 03, 08 (Anzahlung) |
| MOD-20 | **Spesen & Reisekosten** | Expenses | Belegfoto → PS-04-Extraktion → Freigabe → Export/Auszahlung via MOD-04 SEPA; AT-Taggeld/Kilometergeld als Konfig | 3–4 Wo | 04, 06, 07, 12 |
| MOD-21 | **Formulare & Umfragen** | Surveys, Web-Lead-Formulare | Ein Baustein, viele Konsumenten (MOD-10, MOD-12, MOD-14) | 2–3 Wo | 03, 02 |
| MOD-22 | **Wissen** | Knowledge | Wiki + KB für MOD-12, RAG über PS-04 — und ein ehrlicher, abschaltbarer KI-Einsatz | 2–3 Wo | 04, 06, 09 |
| später | Anlagen & Wartung (inkl. Fuhrpark) | Maintenance, Fleet | Prüffristen abgeleitet, Prüfprotokolle | 2–3 Wo | 02, 03, 06 |
| später | Newsletter | Email/SMS Marketing | Double-Opt-in-Nachweis als Kern | 2–3 Wo | 03 |
| später | Recruiting | Recruitment | Löschfristen als Kern | 3 Wo | 06, 03 |

Neuer Platform Service, falls MOD-13/MOD-20/HR ihn brauchen: **Signatur**
(einfache elektronische Signatur mit Hash-Kette über PS-07; qualifizierte
Signatur per ID Austria/Handy-Signatur als Adapter).

**Bewusst nicht bauen:** Finanzbuchhaltung, Lohnverrechnung, Kasse/RKSV,
MRP/PLM/Qualität, Website-Builder/Blog/Forum, eLearning, Discuss, VoIP, IoT,
Social Marketing, ESG, Spreadsheet. Entweder regulatorische Haftung ohne
Lizenzertrag, oder es gibt etablierte Open-Source-Lösungen, die man über
PS-05 anbindet statt nachbaut.

## 4. „Open Source + AI = ❤️“ — realistisch und sinnvoll?

### Was Odoo behauptet

„Nutze Odoo.sh, um maßgeschneiderte Module zu entwickeln oder zu
vibe-coden. Weil wir Open Source sind, sind LLMs schon auf unserem
Quellcode trainiert.“

### Was daran stimmt

- LLMs kennen das Odoo-ORM, `models.Model`, XML-Views und Manifeste gut —
  es gibt 15+ Jahre öffentlichen Code und tausende OCA-Module.
- Für **kleine Anpassungen** (ein Feld, ein Bericht, eine Automatik) ist
  Vibe-Coding in Odoo tatsächlich schnell.

### Wo es hinkt

- **Trainingsdaten sind ein Durchschnitt über Versionen.** Odoo bricht APIs
  jährlich (z. B. `attrs`→direkte Ausdrücke in 17, `tree`→`list` in 18).
  Modelle mischen Versionen; generierter Code läuft oft nicht auf der
  aktuellen.
- **Enterprise ist nicht Open Source.** Studio, Accounting-Erweiterungen,
  Helpdesk, Sign usw. stehen unter der proprietären Enterprise-Lizenz; genau
  dort liegen die Module, die man anpassen will. Das Marketing vermischt die
  Community-Codebasis mit dem Produkt, das verkauft wird.
- **Jedes vibe-gecodete Modul ist Upgrade-Schuld.** Odoos Geschäftsmodell
  lebt von jährlichen Versionen; ein Custom-Modul muss jedes Mal mitmigriert
  werden. Billig gebaut heißt nicht billig betrieben.
- **Odoo.sh ist ein kostenpflichtiges Hosting-Produkt.** Der Satz ist
  primär ein Vertriebsargument für Odoo.sh.

### Was das für 0815software heißt

Für dieses Repo gilt das Argument **in abgewandelter Form stärker als für
Odoo** — nicht weil LLMs den Code kennen (sie kennen ihn nicht), sondern
weil agentische Coding-Tools den Code zur Laufzeit lesen und das Repo dafür
ungewöhnlich gut gebaut ist:

- **Kleine, abgeschlossene Pakete** (3–17 kLOC pro Modul) passen in ein
  Kontextfenster — Odoo-Core mit Abhängigkeiten nicht.
- **Explizite Invarianten mit Tests** („Summen abgeleitet, nie gespeichert“,
  „Org-Baum azyklisch“, „Zahlungsdatei höchstens einmal“) sind genau das
  Geländer, das KI-generierten Code von plausibel-falsch zu prüfbar-richtig
  macht.
- **Maschinenlesbare Verträge** (`registry.json` mit Drift-Test,
  Shell-Contract, Reporting-Contract, `openapi.yaml`) erlauben einem Agenten,
  ein neues Modul zu erzeugen, das der Build selbst auf Konformität prüft.
- **Das Repo selbst ist der Beweis**: ~170 kLOC TypeScript mit ~270
  Testdateien in rund sechs Monaten — das ist ohne starke KI-Unterstützung
  für ein kleines Team kaum erreichbar.

**Urteil:** realistisch und sinnvoll — als **Lieferbeschleuniger für
standardisierte Module**, nicht als „Kunde vibe-coded sein ERP selbst“.

Wo es scheitert, ist dasselbe wie bei Odoo: **Domänenrecht** (E-Rechnung,
RKSV, Lohn, Steuer, EBICS gegen echte Banken). KI schreibt dort sehr
überzeugenden falschen Code. Gegenmittel: offizielle Schemas und
Prüfvektoren in den Tests (wie bei pain.001/PS-12 schon praktiziert) und ein
Mensch, der haftet — das ist ohnehin das Geschäftsmodell.

### Konkrete Schritte, um das Argument einzulösen

1. ✅ **`CLAUDE.md` im Root** (umgesetzt): Architekturregeln,
   Modul-Idiom, „Adding a module“, Testbefehle, die Invarianten-Philosophie.
2. ✅ **Modul-Vorlage/Generator** (`scripts/new-module.mjs`, umgesetzt): Paketgerüst mit
   Auth, `summary.ts`, `platform.ts`, Shell-Contract, Registry-Eintrag und
   Copy-Block — damit KI-Erzeugtes vom ersten Commit an konform ist.
3. **Eine Spezifikation pro Modul vor dem Code** (Invarianten, Out-of-scope,
   Datenmodell — die README-Struktur gibt es schon), als Prompt-Vorlage.
4. ✅ **Mehrbenutzer-Fundament zuerst** (Abschnitt 2, Punkt 1; umgesetzt,
   `docs/ACCESS-LEVELS.md`) — sonst vervielfältigt KI das Single-Admin-Muster
   in jedes neue Modul. Inzwischen auch umgesetzt: Stufen pro Zielmodul in den
   Shells (MOD-15/16), Oberflächen blenden nach Stufe aus, „nur eigene Zeiten“
   in MOD-11, Typcheck in der CI.
5. **Positionierung:** nicht „Odoo-Klon“, sondern „die DACH-Pflichtteile, die
   Odoo Community fehlen (EBICS, SEPA, E-Rechnung, Finanzamtszahlung),
   MIT-lizenziert, ohne Upgrade-Zwang, mit beweisbaren Invarianten“.
   Gegen Odoos 45 Apps gewinnt man nicht über die Breite.
