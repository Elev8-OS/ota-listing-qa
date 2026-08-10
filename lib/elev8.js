// Verbindung zur Elev8-Suite-API, um Airbnb- und Booking.com-Kanäle
// desselben physischen Objekts beim MyDataValue-Import zu einem einzigen
// QA-Tool-Inserat zusammenzuführen, statt für jede Plattform ein eigenes
// Inserat anzulegen.
//
// Elev8 verwaltet pro Objekt ein Feld `ota_channels` (Array), das genau die
// beiden OTA-IDs verknüpft, z. B.:
//   ota_channels: [
//     { ota_listing_id: "1339703527804799550", channel_name: "AIRBNB" },
//     { ota_listing_id: "13478024", channel_name: "BOOKING_COM" }
//   ]
// `ota_listing_id` entspricht dabei exakt Airbnbs `listing_id` bzw. Bookings
// `property_id`, wie sie auch in MyDataValue verwendet werden — damit lässt
// sich (platform, external_id) auf eine gemeinsame Elev8-Objekt-ID (item.id)
// abbilden.
//
// Nicht jedes Objekt hat eine Elev8-Verknüpfung (z. B. Marken/Accounts, die
// Elev8 gar nicht kennt, wie "MiHome" in Österreich laut ID-Abgleich-Tabelle)
// — für solche Fälle liefert die Zuordnung schlicht nichts, und der Aufrufer
// fällt auf das bisherige Verhalten (ein Inserat pro Plattform) zurück.

const ELEV8_API_BASE = "https://api.elev8-suite.com/api/v1";

const PLATFORM_BY_CHANNEL_NAME = {
  AIRBNB: "airbnb",
  BOOKING_COM: "booking",
};

// Holt alle Elev8-Listings (seitenweise, siehe `last_page`/`current_page` in
// der API-Antwort) und gibt sie als flaches Array zurück. Gibt `null`
// zurück, wenn kein ELEV8_API_TOKEN gesetzt ist (dann ist eine Zusammen-
// führung schlicht nicht möglich, kein harter Fehler).
async function fetchAllElev8Listings() {
  const token = process.env.ELEV8_API_TOKEN;
  if (!token) return null;

  const perPage = 100;
  const maxPages = 50; // Sicherheitsgrenze gegen eine Endlosschleife bei unerwarteter API-Antwort.
  const all = [];
  let page = 1;
  let lastPage = 1;

  do {
    const url = new URL(`${ELEV8_API_BASE}/listing`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const upstream = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      throw new Error(`Elev8-API antwortete mit Status ${upstream.status}${text ? ": " + text.slice(0, 300) : ""}`);
    }
    const parsed = await upstream.json();
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    all.push(...data);
    lastPage = Number(parsed.last_page) || 1;
    page += 1;
  } while (page <= lastPage && page <= maxPages);

  return all;
}

// Baut aus den Elev8-Listings eine Lookup-Map: "airbnb:<externalId>" bzw.
// "booking:<externalId>" -> Elev8-Listing-ID (item.id). Diese Elev8-Listing-ID
// dient im QA-Tool als gemeinsamer Gruppierungsschlüssel (siehe
// listings.elev8_listing_id in db.js).
function buildOtaChannelMap(elev8Listings) {
  const map = new Map();
  for (const item of elev8Listings || []) {
    if (!item || !Array.isArray(item.ota_channels)) continue;
    for (const ch of item.ota_channels) {
      if (!ch) continue;
      const platform = PLATFORM_BY_CHANNEL_NAME[ch.channel_name];
      if (!platform || !ch.ota_listing_id) continue;
      map.set(`${platform}:${ch.ota_listing_id}`, item.id);
    }
  }
  return map;
}

module.exports = { ELEV8_API_BASE, fetchAllElev8Listings, buildOtaChannelMap };
