// Extrahiert die numerische Airbnb-Listing-ID aus einem öffentlichen
// Inserat-Link (z. B. https://www.airbnb.ch/rooms/1135860716568917181?...).
// Diese ID ist bei den meisten Airbnb-Inseraten dieselbe wie die ID in der
// Host-Editor-URL (.../hosting/listings/editor/<ID>/...), die für die
// Browser-Extension benötigt wird — daher kann sie direkt übernommen werden,
// statt sie ein zweites Mal manuell abzutippen. Da Airbnb im Lauf der Zeit
// unterschiedliche ID-Formate verwendet hat (kurze wie lange, rein numerische
// IDs), bleibt das Feld im QA-Tool trotzdem frei editierbar, falls die
// Editor-URL im Einzelfall doch abweicht.
function extractAirbnbListingId(url) {
  if (!url) return null;
  const m = String(url).match(/\/rooms\/(?:plus\/)?(?:[a-z0-9-]+\/)?(\d{5,})/i);
  return m ? m[1] : null;
}

module.exports = { extractAirbnbListingId };
