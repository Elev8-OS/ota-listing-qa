// Läuft auf jeder Airbnb-Host-Editor-Seite (echte, eingeloggte Session der
// Person). Liest:
//   1) auf der Fotorundgang-Seite die Felder, die öffentlich nie sichtbar
//      sind (Fotorundgang-Zimmerliste, Sleeping arrangements) per Text-
//      Heuristik aus document.body.innerText.
//   2) auf JEDER Editor-Unterseite (Title, Description-Unterpanels wie
//      "Listing description"/"Your property", ...) generisch alle
//      <textarea>/<input type=text>-Felder mit HTML-id ("alle Texte im
//      Inserat"). Diese generische Erfassung ist bewusst nicht auf
//      bestimmte Felder hartkodiert, weil Airbnb viele solcher Textfelder
//      hat und sich deren ids/Struktur ändern können.
//   3) auf der Fotoraum-Übersicht (z. B. .../photo-tour/<raum-id>, die Seite
//      mit dem Foto-Grid eines Raums) auf Wunsch automatisch jedes Foto
//      dieses Raums: klickt nacheinander jedes Foto auf, liest dessen
//      Editor-Pfad (enthält die feste Foto-ID) + Bild-URL aus und klickt
//      wieder zurück zum Grid — schickt dann alle gesammelten Fotos ans
//      QA-Tool, das per Claude-Vision einen Alt-Text-Vorschlag ("visual
//      description") pro Foto erzeugt. Es wird dabei nirgends "Save"
//      geklickt oder ein Airbnb-Feld verändert — nur geklickt, um zur
//      jeweiligen Foto-Detailseite zu navigieren und wieder zurück.
// Schickt (1)+(2) und (3) an den Hintergrundprozess, der es ans QA-Tool
// weiterleitet. Ein weiterer Button liest freigegebene Text-Vorschläge vom
// QA-Tool und trägt sie (nur) ins jeweilige Feld ein — Speichern in Airbnb
// bleibt bewusst ein manueller Schritt der Person.
//
// Es wird nichts auf airbnb.com automatisch gespeichert/abgeschickt.

