// Hintergrundprozess (Service Worker). Vier Aufgaben:
//   1) OTA_QA_TOOL_IMPORT: vom content.js extrahierte Felder per API-Key-
//      authentifiziertem POST ans QA-Tool schicken.
//   2) OTA_QA_TOOL_FETCH_WRITEBACK: freigegebene Text-Vorschläge fürs
//      aktuelle Listing (+ optional aktuelle Editor-Unterseite) abfragen,
//      damit content.js sie ins passende Feld eintragen kann.
//   3) OTA_QA_TOOL_PHOTO_SCAN: die beim automatischen Durchklicken eines
//      Raums gesammelten Fotos (Pfad + Bild-URL) ans QA-Tool schicken, das
//      pro Foto per Claude-Vision einen Alt-Text-Vorschlag erzeugt.
//   4) OTA_QA_TOOL_FETCH_AMENITY_CATALOG: den serverseitig über alle
//      gescannten Airbnb-Inserate hinweg gewachsenen Katalog aller bisher
//      gesehenen Ausstattungsnamen abfragen, damit content.js beim Erfassen
//      der Amenities-Seite Name- von Beschreibungszeilen zuverlässiger
//      trennen kann (siehe content.js).
//   5) OTA_QA_TOOL_FETCH_ROOM_TARGETS: die aktuellen Zimmer/Betten-Werte aus
//      der QA-Tool-"rooms"-Tabelle für den aktuellen Kanal abfragen, damit
//      content.js sie auf Airbnbs Betten-Editor-Seite
//      (.../details/photo-tour/<room-id>/beds) vorausfüllen kann.
// Läuft hier (statt im content.js), weil Extension-Hintergrundprozesse mit
// deklarierten host_permissions nicht den CORS-Beschränkungen der
// aufrufenden Seite (airbnb.com) unterliegen.

async function getConfig() {
  const { baseUrl, apiKey } = await chrome.storage.sync.get(["baseUrl", "apiKey"]);
  return { baseUrl, apiKey };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "OTA_QA_TOOL_IMPORT") {
    (async () => {
      try {
        const { baseUrl, apiKey } = await getConfig();
        if (!baseUrl || !apiKey) {
          sendResponse({ ok: false, error: "Bitte zuerst in den Extension-Optionen QA-Tool-URL und API-Key hinterlegen." });
          return;
        }
        const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import";
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify({
            platform: msg.platform,
            external_id: msg.external_id,
            fields: msg.fields,
            extension_version: chrome.runtime.getManifest().version,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // Antwort kommt asynchron.
  }

  if (msg.type === "OTA_QA_TOOL_FETCH_WRITEBACK") {
    (async () => {
      try {
        const { baseUrl, apiKey } = await getConfig();
        if (!baseUrl || !apiKey) {
          sendResponse({ ok: false, error: "Bitte zuerst in den Extension-Optionen QA-Tool-URL und API-Key hinterlegen." });
          return;
        }
        const params = new URLSearchParams({
          platform: msg.platform,
          external_id: msg.external_id,
          path: msg.path || "",
        });
        const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import/pending-writeback?" + params.toString();
        const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg.type === "OTA_QA_TOOL_FETCH_ROOM_TARGETS") {
    (async () => {
      try {
        const { baseUrl, apiKey } = await getConfig();
        if (!baseUrl || !apiKey) {
          sendResponse({ ok: false, error: "Bitte zuerst in den Extension-Optionen QA-Tool-URL und API-Key hinterlegen." });
          return;
        }
        const params = new URLSearchParams({ platform: msg.platform, external_id: msg.external_id });
        const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import/room-targets?" + params.toString();
        const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg.type === "OTA_QA_TOOL_PHOTO_SCAN") {
    (async () => {
      try {
        const { baseUrl, apiKey } = await getConfig();
        if (!baseUrl || !apiKey) {
          sendResponse({ ok: false, error: "Bitte zuerst in den Extension-Optionen QA-Tool-URL und API-Key hinterlegen." });
          return;
        }
        const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import/photos";
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
          body: JSON.stringify({
            platform: msg.platform,
            external_id: msg.external_id,
            room_label: msg.room_label,
            items: msg.items,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // Antwort kommt asynchron (Claude-Vision braucht Zeit pro Foto).
  }

  if (msg.type === "OTA_QA_TOOL_FETCH_AMENITY_CATALOG") {
    (async () => {
      try {
        const { baseUrl, apiKey } = await getConfig();
        if (!baseUrl || !apiKey) {
          sendResponse({ ok: false, error: "Bitte zuerst in den Extension-Optionen QA-Tool-URL und API-Key hinterlegen." });
          return;
        }
        const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import/amenity-catalog";
        const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  return false;
});
