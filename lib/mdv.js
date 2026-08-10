// MyDataValue-API-Anbindung (server-seitig, direkt per OAuth2, NICHT über die
// Claude-MCP-Verbindung — die läuft nur in einzelnen Chat-Sessions und ist
// zudem rein lesend). Für den "MyDataValue importieren"-Button und die
// Recalculate-Jobs im QA-Tool braucht der produktive Server selbst
// Zugangsdaten.
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
//
// Diese Datei implementiert den kompletten öffentlichen MyDataValue-API-
// Vertrag (siehe die von MyDataValue bereitgestellte OpenAPI-3.0.3-Spezifikation,
// Stand 2026-08, https://www.mydatavalue.com/developers/): jeder dort
// dokumentierte Endpunkt hat hier eine benannte Funktion mit demselben Namen
// wie der jeweilige `operationId` aus der Spezifikation. Darunter liegt ein
// generischer `request()`-Helper (Query/Body/Idempotency-Key), damit neue
// oder in dieser Datei noch nicht einzeln benannte Endpunkte trotzdem sofort
// nutzbar sind (`mdvGet`/`mdvPost`/`mdvPut`/`mdvPatch`/`mdvDelete`).
//
// Fehlerformat der API (siehe Spezifikation): 400 invalid_body, 401
// abgelaufener/ungültiger Token, 403 fehlender Scope oder Schreib-Sperre
// (writes_disabled/partner_writes_disabled/not_connected/Guardrail), 404
// Ziel nicht gefunden (bewusst identisch für unbekannte und fremde IDs), 409
// idempotency_key_conflict, 429 Rate-Limit (Retry-After beachten). Diese
// Datei reicht solche Fehler als normale JS-Errors nach oben durch (siehe
// `request()`), inkl. des von der API gelieferten Fehlercodes/Texts.
const crypto = require("crypto");
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

// WICHTIG zum Client: MDV_CLIENT_ID ist ein "public client" (OAuth-Begriff —
// kein Geheimnis, siehe MyDataValue-Doku: "token_endpoint_auth_method: none").
// Es gibt bewusst KEIN MDV_CLIENT_SECRET mehr — die Sicherheit kommt bei
// einem public client stattdessen aus PKCE beim Autorisieren (siehe
// buildAuthorizeUrl/exchangeAuthorizationCode unten) plus dem rotierenden
// Refresh-Token danach. Falls doch einmal ein "confidential" Client mit
// Secret verwendet wird, wird MDV_CLIENT_SECRET (falls gesetzt) weiterhin
// automatisch als HTTP-Basic-Auth mitgeschickt — für den aktuellen public
// Client bleibt die Variable einfach ungesetzt.
async function refreshAccessToken() {
  const clientId = process.env.MDV_CLIENT_ID;
  const clientSecret = process.env.MDV_CLIENT_SECRET;
  if (!clientId) {
    throw new Error("MDV_CLIENT_ID fehlt (als Railway-Umgebungsvariable setzen).");
  }
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    throw new Error(
      "Kein MyDataValue-Refresh-Token vorhanden. Über den \"Mit MyDataValue verbinden\"-Button auf der /mdv-Seite neu autorisieren."
    );
  }
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
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

// Speichert einen frisch (per Autorisierungs-Code-Tausch, siehe
// exchangeAuthorizationCode) erhaltenen Refresh-Token und verwirft den
// gecachten Access-Token, damit der nächste Aufruf garantiert den neuen
// Token verwendet statt eines evtl. noch laufenden alten.
function storeRefreshToken(refreshToken) {
  setSetting(SETTINGS_KEY, refreshToken);
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
}

// Alle von MyDataValue unterstützten Scopes (siehe
// https://app.mydatavalue.com/.well-known/oauth-authorization-server). Der
// "Mit MyDataValue verbinden"-Button fordert bewusst ALLE an, weil lib/mdv.js
// bereits Wrapper für die komplette API anbietet und eine später fehlende
// Berechtigung sich sonst erst als kryptischer 403 mitten in einer
// Funktion zeigen würde statt schon beim Verbinden sichtbar zu sein.
const OAUTH_SCOPES = [
  "read:properties",
  "read:properties-private",
  "read:pricing",
  "read:promotions",
  "read:ranking",
  "read:reviews",
  "read:demand",
  "read:compset",
  "read:performance",
  "read:jobs",
  "read:tags",
  "read:webhooks",
  "read:changelog",
  "write:promotions",
  "write:tags",
  "write:guest-target",
  "write:rateplans",
  "write:service-charge",
  "write:sync",
  "write:webhooks",
  "write:cancellation-policies",
  "write:visibility-booster",
  "write:preferred",
  "write:genius",
];

