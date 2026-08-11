# OTA QA-Tool – Airbnb & Booking.com Host-Editor Import (Chrome-Extension)

Liest im eingeloggten Airbnb-Host-Editor die Felder, die öffentlich nie sichtbar
sind (Fotorundgang-Zimmerliste, "Sleeping arrangements", Gästezahl, Kopfzeile
"X bedrooms · Y beds · Z baths") sowie im eingeloggten Booking.com-Extranet die
freien Profil-Textfelder ("About the property"/"About the host"/"About the
neighbourhood") und sendet sie an das ota-qa-tool. Es wird nichts auf
airbnb.com oder booking.com verändert — nur gelesen (bzw. beim Zurückschreiben
freigegebener Texte nur ins Formularfeld eingetragen, nie gespeichert).

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

## Ausstattung (Amenities)

Die Extension liest auf der Editor-Unterseite "Amenities" die vollständige,
bereits gesetzte Liste (Name + Kurzbeschreibung je Merkmal, z. B. "Air
conditioning – Split type ductless system.") — beim manuellen "An OTA
QA-Tool senden" genauso wie beim automatischen Hintergrund-Scan (siehe unten).
Airbnb zeigt im Editor selbst nirgends eine Liste "aller möglichen"
Ausstattungsmerkmale unabhängig von einem konkreten Inserat (nur das bereits
Gesetzte, mit einem Minus-Symbol zum Entfernen, live geprüft). Das QA-Tool
baut diesen Katalog deshalb aus echten Scans selbst auf: jeder neu gesehene
Name landet in einem gemeinsamen, über alle gescannten Airbnb-Inserate
wachsenden Katalog. Im QA-Tool wird pro Inserat sowohl die aktuell gesetzte
Ausstattung als auch "Zusätzlich möglich" (Katalog abzüglich des bereits
Gesetzten) angezeigt — je mehr Inserate gescannt sind, desto vollständiger
wird der Katalog von selbst. Auch hier: nur gelesen, nichts wird automatisch
in Airbnb verändert.

## Automatischer Hintergrund-Scan (nur Airbnb)

Statt für jedes Listing selbst zu navigieren und "An OTA QA-Tool senden" zu
klicken, kann die Extension alle Airbnb-Kanäle mit hinterlegter Listing-ID
automatisch im Hintergrund durchscannen:

1. Im QA-Tool bei allen betreffenden Airbnb-Kanälen die **Airbnb Listing-ID**
   hinterlegen (siehe oben).
2. Extension-Optionen öffnen → Abschnitt "Automatischer Scan (Airbnb)" →
   in der Liste "Zu scannende Listings" bei Bedarf einzelne Listings
   abwählen (Standard: alle ausgewählt; Suchfeld hilft bei vielen Listings)
   → **"Scan starten"** klicken.
3. Die Extension öffnet einen eigenen Hintergrund-Tab, navigiert dort selbst
   nacheinander zu "Photo tour", "Description" (inkl. automatischem
   Durchklicken aller Unterpanels: "Listing description"/"Your property"/
   "Guest access"/"Interaction with guests"/"Other details to note"), "Title"
   und "Amenities" jedes Listings, liest die Felder aus und sendet sie ans
   QA-Tool — identisch zum manuellen "An OTA QA-Tool senden", nur automatisiert.
4. Der Live-Log auf der Optionsseite zeigt den Fortschritt; "Scan abbrechen"
   stoppt nach dem aktuell laufenden Listing. Die Optionsseite muss während
   des Scans offen bleiben (der Scan läuft dort, nicht im Hintergrundprozess,
   damit ein mehrminütiger Lauf nicht durch Chromes Service-Worker-Timeout
   abbricht).
5. Wie überall in diesem Tool: **nichts wird automatisch in Airbnb
   gespeichert** — der Scan liest nur, das Vier-Augen-Prinzip für Text-
   Umformulierungen bleibt unverändert.

**Nur Airbnb:** Booking.coms Extranet löst bei jeder skriptgestützten
Navigation (auch mit gültigem Session-Token) eine erneute Passwort-Abfrage
aus — live geprüft, kein Umgehen ohne das Passwort selbst einzugeben (was
diese Extension aus Sicherheitsgründen nie tut). Bei Booking.com bleibt es
deshalb beim manuellen "An OTA QA-Tool senden" pro Unterkunft.

## Booking.com

Booking.com hat ein grundsätzlich anderes Content-Modell als Airbnb:
"Property description" und "Room descriptions" werden **automatisch aus den
hinterlegten Facilities/Amenities generiert** und sind dort **nicht frei
editierbar** (nur "Request a correction" für Tippfehler, von Booking-
Redakteuren geprüft, ~6 Tage Bearbeitungszeit). Die Extension erfasst deshalb
nicht diese Seite, sondern die Extranet-Seite **"Property" → "Your profile"**
(bzw. "View your descriptions" → "Go to host profile") — dort gibt es echte,
freie Textfelder je Sprache:

- **About the property** (Feld-id `hotelier-message-<sprache>-welcome_message`)
- **About the host** (`…-owner_info`)
- **About the neighbourhood** (`…-neighborhood_info`)
- **Host name** (`name-or-company`)

jeweils mit nativem Zeichenlimit (aktuell 2000 bzw. 80 Zeichen) — genau wie
bei Airbnb wird das Limit erfasst, an die KI-Umformulierung durchgereicht und
beim Zurückschreiben geprüft.

Ablauf identisch zu Airbnb: auf der Profilseite der Unterkunft
(`admin.booking.com/.../property_profile.html?hotel_id=<ID>`) auf **"An OTA
QA-Tool senden"** klicken (Abgleich läuft über `hotel_id` = dieselbe
Property-ID wie in MyDataValue/Elev8), im QA-Tool Umformulierungen einreichen
und per Vier-Augen-Prinzip freigeben, dann auf derselben Seite **"Freigegebene
Texte hier einfüllen"** klicken und selbst in Booking.com speichern.

**Noch nicht umgesetzt:** ein Foto-Alt-Text-Scan wie bei Airbnb, sowie das
strukturierte Erfassen von Zimmer-/Bettenzahl (Booking.com bildet das über
verschachtelte Bettentyp-/Anzahl-Dropdowns pro Schlafzimmer ab, nicht über
einfache Zahlenfelder wie Airbnb — das bräuchte eine eigene Erfassungslogik).
