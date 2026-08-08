// Hintergrundprozess (Service Worker). Zwei Aufgaben:
//   1) OTA_QA_TOOL_IMPORT: vom content.js extrahierte Felder per API-Key-
//      authentifiziertem POST ans QA-Tool schicken.
//   2) OTA_QA_TOOL_FETCH_WRITEBACK: freigegebene Text-Vorschläge fürs
//      aktuelle Listing (+ optional aktuelle Editor-Unterseite) abfragen,
//      damit content.js sie ins passende Feld eintragen kann.
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
          body: JSON.stringify({ platform: msg.platform, external_id: msg.external_id, fields: msg.fields }),
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

  return false;
});
