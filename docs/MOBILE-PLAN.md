# Jedes Modul mobil und am Desktop — Plan

Ziel: **Jedes der 17 Module ist am Handy genauso verwendbar wie am Desktop**, und
zwar auch von außerhalb der Firma. „Verwendbar“ heißt: alle Aufgaben des Moduls
lassen sich am Handy erledigen, nicht nur ansehen. Eine abgespeckte
„Mobile-Ansicht“ mit weniger Funktionen ist ausdrücklich **nicht** das Ziel.
Native Apps sind es auch nicht: Die Module bleiben Web-Apps (PWA), eine
Codebasis für beide Bildschirme.

Status: **umgesetzt.** Alle Phasen dieses Plans sind gebaut; was davon
abweicht oder offen bleibt, steht in Abschnitt 8. Benachrichtigungen und
App-Badge: [`NOTIFICATIONS-PLAN.md`](./NOTIFICATIONS-PLAN.md) (ebenfalls
umgesetzt).

## 1. Was „mobil verwendbar“ prüfbar heißt

Ein Modul gilt als fertig, wenn **jede Hauptansicht** (jeder Eintrag in seiner
Navigation, jeder Dialog, jeder Editor) diese Punkte erfüllt. Sie werden
automatisch geprüft (Abschnitt 5), nicht per Augenmaß:

| # | Kriterium | Gemessen bei |
| --- | --- | --- |
| M1 | Kein waagrechtes Scrollen der Seite (`scrollWidth ≤ innerWidth`). Breite Inhalte scrollen höchstens in ihrem eigenen Kasten. | 360 × 740 und 390 × 844 |
| M2 | Jedes Bedienelement ist mindestens 44 × 44 px groß (Apple HIG / WCAG 2.5.8 empfiehlt ≥ 24 px, 44 px ist der Praxiswert für Daumen). | 390 × 844 |
| M3 | Eingabefelder haben mindestens 16 px Schrift — sonst zoomt iOS beim Antippen hinein und nicht wieder heraus. | alle |
| M4 | Tabellen werden unter 700 px zu Karten (eine Zeile ⇒ eine Karte mit Beschriftung je Wert), außer ein Raster ist der Inhalt selbst (Positionen einer Rechnung, Wochen-Stundenzettel). Dann scrollt das Raster in sich, mit fixierter erster Spalte. | 390 × 844 |
| M5 | Die Hauptaktion einer Ansicht („Speichern“, „Freigeben“, „Senden“) ist ohne Scrollen erreichbar (fixierte Aktionsleiste unten). | 390 × 844 |
| M6 | Formulare sind einspaltig. Passende Tastaturen über `inputmode`/`type` (Zahl, E-Mail, Telefon, Datum), passendes `autocomplete`. | alle |
| M7 | Die Navigation ist unten oder als Menü erreichbar, nicht als umbrechende Reiter-Wolke über dem Inhalt. | 390 × 844 |
| M8 | Funktioniert im Rahmen von MOD-16 Mosaik und MOD-15 Workspace (Vollbild-Pane, untere Leiste der Shell) und berücksichtigt `safe-area-inset-*` (Notch, Home-Balken). | 390 × 844 in Mosaik |
| M9 | Desktop bleibt unverändert gut: keine Regression bei 1280 × 800 (Screenshot-Vergleich). | 1280 × 800 |
| M10 | Bedienbar ohne Hover: nichts ist nur per Maus-Hover sichtbar (Aktionen in Tabellenzeilen, Tooltips mit Pflichtinformation). | Touch-Emulation |

## 2. Ist-Stand

Was schon da ist und trägt:

- Alle Module laufen im Browser über HTTPS auf eigenen Subdomains
  (`deploy/provision.mjs`, Caddy). Damit sind sie von unterwegs erreichbar,
  sobald der Server aus dem Internet erreichbar ist.
