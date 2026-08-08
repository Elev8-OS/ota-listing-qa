# OTA QA-Tool – Airbnb Host-Editor Import (Chrome-Extension)

Liest im eingeloggten Airbnb-Host-Editor die Felder, die öffentlich nie sichtbar
sind (Fotorundgang-Zimmerliste, "Sleeping arrangements", Gästezahl, Kopfzeile
"X bedrooms · Y beds · Z baths") und sendet sie an das ota-qa-tool. Es wird
nichts auf airbnb.com verändert — nur gelesen.

## Warum eine Extension statt Server-seitigem Scraping?

Das QA-Tool ruft bewusst nie serverseitig die öffentliche Airbnb-/
Booking.com-Seite ab (kein Playwright, kein Headless-Chromium) — das war
unzuverlässig (Bot-Schutz, Lade-Skelette/Domain-Redirects auf der
öffentlichen Seite) und sieht ausserdem nie die Editor-internen Felder.
Diese Extension läuft dagegen in deinem echten, bereits eingeloggten
Chrome — keine Headless-Erkennung, kein Bot-Schutz-Thema, und zusätzlich
Zugriff auf die Host-internen Editor-Felder. Sämtlicher Datenimport läuft
ausschliesslich über diese Extension.

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

## "Alle Texte im Inserat" — KI-Umformulierung + Rückschreiben (Vier-Augen)

Zusätzlich zu den Fotorundgang-Feldern liest die Extension auf **jeder**
Airbnb-Editor-Unterseite generisch alle sichtbaren `<textarea>`- und
`<input type="text">`-Felder mit HTML-`id` aus (Title, "Listing description",
"Your property", "Guest access", "Interaction with guests", "Other details to
note", ...). Das ist bewusst nicht auf einzelne Felder hartkodiert, weil
Airbnb viele solcher Textfelder hat und sich deren `id`s/Struktur ändern
können — jede neue Editor-Unterseite, die du einmal mit der Extension
besuchst, wird automatisch erfasst.

Ablauf:

1. Auf einer Editor-Unterseite (z. B. `.../details/title`) auf **"An OTA
   QA-Tool senden"** klicken — alle Textfelder dieser Seite werden zusammen
   mit dem Seitenpfad ans QA-Tool geschickt und dort unter "Erfasste Texte
   aus dem Airbnb-Editor" angezeigt.
2. Im QA-Tool kann jeder Text als Umformulierung eingereicht werden (Textfeld
   vorausgefüllt mit dem aktuellen Wert — hier die KI-generierte oder von
   Hand verbesserte Version eintragen und "als Vorschlag einreichen").
3. Eine **zweite** Person prüft und gibt frei (Vier-Augen-Prinzip, wie bei
   allen anderen Korrekturen in diesem Tool — niemand kann den eigenen
   Vorschlag freigeben).
4. Zurück auf genau der Editor-Unterseite, von der das Feld stammt, auf
   **"Freigegebene Texte hier einfüllen"** klicken — die Extension holt die
   freigegebenen Vorschläge für diese Seite und trägt sie ins jeweilige Feld
   ein (rot umrandet zur Kontrolle).
5. **Wichtig:** Die Extension klickt **nie** selbst auf Airbnbs "Save" /
   "Speichern". Das Einfüllen ist absichtlich nur Vorbereitung — du prüfst
   den eingefüllten Text und speicherst selbst in Airbnb. Danach im QA-Tool
   den Vorschlag als "umgesetzt" markieren.

Es wird also nie automatisch etwas in Airbnb gespeichert oder abgeschickt —
nur gelesen (Schritt 1) bzw. ins Formularfeld eingetragen, ohne zu speichern
(Schritt 4).
