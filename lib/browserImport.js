// Verarbeitet Daten, die die QA-Tool-Chrome-Extension aus dem eingeloggten
// Airbnb-Host-Editor extrahiert und per API an dieses Tool sendet.
//
// Dies ist der EINZIGE Weg, wie Daten von Airbnb/Booking.com in dieses Tool
// gelangen — es wird bewusst nie serverseitig (z. B. per Playwright/Headless-
// Chromium) die öffentliche Seite abgerufen. Die Extension läuft im echten,
// bereits eingeloggten Chrome der Person selbst — keine Headless-Erkennung,
// kein Bot-Schutz-Thema, und der Host-Editor zeigt zusätzlich genau die
// Felder, die öffentlich nie sichtbar waren: die Fotorundgang-Zimmerliste und
// den separaten Bereich "Sleeping arrangements" (das war der ursprüngliche
// Auslöser für dieses Tool).
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
  // WICHTIG: \b am Ende jedes Musters — sonst matcht z. B. "beds?" bereits
  // auf das "bed" in "bedroom" (Bug, live gefunden: "2 beds" wurde als 1
  // gelesen, weil "1 bedroom" zuerst im String steht und ohne \b schon als
  // Treffer für "beds?" durchging).
  const bedrooms = numberNear(summary, [/(\d+)\s*bedrooms?\b/i, /(\d+)\s*Schlafzimmer\b/i]);
  const beds = numberNear(summary, [/(\d+)\s*beds?\b/i, /(\d+)\s*Betten\b/i]);
  const bathrooms = numberNear(summary, [/(\d+(?:[.,]\d)?)\s*baths?\b/i, /(\d+(?:[.,]\d)?)\s*Bad(?:ezimmer)?\b/i]);
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

// ---------- Zimmer/Betten aus "Sleeping arrangements" (v1.7.0) ----------
// Wandelt die von content.js auf .../details/sleeping-arrangements gelesenen
// Paare { room, bedsText } (bedsText === null, falls Airbnb dort "Add details"
// zeigt, d. h. noch kein Bett hinterlegt) in Zeilen für die "rooms"-Tabelle
// um. Der eigentliche DB-Upsert (Zuordnung zu bestehenden Zimmern per Name,
// INSERT bei neuen) passiert in server.js — hier nur die reine Umwandlung,
// analog zur Trennung Text-Parsing (hier) vs. DB (server.js) beim Rest dieser
// Datei.
function classifyRoomType(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bedroom") || n.includes("schlafzimmer")) return "schlafzimmer";
  if (n.includes("living") || n.includes("wohnzimmer") || n.includes("wohnbereich")) return "wohnzimmer";
  return "sonstiges";
}

// Reihenfolge wichtig: spezifischere Begriffe (queen/king/sofa/bunk) vor den
// allgemeineren (double/single), sonst würde z. B. "queen" nie erreicht, weil
// manche Namen mehrere Wörter gleichzeitig enthalten könnten.
const BED_TYPE_KEYWORDS = [
  { re: /sofa/i, label: "Schlafcouch", capacityPerBed: 2 },
  { re: /bunk/i, label: "Etagenbett", capacityPerBed: 1 },
  { re: /king/i, label: "Kingsize-Doppelbett", capacityPerBed: 2 },
  { re: /queen/i, label: "Queensize-Doppelbett", capacityPerBed: 2 },
  { re: /(double|full)/i, label: "Doppelbett", capacityPerBed: 2 },
  { re: /(single|twin)/i, label: "Einzelbett", capacityPerBed: 1 },
];

// bedsText sieht bei Airbnb z. B. so aus: "1 queen bed", "2 single beds",
// oder bei mehreren Bettarten im selben Raum kommagetrennt: "1 queen bed,
// 1 single bed". Pro Segment wird die führende Zahl als Bettenzahl gelesen,
// der Rest per Stichwort einem der Dropdown-Bettentypen des QA-Tools
// zugeordnet (Sonstiges als Fallback). sleep_capacity ist eine grobe, aus dem
// Bettentyp abgeleitete Näherung (analog Airbnbs eigener Gästezahl-Logik) —
// wie beim Rest der automatischen Erfassung gilt: Näherung, kein Ersatz für
// eine kurze manuelle Prüfung.
function parseBedsText(bedsText) {
  if (!bedsText) return { bed_count: 0, declared_bed_type: "", sleep_capacity: 0 };
  const segments = String(bedsText)
    .split(/,| and /i)
    .map((s) => s.trim())
    .filter(Boolean);
  let bed_count = 0;
  let sleep_capacity = 0;
  let declared_bed_type = "";
  segments.forEach((seg, idx) => {
    const m = seg.match(/^(\d+)\s+(.+?)\s*beds?$/i);
    const count = m ? Number(m[1]) : 1;
    const typeText = m ? m[2] : seg;
    const known = BED_TYPE_KEYWORDS.find((k) => k.re.test(typeText));
    bed_count += count;
    sleep_capacity += count * (known ? known.capacityPerBed : 1);
    if (idx === 0) declared_bed_type = known ? known.label : "Sonstiges";
  });
  return { bed_count, declared_bed_type, sleep_capacity };
}

function parseSleepingArrangementsRooms(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs
    .map((p) => {
      const name = String((p && p.room) || "").trim();
      const parsed = parseBedsText(p && p.bedsText);
      return {
        name,
        room_type: classifyRoomType(name),
        bed_count: parsed.bed_count,
        declared_bed_type: parsed.declared_bed_type,
        sleep_capacity: parsed.sleep_capacity,
        hat_schlafgelegenheit: parsed.bed_count > 0 ? 1 : 0,
      };
    })
    .filter((r) => r.name);
}

module.exports = { applyBrowserImport, parseSleepingArrangementsRooms };
