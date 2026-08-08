async function load() {
  const { baseUrl, apiKey } = await chrome.storage.sync.get(["baseUrl", "apiKey"]);
  document.getElementById("baseUrl").value = baseUrl || "https://web-production-362e.up.railway.app";
  document.getElementById("apiKey").value = apiKey || "";
}

async function save() {
  const baseUrl = document.getElementById("baseUrl").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  await chrome.storage.sync.set({ baseUrl, apiKey });
  document.getElementById("status").textContent = "Gespeichert.";
}

async function test() {
  const statusEl = document.getElementById("status");
  const baseUrl = document.getElementById("baseUrl").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!baseUrl || !apiKey) {
    statusEl.textContent = "Bitte zuerst URL und API-Key eingeben und speichern.";
    return;
  }
  await chrome.storage.sync.set({ baseUrl, apiKey });
  statusEl.textContent = "Teste Verbindung …";
  try {
    const url = baseUrl.replace(/\/+$/, "");
    let origin = null;
    try {
      origin = new URL(url).origin + "/*";
    } catch (e) {
      // ignore, url invalid
    }
    if (origin) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        statusEl.textContent = "Zugriff auf diese Domain wurde nicht erlaubt (Berechtigung abgelehnt).";
        return;
      }
    }
    const res = await fetch(url + "/api/browser-import/ping", { headers: { "X-API-Key": apiKey } });
    const data = await res.json().catch(() => ({}));
    statusEl.textContent = res.ok ? "Verbindung erfolgreich." : "Fehler: " + (data.error || res.status);
  } catch (err) {
    statusEl.textContent = "Fehler: " + err.message;
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
