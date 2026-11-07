# Push-Benachrichtigungen und App-Badge — Plan

Status: **Plan, nichts davon ist umgesetzt.** Dieses Dokument legt fest, *welche*
Benachrichtigungen sinnvoll sind, bevor eine Zeile Code entsteht. Es baut auf
[`MOBILE-PLAN.md`](./MOBILE-PLAN.md) auf, denn Push und Badge setzen die
installierte App voraus.

## 1. Grundsätze

Eine Benachrichtigung unterbricht einen Menschen. In einem KMU ist das oft
dieselbe Person, die gerade beim Kunden steht oder Feierabend hat. Deshalb
gelten diese Regeln, und jede Zeile im Katalog (Abschnitt 3) muss sie erfüllen:

1. **Nur wenn jemand handeln muss oder auf etwas wartet.** „Wartet auf deine
   Freigabe“ ist eine Benachrichtigung, „Rechnung 2026-0142 wurde geändert“
   ist keine. Was man selbst getan hat, wird nie gemeldet.
2. **An eine Person, nicht an alle.** Empfänger ist, wem die Sache zugewiesen
   ist, oder wer sie freigeben darf (Zugriffsstufe aus PS-01,
   `docs/ACCESS-LEVELS.md`). Rundrufe an das ganze Team gibt es nicht.
3. **Drei Dringlichkeiten:**
   - **Sofort** — Push jetzt. Nur, wenn Warten schadet (SLA reißt, Kunde wartet,
     Sicherheit).
   - **Gesammelt** — einmal am Tag zur eingestellten Uhrzeit (Standard 7:30,
     Arbeitstage) als *eine* Push-Nachricht „3 Dinge warten auf dich“, wahlweise
     per Mail.
   - **Nur Badge** — keine Nachricht, aber die Zahl am App-Symbol zählt es mit.
4. **Der Badge zählt, was auf mich wartet — nicht, was ungelesen ist.** Er
   sinkt, wenn die Sache erledigt ist, nicht, wenn die Nachricht angetippt
   wurde. Die Zahl wird bei jedem Abruf aus den Zeilen abgeleitet, nie
   gespeichert und hochgezählt (CLAUDE.md, Regel 3). Damit kann er nicht
   „hängen bleiben“.
5. **Nichts Vertrauliches auf dem Sperrbildschirm.** Standardmäßig enthält
   eine Push-Nachricht keine Namen, Beträge oder Kundendaten, nur die Art
   („Neue Freigabe in Beschaffung“). Den Inhalt sieht man erst nach dem
   Öffnen und Anmelden. Wer Details sehen will, schaltet das je Person ein.
6. **Ruhezeiten.** Außerhalb der eingestellten Arbeitszeit wird nur
   „Sofort“ mit Kennzeichen *Bereitschaft* oder *Sicherheit* zugestellt. Alles
   andere wartet auf die nächste Zusammenfassung. Wo MOD-11 ein
   Arbeitszeitmodell der Person kennt, ist das die Vorgabe.
7. **Abbestellbar je Kategorie und Person** — mit einer Ausnahme:
   Sicherheitsmeldungen (Abschnitt 3, PS-01) lassen sich nicht abschalten.
8. **Einmal pro Anlass.** Jede Benachrichtigung hat einen Idempotenzschlüssel
   (Modul, Art, Datensatz, Anlass). So wird ein Tick alle paar Minuten nie zu
   einer Nachrichtenflut. MOD-11 macht das heute schon für Mail-Erinnerungen
   (`server/reminders.ts`, `reminders_sent`).

## 2. Was es heute schon gibt

- **PS-03 Notification Hub** stellt zu: E-Mail, SMS, Chat und Webhook mit
  echten Anbietern, Vorlagen, Wiederholungsversuche, Idempotenzschlüssel. Ein
  Kanal `push` ist im Schema angelegt (`server/db.ts`, Seed `push-default`),
  hat aber **keinen echten Anbieter**. Er fällt auf die Konsole zurück.
