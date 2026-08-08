// Best-effort Import aus dem OEFFENTLICHEN Inserats-Link.
//
// WICHTIG (bewusste Einschraenkung, im UI klar kommuniziert):
// Airbnb und Booking.com bieten keine offizielle API fuer die Editor-internen
// Felder "Fotorundgang" (Aufteilung nach Zimmerkategorien) und "Schlafgelegenheiten"
// pro Zimmer. Diese Daten sind nur sichtbar, wenn man als Host/Objekt-Betreuer im
// jeweiligen Editor eingeloggt ist, und muessen daher manuell erfasst werden.
//
// Was sich ueber die oeffentliche Seite ansatzweise auslesen laesst (best effort,
// haengt von der jeweiligen Seitenstruktur ab und kann jederzeit brechen):
// Titel, Meta-Beschreibung, teilweise Gaeste-/Zimmer-/Bettenangaben, falls diese
// im HTML bzw. in eingebetteten JSON-LD-Daten oder OpenGraph-Tags stehen.
//
// Ergebnis wird immer als "automatisch vorbefuellt - bitte pruefen" markiert.

async function fetchPublicListingData(url) {
  const result = {
    ok: false,
    note: "",
    fields: {},
  };

  if (!url || !/^https?:\/\//i.test(url)) {
    result.note = "Kein gültiger Link angegeben – Import übersprungen.";
    return result;
  }

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "de-CH,de;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      result.note = `Seite konnte nicht geladen werden (HTTP ${res.status}). Bitte Angaben manuell erfassen.`;
      return result;
    }
    html = await res.text();
  } catch (err) {
    result.note = `Automatischer Import fehlgeschlagen (${err.message}). Airbnb/Booking.com rendern Inhalte oft erst per JavaScript und blocken automatisierte Abrufe — bitte Angaben manuell aus dem eingeloggten Editor übertragen.`;
    return result;
  }

  const getMeta = (name) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`,
      "i"
    );
    const m = html.match(re);
    return m ? m[1] : null;
  };

  const title = getMeta("og:title") || (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
  const description = getMeta("og:description") || getMeta("description");

  if (title) result.fields.title = title.trim();
  if (description) result.fields.description = description.trim();

  // Sehr grobe, best-effort Heuristik fuer Zahlenangaben, falls sie im sichtbaren
  // Text/JSON-LD vorkommen (z.B. "4 guests", "4 Gäste", "2 bedrooms", "1 bathroom").
  const numberNear = (patterns) => {
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };

  const guests = numberNear([
    /(\d+)\s*(?:guests?|Gäste)/i,
    /"personCapacity"\s*:\s*(\d+)/i,
  ]);
  const bedrooms = numberNear([
    /(\d+)\s*(?:bedrooms?|Schlafzimmer)/i,
    /"bedrooms"\s*:\s*(\d+)/i,
  ]);
  const beds = numberNear([/(\d+)\s*(?:beds?|Betten?)/i, /"beds"\s*:\s*(\d+)/i]);
  const bathrooms = numberNear([
    /(\d+(?:[.,]\d)?)\s*(?:bathrooms?|Badezimmer)/i,
  ]);

  if (guests !== null) result.fields.guests = guests;
  if (bedrooms !== null) result.fields.bedrooms = bedrooms;
  if (beds !== null) result.fields.beds = beds;
  if (bathrooms !== null) result.fields.bathrooms = bathrooms;

  result.ok = Object.keys(result.fields).length > 0;
  result.note = result.ok
    ? "Automatisch aus der öffentlichen Seite vorbefüllt — bitte jeden Wert prüfen, bevor er übernommen wird. Die zimmerweise Aufteilung (Fotorundgang, Schlafgelegenheiten pro Zimmer) ist nicht öffentlich sichtbar und muss manuell aus dem Editor erfasst werden."
    : "Auf der öffentlichen Seite konnten keine der bekannten Felder gefunden werden (Seite wird häufig erst per JavaScript befüllt). Bitte alle Angaben manuell erfassen.";

  return result;
}

module.exports = { fetchPublicListingData };