- Alle Module haben `<meta name="viewport">`.
- MOD-15 Workspace, MOD-16 Mosaik und MOD-11 sind installierbare PWAs
  (`docs/SHELL-CONTRACT.md` §5). In Mosaik läuft am Handy jedes Modul im
  Vollbild, mit einer Leiste zum Wechseln. Damit ist **jedes Modul heute schon
  erreichbar**, das Problem ist die Bedienung innerhalb des Moduls.
- Abmelden in der Shell meldet in allen Modulen ab und leert den Speicher des
  Geräts (`/session/logout`, `Clear-Site-Data`).
- **Neu: Zwei-Faktor-Anmeldung** (PS-01, siehe Phase 0a).

Was fehlt — gezählt im Code (`<table>` in `src/`, `@media`-Umbrüche ohne `print`):

| Modul | Tabellen | Umbrüche | Einschätzung |
| --- | ---: | --- | --- |
| MOD-01 Kundenportal | 3 | 900 px | klein, kundenseitig, früh machen |
| MOD-02 Admin-Dashboard | 1 | 900 px | klein |
| MOD-03 Lager | 5 | 900 px | mittel; Barcode-Scan per Kamera ist der Gewinn |
| MOD-04 Rechnungen | 17 | 900 px | **groß**: Rechnungseditor, Zahlungsläufe, Mahnwesen |
| MOD-05 Mitarbeiterverzeichnis | 7 | 900 px | mittel; Telefon/Mail als Links |
| MOD-06 Beschaffung | 8 | 900 px | mittel; Freigaben unterwegs |
| MOD-07 Storefront | 6 | 900 px | kundenseitig, Kaufabschluss muss am Handy perfekt sein |
| MOD-08 Berichte | 5 | 900 px | mittel; Diagramme responsiv |
| MOD-09 Dokumente | 9 | 900 px | mittel; Upload per Kamera |
| MOD-10 CRM | 5 | 900 px | mittel; Außendienst, hoher Nutzen |
| MOD-11 Zeiterfassung | 22 | 600 + 900 px | **am weitesten** (PWA, offline, QR); Rest-Ansichten nachziehen |
| MOD-12 Tickets | 7 | 900 px | mittel; Bereitschaft, hoher Nutzen |
| MOD-13 Angebote | 5 | 900 px | mittel; Positionseditor |
| MOD-14 Förderungen | 5 | 900 px | mittel |
| MOD-15 Workspace | 0 | 700 + 900 px | fertig (Kacheln untereinander) |
| MOD-16 Mosaik | 0 | 700 + 900 px | fertig (ein Modul im Vollbild) |
| MOD-17 Aufträge & Lieferscheine | 4 | 900 px | mittel; Zustellung mit Unterschrift/Foto vor Ort |

Der eine Umbruch bei 900 px stapelt die Seitenleiste über den Inhalt und stellt
Formulare einspaltig. Breite Tabellen, Positionsraster, Aktionsknöpfe in
Tabellenzeilen und fixe Rasterbreiten (z. B. `.inv-line` in MOD-04) bleiben so
breit wie am Desktop. Am Handy heißt das: Die ganze Seite scrollt waagrecht.

## 3. Gemeinsame Bausteine (einmal bauen, überall einsetzen)

Die 17 Module sehen gleich aus und teilen Copy-in-Dateien. Deshalb wird das
Mobile-Verhalten **einmal** gebaut und als Copy-in verteilt, nicht 17-mal von
Hand:

1. **`src/mobile.css` (neues Copy-in).** Eine Schicht über `styles.css`:
   - `@media (max-width: 700px)`: Seitenleiste ⇒ untere Navigationsleiste mit
     den 4 wichtigsten Einträgen + „Mehr“-Menü (M7); `env(safe-area-inset-*)` (M8).
   - Tabellen mit `class="table--cards"` werden zu Karten: Jede Zelle trägt
     `data-label="…"`, die Kopfzeile wird ausgeblendet, das Label steht vor
     dem Wert (M4). Rein CSS, kein JavaScript.
   - `.table--grid` für Raster, die Raster bleiben müssen: Scrollen im Kasten
     mit `position: sticky` auf der ersten Spalte (M4).
   - `.actionbar`: fixierte Leiste unten für die Hauptaktion (M5).
   - Mindestgrößen für Knöpfe und Felder, 16 px in Eingabefeldern (M2, M3).
   - Dialoge (`.modal`) werden unter 700 px zu Vollbild-Blättern mit eigener
     Scrollfläche, statt über den Rand zu ragen.