- **Module mit `notify`-Haken über PS-03:** MOD-06 Beschaffung, MOD-11
  (Erinnerungen „Woche nicht abgegeben“ und „Timer läuft noch“, Spesen), MOD-13
  Angebote (Versand an Kunden), MOD-14 Förderungen. Heute alles per Mail.
- **Shell-Zusammenfassungen** (`shared/summary.ts`): Jedes Modul liefert Zahlen
  und Listen mit Ton (`warn`, `bad`). Das ist die Sicht für eine Tafel, aber
  nicht „was wartet auf *diese* Person“.

## 3. Katalog: welche Benachrichtigungen sinnvoll sind

Spalte **Stufe**: S = sofort, G = gesammelt, B = nur Badge. Spalte **Badge**:
zählt bis zur Erledigung mit. „Freigeber“ heißt: Personen mit der nötigen
Zugriffsstufe, und nie die Person, die den Antrag gestellt hat (Vier-Augen,
wie MOD-11 es bei Spesen schon durchsetzt).

Ein Anlass setzt voraus, dass das Modul den Vorgang kennt. Wo ein Modul ihn
heute nicht hat (etwa einen Tourplan je Fahrer:in in MOD-17 oder eine interne
Angebotsfreigabe in MOD-13), wird er mit dem Modul gebaut oder entfällt. Die
Tabelle sagt, was sinnvoll ist, nicht was schon existiert.

### Sicherheit (PS-01) — nicht abschaltbar

| Anlass | Empfänger | Stufe | Badge | Warum |
| --- | --- | --- | --- | --- |
| Anmeldung von einem neuen Gerät/Browser | die Person | S | – | Erkennt eine fremde Anmeldung sofort. |
| Zwei-Faktor ausgeschaltet oder von Admin zurückgesetzt | die Person | S | – | Ein Angreifer würde genau das tun. |
| Wiederherstellungscode benutzt (mit „noch N übrig“) | die Person | S | – | Ab 2 verbleibenden Codes zusätzlich der Hinweis „neue erzeugen“. |
| Passwort geändert | die Person | S | – | Klassischer Übernahme-Hinweis. |
| Viele Fehlversuche an einem Konto (Drosselung greift) | Admins der Organisation | S | – | Die Kennzahl `identity_throttled_accounts` gibt es schon; das macht sie sichtbar. |

### MOD-12 Tickets — Bereitschaft

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Ticket mir zugewiesen | Bearbeiter:in | S | ✔ |
| Kunde hat auf mein Ticket geantwortet | Bearbeiter:in | S | ✔ |
| SLA reißt in 60 Minuten (Zeit konfigurierbar) | Bearbeiter:in | S · Bereitschaft | ✔ |
| SLA gerissen | Bearbeiter:in und Teamleitung | S · Bereitschaft | ✔ |
| Neues Ticket ohne Zuweisung | Team (Stufe `edit`) | G | ✔ |

### MOD-11 Zeiterfassung, Abwesenheiten, Spesen, Projekte

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Urlaubs- oder Abwesenheitsantrag wartet auf Freigabe | Freigeber | G | ✔ |
| Mein Antrag genehmigt oder abgelehnt | Antragsteller:in | S | – |
| Spesenabrechnung wartet auf Freigabe | Freigeber | G | ✔ |
| Meine Spesen genehmigt, abgelehnt oder ausgezahlt | Antragsteller:in | S | – |
| Woche nicht abgegeben (gibt es per Mail) | die Person | G | ✔ |
| Timer läuft noch (gibt es per Mail) | die Person | S | – |
| Offline erfasste Spesen konnten nicht gesendet werden | die Person | S | ✔ |

