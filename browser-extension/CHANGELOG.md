# Changelog – OTA QA-Tool Browser-Extension

Alle nennenswerten Änderungen an der Extension. Versionsnummer folgt
`major.minor.patch` (SemVer-artig, aber informell): `patch` für Bugfixes,
`minor` für neue Funktionen, `major` für Breaking Changes (z. B. wenn
gespeicherte Felder aus alten Versionen nicht mehr kompatibel sind).

Die laufende Version steht immer unten rechts im eingeblendeten Status-Widget
auf jeder Airbnb-Editor-Seite — damit ist auf einen Blick erkennbar, ob eine
neu geladene Version tatsächlich aktiv ist (chrome://extensions → Neu laden
lädt nur das, was aktuell im entpackten Ordner liegt; die Zip muss davor
dort entpackt worden sein).

## 1.7.0 – 2026-08-11

- Neu: **Zimmer/Betten automatisch aus "Sleeping arrangements" befüllen.**
  Die Extension liest beim Hintergrund-Scan zusätzlich die Editor-Unterseite
  "Sleeping arrangements" (Add sleeping arrangements-Widget) — dort listet
  Airbnb IMMER alle Schlafzimmer + den Wohnbereich auf, inklusive noch leerer
  Räume ("Add details"), zusammen mit der dort tatsächlich hinterlegten
  Bettenkonfiguration (z. B. "1 queen bed", "1 sofa bed"). Das QA-Tool
  gleicht das automatisch mit der Zimmer-Tabelle ab (neues Zimmer wird
  angelegt, bestehendes per Name aktualisiert) — der Konsistenz-Check
  Kopfzeile vs. Fotorundgang/Sleeping arrangements funktioniert damit ohne
  manuelles Nacherfassen jedes einzelnen Zimmers.
- Fix/Hinweis: Beim Klicken zwischen einzelnen Zimmern zeigte die Seite kurz
  noch die Betten-Angabe des vorher geöffneten Zimmers (React-Re-Render nicht
  abgeschlossen) — deshalb liest diese neue Erfassung bewusst die
  konsolidierte "Add sleeping arrangements"-Übersicht auf einen Blick statt
  einzelne Zimmer nacheinander anzuklicken.

## 1.6.0 – 2026-08-11

- Neu: **Ausstattung (Amenities) erfassen.** Die Extension liest auf der
  Editor-Unterseite "Amenities" die vollständige, bereits gesetzte Liste
  (Name + Kurzbeschreibung je Merkmal) — sowohl beim manuellen "An OTA
  QA-Tool senden" als auch automatisch beim Hintergrund-Scan (jetzt zusätzlich
  zu Photo tour/Description/Title). Airbnb zeigt im Editor selbst nirgends
  eine Liste "aller möglichen" Merkmale (nur das bereits Gesetzte, mit einem
  Minus-Symbol zum Entfernen) — das QA-Tool baut diesen Katalog deshalb aus
  echten Scans selbst auf: jeder neu gesehene Name (über alle gescannten
  Airbnb-Inserate hinweg) landet in einem wachsenden, gemeinsamen Katalog.
  Pro Inserat zeigt das QA-Tool jetzt "Ausstattung" (aktuell gesetzt) und
  "Zusätzlich möglich" (Katalog abzüglich der hier bereits gesetzten
  Merkmale) an. Wie überall: nur gelesen, nichts wird automatisch in Airbnb
  geändert.

## 1.5.0 – 2026-08-10

