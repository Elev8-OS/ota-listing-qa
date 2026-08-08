# OTA Listing QA-Tool

Internes Vier-Augen-Tool zur Qualitätssicherung von OTA-Inseraten (Airbnb, Booking.com).

Entstanden aus dem Befund, dass bei einem Airbnb-Inserat durch manuelle Pflege beim
Fotoupload eine doppelte Zimmerkategorie entstanden ist, ohne dass die separate
"Schlafgelegenheiten"-Ansicht mitaktualisiert wurde. Dieses Tool erfasst pro Inserat
und Kanal (Airbnb/Booking.com) die Kopfzeilen-Zusammenfassung sowie die einzelnen
Zimmer mit Schlafgelegenheit, prüft sie automatisch auf Inkonsistenzen und erzeugt
copy-paste-fertige Korrekturtexte. Jede Korrektur muss von einer zweiten Person
freigegeben werden (Vier-Augen-Prinzip), bevor sie als umgesetzt markiert wird.

## Automatisch geprüfte Inkonsistenzen

1. Anzahl Schlafzimmer in der Kopfzeile vs. Anzahl Zimmer vom Typ "Schlafzimmer"
2. Anzahl Betten in der Kopfzeile vs. Summe der Betten über alle Zimmer mit Schlafgelegenheit
3. Zimmer mit Schlafgelegenheit im Fotorundgang, das im separaten Bereich
   "Schlafgelegenheiten" fehlt
4. Hinterlegter Bettentyp pro Zimmer vs. Bettentyp, der auf den Fotos zu sehen ist
5. Gesamte Schlafkapazität vs. maximale Gästezahl

## Datenimport aus dem OTA-Link (Playwright, live von Airbnb/Booking.com)

Der "Aus Link vorbefüllen"-Button (`lib/otaScraper.js`) öffnet die öffentliche
Airbnb- bzw. Booking.com-Seite in einem echten, headless Chromium-Browser
(Playwright) — nicht per einfachem HTML-Fetch. Das ist nötig, weil Airbnb und
Booking.com die eigentlichen Inhalte erst per JavaScript nachladen; ein
einfacher `fetch()` sieht davon praktisch nichts (siehe Git-Historie: die
erste Version hatte genau dieses Problem, "Import ausgeführt" ohne Daten).

Ausgelesen werden: Titel, Anzahl Gäste/Schlafzimmer/Betten/Bäder (aus dem
sichtbaren Zusammenfassungstext) sowie roh der Textblock unter
"Where you'll sleep" (Airbnb) bzw. der Zimmer-/Raumtypen-Bereich (Booking.com)
— letzterer wird zum manuellen Abgleich mit den unten erfassten Zimmern
angezeigt, ersetzt diese aber nicht automatisch.

**Nach wie vor nicht auslesbar** (bewusste Einschränkung, nicht technisch
lösbar ohne Host-Login): die Editor-internen Felder "Fotorundgang"
(Zuordnung der Fotos zu Zimmerkategorien) und ob ein Zimmer im separaten
Bereich "Schlafgelegenheiten" hinterlegt ist. Genau das war der ursprüngliche
Fehler, den dieses Tool aufdecken soll — diese Felder bleiben daher immer
manuell zu erfassen.

**Bot-Schutz:** Erkennt der Scraper eine Verifizierungs-/Captcha-Seite, bricht
er sauber ab und meldet das — es wird nicht versucht, Bot-Schutz zu umgehen.

**Hinweis zur Zuverlässigkeit:** Airbnb/Booking.com können ihre Seitenstruktur
jederzeit ändern oder automatisierte Zugriffe erschweren; jeder importierte
Wert ist als "bitte prüfen" zu behandeln, nie blind zu übernehmen.

## Airbnb-Host-Editor-Import per Chrome-Extension

Der Playwright-Scraper (oben) wird bei Airbnb teilweise von Bot-Schutz
blockiert, weil er auf der öffentlichen Seite läuft. Als Alternative gibt es
`browser-extension/` — eine kleine Chrome-Extension, die im echten,
eingeloggten Chrome der Person läuft (kein Bot-Schutz-Thema, da echte
menschliche Session) und dabei zusätzlich Zugriff auf Host-interne
Editor-Felder hat (Fotorundgang-Zimmerliste, "Sleeping arrangements") — genau
die Felder, die öffentlich nie sichtbar waren. Details und Installation:
siehe `browser-extension/README.md`.

Voraussetzung im QA-Tool:

- Umgebungsvariable `EXTENSION_API_KEY` setzen (beliebiger langer, zufälliger
  String) — ohne diese Variable ist der Endpunkt `/api/browser-import`
  deaktiviert.
- Bei jedem Airbnb-Kanal die "Airbnb Listing-ID" hinterlegen (Feld im
  Kanal-Bereich), damit die Extension weiss, welchen Kanal sie aktualisieren
  soll.

Sicherheitshinweis: Der API-Key ist ein reiner Freigabe-Mechanismus zwischen
Extension und QA-Tool, kein Ersatz für Airbnb-Zugangsdaten — die Extension
nutzt ausschliesslich die bereits bestehende, legitime Browser-Session der
Person. Es wird nie versucht, sich anderswo einzuloggen oder Bot-/Captcha-Schutz
zu umgehen.

## "Alle Texte im Inserat": KI-Umformulierung, Vier-Augen-Freigabe, Rückschreiben