### MOD-06 Beschaffung

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Bestellanforderung wartet auf Freigabe | Freigeber | G (S ab Betragsgrenze) | ✔ |
| Meine Anforderung freigegeben oder abgelehnt | Anforderer:in | S | – |
| Ware zu meiner Anforderung eingegangen | Anforderer:in | G | – |
| Lieferung überfällig | Einkauf | G | ✔ |

### MOD-04 Rechnungen

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Eingangsrechnung wartet auf Freigabe (3-Way-Match mit Abweichung) | Freigeber | G | ✔ |
| Zahlungslauf wartet auf zweite Freigabe | Freigeber (nicht Ersteller:in) | S | ✔ |
| Eingangsrechnung wird morgen fällig, Skonto läuft ab | Buchhaltung | G | ✔ |
| Mahnvorschlag bereit zur Prüfung | Buchhaltung | G | ✔ |
| Versand einer E-Rechnung fehlgeschlagen oder Validierung abgelehnt | Ersteller:in | S | ✔ |
| Zahlung eingegangen (nur über einer eingestellten Grenze, abonnierbar) | wer abonniert | G | – |

### MOD-13 Angebote

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Angebot vom Kunden angenommen | Verkäufer:in | S | – |
| Angebot vom Kunden abgelehnt | Verkäufer:in | G | – |
| Angebot läuft in 3 Tagen ab, ohne Antwort | Verkäufer:in | G | ✔ |
| Angebot wartet auf interne Freigabe (wo vorhanden) | Freigeber | G | ✔ |

### MOD-10 CRM

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Wiedervorlage oder Aufgabe heute fällig | Zuständige:r | G (morgens) | ✔ |
| Wiedervorlage überfällig | Zuständige:r | B | ✔ |
| Lead oder Kontakt mir zugewiesen | Zuständige:r | S | ✔ |

### MOD-17 Aufträge & Lieferscheine

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Neuer Auftrag zur Disposition | Disposition | S | ✔ |
| Mir zugeteilte Zustellung für heute (Tourplan) | Fahrer:in | G (morgens) | ✔ |
| Zustellung fehlgeschlagen oder verspätet | Disposition | S | ✔ |

### MOD-03 Lager

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Mindestbestand unterschritten | Einkauf/Lager | G | ✔ |
| Inventurdifferenz über Toleranz | Lagerleitung | G | ✔ |

### MOD-09 Dokumente

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Dokument wartet auf meine Freigabe | Freigeber | G | ✔ |
| Aufbewahrungsfrist abgelaufen, Löschung zu entscheiden | Verantwortliche:r | G (wöchentlich) | ✔ |

### MOD-14 Förderungen

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Frist (Antrag, Verwendungsnachweis, Abruf) in 14 / 3 Tagen | Zuständige:r | G | ✔ |
| Frist überschritten | Zuständige:r und Geschäftsführung | S | ✔ |

### MOD-08 Berichte

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Geplanter Bericht ist fertig | wer ihn geplant hat | G | – |
| Kennzahl über oder unter einer selbst gesetzten Schwelle | wer die Schwelle gesetzt hat | S | – |

### MOD-07 Storefront und MOD-01 Kundenportal (Betreiberseite)

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Neue Bestellung im Shop | Shop-Verantwortliche | S (abschaltbar) | ✔ bis bearbeitet |
| Kunde schreibt im Portal | Zuständige:r beim Kunden | S | ✔ |

### MOD-02 Admin-Dashboard, Betrieb

| Anlass | Empfänger | Stufe | Badge |
| --- | --- | --- | --- |
| Ein Dienst des Stacks antwortet nicht (`/api/ready`) | Admins | S · Bereitschaft | – |
| Nächtliche Sicherung fehlgeschlagen (`scripts/backup.mjs`) | Admins | S | – |

### MOD-05 Verzeichnis, MOD-15 Workspace, MOD-16 Mosaik