(function () {
  function extractListingId() {
    const m = location.pathname.match(/\/hosting\/listings\/editor\/(\d+)/);
    return m ? m[1] : null;
  }

  // Auf Seiten mit einer Liste von Unterpanels (z. B. "Description" →
  // "Listing description" / "Your property" / "Guest access" / ...)
  // verwendet Airbnb für die Textfelder in JEDEM Unterpanel DIESELBEN
  // HTML-ids (z. B. immer "listing-description-Deutsch-textarea", egal
  // welches der Panels gerade offen ist) — live gefunden, kritischer Bug:
  // ohne Erkennung, welches Panel offen ist, überschreibt das Senden von
  // "Your property" unbemerkt die vorher gesendeten Werte von "Listing
  // description" im QA-Tool, weil beide unter demselben Feld-Schlüssel
  // landen ("es kommt nur der Titel an, nicht alle Texte" — der eigentliche,
  // tiefere Grund dahinter). Erkennung rein über Position (nicht über den
  // Text/Wortlaut, der sich ändern kann): Ist eine zweite, weiter rechts
  // liegende sichtbare Überschrift vorhanden (das offene Panel), zusätzlich
  // zur Seiten-Überschrift links, wird ihr Text als Präfix vor die id
  // gesetzt, damit gleiche ids aus verschiedenen Panels nicht kollidieren.
  function getOpenPanelLabel() {
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .map((h) => ({ text: h.textContent.trim(), rect: h.getBoundingClientRect() }))
      .filter((h) => h.text && h.text !== "Listing editor" && h.rect.width > 0 && h.rect.height > 0);
    if (headings.length < 2) return null;
    headings.sort((a, b) => b.rect.left - a.rect.left);
    return headings[0].text;
  }

  function extractGenericTextFields() {
    const out = [];
    const panelLabel = getOpenPanelLabel();
    document.querySelectorAll("textarea, input[type='text']").forEach((el) => {
      if (!el.id) return;
      const id = panelLabel ? `${panelLabel} · ${el.id}` : el.id;
      // el.maxLength ist die native DOM-Eigenschaft für das maxlength-Attribut
      // (z. B. 50 beim Titel-Feld) — Airbnb setzt das tatsächlich als echtes
      // HTML-Attribut, deshalb kein Rätselraten über Zeichenlimits pro Feld
      // nötig. Ohne Attribut liefert der Browser laut Spec -1, das wird hier
      // zu null (= "kein bekanntes Limit").
      const maxLength = typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : null;
      out.push({ id, value: el.value || "", maxLength });
    });
    return out;
  }

  function extractPhotoTourFields() {
    const text = document.body.innerText || "";

    // WICHTIG: [\s\S]{0,60}? statt [^\n]*? zwischen den drei Zahlen — die
    // Kopfzeile im Host-Editor rendert "3 bedrooms", "4 beds", "1 bath" als
    // DREI EIGENE ZEILEN (nicht "3 bedrooms · 4 beds · 1 bath" auf einer
    // Zeile wie auf der öffentlichen Seite). Mit [^\n]*? matchte das nie,
    // Bettentyp/Schlafzimmer/Bäder blieben deshalb live immer auf 0 (Bug,
    // live gefunden). Auf 60 Zeichen begrenzt, damit es nicht quer über die
    // ganze Seite matcht.
    const summaryMatch =
      text.match(/(\d+\s*bedrooms?[\s\S]{0,60}?\d+\s*beds?[\s\S]{0,60}?\d+(?:[.,]\d)?\s*baths?)/i) ||
      text.match(/(\d+\s*Schlafzimmer[\s\S]{0,60}?\d+\s*Betten[\s\S]{0,60}?\d+(?:[.,]\d)?\s*Bad(?:ezimmer)?)/i);
    const bedroomsSummary = summaryMatch ? summaryMatch[1] : null;

    let guests = null;
    const guestsBlock =
      text.match(/Number of guests\n[^\n]*\n?(\d+)\s*guests?/i) || text.match(/(\d+)\s*guests?\b/i);
    if (guestsBlock) guests = Number(guestsBlock[1]);

    const sleepingArrangements = [];
    const sIdx = text.search(/Sleeping arrangements/i);
    const gIdx = text.search(/Number of guests/i);
    if (sIdx !== -1) {
      const end = gIdx !== -1 && gIdx > sIdx ? gIdx : sIdx + 800;
      const block = text.slice(sIdx + "Sleeping arrangements".length, end);
      const lines = block
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      // WICHTIG: Nur noch prüfen, ob lines[i+1] wie eine Betten-Zeile aussieht
      // (beginnt mit einer Zahl, enthält "bed") — NICHT mehr verlangen, dass
      // die Raum-Zeile lines[i] kein "bed" enthält. Airbnbs Standard-Namen
      // sind "Bedroom 1", "Bedroom 2", ... — die enthalten selbst "bed", die
      // alte Bedingung liess dadurch nie einen Treffer zu (Bug, live
      // gefunden: Sleeping arrangements blieb bei Standard-Zimmernamen immer
      // leer).
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d+\s.*bed/i.test(lines[i + 1])) {
          sleepingArrangements.push({ room: lines[i], beds: lines[i + 1] });
          i++;
        }
      }
    }

    const photoTourRooms = [];
    const photoRe = /\n([A-Z][A-Za-zÀ-ÿ '\/&-]{2,40})\n(?:•\s*)?(\d+)\s*photos?\b/g;
    const seen = new Set();
    let m;
    while ((m = photoRe.exec(text)) !== null) {
      const name = m[1].trim();
      if (/^\d+$/.test(name)) continue;
      const key = name + "|" + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      photoTourRooms.push({ name, photos: Number(m[2]) });
    }

    return { bedroomsSummary, guests, sleepingArrangements, photoTourRooms };
  }

  function setFieldValue(el, value) {
    // Airbnb ist eine React-App: el.value = ... allein aktualisiert nur das
    // DOM, nicht Reacts internen State. Über den nativen Value-Setter +
    // ein echtes "input"-Event zu gehen, ist der zuverlässige Weg, damit
    // React (und damit der "Save"-Button) die Änderung mitbekommt.
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.style.outline = "3px solid #e0004d";
    el.style.outlineOffset = "2px";
  }

  function simulateClick(el) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------- Automatischer Hintergrund-Scan (v1.5.0) ----------
  // Im Gegensatz zu Booking.com (Login-Sperre bei Skript-Navigation, siehe
  // README/CHANGELOG) lässt sich Airbnbs Host-Editor per direkter URL-
  // Navigation UND per skriptgestütztem .click() vollständig automatisieren
  // (live geprüft: kein Login-Wall, .click() öffnet die Description-
  // Unterpanels genauso wie ein echter Klick). options.js (der "Automatischer
  // Scan"-Bereich) nutzt das: es navigiert selbst durch alle Editor-Seiten
  // jedes Listings und schickt hierhin die Nachricht "OTA_QA_TOOL_AUTO_SCAN_PAGE" —
  // diese Funktion liest die aktuelle Seite GENAU so aus wie ein manueller
  // Klick auf "An OTA QA-Tool senden" (identisches Feld-Format), klickt aber
  // auf der Description-Seite zusätzlich selbst durch alle Unterpanels statt
  // nur das (leere) Übersichtspanel zu lesen. Es wird auch hier nirgends
  // "Save" geklickt oder etwas in Airbnb verändert — nur gelesen.
  const DESCRIPTION_PANEL_LABELS = [
    "Listing description",
    "Your property",
    "Guest access",
    "Interaction with guests",
    "Other details to note",
  ];

  function findClickableByExactText(text) {
    return [...document.querySelectorAll("button, [role='button'], a")].find(
      (el) => (el.textContent || "").trim() === text
    );
  }

  // Das Schliessen eines offenen Unterpanels läuft über einen "Back"-Button —
  // davon gibt es auf der Seite mehrere (u. a. für die Haupt-Navigation),
  // aber nur der zum offenen Panel gehörende ist sichtbar UND liegt am
  // weitesten rechts (live geprüft: liefert zuverlässig genau den richtigen).
  function findVisibleBackButton() {
    const backs = [...document.querySelectorAll('button[aria-label="Back"], [role="button"][aria-label="Back"]')]
      .map((b) => ({ el: b, rect: b.getBoundingClientRect() }))
      .filter((b) => b.rect.width > 0 && b.rect.height > 0);
    if (!backs.length) return null;
    backs.sort((a, b) => b.rect.left - a.rect.left);
    return backs[0].el;
  }

  // Klickt nacheinander jedes der fünf bekannten Description-Unterpanels auf,
  // liest dessen Textfeld(er) (inkl. Panel-Präfix über getOpenPanelLabel(),
  // siehe oben) und schliesst es wieder, bevor das nächste geöffnet wird —
  // dieselbe Reihenfolge/Wartezeit, die live als zuverlässig geprüft wurde.
  // Fehlt ein Panel bei einem bestimmten Listing (z. B. weil Airbnb das Panel
  // je Listing-Typ unterschiedlich anzeigt), wird es einfach übersprungen statt
  // den ganzen Scan abzubrechen.
  async function autoScanDescriptionPanels() {
    const collected = [];
    for (const label of DESCRIPTION_PANEL_LABELS) {
      const btn = findClickableByExactText(label);
      if (!btn) continue;
      btn.click();
      await sleep(1400);
      collected.push(...extractGenericTextFields());
      const backBtn = findVisibleBackButton();
      if (backBtn) {
        backBtn.click();
        await sleep(900);
      }
    }
    return collected;
  }

  // ---------- Ausstattung ("Amenities") — v1.6.0 ----------
  // Airbnb zeigt auf .../details/amenities die vollständige, bereits gesetzte
  // Liste ("You've added these to your listing so far") als Name+Kurz-
  // beschreibung-Paare in reinem Fliesstext (kein festes DOM-Schema, wie beim
  // Rest dieser Extraktion) — live geprüft: das zugehörige "Edit"-Panel zeigt
  // ausschliesslich das bereits Gesetzte mit einem Minus-Symbol zum
  // Entfernen, KEINE Checkliste der noch nicht gewählten, "möglichen"
  // Merkmale. Airbnb bietet also nirgends im Editor eine Liste "aller
  // möglichen" Ausstattungsmerkmale unabhängig von einem konkreten Inserat.
  // Das QA-Tool baut diesen Katalog deshalb selbst auf: der Server sammelt
  // über ALLE gescannten Airbnb-Inserate hinweg jeden bisher gesehenen Namen
  // (siehe lib/amenities.js) und zeigt pro Inserat die Differenz an — je mehr
  // Inserate gescannt sind, desto vollständiger wird der Katalog von selbst.
  //
  // Zum sicheren Trennen von "Name"- und "Beschreibungs"-Zeilen im Fliesstext
  // dient eine Startliste bekannter Namen (live aus einem echten Inserat
  // ausgelesen) plus eine Heuristik für noch unbekannte Namen: Airbnbs
  // Namen sind immer kurz, enthalten nie einen Aufzählungspunkt/Punkt am Ende
  // und sind nie in Satzform ("A device that...") — Beschreibungen sind fast
  // immer genau das Gegenteil.
  const KNOWN_AMENITY_NAMES = [
    "Air conditioning", "Backyard", "BBQ grill", "Bed linens", "Board games", "Books and reading material",
    "Carbon monoxide alarm", "Cleaning available during stay", "Cleaning products", "Clothing storage",
    "Coffee maker", "Conditioner", "Crib", "Dedicated workspace", "Dining table", "Dishes and silverware",
    "Dishwasher", "Dryer", "Elevator", "Essentials", "Ethernet connection", "EV charger", "Fire extinguisher",
    "First aid kit", "Free parking on premises", "Hair dryer", "Hangers", "Heating", "Hot water",
    "Hot water kettle", "Iron", "Kitchen", "Laundromat nearby", "Long term stays allowed",
    "Luggage dropoff allowed", "Outdoor dining area", "Outdoor furniture", "Oven", "Paid parking off premises",
    "Patio or balcony", "Private entrance", "Private living room", "Refrigerator", "Room-darkening shades",
    "Shampoo", "Shower gel", "Single level home", "Smoke alarm", "Stove", "TV", "Washer", "Wifi",
  ];

  function looksLikeAmenityName(line, knownNames) {
    if (knownNames.has(line)) return true;
    if (/\.\s*$/.test(line)) return false; // "Cotton.", "Central heating." — Attribut-Notizen enden auf einen Punkt, Namen nie.
    if (line.length > 34) return false; // Beschreibungen sind praktisch immer länger als Airbnbs kurze Namen.
    if (line.includes("•")) return false; // Attribut-Aufzählungen ("Miele • Induction • ...").
    if (/^(A|An)\s[a-z]/.test(line)) return false; // "A device that...", "An entrance that..." — Satzform.
    if (/,/.test(line) && /\band\b/i.test(line)) return false; // "Plates, bowls, cups, ... and other utensils".
    return true;
  }

  // Der isolierte Container um die "Amenities"-Überschrift (nicht das ganze
  // document.body.innerText, das auch die linke Navigationsspalte enthält) —
  // per Höhenwanderung von der Überschrift aus gefunden, weil Airbnbs
  // CSS-Klassen automatisch generiert und damit als Selektor unbrauchbar sind
  // (gleiches Problem/gleiche Lösung wie bei getOpenPanelLabel() oben).
  function findAmenitiesContainer() {
    const headings = [...document.querySelectorAll("h1, h2, h3, h4")].filter((h) => h.textContent.trim() === "Amenities");
    for (const h of headings) {
      let el = h;
      for (let i = 0; i < 6 && el; i++) {
        if (el.innerText && el.innerText.length > 200) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  // Steuer-Beschriftungen, die vor der eigentlichen Liste stehen (Überschrift
  // "Amenities", der "Edit"-Link) — MÜSSEN vor dem Namen/Beschreibung-Split
  // entfernt werden: "Edit" alleine sieht sonst selbst wie ein gültiger, sehr
  // kurzer Name aus und würde den folgenden Einleitungssatz ("You've added
  // these to your listing so far.") fälschlich als dessen Beschreibung
  // einziehen und damit die gesamte restliche Zuordnung verschieben (live
  // gefunden beim Testen dieser Extraktion).
  const AMENITY_CONTROL_LABELS = new Set(["Amenities", "Edit", "Done"]);

  function extractAmenities(extraKnownNames) {
    const container = findAmenitiesContainer();
    if (!container) return [];
    const known = new Set(KNOWN_AMENITY_NAMES.concat(extraKnownNames || []));
    const lines = container.innerText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !AMENITY_CONTROL_LABELS.has(l));
    // Vor dem ersten echten Merkmal steht nur noch der Einleitungssatz
    // "You've added these to your listing so far." — bis zum ersten
    // erkannten Namen überspringen statt fix zu zählen, damit kleine
    // Textänderungen bei Airbnb nichts kaputt machen.
    const startIndex = lines.findIndex((l) => looksLikeAmenityName(l, known));
    if (startIndex === -1) return [];
    const items = [];
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (!looksLikeAmenityName(line, known)) continue; // Sicherheitsnetz, sollte durch die Logik unten nicht vorkommen.
      const next = lines[i + 1];
      let description = null;
      if (next && !looksLikeAmenityName(next, known)) {
        description = next;
        i++;
      }
      items.push({ name: line, description });
    }
    return items;
  }

  // Vor dem Erfassen der Amenities einmal den serverseitig gewachsenen
  // Katalog (siehe oben) holen, damit auch bei DIESEM Listing neu
  // dazugekommene, dem hartkodierten KNOWN_AMENITY_NAMES noch unbekannte
  // Namen zuverlässig als "Name" statt als Beschreibung erkannt werden.
  function fetchAmenityCatalog() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "OTA_QA_TOOL_FETCH_AMENITY_CATALOG" }, (response) => {
          resolve(response && response.ok && Array.isArray(response.items) ? response.items : []);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  // ---------- Zimmer/Betten aus der Seite "Sleeping arrangements" — v1.7.0 ----------
  // Ausgangslage: die bisherige Erfassung (extractPhotoTourFields, oben) liest
  // auf der Fotorundgang-Übersichtsseite nur Zimmernamen + Fotoanzahl, sowie
  // – als reinen Fliesstext-Hinweis, NICHT strukturiert – einen "Sleeping
  // arrangements"-Textblock, der dort aber unvollständig ist (Räume ohne
  // Bett fehlen ganz). Airbnb hat dafür eine eigene Editor-Unterseite
  // (.../details/sleeping-arrangements), die IMMER alle schlafraum-fähigen
  // Räume (Schlafzimmer + Wohnbereich) auflistet, inkl. der noch leeren
  // ("Add details") — live geprüft an einem echten Inserat mit 2 Schlafzimmern
  // + Wohnbereich mit Sofa-Bett. WICHTIG dabei live gefunden: ohne Wartezeit
  // nach jedem Klick zeigte die Seite kurz noch die Betten-Angabe des vorher
  // geöffneten Zimmers (React-Re-Render nicht abgeschlossen) — deshalb bei
  // jeder Automatisierung, die zwischen Zimmern klickt, immer erst kurz
  // warten, bevor der Text gelesen wird (gleiches Prinzip wie bei
  // autoScanDescriptionPanels oben).
  //
  // Diese Seite selbst braucht dafür gar keine Einzel-Zimmer-Klicks: das
  // Widget "Add sleeping arrangements" zeigt bereits alle Räume mit ihrer
  // jeweiligen Betten-Angabe (oder "Add details", falls noch keine gesetzt)
  // auf einen Blick.
  function isSleepingStatusLine(line) {
    return /^\d+\s.*\bbeds?\b/i.test(line) || /^add details$/i.test(line);
  }

  function findSleepingArrangementsContainer() {
    const headings = [...document.querySelectorAll("h1, h2, h3, h4")].filter(
      (h) => h.textContent.trim() === "Add sleeping arrangements"
    );
    for (const h of headings) {
      let el = h;
      for (let i = 0; i < 6 && el; i++) {
        if (el.innerText && el.innerText.length > 60) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  // Liefert pro Raum { room, bedsText } — bedsText ist null, wenn Airbnb dort
  // noch "Add details" zeigt (kein Bett hinterlegt). Funktioniert unabhängig
  // von Zimmeranzahl/-namen: paart einfach jede Nicht-Status-Zeile mit der
  // direkt folgenden Status-Zeile (Zahl+"bed(s)" oder "Add details") — genau
  // dieselbe Heuristik wie beim bestehenden (unvollständigen) Sleeping-
  // arrangements-Block in extractPhotoTourFields.
  function extractSleepingArrangementsRooms() {
    const container = findSleepingArrangementsContainer();
    if (!container) return [];
    const lines = container.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!isSleepingStatusLine(lines[i]) && isSleepingStatusLine(lines[i + 1])) {
        out.push({ room: lines[i], bedsText: /^add details$/i.test(lines[i + 1]) ? null : lines[i + 1] });
        i++;
      }
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "OTA_QA_TOOL_AUTO_SCAN_PAGE") return false;
    (async () => {
      const listingId = extractListingId();
      if (!listingId) {
        sendResponse({ ok: false, error: "Keine Listing-ID in der URL gefunden." });
        return;
      }
      // Auf der Description-Seite sind die Unterpanel-Buttons vorhanden — dort
      // automatisch durchklicken. Auf allen anderen Seiten (Title, Photo tour,
      // ...) reicht die generische Erfassung der bereits sichtbaren Felder.
      const hasDescriptionPanels = DESCRIPTION_PANEL_LABELS.some((label) => findClickableByExactText(label));
      const rawTextInputs = hasDescriptionPanels ? await autoScanDescriptionPanels() : extractGenericTextFields();
      const fields = { ...extractPhotoTourFields(), page: location.pathname, rawTextInputs };
      if (findAmenitiesContainer()) {
        const catalog = await fetchAmenityCatalog();
        fields.amenities = extractAmenities(catalog);
      }
      if (findSleepingArrangementsContainer()) {
        fields.sleepingArrangementsRooms = extractSleepingArrangementsRooms();
      }
      sendResponse({ ok: true, listingId, fields });
    })();
    return true; // Antwort kommt asynchron (Panel-Klicks brauchen Zeit).
  });

  // Ist dies die Foto-Grid-Seite eines einzelnen Raums (z. B. .../details/
  // photo-tour/790119223), NICHT die Detailseite eines einzelnen Fotos
  // (.../space-photo/<id>) und nicht die Fotorundgang-Übersicht aller Räume?
  function isRoomPhotoGridPage() {
    return /\/details\/photo-tour\/\d+$/.test(location.pathname);
  }

  function getRoomLabel() {
    // WICHTIG: Nicht einfach das erste h1/h2 nehmen — die Raum-Detailseite
    // hat ZUSÄTZLICH zum sichtbaren Raumnamen (z. B. "Dining area") ein
    // global-verstecktes <h1>Listing editor</h1> (rect 0,0) UND ein
    // sichtbares <h1>Photo tour</h1> VOR dem eigentlichen Raum-<h2> im DOM.
    // document.querySelector("h1, h2") matchte deshalb live immer
    // "Listing editor" statt des Raumnamens (Bug, live gefunden). Jetzt:
    // über alle Überschriften iterieren, bekannte statische Seitentitel
    // überspringen und nur eine tatsächlich sichtbare (Breite/Höhe > 0)
    // Überschrift zurückgeben.
    const headings = [...document.querySelectorAll("h1, h2, h3")];
    for (const h of headings) {
      const text = h.textContent.trim();
      if (!text || text === "Listing editor" || text === "Photo tour") continue;
      const r = h.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return text;
    }
    return null;
  }

  function findRoomThumbnails() {
    // Grössere Fotos im rechten Hauptbereich (nicht die Raum-Navigation
    // links, die auf derselben Seite ebenfalls Miniaturbilder zeigt).
    return [...document.querySelectorAll("img")].filter((img) => {
      if (!/\/original\//.test(img.src)) return false;
      const r = img.getBoundingClientRect();
      return r.left > 400 && r.width > 100;
    });
  }

  function findCloseButton() {
    return [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Close");
  }

  function upscaleImageUrl(src) {
    // WICHTIG: Airbnbs Bild-CDN (muscache.com) liefert nur eine feste Liste
    // erlaubter im_w-Breiten aus — live per direktem HTTP-Test geprüft:
    // 240/480/720/960 -> 200 OK, aber 640/750/800/1024/1080/1280 -> 404.
    // 1280 (der alte Wert hier) 404t deshalb immer, wodurch der Alt-Text-Scan
    // nie ein Bild laden konnte (Bug, live gefunden). 960 ist die höchste
    // bestätigt funktionierende Breite.
    return src.replace(/im_w=\d+/, "im_w=960");
  }

  // Klickt nacheinander jedes Foto im aktuellen Raum-Grid auf, liest dessen
  // Editor-Pfad (feste Foto-ID) + Bild-URL, klickt wieder zurück. Liest nur —
  // es wird nirgends ein Airbnb-Feld verändert oder "Save" geklickt.
  async function collectRoomPhotos(setStatus) {
    const items = [];
    const startPath = location.pathname;
    const count = findRoomThumbnails().length;
    for (let i = 0; i < count && i < 40; i++) {
      const thumbs = findRoomThumbnails();
      if (i >= thumbs.length) break;
      setStatus(`Foto ${i + 1}/${count} wird geöffnet …`);
      simulateClick(thumbs[i]);
      await sleep(1000);
      if (location.pathname === startPath) {
        // Navigation hat nicht geklappt (z. B. Layout anders als erwartet) — abbrechen statt zu raten.
        setStatus(`Foto ${i + 1}/${count}: Konnte Detailseite nicht öffnen, breche ab.`);
        break;
      }
      const mainImg = [...document.querySelectorAll("img")].find((img) => /\/original\//.test(img.src));
      if (mainImg) {
        items.push({ path: location.pathname, imageUrl: upscaleImageUrl(mainImg.src) });
      }
      const closeBtn = findCloseButton();
      if (closeBtn) {
        simulateClick(closeBtn);
      } else {
        history.back();
      }
      await sleep(800);
    }
    return items;
  }

  // Widget ist per Drag-Griff frei verschiebbar (Position wird über
  // chrome.storage.local gemerkt) und lässt sich auf ein kleines Icon
  // einklappen — beides, weil das Widget standardmässig unten rechts sitzt
  // und dort teilweise Airbnb-eigene Bedienelemente (z. B. den Chat-Button)
  // verdeckt und damit unklickbar macht (live gemeldet). Ohne Verschieben/
  // Einklappen bliebe das ein Dauerproblem, weil sich Airbnbs Layout von
  // Seite zu Seite unterscheidet und "ein fester Ort, der nie stört" gar
  // nicht existiert.
  const WIDGET_STORAGE_KEY = "otaQaToolWidgetState";

  function clampToViewport(left, top, width, height) {
    const maxLeft = Math.max(0, window.innerWidth - width - 4);
    const maxTop = Math.max(0, window.innerHeight - height - 4);
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
  }

  function saveWidgetState(state) {
    try {
      chrome.storage.local.set({ [WIDGET_STORAGE_KEY]: state });
    } catch (e) {
      // Storage evtl. nicht verfügbar (z. B. Extension wird gerade neu geladen) — Position geht dann nur für diesen Moment verloren.
    }
  }

  function makeDraggable(wrap, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = wrap.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      handle.style.cursor = "grabbing";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = wrap.getBoundingClientRect();
      const { left, top } = clampToViewport(
        startLeft + (e.clientX - startX),
        startTop + (e.clientY - startY),
        rect.width,
        rect.height
      );
      wrap.style.left = left + "px";
      wrap.style.top = top + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = "grab";
      const rect = wrap.getBoundingClientRect();
      saveWidgetState({ left: rect.left, top: rect.top, collapsed: wrap.dataset.collapsed === "1" });
    });

    // Falls das Fenster verkleinert wird, Widget wieder in den sichtbaren Bereich holen statt es ausserhalb hängen zu lassen.
    window.addEventListener("resize", () => {
      const rect = wrap.getBoundingClientRect();
      const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
      wrap.style.left = left + "px";
      wrap.style.top = top + "px";
    });
  }

  function injectUi() {
    if (!document.getElementById("ota-qa-tool-import-wrap")) {
      const wrap = document.createElement("div");
      wrap.id = "ota-qa-tool-import-wrap";
      wrap.dataset.collapsed = "0";
      // Position vorerst nur ein Platzhalter (unten rechts, wie bisher) —
      // die tatsächliche, gemerkte Position wird gleich unten asynchron aus
      // chrome.storage.local nachgeladen und überschreibt das.
      wrap.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;gap:6px;max-width:320px";

      const header = document.createElement("div");
      header.style.cssText =
        "display:flex;align-items:center;justify-content:flex-end;gap:4px";

      const dragHandle = document.createElement("div");
      dragHandle.title = "Ziehen, um das Widget zu verschieben";
      dragHandle.textContent = "⠿";
      dragHandle.style.cssText =
        "background:#111;color:#fff;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:grab;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.25);user-select:none";

      const collapseBtn = document.createElement("button");
      collapseBtn.type = "button";
      collapseBtn.title = "Widget einklappen/ausklappen";
      collapseBtn.textContent = "–";
      collapseBtn.style.cssText =
        "background:#111;color:#fff;width:22px;height:22px;border-radius:6px;border:none;cursor:pointer;font-size:14px;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.25)";

      const body = document.createElement("div");
      body.id = "ota-qa-tool-body";
      body.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:8px";

      collapseBtn.addEventListener("click", () => {
        const collapsedNow = wrap.dataset.collapsed === "1";
        const nextCollapsed = !collapsedNow;
        wrap.dataset.collapsed = nextCollapsed ? "1" : "0";
        body.style.display = nextCollapsed ? "none" : "flex";
        collapseBtn.textContent = nextCollapsed ? "+" : "–";
        collapseBtn.title = nextCollapsed ? "Widget ausklappen" : "Widget einklappen";
        const rect = wrap.getBoundingClientRect();
        saveWidgetState({ left: rect.left, top: rect.top, collapsed: nextCollapsed });
      });

      header.appendChild(dragHandle);
      header.appendChild(collapseBtn);

      const status = document.createElement("div");
      status.id = "ota-qa-tool-import-status";
      status.style.cssText =
        "background:#111;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;max-width:320px;display:none;box-shadow:0 2px 8px rgba(0,0,0,.25)";

      function setStatus(text) {
        status.style.display = "block";
        status.textContent = text;
      }

      // WICHTIG: Version aus dem Manifest lesen statt hartzukodieren, damit
      // sie nie veralten kann — und immer sichtbar, damit auf einen Blick
      // erkennbar ist, ob "Neu laden" in chrome://extensions tatsächlich eine
      // neue Version aktiviert hat (Neu laden liest nur den aktuellen Stand
      // des entpackten Ordners; ohne vorheriges Entpacken der neuen Zip in
      // genau diesen Ordner ändert der Reload-Klick nichts — live erlebt).
      const versionLabel = document.createElement("div");
      versionLabel.id = "ota-qa-tool-version-label";
      versionLabel.style.cssText = "color:#999;font-size:10px;background:#fff;padding:1px 6px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15)";
      try {
        versionLabel.textContent = "OTA QA-Tool Extension v" + chrome.runtime.getManifest().version;
      } catch (e) {
        versionLabel.textContent = "OTA QA-Tool Extension";
      }

      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.textContent = "An OTA QA-Tool senden";
      sendBtn.style.cssText =
        "background:#e0004d;color:#fff;border:none;padding:10px 18px;border-radius:24px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";

      sendBtn.addEventListener("click", async () => {
        const listingId = extractListingId();
        if (!listingId) {
          setStatus("Konnte keine Listing-ID aus der URL lesen. Bitte auf der Editor-Seite eines Listings bleiben.");
          return;
        }
        setStatus("Sende Daten …");
        const fields = {
          ...extractPhotoTourFields(),
          page: location.pathname,
          rawTextInputs: extractGenericTextFields(),
        };
        if (findAmenitiesContainer()) {
          const catalog = await fetchAmenityCatalog();
          fields.amenities = extractAmenities(catalog);
        }
        if (findSleepingArrangementsContainer()) {
          fields.sleepingArrangementsRooms = extractSleepingArrangementsRooms();
        }
        chrome.runtime.sendMessage(
          { type: "OTA_QA_TOOL_IMPORT", platform: "airbnb", external_id: listingId, fields },
          (response) => {
            if (!response) {
              setStatus("Keine Antwort vom Hintergrundprozess der Extension. Bitte Extension-Optionen prüfen.");
              return;
            }
            if (response.ok) {
              setStatus(
                "Gesendet – Kanal #" +
                  response.channel_id +
                  " aktualisiert" +
                  (response.textFieldsCount ? ` (${response.textFieldsCount} Textfeld(er) von dieser Seite)` : "") +
                  "."
              );
            } else {
              setStatus("Fehler: " + (response.error || "unbekannt"));
            }
          }
        );
      });

      const fillBtn = document.createElement("button");
      fillBtn.type = "button";
      fillBtn.textContent = "Freigegebene Texte hier einfüllen";
      fillBtn.style.cssText =
        "background:#fff;color:#e0004d;border:2px solid #e0004d;padding:8px 16px;border-radius:24px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)";

      fillBtn.addEventListener("click", () => {
        const listingId = extractListingId();
        if (!listingId) {
          setStatus("Konnte keine Listing-ID aus der URL lesen.");
          return;
        }
        setStatus("Suche freigegebene Texte für diese Seite …");
        chrome.runtime.sendMessage(
          { type: "OTA_QA_TOOL_FETCH_WRITEBACK", platform: "airbnb", external_id: listingId, path: location.pathname },
          (response) => {
            if (!response || !response.ok) {
              setStatus("Fehler: " + (response && response.error ? response.error : "keine Antwort"));
              return;
            }
            const items = response.items || [];
            if (!items.length) {
              setStatus("Keine freigegebenen Texte für diese Seite gefunden.");
              return;
            }
            let filled = 0;
            let wrongPanel = 0;
            let overLength = [];
            const openPanel = getOpenPanelLabel();
            items.forEach((it) => {
              // WICHTIG: target_field_id kann jetzt ein Präfix haben ("Your
              // property · listing-description-Deutsch-textarea"), weil
              // gleiche Airbnb-ids in verschiedenen Unterpanels kollidieren
              // (siehe getOpenPanelLabel() oben) — die echte DOM-id ist immer
              // der Teil NACH dem letzten " · ". Ist ein Präfix vorhanden,
              // muss zusätzlich GENAU DIESES Unterpanel offen sein, sonst
              // gehört ein gleichnamiges Feld zu einem ANDEREN, gerade
              // offenen Panel — sonst würde man versehentlich das falsche
              // Feld überschreiben.
              const parts = it.target_field_id.split(" · ");
              const realId = parts.pop();
              const requiredPanel = parts.length ? parts.join(" · ") : null;
              if (requiredPanel && requiredPanel !== openPanel) {
                wrongPanel++;
                return;
              }
              const el = document.getElementById(realId);
              if (el) {
                setFieldValue(el, it.proposed_text);
                filled++;
                // WICHTIG: el.value = ... per JS wird vom Browser NICHT auf
                // maxlength gekürzt (das gilt nur für Texteingabe durch die
                // Person selbst) — Airbnb würde den zu langen Wert beim
                // "Save" entweder ablehnen oder serverseitig abschneiden.
                // Deshalb hier selbst prüfen und die Person warnen, statt
                // sie das erst beim Speichern in Airbnb merken zu lassen.
                if (typeof el.maxLength === "number" && el.maxLength > 0 && it.proposed_text.length > el.maxLength) {
                  overLength.push(`${realId} (${it.proposed_text.length}/${el.maxLength} Zeichen)`);
                }
              }
            });
            setStatus(
              (filled
                ? `${filled} Feld(er) eingefüllt (rot markiert) — bitte prüfen und in Airbnb selbst „Save“ klicken. Danach im QA-Tool als „umgesetzt“ markieren.` +
                    (wrongPanel ? ` (${wrongPanel} weitere gehören zu einem anderen Unterpanel — dort öffnen und erneut versuchen.)` : "")
                : wrongPanel
                  ? `Gefunden, aber gehören zu einem anderen Unterpanel dieser Seite — das jeweils richtige Panel öffnen (z. B. "Your property") und erneut versuchen.`
                  : "Freigegebene Texte gefunden, aber die zugehörigen Felder sind auf dieser Seite nicht sichtbar (z. B. bei Alt-Texten: erst „Add a visual description“ am Foto öffnen). Dann erneut versuchen.") +
                (overLength.length
                  ? ` ⚠️ ACHTUNG, über Airbnbs Zeichenlimit: ${overLength.join(", ")} — Text vor dem Speichern kürzen!`
                  : "")
            );
          }
        );
      });

      const photoScanBtn = document.createElement("button");
      photoScanBtn.type = "button";
      photoScanBtn.id = "ota-qa-tool-photo-scan-btn";
      photoScanBtn.textContent = "Alle Fotos in diesem Raum per KI beschreiben (Alt-Text)";
      photoScanBtn.style.cssText =
        "background:#fff;color:#111;border:2px solid #111;padding:8px 16px;border-radius:24px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);display:none";

      photoScanBtn.addEventListener("click", async () => {
        const listingId = extractListingId();
        if (!listingId) {
          setStatus("Konnte keine Listing-ID aus der URL lesen.");
          return;
        }
        const roomLabel = getRoomLabel();
        photoScanBtn.disabled = true;
        setStatus("Lese Fotos dieses Raums (klickt automatisch durch, ohne zu speichern) …");
        try {
          const items = await collectRoomPhotos(setStatus);
          if (!items.length) {
            setStatus("Keine Fotos gefunden/gelesen.");
            photoScanBtn.disabled = false;
            return;
          }
          setStatus(`${items.length} Foto(s) gelesen — sende an Claude-Vision …`);
          chrome.runtime.sendMessage(
            { type: "OTA_QA_TOOL_PHOTO_SCAN", platform: "airbnb", external_id: listingId, room_label: roomLabel, items },
            (response) => {
              photoScanBtn.disabled = false;
              if (!response) {
                setStatus("Keine Antwort vom Hintergrundprozess der Extension.");
                return;
              }
              if (response.ok || response.successCount > 0) {
                setStatus(
                  `${response.successCount}/${response.total} Alt-Text-Vorschläge erstellt — im QA-Tool prüfen und zur Freigabe einreichen.`
                );
              } else {
                setStatus("Fehler: " + (response.error || "keine Alt-Texte erzeugt (siehe QA-Tool für Details)."));
              }
            }
          );
        } catch (err) {
          photoScanBtn.disabled = false;
          setStatus("Fehler beim Foto-Scan: " + String((err && err.message) || err));
        }
      });

      body.appendChild(status);
      body.appendChild(photoScanBtn);
      body.appendChild(fillBtn);
      body.appendChild(sendBtn);
      body.appendChild(versionLabel);
      wrap.appendChild(header);
      wrap.appendChild(body);
      document.body.appendChild(wrap);

      makeDraggable(wrap, dragHandle);

      // Standardposition (unten rechts) in feste left/top-Koordinaten
      // umrechnen, damit das Ziehen danach konsistent mit left/top statt
      // bottom/right rechnet — und direkt danach die zuletzt gemerkte
      // Position/den Einklapp-Zustand aus chrome.storage.local nachladen,
      // falls die Person das Widget schon einmal verschoben/eingeklappt hat.
      const initialRect = wrap.getBoundingClientRect();
      wrap.style.right = "";
      wrap.style.bottom = "";
      wrap.style.left = initialRect.left + "px";
      wrap.style.top = initialRect.top + "px";

      try {
        chrome.storage.local.get([WIDGET_STORAGE_KEY], (result) => {
          const saved = result && result[WIDGET_STORAGE_KEY];
          if (!saved) return;
          const rect = wrap.getBoundingClientRect();
          const { left, top } = clampToViewport(saved.left, saved.top, rect.width, rect.height);
          wrap.style.left = left + "px";
          wrap.style.top = top + "px";
          if (saved.collapsed) {
            wrap.dataset.collapsed = "1";
            body.style.display = "none";
            collapseBtn.textContent = "+";
            collapseBtn.title = "Widget ausklappen";
          }
        });
      } catch (e) {
        // Storage evtl. nicht verfügbar — Widget bleibt einfach an der Standardposition.
      }
    }

    const photoScanBtn = document.getElementById("ota-qa-tool-photo-scan-btn");
    if (photoScanBtn) {
      photoScanBtn.style.display = isRoomPhotoGridPage() ? "inline-block" : "none";
    }
  }

  injectUi();
  const observer = new MutationObserver(() => injectUi());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
