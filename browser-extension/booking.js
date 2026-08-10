// Läuft auf der Booking.com-Extranet-Seite "Your profile" / "View your
// descriptions" (property_profile.html) einer einzelnen Unterkunft — der
// eingeloggten, echten Session der Person (analog zu content.js für Airbnb).
//
// WICHTIG, live recherchiert (siehe Commit-Beschreibung): Booking.com hat ein
// GRUNDSÄTZLICH ANDERES Content-Modell als Airbnb:
//   - "Property description" und "Room descriptions" werden AUTOMATISCH aus
//     den hinterlegten Facilities/Amenities generiert. Sie sind NICHT frei
//     editierbar — nur ein "Request a correction"-Formular (Tippfehler-
//     Korrektur, von Booking-Redakteuren geprüft, ~6 Tage Bearbeitungszeit)
//     ist möglich. Es gibt hier also keine Textarea zum Erfassen/Umschreiben.
//   - Auf der Profilseite ("Your profile") gibt es dagegen ECHTE freie
//     Textfelder pro Sprache: "About the property" (id
//     hotelier-message-<lang>-welcome_message), "About the host" (…-owner_
//     info), "About the neighbourhood" (…-neighborhood_info), jeweils mit
//     nativem maxlength (aktuell 2000), plus "Host name" (id
//     name-or-company, maxlength 80). Das sind die Felder, die dieses
//     Script erfasst/umschreibt/zurückschreibt — dieselbe generische
//     "jedes Textfeld mit id" Strategie wie bei Airbnb, damit es robust
//     bleibt, falls Booking weitere Sprachen/Felder ergänzt.
//
// Es wird nichts auf booking.com automatisch gespeichert/abgeschickt.