Keine eigenen Anlässe. Das Verzeichnis hat nichts, auf das jemand warten
müsste; Geburtstage und Ähnliches sind bewusst nicht dabei, weil sie Grundsatz 1
verletzen. Die beiden Shells *empfangen* die Benachrichtigungen und zeigen
den Badge, erzeugen aber keine.

### Bewusst ausgeschlossen

- Jede Änderung an einem Datensatz („X hat Y bearbeitet“) — dafür gibt es das
  Audit-Log (PS-07) und den Feed im Workspace.
- Kennzahlen ohne selbst gesetzte Schwelle („Umsatz heute“).
- Kunde hat Angebot oder Rechnung geöffnet. Dafür bräuchte es ein Tracking,
  das es nicht gibt und das datenschutzrechtlich eigene Fragen aufwirft.
- Alles, was die Person selbst ausgelöst hat.

## 4. Wie es technisch gebaut wird

```
Modul ──(Anlass, Empfänger, Kategorie, Idempotenzschlüssel)──▶ PS-03
                                                     │ Vorlieben, Ruhezeiten,
                                                     │ Zusammenfassung
                                                     ▼
                         Web Push (verschlüsselt) ──▶ Push-Dienst des Browsers
                                                     ▼
                       Service Worker der Shell (MOD-15/16, MOD-11) zeigt an
                       und holt die Badge-Zahl von der Shell (mit Sitzung)
```

1. **Web Push in PS-03, ohne neue Abhängigkeit.** Ein Anbieter `webpush` für den
   vorhandenen Kanal `push`: Nachrichtenverschlüsselung nach RFC 8291
   (`aes128gcm`, RFC 8188) und Absenderkennung nach RFC 8292 (VAPID, ES256).
   Beides geht mit Node-`crypto` (ECDH P-256, HKDF, AES-128-GCM,
   ECDSA). Getestet wird **gegen die Testvektoren in RFC 8291 Anhang A**
   (CLAUDE.md, Regel 7). Neue Geheimnisse: `VAPID_PRIVATE_KEY` und
   `VAPID_PUBLIC_KEY` je Stack. Sie gehen in `server/config.ts`, in
   `modules/registry.json` und in `deploy/provision.mjs`, das sie erzeugt.
   `guard.ts` verweigert den Start ohne sie in Produktion.
2. **Ausgehende Hosts.** Die Push-Dienste der Browser müssen erreichbar sein
   (`EGRESS_ALLOW_HOSTS` in PS-03): `fcm.googleapis.com` (Chrome, Edge,
   Android), `updates.push.services.mozilla.com` (Firefox) und
   `web.push.apple.com` (Safari, iOS). Die Inhalte sind Ende-zu-Ende
   verschlüsselt; diese Dienste sehen nur, *dass* eine Nachricht an ein Gerät
   geht.
3. **Geräte registrieren.** Die installierte Shell fragt nach der Erlaubnis.
   Das passiert **nie beim ersten Start**, sondern nach einem Tippen auf
   „Benachrichtigungen einschalten“; iOS verlangt das ohnehin. Die
   Shell-Server reichen das Abo mit dem PS-01-Token der Person an PS-03 weiter
   (`POST /api/push/subscriptions`). Ein Abo gehört zu Person **und** Gerät;
   Abmelden (`/session/logout`) und „Alle Sitzungen beenden“ löschen die Abos
   dieses Geräts bzw. der Person. Die Abo-Adresse ist ein personenbezogenes
   Datum und kommt in `docs/PII-MAP.md`.
4. **Vorlieben je Person in PS-03:** Kategorien an/aus, Zusammenfassung
   (Uhrzeit, Push oder Mail), Ruhezeiten, „Details auf dem Sperrbildschirm“.
   Die Einstellungsseite liegt in der Shell, neben „Zwei-Faktor“
   (MOBILE-PLAN, Phase 0b).