2. **`src/components/ResponsiveTable.tsx` (neues Copy-in).** Ein
   Tabellenbaustein, der die `data-label` aus der Spaltendefinition setzt, damit
   kein Modul sie vergisst. Zeilenaktionen kommen in ein „⋯“-Menü statt auf
   Hover (M10).
3. **`src/components/NavBar.tsx`**, die untere Leiste aus (1). Die Module
   geben nur ihre Einträge und deren Reihenfolge an.
4. **Kamera und Gerät:** `<input type="file" accept="image/*" capture="environment">`
   für Belege und Fotos (MOD-09, MOD-17, MOD-04 Eingangsrechnungen) sowie
   `tel:`/`mailto:`/Karten-Links (MOD-05, MOD-10, MOD-17). Barcode und QR-Code
   gibt es schon (MOD-11 `src/scan/qr.ts`); das wird ein Copy-in für MOD-03 und
   MOD-17.
5. **Installierbarkeit für alle.** Die PWA-Copy-ins (`src/pwa/sw.js`,
   `register.ts`, `scripts/pwa-plugin.mjs`) werden auf jedes Modul ausgerollt
   (`installable: true` in `modules/registry.json`). Offline bleibt die
   Ausnahme: Der Service Worker hält nur die App, nie `/api`-Antworten.
   Offline erfassen dürfen nur Module, die das ausdrücklich bauen, wie MOD-11.

Die Drift-Wache kennt Copy-ins schon (`deploy/test/new-module.test.ts`). Die
neuen Dateien kommen in `COPY_IN` von `scripts/new-module.mjs`, damit auch
künftige Module mobil starten.

## 4. Reihenfolge

Die Reihenfolge richtet sich danach, wer das Handy unterwegs am meisten braucht.
Jede Phase endet mit grünen Mobile-Tests (Abschnitt 5) für ihre Module.

### Phase 0 — Grundlagen (Voraussetzung für alles)

- **0a Zwei-Faktor-Anmeldung — umgesetzt.** TOTP (RFC 6238) in PS-01, gegen
  die RFC-Referenzvektoren getestet, mit Wiederherstellungscodes, Schutz gegen
  Wiederverwendung, Drosselung, Zurücksetzen durch Admins. Jedes Modul mit
  PS-01-Anmeldung (`server/sso.ts`) reicht den Code durch und zeigt das
  Code-Feld im Login. Details: `platform/ps-01-identity/README.md`.
- **0b Zwei-Faktor einrichten können.** Bisher gibt es dafür nur die API. Es
  fehlt die Seite „Mein Konto → Zwei-Faktor“ (QR-Code, erster Code,
  Wiederherstellungscodes anzeigen und ausdrucken). Ort: MOD-15 und MOD-16,
  weil man dort ohnehin angemeldet ist. Der QR-Code wird im Browser erzeugt
  (kleiner QR-Encoder als Copy-in; den Decoder hat MOD-11 schon), nie auf
  einem fremden Dienst.
- **0c Zwei-Faktor-Pflicht je Organisation.** Eine Einstellung in PS-01: „Wer
  von außen anmeldet, braucht einen zweiten Faktor.“ Dazu gehört ein
  Einrichtungsschritt im Login für Personen ohne Faktor. Bis dahin sieht die
  Verwaltung in der Benutzerliste (`mfa_enabled`), wer noch fehlt.
- **0d Gemeinsame Bausteine** aus Abschnitt 3 sowie das Test-Gerüst aus
  Abschnitt 5.

### Phase 1 — Wer unterwegs arbeitet

MOD-12 Tickets, MOD-10 CRM, MOD-17 Aufträge & Lieferscheine, MOD-11
(Restansichten), MOD-05 Verzeichnis, MOD-03 Lager. Außendienst, Bereitschaft,
Zustellung, Lager: Hier entsteht der größte Nutzen.

