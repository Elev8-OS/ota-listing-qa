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
      out.push({ id, value: el.value || "" });
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

  function injectUi() {
    if (!document.getElementById("ota-qa-tool-import-wrap")) {
      const wrap = document.createElement("div");
      wrap.id = "ota-qa-tool-import-wrap";
      wrap.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px";

      const status = document.createElement("div");
      status.id = "ota-qa-tool-import-status";
      status.style.cssText =
        "background:#111;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;max-width:320px;display:none;box-shadow:0 2px 8px rgba(0,0,0,.25)";

      function setStatus(text) {
        status.style.display = "block";
        status.textContent = text;
      }

      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.textContent = "An OTA QA-Tool senden";
      sendBtn.style.cssText =
        "background:#e0004d;color:#fff;border:none;padding:10px 18px;border-radius:24px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";

      sendBtn.addEventListener("click", () => {
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
              }
            });
            setStatus(
              filled
                ? `${filled} Feld(er) eingefüllt (rot markiert) — bitte prüfen und in Airbnb selbst „Save“ klicken. Danach im QA-Tool als „umgesetzt“ markieren.` +
                    (wrongPanel ? ` (${wrongPanel} weitere gehören zu einem anderen Unterpanel — dort öffnen und erneut versuchen.)` : "")
                : wrongPanel
                  ? `Gefunden, aber gehören zu einem anderen Unterpanel dieser Seite — das jeweils richtige Panel öffnen (z. B. "Your property") und erneut versuchen.`
                  : "Freigegebene Texte gefunden, aber die zugehörigen Felder sind auf dieser Seite nicht sichtbar (z. B. bei Alt-Texten: erst „Add a visual description“ am Foto öffnen). Dann erneut versuchen."
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

      wrap.appendChild(status);
      wrap.appendChild(photoScanBtn);
      wrap.appendChild(fillBtn);
      wrap.appendChild(sendBtn);
      document.body.appendChild(wrap);
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
