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

## Datenimport ausschliesslich über die eingeloggte Seite (Chrome-Extension)

Es wird bewusst **nie** die öffentliche Airbnb-/Booking.com-Seite automatisiert
abgerufen (kein Playwright-Scraper, kein serverseitiger `fetch()` gegen die
OTA-Seite) — jeglicher Datenimport läuft ausschliesslich über
`browser-extension/`, eine kleine Chrome-Extension, die im echten,
bereits eingeloggten Chrome der Person läuft. Gründe: kein Bot-Schutz-Thema
(echte menschliche Session statt Headless-Browser), zuverlässiger (kein
Wettlauf mit Lade-Skeletten/Domain-Redirects auf der öffentlichen Seite), und
zusätzlich Zugriff auf Host-interne Editor-Felder, die öffentlich nie
sichtbar sind (Fotorundgang-Zimmerliste, "Sleeping arrangements", Titel/
Beschreibungstexte, Alt-Texte der Fotos). Details und Installation: siehe
`browser-extension/README.md`.

(Frühere Version dieses Tools hatte zusätzlich einen "Aus Link vorbefüllen"-
Button, der per Playwright die öffentliche Seite abgerufen hat — dieser wurde
entfernt, da explizit gewünscht ist, dass alles über die eingeloggte Seite
läuft.)

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

Wird über das mitgelieferte `Dockerfile` gebaut (schlankes `node:20-slim`-
Basis-Image — kein Chromium/Playwright mehr nötig, siehe Abschnitt
"Datenimport" oben: es wird nie mehr serverseitig ein Browser gestartet).
Railway erkennt das Dockerfile automatisch und baut damit statt mit dem
generischen Node-Buildpack.

`npm start` startet `server.js`. Persistenz erfolgt über eine SQLite-Datei
unter `DATA_DIR` (Standard: `./data`). Für dauerhafte Daten auf Railway muss dem
Service ein **Volume** hinzugefügt und unter dem Pfad, der in `DATA_DIR` steht,
gemountet werden — sonst gehen Daten bei jedem Redeploy verloren.

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
