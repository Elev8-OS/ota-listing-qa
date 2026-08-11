// Verwaltet die pro Kanal erfasste Airbnb-"Amenities"-Liste (channels.amenities,
// JSON: [{name, description}]) sowie den global über alle gescannten Airbnb-
// Kanäle hinweg gewachsenen Katalog aller JEMALS gesehenen Ausstattungsnamen
// (settings-Tabelle, Key "airbnb_amenity_catalog", JSON: string[]).
//
// Airbnb bietet Ausstattungsmerkmale aus einer festen, aber nirgends
// öffentlich als vollständige Liste dokumentierten Auswahl an -- im
// Host-Editor gibt es (Stand 2026-08) keine Seite, die "alle möglichen"
// unabhängig von einem konkreten Inserat auflistet, nur die bereits
// gewählten pro Inserat (live geprüft). Statt eine vermutlich unvollständige
// Liste von Hand zu pflegen, wächst der Katalog deshalb automatisch: jedes
// Mal, wenn die Extension die Amenities-Seite eines Inserats liest, werden
// neu gesehene Namen in den globalen Katalog aufgenommen. Je mehr Inserate
// gescannt wurden, desto vollständiger wird er von selbst -- die Differenz
// (Katalog minus die eines einzelnen Kanals) zeigt im QA-Tool, was bei DIESEM
// Inserat laut den ANDEREN gescannten Inseraten zusätzlich möglich wäre.

function parseAmenities(json) {
  if (!json) return [];
  try {
    const data = JSON.parse(json);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function parseCatalog(json) {
  if (!json) return [];
  try {
    const data = JSON.parse(json);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Führt neu gesehene Namen (aus einem einzelnen Kanal-Scan) case-insensitive
// mit dem bestehenden Katalog zusammen -- die zuerst gesehene Schreibweise
// bleibt erhalten (Airbnb schreibt Namen konsistent; Abweichungen wären eher
// ein Erfassungsfehler als eine echte alternative Schreibweise).
function mergeAmenityCatalog(existingJson, newNames) {
  const existing = parseCatalog(existingJson);
  const seen = new Set(existing.map((n) => String(n).toLowerCase()));
  const merged = [...existing];
  (newNames || []).forEach((name) => {
    const key = String(name || "").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(String(name).trim());
  });
  merged.sort((a, b) => a.localeCompare(b));
  return JSON.stringify(merged);
}

// Was wäre bei diesem Kanal laut Katalog zusätzlich möglich (case-insensitiver
// Abgleich, damit z. B. "wifi" vs. "Wifi" nicht fälschlich als "fehlt" gilt)?
function possibleAdditions(catalog, currentAmenities) {
  const have = new Set((currentAmenities || []).map((a) => String((a && a.name) || "").trim().toLowerCase()));
  return (catalog || []).filter((name) => !have.has(String(name).trim().toLowerCase()));
}

module.exports = { parseAmenities, parseCatalog, mergeAmenityCatalog, possibleAdditions };
