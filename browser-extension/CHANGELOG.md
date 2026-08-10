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
