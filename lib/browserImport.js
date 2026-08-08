// Verarbeitet Daten, die die QA-Tool-Chrome-Extension aus dem eingeloggten
// Airbnb-Host-Editor extrahiert und per API an dieses Tool sendet.
//
// Unterschied zu lib/otaScraper.js (Playwright, öffentliche Seite, server-seitig
// auf Railway): Die Extension läuft im echten, bereits eingeloggten Chrome der
// Person selbst — keine Headless-Erkennung, kein Bot-Schutz-Thema, und der
// Host-Editor zeigt zusätzlich genau die Felder, die öffentlich nie sichtbar
// waren: die Fotorundgang-Zimmerliste und den separaten Bereich
// "Sleeping arrangements" (das war der ursprüngliche Auslöser für dieses Tool).
//
// WICHTIG: Es wird bewusst kein Login auf dem Server/Railway vorgenommen (siehe
// README) — die Extension nutzt ausschliesslich die bereits bestehende,
// legitime Browser-Session der Person auf ihrem eigenen Gerät.

function numberNear(text, patterns) {
  if (!text) return null;
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(",", "."));
  }
  return null;
}

function formatBrowserImportText(fields) {
  const lines = [];
  if (Array.isArray(fields.photoTourRooms) && fields.photoTourRooms.length) {
    lines.push("[Fotorundgang – Zimmer]");
    fields.photoTourRooms.forEach((r) => {
      const photos = r && r.photos != null ? ` (${r.photos} Foto${Number(r.photos) === 1 ? "" : "s"})` : "";
      lines.push(`${(r && r.name) || "?"}${photos}`);
    });
  }
  if (Array.isArray(fields.sleepingArrangements) && fields.sleepingArrangements.length) {
    if (lines.length) lines.push("");
    lines.push("[Sleeping arrangements]");
    fields.sleepingArrangements.forEach((r) => {
      lines.push(`${(r && r.room) || "?"}: ${(r && r.beds) || "?"}`);
    });
  }
  return lines.length ? lines.join("\n") : null;
}

function applyBrowserImport(fields) {
  fields = fields || {};
  const summary = String(fields.bedroomsSummary || "");
  const bedrooms = numberNear(summary, [/(\d+)\s*bedrooms?/i, /(\d+)\s*Schlafzimmer/i]);
  const beds = numberNear(summary, [/(\d+)\s*beds?/i, /(\d+)\s*Betten/i]);
  const bathrooms = numberNear(summary, [/(\d+(?:[.,]\d)?)\s*baths?/i, /(\d+(?:[.,]\d)?)\s*Bad(?:ezimmer)?/i]);
  const guestsRaw = fields.guests;
  const guests =
    guestsRaw != null && guestsRaw !== "" && !Number.isNaN(Number(guestsRaw)) ? Number(guestsRaw) : null;

  const liveText = formatBrowserImportText(fields);
  const ok = Boolean(liveText) || bedrooms != null || beds != null || guests != null;

  return {
    ok,
    note: ok
      ? "Aus dem eingeloggten Airbnb-Host-Editor per QA-Tool-Chrome-Extension gelesen — inkl. Fotorundgang-Zimmerliste und Sleeping-Arrangements-Bereich. Bitte trotzdem jeden Wert prüfen."
      : "Von der Browser-Extension kamen keine auswertbaren Felder (Seitenstruktur evtl. geändert). Bitte manuell erfassen.",
    declared: {
      bedrooms: bedrooms != null ? Math.round(bedrooms) : null,
      beds: beds != null ? Math.round(beds) : null,
      bathrooms: bathrooms,
      guests,
    },
    liveText,
  };
}

module.exports = { applyBrowserImport };
