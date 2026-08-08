// Hintergrundprozess (Service Worker). Nimmt die vom content.js extrahierten
// Felder entgegen und schickt sie per API-Key-authentifiziertem POST an das
// QA-Tool. Läuft hier (statt im content.js), weil Extension-Hintergrundprozesse
// mit deklarierten host_permissions nicht den CORS-Beschränkungen der
// aufrufenden Seite (airbnb.com) unterliegen.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "OTA_QA_TOOL_IMPORT") return false;

  (async () => {
    try {
      const { baseUrl, apiKey } = await chrome.storage.sync.get(["baseUrl", "apiKey"]);
      if (!baseUrl || !apiKey) {
        sendResponse({
          ok: false,
          error: "Bitte zuerst in den Extension-Optionen QA-Tool-URL und API-Key hinterlegen.",
        });
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

  return true; // Antwort kommt asynchron — Message-Channel offen halten.
});
