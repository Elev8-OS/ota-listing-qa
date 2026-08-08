// Läuft auf der Airbnb-Host-Editor-Seite (echte, eingeloggte Session der
// Person). Liest per Text-Heuristik die Felder aus, die öffentlich nie
// sichtbar sind (Fotorundgang-Zimmerliste, Sleeping arrangements), und
// schickt sie auf Klick an den Hintergrundprozess, der sie ans QA-Tool
// weiterleitet. Es wird nichts auf airbnb.com verändert oder abgeschickt —
// nur gelesen.

(function () {
  function extractListingId() {
    const m = location.pathname.match(/\/hosting\/listings\/editor\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractFields() {
    const text = document.body.innerText || "";

    const summaryMatch =
      text.match(/(\d+\s*bedrooms?[^\n]*?\d+\s*beds?[^\n]*?\d+(?:[.,]\d)?\s*baths?)/i) ||
      text.match(/(\d+\s*Schlafzimmer[^\n]*?\d+\s*Betten[^\n]*?\d+(?:[.,]\d)?\s*Bad(?:ezimmer)?)/i);
    const bedroomsSummary = summaryMatch ? summaryMatch[1] : null;

    const titleMatch = text.match(/\nTitle\n([^\n]+)/) || text.match(/\nTitel\n([^\n]+)/);
    const title = titleMatch ? titleMatch[1].trim() : document.title || null;

    let guests = null;
    const guestsBlock =
      text.match(/Number of guests\n[^\n]*\n?(\d+)\s*guests?/i) || text.match(/(\d+)\s*guests?\b/i);
    if (guestsBlock) guests = Number(guestsBlock[1]);

    // Sleeping arrangements: Textblock zwischen der Überschrift und
    // "Number of guests" -> abwechselnd Zimmername / Bettenbeschreibung.
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

    // Fotorundgang-Zimmerliste (rechte Spalte): "<Name>\n<N> photos"
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

    // Description (freier Text, best-effort — nur zur Anzeige, keine
    // automatische Übernahme irgendwohin).
    const descMatch = text.match(/\nDescription\n([\s\S]{10,1500}?)\n(?:Amenities|Ausstattung)\b/i);
    const description = descMatch ? descMatch[1].trim() : null;

    return { title, bedroomsSummary, guests, sleepingArrangements, photoTourRooms, description };
  }

  function injectUi() {
    if (document.getElementById("ota-qa-tool-import-wrap")) return;

    const wrap = document.createElement("div");
    wrap.id = "ota-qa-tool-import-wrap";
    wrap.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:6px";

    const status = document.createElement("div");
    status.id = "ota-qa-tool-import-status";
    status.style.cssText =
      "background:#111;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;max-width:300px;display:none;box-shadow:0 2px 8px rgba(0,0,0,.25)";

    const btn = document.createElement("button");
    btn.id = "ota-qa-tool-import-btn";
    btn.type = "button";
    btn.textContent = "An OTA QA-Tool senden";
    btn.style.cssText =
      "background:#e0004d;color:#fff;border:none;padding:10px 18px;border-radius:24px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";

    btn.addEventListener("click", () => {
      const listingId = extractListingId();
      status.style.display = "block";
      if (!listingId) {
        status.textContent = "Konnte keine Listing-ID aus der URL lesen. Bitte auf der Editor-Seite eines Listings bleiben.";
        return;
      }
      status.textContent = "Sende Daten …";
      const fields = extractFields();
      chrome.runtime.sendMessage(
        { type: "OTA_QA_TOOL_IMPORT", platform: "airbnb", external_id: listingId, fields },
        (response) => {
          if (!response) {
            status.textContent = "Keine Antwort vom Hintergrundprozess der Extension. Bitte Extension-Optionen prüfen.";
            return;
          }
          if (response.ok) {
            status.textContent = "Gesendet – Kanal #" + response.channel_id + " im QA-Tool aktualisiert.";
          } else {
            status.textContent = "Fehler: " + (response.error || "unbekannt");
          }
        }
      );
    });

    wrap.appendChild(status);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  injectUi();
  const observer = new MutationObserver(() => injectUi());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