- Neu: **Automatischer Hintergrund-Scan für Airbnb** (Extension-Optionen →
  "Automatischer Scan starten"). Liest alle Airbnb-Kanäle mit hinterlegter
  Listing-ID automatisch aus einem eigenen Hintergrund-Tab: navigiert selbst
  durch "Photo tour"/"Description"/"Title", klickt auf der Description-Seite
  automatisch durch alle Unterpanels ("Listing description"/"Your
  property"/...) und sendet alles ans QA-Tool — ohne dass man selbst
  Seiten wechseln oder Buttons klicken muss. Läuft auf der Optionsseite
  (nicht im Service Worker), damit ein mehrminütiger Scan über viele Listings
  nicht durch Chromes Service-Worker-Timeout abgebrochen wird.
  Live geprüft: Airbnb erlaubt (im Gegensatz zu Booking.com) sowohl direkte
  URL-Navigation als auch skriptgestützte Klicks ohne Login-Sperre — bleibt
  deshalb bewusst **Airbnb-exklusiv**. Booking.coms Extranet löst bei
  Skript-Navigation eine erneute Passwort-Abfrage aus und lässt sich deshalb
  nicht unbeaufsichtigt automatisieren; dort bleibt es beim manuellen "An OTA
  QA-Tool senden" pro Unterkunft.

## 1.4.0 – 2026-08-10

- Neu: Booking.com-Unterstützung (bisher nur Airbnb). Läuft auf der
  Extranet-Profilseite ("Property" → "Your profile") einer Unterkunft und
  erfasst dort die drei echten Freitext-Felder ("About the property"/
  "About the host"/"About the neighbourhood", je Sprache) plus den
  Unterkunftsnamen — inkl. nativem Zeichenlimit, genau wie bei Airbnb.
  WICHTIG: Booking.coms "Property description" und "Room descriptions"
  werden automatisch aus den hinterlegten Facilities/Amenities generiert
  und sind NICHT frei editierbar (nur "Request a correction" für
  Tippfehler) — die Extension kann und soll diese deshalb nicht erfassen.
  Foto-Alt-Text-Scan (wie bei Airbnb) ist für Booking.com noch nicht
  umgesetzt, da die Fotoseite dort strukturell anders aufgebaut ist.

## 1.3.0 – 2026-08-10

- Neu: Beim Erfassen der Texte ("alle Texte im Inserat") wird jetzt pro Feld
  zusätzlich Airbnbs natives Zeichenlimit (maxlength-Attribut, z. B. 50 beim
  Titel) mitgelesen und ans QA-Tool übermittelt. Das Tool zeigt das Limit an,
  lässt die KI-Umformulierung sich daran halten und warnt beim Zurückschreiben
  freigegebener Texte, falls ein Feld trotzdem über dem Limit liegt.

## 1.2.0 – 2026-08-10

- Fix: Das Status-Widget sass fest unten rechts und verdeckte dort teilweise
  Airbnb-eigene Bedienelemente (z. B. den Chat-Button), die dadurch nicht mehr
  klickbar waren.
- Neu: Widget per Griff (⠿ oben im Widget) frei verschiebbar — die Position
  wird gemerkt (auch über Seitenwechsel/Neuladen hinweg) und beim nächsten
  Besuch automatisch wieder angewendet.
- Neu: Widget lässt sich per "–"/"+"-Knopf auf ein kleines Icon einklappen,
  falls es gerade gar nicht stören soll (Zustand wird ebenfalls gemerkt).

## 1.1.0 – 2026-08-08

- Fix: Airbnb verwendet auf Seiten mit mehreren Unterpanels (z. B.
  "Description" → "Listing description"/"Your property"/"Guest access"/...)
  für die Textfelder in JEDEM Panel dieselbe HTML-id. Ohne Erkennung, welches
  Panel gerade offen ist, überschrieb das Senden eines Panels unbemerkt die
  vorher erfassten Texte eines anderen Panels. Die Extension erkennt jetzt
  über die Panel-Überschrift, welches Panel offen ist, und macht die
  Feld-id damit eindeutig.
- Fix: Alt-Text-Bildabruf schlug immer fehl (HTTP 404), weil Airbnbs
  Bild-CDN nur bestimmte Breiten ausliefert (`im_w=960` statt `im_w=1280`).
- Fix: Zimmername beim Alt-Text-Scan zeigte immer "Listing editor" statt des
  echten Raumnamens.
- Metadaten: Version/Author/Changelog ergänzt, Version im Status-Widget
  sichtbar.

## 1.0.0 – 2026-08-07

- Erste Version: Fotorundgang- und Sleeping-Arrangements-Erfassung,
  generische Text-Erfassung ("alle Texte im Inserat"), Rückschreiben
  freigegebener Vorschläge, automatischer Alt-Text-Foto-Scan per
  Claude-Vision.
