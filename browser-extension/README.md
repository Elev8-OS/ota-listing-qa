# OTA QA-Tool – Airbnb Host-Editor Import (Chrome-Extension)

Liest im eingeloggten Airbnb-Host-Editor die Felder, die öffentlich nie sichtbar
sind (Fotorundgang-Zimmerliste, "Sleeping arrangements", Gästezahl, Kopfzeile
"X bedrooms · Y beds · Z baths") und sendet sie an das ota-qa-tool. Es wird
nichts auf airbnb.com verändert — nur gelesen.

## Warum eine Extension statt Server-seitigem Scraping?

Der Server-seitige Playwright-Import (`lib/otaScraper.js`) sieht nur die
öffentliche Seite und wird von Airbnbs Bot-Schutz teilweise blockiert. Diese
Extension läuft dagegen in deinem echten, bereits eingeloggten Chrome — keine
Headless-Erkennung, kein Bot-Schutz-Thema, und zusätzlich Zugriff auf die
Host-internen Editor-Felder.

## Installation (Entwicklermodus, kein Chrome Web Store nötig)

1. `chrome://extensions` öffnen.
2. Oben rechts "Entwicklermodus" aktivieren.
3. "Entpackte Erweiterung laden" klicken und diesen Ordner (`browser-extension/`) auswählen.
4. Auf das Erweiterungssymbol → "Details" → "Erweiterungsoptionen" (oder Rechtsklick auf das Icon → Optionen).
5. QA-Tool-Basis-URL eintragen (Standard: die produktive Railway-App) und den
   API-Key eintragen, der im QA-Tool als Umgebungsvariable `EXTENSION_API_KEY`
   gesetzt ist (beim Admin/Reto erfragen). Mit "Verbindung testen" prüfen.

## Benutzung

1. Im QA-Tool bei dem betreffenden Airbnb-Kanal die **Airbnb Listing-ID**
   hinterlegen (Feld "Airbnb Listing-ID (für die Browser-Extension)") — die
   ID steht in der Editor-URL: `airbnb.com/hosting/listings/editor/<ID>/...`.
2. In Airbnb zum Host-Editor dieses Listings navigieren
   (`https://www.airbnb.com/hosting/listings/editor/<ID>/details/photo-tour`),
   einmal durch die linke Spalte scrollen (Fotorundgang, Title, Sleeping
   arrangements, Number of guests), damit alles geladen ist.
3. Unten rechts erscheint ein Button "An OTA QA-Tool senden" — klicken.
4. Im QA-Tool erscheint beim Kanal ein Hinweis "Live aus deinem eingeloggten
   Airbnb-Host-Editor gelesen" mit den ausgelesenen Werten — wie beim
   automatischen Import gilt: jeden Wert prüfen, nichts blind übernehmen.

## Grenzen

Die Extraktion basiert auf Text-Mustern (kein festes DOM-Schema, da Airbnb
seine internen CSS-Klassen häufig ändert). Ändert Airbnb den Aufbau des
Editors grundlegend, kann die Erkennung einzelner Felder ausfallen — das
QA-Tool zeigt dann entsprechend weniger oder gar keine Felder an.