5. **Der Badge ist abgeleitet.** Jedes Modul bekommt einen Endpunkt
   `GET /api/inbox?for=<person>` (Service-Token, wie `/api/summary`), der zählt,
   was auf diese Person wartet. Er nutzt dieselben Regeln wie die Zeilen mit
   ✔ im Katalog. Die Shell summiert über die Module, die die Person erreichen
   darf. Die Push-Nachricht trägt **keine** Zahl, nur „neu zählen“. Der
   Service Worker fragt die Shell und setzt `navigator.setAppBadge(n)`. Ohne
   gültige Sitzung setzt er nur einen Punkt (`setAppBadge()` ohne Zahl). Beim
   Öffnen der App wird ohnehin neu gezählt.
6. **Module senden Anlässe, nicht Texte.** Ein Modul meldet
   `{kind, recipient, record, href}` an PS-03. Die Vorlage (PS-03 hat
   versionierte Vorlagen) macht daraus den Text in der Sprache der Person. So
   bleibt der Sperrbildschirm-Grundsatz an *einer* Stelle durchgesetzt. Das ist
   ein Copy-in-Haken (`server/platform.ts` hat `notify` schon in vier Modulen)
   und ohne `NOTIFICATION_URL` ein No-op wie bisher.

### Was die Plattformen können (Stand Ende 2026, vor Umsetzung neu prüfen)

| | Push | Zahl am App-Symbol |
| --- | --- | --- |
| Android, Chrome/Edge, installiert | ja | je nach Launcher Zahl oder Punkt |
| iPhone/iPad, Safari, **zum Home-Bildschirm hinzugefügt** (ab iOS 16.4) | ja | ja |
| iPhone/iPad, nur im Browser-Tab | nein | nein |
| Windows/macOS, Chrome/Edge, installiert | ja | ja |
| Firefox Desktop | ja | nein |

Daraus folgt: Am iPhone muss die App installiert sein. Die Shell erklärt das
beim Tippen auf „Benachrichtigungen einschalten“, statt still zu scheitern.

## 5. Reihenfolge

1. **Grundlage:** Web-Push-Anbieter in PS-03 mit RFC-8291-Vektoren, VAPID im
   Provisioning, Geräteregistrierung und Vorlieben, Einstellungsseite in der
   Shell, Badge über `/api/inbox`. Erster Anlass: die **Sicherheitsmeldungen**
   aus PS-01. Sie sind am wichtigsten und brauchen kein Modul.
2. **Sofort-Anlässe, die heute schon bei jemandem Arbeit liegen lassen:**
   MOD-12 (Zuweisung, SLA), MOD-11 (Anträge, Spesen), MOD-06 (Freigaben),
   MOD-04 (Zahlungslauf-Freigabe). Die vorhandenen Mail-Erinnerungen von MOD-11
   bekommen Push als zweiten Weg.
3. **Zusammenfassung** (eine Push am Morgen) und die übrigen G-Anlässe.
4. **Rest des Katalogs**, Modul für Modul, zusammen mit dem jeweiligen
   Mobile-Umbau (MOBILE-PLAN, Phasen 1–3).

Jeder Schritt hat Tests nach dem Muster, das es schon gibt: ein Anlass wird
genau einmal gemeldet, nicht an die auslösende Person, nicht an jemanden ohne
Zugriffsstufe, nicht in der Ruhezeit (außer Bereitschaft/Sicherheit), und die
Badge-Zahl fällt, sobald die Sache erledigt ist.

## 6. Offene Fragen an die Fachseite

- Uhrzeit und Tage der Zusammenfassung als Vorgabe: 7:30 an Arbeitstagen?
- Betragsgrenze, ab der eine Bestellanforderung sofort statt gesammelt kommt
  (MOD-06)?
- Wer ist in MOD-12 „Teamleitung“? Eine eigene Rolle oder die Stufe `manage`?
- Soll eine Shop-Bestellung (MOD-07) auch außerhalb der Arbeitszeit sofort
  kommen?
