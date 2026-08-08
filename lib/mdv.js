// MyDataValue-API-Anbindung (server-seitig, direkt per OAuth2, NICHT über die
// Claude-MCP-Verbindung — die läuft nur in einzelnen Chat-Sessions und ist
// zudem rein lesend). Für den "MyDataValue importieren"-Button im QA-Tool
// braucht der produktive Server selbst Zugangsdaten.
//
// WICHTIG zum Refresh-Token: MyDataValue verwendet einen ROTIERENDEN
// Refresh-Token — jeder Token-Tausch liefert einen NEUEN Refresh-Token zurück
// und invalidiert den alten sofort. Wird der alte danach nochmal benutzt,
// wertet MyDataValue das als gestohlenen Token und sperrt den Zugriff
// komplett (laut Auskunft von MyDataValue). Deshalb wird der neue
// Refresh-Token hier IMMER als allererster Schritt nach dem Tausch in der DB
// (settings-Tabelle) gespeichert, noch bevor irgendetwas anderes mit dem
// Access-Token passiert. Die Umgebungsvariable MDV_REFRESH_TOKEN dient nur
// als einmaliger Startwert (Bootstrap) beim allerersten Aufruf nach dem
// Deployment; ab dann übernimmt die DB und die Env-Var wird nicht mehr
// gebraucht (kann drin bleiben, wird ignoriert sobald ein Wert in der DB steht).
const db = require("../db");

const TOKEN_URL = "https://app.mydatavalue.com/oauth/token";
const API_BASE = "https://app.mydatavalue.com/api/v1";
const SETTINGS_KEY = "mdv_refresh_token";

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let refreshPromise = null;

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function getStoredRefreshToken() {
  const stored = getSetting(SETTINGS_KEY);
  if (stored) return stored;
  const bootstrap = process.env.MDV_REFRESH_TOKEN;
  if (!bootstrap) return null;
  setSetting(SETTINGS_KEY, bootstrap);
  return bootstrap;
}

async function refreshAccessToken() {
  const clientId = process.env.MDV_CLIENT_ID;
  const clientSecret = process.env.MDV_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("MDV_CLIENT_ID/MDV_CLIENT_SECRET fehlen (als Railway-Umgebungsvariablen setzen).");
  }
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    throw new Error("Kein MyDataValue-Refresh-Token vorhanden (MDV_REFRESH_TOKEN als Bootstrap-Umgebungsvariable setzen).");
  }
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MyDataValue-Token-Tausch fehlgeschlagen: ${data.error_description || data.error || res.status}`);
  }
  // WICHTIG: neuen Refresh-Token SOFORT speichern (siehe Kommentar oben), bevor
  // irgendetwas anderes mit dem frischen Access-Token passiert.
  if (data.refresh_token) setSetting(SETTINGS_KEY, data.refresh_token);
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }
  // Mehrere gleichzeitige Aufrufe teilen sich denselben laufenden Refresh,
  // statt jeweils einen eigenen Token-Tausch auszulösen (unnötig und riskant
  // wegen des rotierenden Refresh-Tokens bei parallelen Requests).
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function mdvGet(path, query) {
  const token = await getAccessToken();
  const url = new URL(API_BASE + path);
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MyDataValue-API-Fehler ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Holt ALLE Airbnb-Listings des Teams (paginiert). Sicherheitsgrenze von 20
// Seiten (bei Limit 100 also max. 2000 Listings) gegen eine Endlosschleife,
// falls die Pagination-Felder der API sich mal anders verhalten als erwartet.
async function listAllAirbnbListings() {
  const out = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 20; i++) {
    const page = await mdvGet("/airbnb/listings/", { limit, offset });
    const results = page.results || [];
    out.push(...results);
    if (results.length < limit || out.length >= (page.count || out.length)) break;
    offset += limit;
  }
  return out;
}

module.exports = { getAccessToken, mdvGet, listAllAirbnbListings };
