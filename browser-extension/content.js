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
// Schickt beides auf Klick an den Hintergrundprozess, der es ans QA-Tool
// weiterleitet. Zweiter Button liest freigegebene Text-Vorschläge vom
// QA-Tool und trägt sie (nur) ins jeweilige Feld ein — Speichern in Airbnb
// bleibt bewusst ein manueller Schritt der Person.
//
// Es wird nichts auf airbnb.com automatisch gespeichert/abgeschickt.

(function () {
  function extractListingId() {
    const m = location.pathname.match(/\/hosting\/listings\/editor\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractGenericTextFields() {
    const out = [];
    document.querySelectorAll("textarea, input[type='text']").forEach((el) => {
      if (!el.id) return;
      out.push({ id: el.id, value: el.value || "" });
    });
    return out;
  }

  function extractPhotoTourFields() {
    const text = document.body.innerText || "";

    const summaryMatch =
      text.match(/(\d+\s*bedrooms?[^\n]*?\d+\s*beds?[^\n]*?\d+(?:[.,]\d)?\s*baths?)/i) ||
      text.match(/(\d+\s*Schlafzimmer[^\n]*?\d+\s*Betten[^\n]*?\d+(?:[.,]\d)?\s*Bad(?:ezimmer)?)/i);
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
      for (let i = 0; i < lines.length - 1; i++) {
        if (/bed/i.test(lines[i + 1]) && !/bed/i.test(lines[i])) {
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

  function injectUi() {
    if (document.getElementById("ota-qa-tool-import-wrap")) return;

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
          items.forEach((it) => {
            const el = document.getElementById(it.target_field_id);
            if (el) {
              setFieldValue(el, it.proposed_text);
              filled++;
            }
          });
          setStatus(
            filled
              ? `${filled} Feld(er) eingefüllt (rot markiert) — bitte prüfen und in Airbnb selbst „Save“ klicken. Danach im QA-Tool als „umgesetzt“ markieren.`
              : "Freigegebene Texte gefunden, aber die zugehörigen Felder sind auf dieser Seite nicht sichtbar. Richtige Unterseite öffnen und erneut versuchen."
          );
        }
      );
    });

    wrap.appendChild(status);
    wrap.appendChild(fillBtn);
    wrap.appendChild(sendBtn);
    document.body.appendChild(wrap);
  }

  injectUi();
  const observer = new MutationObserver(() => injectUi());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