Über dieselbe Extension werden zusätzlich auf jeder Airbnb-Editor-Unterseite
(Title, "Listing description", "Your property", "Guest access", "Interaction
with guests", "Other details to note", ...) generisch alle Textfelder
erfasst (`channels.text_fields`, pro Seitenpfad). Das QA-Tool zeigt sie unter
"Erfasste Texte aus dem Airbnb-Editor" an; jeder Text kann als Umformulierung
vorgeschlagen werden (`/channels/:id/propose-text`), durchläuft die normale
Vier-Augen-Freigabe (niemand gibt den eigenen Vorschlag frei) und kann danach
per Extension-Button "Freigegebene Texte hier einfüllen"
(`/api/browser-import/pending-writeback`) ins passende Feld auf genau der
Editor-Seite eingetragen werden, von der es stammt. Gespeichert wird in
Airbnb weiterhin nur manuell durch die Person selbst — die Extension füllt
das Feld, klickt aber nie Airbnbs eigenen "Save"-Button.

Direkt neben jedem erfassten Text gibt es zusätzlich einen Button "Mit KI
umformulieren" (`lib/aiRewrite.js`, Route `/channels/:id/ai-rewrite`), der
per Claude-API (Anthropic Messages API, direkter `fetch`-Aufruf, kein SDK)
einen Vorschlag erzeugt und ins Vorschlagsfeld einträgt — nichts wird
automatisch übernommen oder eingereicht, die Person prüft/bearbeitet den
KI-Vorschlag weiterhin selbst, bevor sie ihn zur Vier-Augen-Freigabe
einreicht. Als Kontext bekommt Claude die Eckdaten des Kanals (Schlafzimmer/
Betten/Bäder/Gäste) sowie die anderen bereits erfassten Texte desselben
Inserats mit, damit die Umformulierung nicht widersprüchlich wird.

Benötigte Umgebungsvariable: `ANTHROPIC_API_KEY` (Anthropic-Konto/API-Key,
kostenpflichtig je Aufruf — ohne diese Variable meldet der Button einen
klaren Fehler, es passiert aber nichts Kaputtes). Optional anpassbar, jeweils
ohne Code-Änderung, nur per Railway-Variable:

- `AI_REWRITE_SYSTEM_PROMPT` — der eigentliche Prompt/die Persona. Ohne
  gesetzte Variable wird ein neutraler Standard-Prompt verwendet (siehe
  `DEFAULT_SYSTEM_PROMPT` in `lib/aiRewrite.js`). Hier den eigenen,
  ausführlicheren Prompt eintragen, sobald er feststeht.
- `AI_REWRITE_MODEL` — Claude-Modellname, falls nicht das Standardmodell
  verwendet werden soll (Default: `claude-3-5-sonnet-latest`).

## Rollen

- **Bearbeiter**: kann Inserate/Kanäle/Zimmer pflegen und Korrekturvorschläge einreichen
- **Prüfer**: kann Vorschläge freigeben oder ablehnen
- **Admin**: beides, plus Benutzerverwaltung

Niemand kann einen eigenen Vorschlag freigeben — das gilt unabhängig von der Rolle.

## Lokale Entwicklung

```
npm install
DATA_DIR=./data SESSION_SECRET=dev node server.js
```

Der erste Aufruf von `/` leitet zur Ersteinrichtung (`/setup`), da noch kein Benutzer
existiert. Der erste angelegte Account erhält automatisch die Rolle Admin.

## Deployment

Wird über das mitgelieferte `Dockerfile` gebaut (Basis-Image
`mcr.microsoft.com/playwright:v1.62.0-noble`, enthält bereits einen zur
`playwright`-npm-Version passenden Chromium — kein fragiler
"Browser nachinstallieren"-Schritt nötig). Railway erkennt das Dockerfile
automatisch und baut damit statt mit dem generischen Node-Buildpack. Das
Image ist wegen Chromium deutlich grösser als vorher und der Build dauert
entsprechend länger.

`npm start` startet `server.js`. Persistenz erfolgt über eine SQLite-Datei
unter `DATA_DIR` (Standard: `./data`). Für dauerhafte Daten auf Railway muss dem
Service ein **Volume** hinzugefügt und unter dem Pfad, der in `DATA_DIR` steht,
gemountet werden — sonst gehen Daten bei jedem Redeploy verloren.

Der Live-Import startet pro Klick einen echten Browser-Prozess (Playwright).
Das braucht mehr Arbeitsspeicher als eine reine Node-App — falls der Import
auf Railway mit Speicherfehlern abbricht, muss dem Service mehr RAM zugewiesen
werden.

Benötigte Umgebungsvariablen:

- `SESSION_SECRET` – beliebiger langer, zufälliger String
- `DATA_DIR` – Pfad zum gemounteten Volume, z. B. `/data`
- `NODE_ENV=production`
- `DEV_LOGIN_ENABLED` – optional, Standard: aktiv (nicht gesetzt oder alles außer
  `"false"`). Siehe Abschnitt "Dev-Login" unten.

## Dev-Login (ohne Passwort)

Auf der Login-Seite gibt es zusätzlich zum normalen E-Mail/Passwort-Login pro
bestehendem Benutzer einen Button "Als … anmelden", der ohne Passwort direkt
einloggt.

**Sicherheitshinweis:** Dieser Zugang ist bewusst auch auf der produktiven
App aktiv. Das bedeutet: **jede Person, die die App-URL kennt, kann sich ohne
Passwort als beliebiger bestehender Benutzer (inkl. Admin) anmelden** — der
normale Login-Schutz ist damit für alle, die die URL kennen, wirkungslos.
Das Vier-Augen-Prinzip innerhalb der App (kein Freigeben eigener Vorschläge)
bleibt zwar bestehen, aber der Zugangsschutz selbst ist deaktiviert.

Deaktivieren ohne Redeploy: Umgebungsvariable `DEV_LOGIN_ENABLED=false` in
Railway setzen (Variable ändern → Service startet automatisch neu). Danach
ist nur noch der normale E-Mail/Passwort-Login möglich.