const AUTHORIZE_URL = "https://app.mydatavalue.com/oauth/authorize";

// PKCE-Paar (S256, von MyDataValue verlangt) für den Autorisierungs-Code-Fluss.
function generatePkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl({ redirectUri, state, codeChallenge, scope }) {
  const clientId = process.env.MDV_CLIENT_ID;
  if (!clientId) throw new Error("MDV_CLIENT_ID fehlt (als Railway-Umgebungsvariable setzen).");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope || OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// Letzter Schritt des Autorisierungs-Code-Flusses: tauscht den von
// MyDataValue nach Login+Freigabe zurückgegebenen `code` gegen ein
// Token-Paar. Speichert den neuen Refresh-Token sofort (siehe
// storeRefreshToken) und liefert die Rohantwort (u. a. `scope`) zurück,
// damit die aufrufende Route dem admin zeigen kann, welche Berechtigungen
// tatsächlich gewährt wurden.
async function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
  const clientId = process.env.MDV_CLIENT_ID;
  const clientSecret = process.env.MDV_CLIENT_SECRET;
  if (!clientId) throw new Error("MDV_CLIENT_ID fehlt (als Railway-Umgebungsvariable setzen).");
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MyDataValue-Autorisierung fehlgeschlagen: ${data.error_description || data.error || res.status}`);
  }
  if (!data.refresh_token) {
    throw new Error("MyDataValue hat keinen Refresh-Token zurückgegeben (Antwort ohne refresh_token).");
  }
  storeRefreshToken(data.refresh_token);
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
  return data;
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

function buildIdempotencyKey(prefix) {
  return `${prefix || "ota-qa-tool"}-${crypto.randomUUID()}`;
}

// Genereller Low-Level-Aufruf gegen die MyDataValue-API. `query` wird als
// URL-Suchparameter angehängt (Arrays werden zu wiederholten Parametern,
// wie von den `list_*`-Endpunkten mit z. B. `listing_id` erwartet). `body`
// wird als JSON gesendet (auch bei DELETE, das die API bei einigen
// Endpunkten — z. B. `clear_airbnb_mobile_discount` — bewusst mit Body
// verwendet). `idempotencyKey`, falls gesetzt, geht als `Idempotency-Key`-
// Header mit, zusätzlich zu einem eventuell im Body vorhandenen
// `idempotency_key`-Feld (die "desired-state"/Job-Endpunkte verlangen das
// Feld im Body; der Header ist die von der API zusätzlich unterstützte
// Variante für andere Schreib-Endpunkte).
async function request(method, urlPath, { query, body, idempotencyKey } = {}) {
  const token = await getAccessToken();
  const url = new URL(API_BASE + urlPath);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, v));
    } else {
      url.searchParams.set(key, value);
    }
  });
  const headers = { Authorization: `Bearer ${token}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let fetchBody;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), { method, headers, body: fetchBody });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && (data.detail || data.error)) || text.slice(0, 300) || res.statusText;
    const err = new Error(`MyDataValue-API-Fehler ${res.status} bei ${method} ${urlPath}: ${detail}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const mdvGet = (urlPath, query) => request("GET", urlPath, { query });
const mdvPost = (urlPath, body, opts) => request("POST", urlPath, { body, ...opts });
const mdvPut = (urlPath, body, opts) => request("PUT", urlPath, { body, ...opts });
const mdvPatch = (urlPath, body, opts) => request("PATCH", urlPath, { body, ...opts });
const mdvDelete = (urlPath, body, opts) => request("DELETE", urlPath, { body, ...opts });

// ===================== Airbnb =====================

const listAirbnbAutoRefresh = (query) => mdvGet("/airbnb/auto-refresh/", query);
const updateAirbnbAutoRefresh = (updates) => mdvPut("/airbnb/auto-refresh/", { updates });
const updateAirbnbCancellationPolicy = (body) => mdvPut("/airbnb/cancellation-policy/", body);
const getAirbnbCancellationPolicyOptions = (listingId) =>
  mdvGet(`/airbnb/cancellation-policy-options/${encodeURIComponent(listingId)}/`);
const getAirbnbListingCompset = (listingId) => mdvGet(`/airbnb/compset/${encodeURIComponent(listingId)}/`);
const listAirbnbListings = (query) => mdvGet("/airbnb/listings/", query);
const getAirbnbListing = (listingId) => mdvGet(`/airbnb/listings/${encodeURIComponent(listingId)}/`);
const updateAirbnbLoyalty = (listingId, enabled) => mdvPut("/airbnb/loyalty/", { listing_id: listingId, enabled });
const setAirbnbMobileDiscount = (listingId, percentage) =>
  mdvPut("/airbnb/mobile-discount/", { listing_id: listingId, percentage });
const clearAirbnbMobileDiscount = (listingId) => mdvDelete("/airbnb/mobile-discount/", { listing_id: listingId });
const updateAirbnbNewListingPromotion = (listingId, enabled) =>
  mdvPut("/airbnb/new-listing-promotion/", { listing_id: listingId, enabled });
const getAirbnbPerformance = (query) => mdvGet("/airbnb/performance/", query);
const getAirbnbListingPricing = (listingId, query) =>
  mdvGet(`/airbnb/pricing/${encodeURIComponent(listingId)}/`, query);
const listAirbnbPromotions = (query) => mdvGet("/airbnb/promotions/", query);
const createAirbnbPromotion = (body) => mdvPost("/airbnb/promotions/", body);
const removeAirbnbPromotion = (listingId, promotionUuid) =>
  mdvDelete("/airbnb/promotions/", { listing_id: listingId, promotion_uuid: promotionUuid });
const listAirbnbRanking = (query) => mdvGet("/airbnb/ranking/", query);
const listAirbnbReviews = (query) => mdvGet("/airbnb/reviews/", query);

// ===================== Booking.com =====================

const listBookingAutoRefresh = (query) => mdvGet("/booking/auto-refresh/", query);
const updateBookingAutoRefresh = (updates) => mdvPut("/booking/auto-refresh/", { updates });
const createBookingCancellationPolicy = (body) => mdvPost("/booking/cancellation-policies/", body);
const updateBookingCancellationPolicy = (body) => mdvPut("/booking/cancellation-policies/", body);
const deleteBookingCancellationPolicy = (body) => mdvDelete("/booking/cancellation-policies/", body);
const getBookingPropertyCompset = (propertyId) => mdvGet(`/booking/compset/${propertyId}/`);
const listBookingDemand = (query) => mdvGet("/booking/demand/", query);
const configureBookingGenius = (body) => mdvPut("/booking/genius/", body);
const updateBookingGuestTarget = (updates) => mdvPut("/booking/guest-target/", { updates });
const getBookingPerformance = (query) => mdvGet("/booking/performance/", query);
const updateBookingPreferredEnrolment = (body) => mdvPut("/booking/preferred/", body);
const getBookingPropertyPricing = (propertyId, query) => mdvGet(`/booking/pricing/${propertyId}/`, query);
const listBookingPromotions = (query) => mdvGet("/booking/promotions/", query);
const saveBookingPromotion = (body) => mdvPost("/booking/promotions/", body);
const deactivateBookingPromotion = (propertyId, promotionId) =>
  mdvDelete("/booking/promotions/", { property_id: propertyId, promotion_id: promotionId });
const listBookingProperties = () => mdvGet("/booking/properties/");
const getBookingProperty = (propertyId) => mdvGet(`/booking/properties/${propertyId}/`);
const listBookingRanking = (query) => mdvGet("/booking/ranking/", query);
const createBookingRatePlan = (propertyId, ratePlanConfig) =>
  mdvPost("/booking/rate-plans/", { property_id: propertyId, rate_plan_config: ratePlanConfig });
const deleteBookingRatePlan = (propertyId, bucketId) =>
  mdvDelete("/booking/rate-plans/", { property_id: propertyId, bucket_id: bucketId });
const listBookingReviews = (query) => mdvGet("/booking/reviews/", query);
const setBookingServiceCharge = (propertyId, serviceChargePct) =>
  mdvPut("/booking/service-charge/", { property_id: propertyId, service_charge_pct: serviceChargePct });
const removeBookingServiceCharge = (propertyId) => mdvDelete("/booking/service-charge/", { property_id: propertyId });
const setBookingVisibilityBooster = (propertyId, days, commission) =>
  mdvPut("/booking/visibility-booster/", { property_id: propertyId, days, commission });
const resetBookingVisibilityBooster = (propertyId, days) =>
  mdvDelete("/booking/visibility-booster/", { property_id: propertyId, days });

// ===================== Change-Log =====================

const listChangeLog = (query) => mdvGet("/change-log/", query);

// ===================== Push-Jobs (explizite Werte schreiben) =====================

const listPushJobs = (query) => mdvGet("/push-jobs/", query);
// targets: [{ target_id, params }]; capability = z.B. "airbnb.promotions.create" (siehe MyDataValue-Doku
// der jeweiligen synchronen Schreib-Endpunkte für die gültigen Capability-Namen).
const submitPushJob = ({ channel, capability, targets, skipUnavailable = false, idempotencyKey }) =>
  mdvPost("/push-jobs/", {
    channel,
    capability,
    targets,
    skip_unavailable: skipUnavailable,
    idempotency_key: idempotencyKey || buildIdempotencyKey("push"),
  });
const getPushJob = (jobId, after) => mdvGet(`/push-jobs/${encodeURIComponent(jobId)}/`, after ? { after } : undefined);

// ===================== Recalculate-Jobs (Promotion-Stack neu berechnen + live pushen) =====================
// Das ist laut MyDataValue-Support (Martin Dawson) der wichtigste Endpunkt:
// "the endpoint you will care about is recalculate-jobs with your desired
// BCOM or Airbnb IDs, that's the main one to calculate the promotion stack
// based on your target price." Der Request selbst trägt aber KEINEN
// Zielpreis — der Ziel-%-Satz wird vorher separat gesetzt (Booking:
// `updateBookingGuestTarget`; Airbnb hat dafür in dieser API keinen eigenen
// Schreib-Endpunkt) bzw. ergibt sich aus der schon konfigurierten
// Promotion-/Loyalty-/NLP-/Mobile-Discount-Lage. `submitRecalculateJob`
// stösst dieselbe Engine an, die auch der nächtliche Auto-Refresh nutzt, nur
// on-demand für die gewünschten IDs.

const listRecalculateJobs = (query) => mdvGet("/recalculate-jobs/", query);
const submitRecalculateJob = ({ channel, propertyIds, listingIds, skipUnavailable = false, idempotencyKey }) =>
  mdvPost("/recalculate-jobs/", {
    channel,
    property_ids: propertyIds,
    listing_ids: listingIds,
    skip_unavailable: skipUnavailable,
    idempotency_key: idempotencyKey || buildIdempotencyKey("recalc"),
  });
const getRecalculateJob = (jobId, after) =>
  mdvGet(`/recalculate-jobs/${encodeURIComponent(jobId)}/`, after ? { after } : undefined);

// ===================== Sync-Jobs (Daten von der OTA nachladen) =====================

const listSyncJobs = (query) => mdvGet("/sync-jobs/", query);
const submitSyncJob = ({ channel, scope = "properties", propertyIds, listingIds, skipUnavailable = false, idempotencyKey }) =>
  mdvPost("/sync-jobs/", {
    channel,
    scope,
    property_ids: propertyIds,
    listing_ids: listingIds,
    skip_unavailable: skipUnavailable,
    idempotency_key: idempotencyKey || buildIdempotencyKey("sync"),
  });
const getSyncJob = (jobId, after) => mdvGet(`/sync-jobs/${encodeURIComponent(jobId)}/`, after ? { after } : undefined);

// ===================== Tags =====================

const listTags = (query) => mdvGet("/tags/", query);
const createTag = (name) => mdvPost("/tags/", { name });
const renameTag = (tagId, name) => mdvPatch(`/tags/${tagId}/`, { name });
const deleteTag = (tagId) => mdvDelete(`/tags/${tagId}/`);
const assignTags = ({ add, remove, propertyIds, listingIds }) =>
  mdvPut("/tags/assignments/", { add, remove, property_ids: propertyIds, listing_ids: listingIds });

// ===================== Webhooks =====================

const listWebhookDeliveries = (query) => mdvGet("/webhook-deliveries/", query);
const listWebhookEndpoints = () => mdvGet("/webhook-endpoints/");
const createWebhookEndpoint = ({ url, eventTypes, description }) =>
  mdvPost("/webhook-endpoints/", { url, event_types: eventTypes, description });
const getWebhookEndpoint = (endpointId) => mdvGet(`/webhook-endpoints/${endpointId}/`);
const updateWebhookEndpoint = (endpointId, patch) => mdvPatch(`/webhook-endpoints/${endpointId}/`, patch);
const deleteWebhookEndpoint = (endpointId) => mdvDelete(`/webhook-endpoints/${endpointId}/`);
const rotateWebhookSecret = (endpointId) => mdvPost(`/webhook-endpoints/${endpointId}/rotate-secret/`);
const testWebhookEndpoint = (endpointId) => mdvPost(`/webhook-endpoints/${endpointId}/test/`);

// ===================== Komfort-Helfer (mehrseitig, fürs QA-Tool) =====================

// Holt ALLE Airbnb-Listings des Teams (paginiert). Sicherheitsgrenze von 20
// Seiten (bei Limit 100 also max. 2000 Listings) gegen eine Endlosschleife,
// falls die Pagination-Felder der API sich mal anders verhalten als erwartet.
async function listAllAirbnbListings() {
  const out = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 20; i++) {
    const page = await listAirbnbListings({ limit, offset });
    const results = page.results || [];
    out.push(...results);
    if (results.length < limit || out.length >= (page.count || out.length)) break;
    offset += limit;
  }
  return out;
}

// Booking.com liefert im Gegensatz zu Airbnb das ganze Portfolio in einer
// Antwort (kein limit/offset) — siehe `PropertyListResponse` in der Spezifikation.
async function listAllBookingProperties() {
  const page = await listBookingProperties();
  return page.properties || [];
}

module.exports = {
  // Low-Level (Escape-Hatch für alles, was hier noch nicht einzeln benannt ist)
  getAccessToken,
  request,
  mdvGet,
  mdvPost,
  mdvPut,
  mdvPatch,
  mdvDelete,
  buildIdempotencyKey,

  // OAuth-Connect ("Mit MyDataValue verbinden")
  storeRefreshToken,
  OAUTH_SCOPES,
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,

  // Airbnb
  listAirbnbAutoRefresh,
  updateAirbnbAutoRefresh,
  updateAirbnbCancellationPolicy,
  getAirbnbCancellationPolicyOptions,
  getAirbnbListingCompset,
  listAirbnbListings,
  getAirbnbListing,
  updateAirbnbLoyalty,
  setAirbnbMobileDiscount,
  clearAirbnbMobileDiscount,
  updateAirbnbNewListingPromotion,
  getAirbnbPerformance,
  getAirbnbListingPricing,
  listAirbnbPromotions,
  createAirbnbPromotion,
  removeAirbnbPromotion,
  listAirbnbRanking,
  listAirbnbReviews,

  // Booking.com
  listBookingAutoRefresh,
  updateBookingAutoRefresh,
  createBookingCancellationPolicy,
  updateBookingCancellationPolicy,
  deleteBookingCancellationPolicy,
  getBookingPropertyCompset,
  listBookingDemand,
  configureBookingGenius,
  updateBookingGuestTarget,
  getBookingPerformance,
  updateBookingPreferredEnrolment,
  getBookingPropertyPricing,
  listBookingPromotions,
  saveBookingPromotion,
  deactivateBookingPromotion,
  listBookingProperties,
  getBookingProperty,
  listBookingRanking,
  createBookingRatePlan,
  deleteBookingRatePlan,
  listBookingReviews,
  setBookingServiceCharge,
  removeBookingServiceCharge,
  setBookingVisibilityBooster,
  resetBookingVisibilityBooster,

  // Change-Log
  listChangeLog,

  // Jobs
  listPushJobs,
  submitPushJob,
  getPushJob,
  listRecalculateJobs,
  submitRecalculateJob,
  getRecalculateJob,
  listSyncJobs,
  submitSyncJob,
  getSyncJob,

  // Tags
  listTags,
  createTag,
  renameTag,
  deleteTag,
  assignTags,

  // Webhooks
  listWebhookDeliveries,
  listWebhookEndpoints,
  createWebhookEndpoint,
  getWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  rotateWebhookSecret,
  testWebhookEndpoint,

  // Komfort
  listAllAirbnbListings,
  listAllBookingProperties,
};