### Phase 2 — Wer unterwegs entscheidet

MOD-06 Beschaffung, MOD-04 Rechnungen, MOD-13 Angebote, MOD-09 Dokumente.
Freigaben, Rechnungen, Angebote. MOD-04 ist das größte Stück: Der
Rechnungseditor bekommt am Handy einen Positionsdialog (eine Position nach der
anderen) statt des 6-spaltigen Rasters. Zahlungsläufe und SEPA-Export müssen
genauso vollständig bedienbar sein wie am Desktop.

### Phase 3 — Der Rest

MOD-08 Berichte (Diagramme skalieren, Tabellen ⇒ Karten), MOD-14
Förderungen, MOD-02 Admin, MOD-01 Kundenportal und MOD-07 Storefront.
MOD-01 und MOD-07 sind kundenseitig. Sie können vorgezogen werden, wenn
Kundinnen und Kunden sie heute schon am Handy benutzen.

## 5. Wie es geprüft wird

Rechtzeitig, nicht erst am Ende: Das Gerüst kommt in Phase 0d, jedes Modul
schaltet seine Prüfung ein, sobald es umgebaut ist. Ab dann kann es nicht
zurückfallen.

- **`deploy/test/mobile.e2e.ts`** (Playwright; Chromium ist in CI und in der
  Entwicklungsumgebung vorhanden): baut das Frontend eines Moduls, startet
  dessen Server mit Demodaten, meldet sich an und besucht jede Ansicht der
  Navigation bei 360 × 740, 390 × 844 und 1280 × 800. Geprüft werden M1
  (waagrechter Überlauf), M2 (Trefferflächen über `getBoundingClientRect`),
  M3 (berechnete Schriftgröße der Eingabefelder) und M7. Bei einem Fehler
  speichert der Test einen Screenshot der Ansicht.
- **Eine Liste je Modul** (`test/mobile-views.json`) nennt die Ansichten und
  die Hauptaktion je Ansicht (M5). Neue Ansichten fehlen sonst unbemerkt.
- **Echte Geräte vor jeder Phase:** ein iPhone (Safari, als PWA installiert)
  und ein Android-Gerät (Chrome). Laut Gap-Analyse ist „auf iOS testen“
  noch offen. iOS verhält sich bei Service Worker, Kamera und Badge anders
  als Chromium.

## 6. Sicherheit beim Zugriff von außen

- **Zwei-Faktor** ist der wichtigste Punkt und umgesetzt (0a). 0b und 0c
  machen ihn nutzbar und verpflichtend.
- **Sitzungsdauer:** `SESSION_TTL_HOURS` (PS-01, Standard 12 h) gilt für jedes
  Gerät gleich. Für Handys ist das vertretbar, weil das Gerät gesperrt ist und
  die Abmeldung alles löscht. Eine kürzere Dauer für Sitzungen ohne zweiten
  Faktor ist eine Option für 0c.
- **Gerät verloren:** „Alle Sitzungen beenden“ (`POST /api/users/:id/sessions/revoke`)
  und „Zwei-Faktor zurücksetzen“ (`POST /api/users/:id/mfa/reset`) gibt es
  beide. Sie brauchen in 0b eine Bedienoberfläche für die Verwaltung.
- **VPN statt offenem Internet** bleibt eine Betriebsoption für Firmen, die das
  wollen (`docs/PROVISIONING.md`). Es ist keine Voraussetzung.

## 7. Aufwand (grob, für die Planung)

| Phase | Inhalt | Umfang |
| --- | --- | --- |
| 0b–0d | Konto-Seite, Pflicht je Organisation, Bausteine, Test-Gerüst | groß, einmalig |
| 1 | 6 Module | je klein bis mittel, weil die Bausteine tragen |
| 2 | 4 Module, MOD-04 groß | mittel bis groß |
| 3 | 5 Module | je klein |