(function () {
  function extractHotelId() {
    const params = new URLSearchParams(location.search);
    return params.get("hotel_id");
  }

  function extractGenericTextFields() {
    const out = [];
    document.querySelectorAll("textarea, input[type='text']").forEach((el) => {
      if (!el.id) return;
      const maxLength = typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : null;
      out.push({ id: el.id, value: el.value || "", maxLength });
    });
    return out;
  }

  function setFieldValue(el, value) {
    // Booking.coms Extranet ist (wie Airbnb) eine React-App: el.value = ...
    // allein aktualisiert nur das DOM, nicht Reacts internen State. Über den
    // nativen Value-Setter + ein echtes "input"-Event zu gehen, ist der
    // zuverlässige Weg (identisch zu content.js/Airbnb übernommen).
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.style.outline = "3px solid #003b95";
    el.style.outlineOffset = "2px";
  }

  // Eigener Storage-Key (nicht derselbe wie bei Airbnb/content.js): beide
  // Content-Scripts laufen in DERSELBEN Extension und teilen sich
  // chrome.storage.local — mit demselben Key würden sich Widget-Position/
  // Einklapp-Zustand von Airbnb- und Booking.com-Tabs gegenseitig überschreiben.
  const WIDGET_STORAGE_KEY = "otaQaToolWidgetStateBooking";

  function clampToViewport(left, top, width, height) {
    const maxLeft = Math.max(0, window.innerWidth - width - 4);
    const maxTop = Math.max(0, window.innerHeight - height - 4);
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
  }

  function saveWidgetState(state) {
    try {
      chrome.storage.local.set({ [WIDGET_STORAGE_KEY]: state });
    } catch (e) {
      // Storage evtl. nicht verfügbar - Position geht dann nur für diesen Moment verloren.
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

    window.addEventListener("resize", () => {
      const rect = wrap.getBoundingClientRect();
      const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
      wrap.style.left = left + "px";
      wrap.style.top = top + "px";
    });
  }

  function injectUi() {
    if (document.getElementById("ota-qa-tool-import-wrap-booking")) return;

    const wrap = document.createElement("div");
    wrap.id = "ota-qa-tool-import-wrap-booking";
    wrap.dataset.collapsed = "0";
    wrap.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;gap:6px;max-width:320px";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:4px";

    const dragHandle = document.createElement("div");
    dragHandle.title = "Ziehen, um das Widget zu verschieben";
    dragHandle.textContent = "⠿";
    dragHandle.style.cssText =
      "background:#003b95;color:#fff;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:grab;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.25);user-select:none";

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.title = "Widget einklappen/ausklappen";
    collapseBtn.textContent = "–";
    collapseBtn.style.cssText =
      "background:#003b95;color:#fff;width:22px;height:22px;border-radius:6px;border:none;cursor:pointer;font-size:14px;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.25)";

    const body = document.createElement("div");
    body.id = "ota-qa-tool-body-booking";
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
    status.id = "ota-qa-tool-import-status-booking";
    status.style.cssText =
      "background:#003b95;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;max-width:320px;display:none;box-shadow:0 2px 8px rgba(0,0,0,.25)";

    function setStatus(text) {
      status.style.display = "block";
      status.textContent = text;
    }

    const versionLabel = document.createElement("div");
    versionLabel.style.cssText = "color:#999;font-size:10px;background:#fff;padding:1px 6px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15)";
    try {
      versionLabel.textContent = "OTA QA-Tool Extension v" + chrome.runtime.getManifest().version + " · Booking.com";
    } catch (e) {
      versionLabel.textContent = "OTA QA-Tool Extension · Booking.com";
    }

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "An OTA QA-Tool senden";
    sendBtn.style.cssText =
      "background:#003b95;color:#fff;border:none;padding:10px 18px;border-radius:24px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";

    sendBtn.addEventListener("click", () => {
      const hotelId = extractHotelId();
      if (!hotelId) {
        setStatus("Konnte keine Property-ID (hotel_id) aus der URL lesen. Bitte auf der Profilseite einer Unterkunft bleiben.");
        return;
      }
      setStatus("Sende Daten …");
      const fields = {
        page: location.pathname,
        rawTextInputs: extractGenericTextFields(),
      };
      chrome.runtime.sendMessage(
        { type: "OTA_QA_TOOL_IMPORT", platform: "booking", external_id: hotelId, fields },
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
      "background:#fff;color:#003b95;border:2px solid #003b95;padding:8px 16px;border-radius:24px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)";

    fillBtn.addEventListener("click", () => {
      const hotelId = extractHotelId();
      if (!hotelId) {
        setStatus("Konnte keine Property-ID (hotel_id) aus der URL lesen.");
        return;
      }
      setStatus("Suche freigegebene Texte für diese Seite …");
      chrome.runtime.sendMessage(
        { type: "OTA_QA_TOOL_FETCH_WRITEBACK", platform: "booking", external_id: hotelId, path: location.pathname },
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
          let overLength = [];
          items.forEach((it) => {
            // Anders als bei Airbnb gibt es auf dieser Booking.com-Seite kein
            // Panel-Kollisions-Problem (jede Sprache hat ihre eigene id, z. B.
            // hotelier-message-en-welcome_message vs. …-de-…) — target_field_id
            // ist deshalb hier immer direkt die echte DOM-id, ohne Präfix.
            const el = document.getElementById(it.target_field_id);
            if (el) {
              setFieldValue(el, it.proposed_text);
              filled++;
              if (typeof el.maxLength === "number" && el.maxLength > 0 && it.proposed_text.length > el.maxLength) {
                overLength.push(`${it.target_field_id} (${it.proposed_text.length}/${el.maxLength} Zeichen)`);
              }
            }
          });
          setStatus(
            (filled
              ? `${filled} Feld(er) eingefüllt (blau markiert) — bitte prüfen und in Booking.com selbst „Save“ klicken. Danach im QA-Tool als „umgesetzt“ markieren.`
              : "Freigegebene Texte gefunden, aber die zugehörigen Felder sind auf dieser Seite nicht sichtbar (z. B. andere Sprache ausgewählt). Bitte die passende Sprache öffnen und erneut versuchen.") +
              (overLength.length
                ? ` ⚠️ ACHTUNG, über Booking.coms Zeichenlimit: ${overLength.join(", ")} — Text vor dem Speichern kürzen!`
                : "")
          );
        }
      );
    });

    body.appendChild(status);
    body.appendChild(fillBtn);
    body.appendChild(sendBtn);
    body.appendChild(versionLabel);
    wrap.appendChild(header);
    wrap.appendChild(body);
    document.body.appendChild(wrap);

    makeDraggable(wrap, dragHandle);

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

  injectUi();
  const observer = new MutationObserver(() => injectUi());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
