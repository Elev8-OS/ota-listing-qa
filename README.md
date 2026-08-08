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

## Wichtige Einschränkung: Datenimport aus dem OTA-Link

Airbnb und Booking.com bieten keine offizielle API für die Editor-internen Felder
(Fotorundgang-Aufteilung, Schlafgelegenheiten pro Zimmer). Diese sind nur sichtbar,
wenn man im jeweiligen Host-Editor eingeloggt ist, und müssen daher manuell erfasst
werden. Der "Aus Link vorbefüllen"-Button versucht best-effort, öffentlich sichtbare
Felder (Titel, Beschreibung, teilweise Gäste-/Zimmer-/Bettenangaben) auszulesen —
das kann je nach Seitenstruktur fehlschlagen, da Airbnb/Booking.com Inhalte oft erst
per JavaScript nachladen. Jeder importierte Wert ist klar als "bitte prüfen" markiert.

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

Node-App, `npm start` startet `server.js`. Persistenz erfolgt über eine SQLite-Datei
unter `DATA_DIR` (Standard: `./data`). Für dauerhafte Daten auf Railway muss dem
Service ein **Volume** hinzugefügt und unter dem Pfad, der in `DATA_DIR` steht,
gemountet werden — sonst gehen Daten bei jedem Redeploy verloren.

Benötigte Umgebungsvariablen:

- `SESSION_SECRET` – beliebiger langer, zufälliger String
- `DATA_DIR` – Pfad zum gemounteten Volume, z. B. `/data`
- `NODE_ENV=production`