Der Aufwand je Modul sinkt mit jeder Phase, weil die Bausteine aus Phase 0
das meiste übernehmen: Tabellen bekommen `data-label`, die Navigation bekommt
ihre Einträge, Raster bekommen ihren Kasten.

## 8. Umsetzung — was gebaut ist

| Teil | Wo | Geprüft durch |
| --- | --- | --- |
| Zwei-Faktor-Anmeldung (TOTP), Wiederherstellungscodes, Schutz vor Wiederverwendung | PS-01 `server/totp.ts`, `server/mfa.ts` | RFC 4226/6238/4648-Vektoren (`test/totp.test.ts`), `test/mfa.test.ts` |
| **0b** Konto-Seite: Faktor einrichten (QR im Browser), Codes erneuern, Passwort, „überall abmelden“ | MOD-15/16 `server/account.ts`, `src/components/Account.tsx` | `test/account.test.ts` gegen echtes PS-01 und PS-03 |
| QR-Code-Erzeugung ohne fremden Dienst | `src/qr/encode.ts` (Copy-in) | Modul für Modul gegen segno, zurückgelesen vom MOD-11-Decoder (`mod-11 test/qr-encode.test.ts`) |
| **0c** Zwei-Faktor-Pflicht je Organisation, Einrichtung direkt beim Login (auch über OAuth) | PS-01 `PATCH /api/orgs/current`, `secondFactorGate`; Login-Formular jedes Moduls | `test/mfa-policy.test.ts`, Copy-in `test/access.test.ts` |
| Verwaltung: Personen, Faktor zurücksetzen, abmelden, Pflicht schalten | Shell → Konto → Administration | `test/account.test.ts` |
| Sicherheitsmeldungen (neues Gerät, Faktor aus, Code benutzt, Passwort, Rate-Versuche) | PS-01 `server/security-notify.ts` | `test/mfa-policy.test.ts`, `test/security-notify.test.ts` |
| **0d** Mobile-Schicht: untere Navigationsleiste, Tabellen als Karten, 44-px-Ziele, 16-px-Felder, einspaltige Formulare, Vollbild-Dialoge | `src/mobile.css`, `src/mobile.ts` (Copy-in, alle 17 Module) | `deploy/mobile-check.mjs` |
| Prüf-Gerüst (Abschnitt 5) | `deploy/mobile-check.mjs`, `.github/workflows/mobile.yml` | jede Ansicht der Navigation, 360/390/1280 px, plus öffentliche Seiten (Shop, Ticket-Formular) |
| Installierbar: alle 17 Module (Manifest, Symbol, Service Worker) | `public/manifest.webmanifest`, `src/pwa/*` (Copy-in) | `deploy/test/pwa.test.ts` |
| **Phasen 1–3** | über die Bausteine; modul-eigene Ursachen dort behoben, wo die Messung sie fand | `deploy/mobile-check.mjs`: alle Module ohne Befund |

Abweichungen vom Plan und was bewusst offen bleibt:

- **Statt eines `ResponsiveTable`-Bausteins** beschriftet `src/mobile.ts` jede
  Tabelle automatisch aus ihrer Kopfzeile. So musste keine der rund 150
  Tabellen einzeln umgebaut werden, und neue Tabellen sind ohne Zutun
  abgedeckt. Ein Raster, das Raster bleiben muss, bekommt `data-mobile="grid"`.
- **Deep Links in ein Modul** (eine Benachrichtigung öffnet den Datensatz,
  nicht nur das Modul): Die meisten Module lesen beim Start keine Adresse
  (`docs/SHELL-CONTRACT.md`). Die Shell öffnet daher das Modul, und die
  Benachrichtigung nennt den Datensatz.
- **Echte Geräte:** Die automatische Messung ersetzt nicht den Blick auf ein
  iPhone (Safari, installiert) und ein Android-Gerät vor einer Auslieferung.
- **Neue Module** aus `scripts/new-module.mjs` bekommen die Mobile-Schicht
  und die Benachrichtigungs-Bausteine. Installierbar werden sie mit eigenem
  Manifest und Symbol (wie in den 17 vorhandenen).
