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

// ---------- Automatischer Scan (Airbnb) ----------
// Läuft bewusst HIER (Optionsseite), nicht im Hintergrundprozess
// (background.js/Service Worker): ein Manifest-V3-Service-Worker wird von
// Chrome nach kurzer Inaktivität beendet, was einen mehrminütigen Scan über
// viele Listings hinweg abbrechen würde. Diese Options-Seite bleibt dagegen
// so lange am Leben, wie du sie offen lässt — genau das macht sie zum
// zuverlässigen Ort für den Scan-Loop. Navigiert per chrome.tabs.update
// (erfordert die "tabs"-Berechtigung) direkt zu jeder Editor-Unterseite und
// spricht das dort automatisch neu geladene content.js über
// chrome.tabs.sendMessage an (siehe "OTA_QA_TOOL_AUTO_SCAN_PAGE" dort).
const scanState = { running: false, stopRequested: false };

function scanSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scanLog(text) {
  const el = document.getElementById("scan-log");
  el.style.display = "block";
  const time = new Date().toLocaleTimeString("de-CH");
  el.textContent += `[${time}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs || 20000);
  });
}

async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId, 20000);
  // Zusätzliche Wartezeit: "complete" heisst nur, dass das HTML geladen ist —
  // Airbnbs React-App braucht danach noch etwas Zeit, bis Felder/Panels
  // tatsächlich im DOM stehen und content.js sich vollständig registriert hat.
  await scanSleep(1800);
}

// content.js wird bei jeder Navigation neu geladen (echte Seitennavigation,
// kein Client-Routing) — je nach Zeitpunkt ist es beim ersten Versuch
// eventuell noch nicht bereit ("Could not establish connection"). Deshalb
// mit kurzen Pausen mehrfach versuchen statt nach dem ersten Fehlschlag
// aufzugeben.
async function sendToContentScript(tabId, msg, attempts) {
  for (let i = 0; i < (attempts || 6); i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, msg);
      if (response) return response;
    } catch (e) {
      // Content-Script noch nicht bereit — kurz warten und erneut versuchen.
    }
    await scanSleep(700);
  }
  return null;
}

async function postScanResult(baseUrl, apiKey, externalId, fields) {
  const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({
      platform: "airbnb",
      external_id: externalId,
      fields,
      extension_version: chrome.runtime.getManifest().version,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function fetchScanTargets(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, "") + "/api/browser-import/scan-targets?platform=airbnb";
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data.items || [];
}

// Die Editor-Unterseiten, die pro Listing automatisch besucht werden.
// "description" bekommt in content.js zusätzlich das automatische
// Durchklicken aller Unterpanels (Listing description/Your property/...).
// "amenities" (seit v1.6.0) liefert die aktuell gesetzte Ausstattung.
// "sleeping-arrangements" (seit v1.7.0) liefert pro Schlafzimmer/Wohnbereich
// die dort tatsächlich hinterlegte Bettenkonfiguration (inkl. Räumen ohne
// Bett) — daraus baut der Server die Zimmer-Tabelle für den Konsistenz-Check
// automatisch statt sie von Hand nachpflegen zu müssen.
const SCAN_SUBPAGES = [
  "details/photo-tour",
  "details/description",
  "details/title",
  "details/amenities",
  "details/sleeping-arrangements",
];

async function runAutoScan() {
  const { baseUrl, apiKey } = await chrome.storage.sync.get(["baseUrl", "apiKey"]);
  if (!baseUrl || !apiKey) {
    scanLog("Bitte zuerst QA-Tool-Basis-URL und API-Key oben eintragen, speichern und testen.");
    return;
  }

  scanState.running = true;
  scanState.stopRequested = false;
  document.getElementById("scan-start").disabled = true;
  document.getElementById("scan-stop").disabled = false;
  document.getElementById("scan-log").textContent = "";

  let targets = [];
  try {
    targets = await fetchScanTargets(baseUrl, apiKey);
  } catch (e) {
    scanLog("Fehler beim Laden der Scan-Liste: " + e.message);
    scanState.running = false;
    document.getElementById("scan-start").disabled = false;
    document.getElementById("scan-stop").disabled = true;
    return;
  }
  if (!targets.length) {
    scanLog(
      "Keine Airbnb-Kanäle mit hinterlegter externer ID (Airbnb Listing-ID) gefunden. Bitte im QA-Tool beim jeweiligen Kanal zuerst die Listing-ID eintragen."
    );
    scanState.running = false;
    document.getElementById("scan-start").disabled = false;
    document.getElementById("scan-stop").disabled = true;
    return;
  }

  scanLog(`${targets.length} Airbnb-Inserat(e) gefunden. Scan startet in einem eigenen Hintergrund-Tab …`);
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const tabId = tab.id;

  let done = 0;
  for (const target of targets) {
    if (scanState.stopRequested) {
      scanLog("Abgebrochen auf Wunsch.");
      break;
    }
    const externalId = target.external_id;
    const label = target.listing_name || `Listing ${externalId}`;
    scanLog(`(${done + 1}/${targets.length}) ${label}: wird gescannt …`);
    try {
      for (const subpage of SCAN_SUBPAGES) {
        if (scanState.stopRequested) break;
        const url = `https://www.airbnb.com/hosting/listings/editor/${externalId}/${subpage}`;
        await navigateAndWait(tabId, url);
        const response = await sendToContentScript(tabId, { type: "OTA_QA_TOOL_AUTO_SCAN_PAGE" });
        if (!response || !response.ok) {
          scanLog(
            `  ⚠️ ${subpage}: keine Antwort vom Content-Script (Listing evtl. nicht mehr vorhanden oder Seite hat sich geändert) — überspringe.`
          );
          continue;
        }
        const result = await postScanResult(baseUrl, apiKey, externalId, response.fields);
        if (!result.ok) {
          scanLog(`  ⚠️ ${subpage}: Fehler beim Senden ans QA-Tool – ${(result.data && result.data.error) || "unbekannt"}`);
        }
      }
      done++;
      scanLog(`(${done}/${targets.length}) ${label}: fertig.`);
    } catch (e) {
      scanLog(`(${done + 1}/${targets.length}) ${label}: Fehler – ${(e && e.message) || e}`);
    }
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // Tab evtl. schon vom Menschen geschlossen worden - kein Problem.
  }

  scanState.running = false;
  document.getElementById("scan-start").disabled = false;
  document.getElementById("scan-stop").disabled = true;
  scanLog(
    scanState.stopRequested
      ? `Abgebrochen – ${done}/${targets.length} Inserat(e) vor dem Abbruch verarbeitet.`
      : `Scan beendet – ${done}/${targets.length} Inserat(e) verarbeitet. Bitte alle Ergebnisse im QA-Tool prüfen, bevor Texte freigegeben werden.`
  );
}

document.getElementById("scan-start").addEventListener("click", () => {
  if (scanState.running) return;
  runAutoScan();
});
document.getElementById("scan-stop").addEventListener("click", () => {
  scanState.stopRequested = true;
  scanLog("Abbruch angefordert — wird nach dem aktuellen Listing gestoppt …");
});
