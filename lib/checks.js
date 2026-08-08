// Konsistenz-Check-Engine
// Operationalisiert genau die Pruefpunkte aus dem Aenderungsreport:
// 1) Anzahl Schlafzimmer im Fotorundgang vs. Kopfzeile
// 2) Anzahl Betten (Fotorundgang-Zimmer + Wohnzimmer-Schlafgelegenheiten) vs. Kopfzeile
// 3) Jedes Zimmer mit Schlafgelegenheit muss auch im separaten Bereich "Schlafgelegenheiten" hinterlegt sein
// 4) Deklarierter Bettentyp pro Zimmer vs. das, was die Fotos tatsaechlich zeigen
// 5) Gesamte Schlafkapazitaet vs. maximale Gästezahl

const PLATFORM_LABEL = { airbnb: "Airbnb", booking: "Booking.com" };
const EDITOR_LABEL = {
  airbnb: "Airbnb Inserate-Editor (Fotorundgang / Schlafgelegenheiten)",
  booking: "Booking.com Extranet (Zimmerinformationen / Bettenkonfiguration)",
};

function computeFindings(channel, rooms) {
  const findings = [];
  const platform = PLATFORM_LABEL[channel.platform] || channel.platform;
  const editorLabel = EDITOR_LABEL[channel.platform] || "OTA-Editor";

  const sleepRooms = rooms.filter((r) => r.hat_schlafgelegenheit);
  const bedroomRooms = rooms.filter((r) => r.room_type === "schlafzimmer");

  const computedBedrooms = bedroomRooms.length;
  const computedBeds = sleepRooms.reduce((sum, r) => sum + (r.bed_count || 0), 0);
  const computedCapacity = sleepRooms.reduce((sum, r) => sum + (r.sleep_capacity || 0), 0);

  // 1) Schlafzimmeranzahl
  if (channel.declared_bedrooms !== null && channel.declared_bedrooms !== computedBedrooms) {
    findings.push({
      key: "bedrooms_mismatch",
      severity: "hoch",
      title: "Schlafzimmeranzahl in Kopfzeile stimmt nicht mit Fotorundgang überein",
      detail: `Kopfzeile zeigt ${channel.declared_bedrooms} Schlafzimmer, im Fotorundgang sind aber ${computedBedrooms} Zimmer als Typ "Schlafzimmer" erfasst.`,
      suggestedText: `Im ${editorLabel} die Anzahl Schlafzimmer in der Übersicht auf ${computedBedrooms} korrigieren (aktuell ${channel.declared_bedrooms}). Falls im Fotorundgang tatsächlich eine überzählige Zimmerkategorie existiert, diese auflösen bzw. deren Fotos der richtigen Kategorie zuordnen, statt nur die Zahl zu ändern.`,
    });
  }

  // 2) Bettenanzahl
  if (channel.declared_beds !== null && channel.declared_beds !== computedBeds) {
    findings.push({
      key: "beds_mismatch",
      severity: "hoch",
      title: "Bettenanzahl in Kopfzeile stimmt nicht mit den einzelnen Zimmern überein",
      detail: `Kopfzeile zeigt ${channel.declared_beds} Bett(en), die Summe der Betten über alle erfassten Zimmer mit Schlafgelegenheit ergibt aber ${computedBeds}.`,
      suggestedText: `Im ${editorLabel} die Bettenanzahl in der Übersicht auf ${computedBeds} setzen (aktuell ${channel.declared_beds}). Betroffene Zimmer: ${sleepRooms.map((r) => `${r.name} (${r.bed_count})`).join(", ") || "-"}.`,
    });
  }

  // 3) Sync Fotorundgang <-> globale Schlafgelegenheiten
  const missingGlobal = sleepRooms.filter((r) => !r.in_schlafgelegenheiten);
  if (missingGlobal.length > 0) {
    findings.push({
      key: "sleeping_arrangements_not_synced",
      severity: "hoch",
      title: "Zimmer im Fotorundgang fehlt im separaten Bereich „Schlafgelegenheiten“",
      detail: `Folgende Zimmer haben laut Fotorundgang eine Schlafgelegenheit, sind aber im globalen Bereich „Schlafgelegenheiten“ nicht hinterlegt: ${missingGlobal.map((r) => r.name).join(", ")}.`,
      suggestedText: `Im Bereich „Schlafgelegenheiten“ die fehlenden Einträge ergänzen: ${missingGlobal
        .map((r) => `${r.name} – ${r.bed_count} × ${r.declared_bed_type || "Bettentyp angeben"}`)
        .join("; ")}. Erst danach stimmen Fotorundgang und Schlafgelegenheiten überein.`,
    });
  }

  // 4) Bettentyp vs. Foto
  const typeMismatches = rooms.filter(
    (r) => r.declared_bed_type && r.photo_bed_type && r.declared_bed_type !== r.photo_bed_type
  );
  for (const r of typeMismatches) {
    findings.push({
      key: `bed_type_mismatch_${r.id}`,
      severity: "mittel",
      title: `„${r.name}“: Hinterlegter Bettentyp widerspricht den Fotos`,
      detail: `Hinterlegt ist „${r.declared_bed_type}“, die Fotos zeigen aber „${r.photo_bed_type}“.`,
      suggestedText: `Bei „${r.name}“ den hinterlegten Bettentyp von „${r.declared_bed_type}“ auf „${r.photo_bed_type}“ korrigieren (bzw. die Fotos ersetzen, falls „${r.declared_bed_type}“ korrekt ist und stattdessen die Fotos falsch sind).`,
    });
  }

  // 5) Schlafkapazitaet vs. Gästezahl
  if (channel.declared_guests !== null && computedCapacity < channel.declared_guests) {
    findings.push({
      key: "capacity_below_guests",
      severity: "hoch",
      title: "Dokumentierte Schlafkapazität deckt die maximale Gästezahl nicht ab",
      detail: `Summe der Schlafkapazität über alle Zimmer: ${computedCapacity} Personen. Inserat gibt aber ${channel.declared_guests} Gäste an.`,
      suggestedText: `Entweder die maximale Gästezahl auf ${computedCapacity} reduzieren, oder eine fehlende Schlafgelegenheit (z. B. Sofabett) ergänzen, damit die Kapazität ${channel.declared_guests} Personen erreicht.`,
    });
  }

  return findings;
}

module.exports = { computeFindings, PLATFORM_LABEL, EDITOR_LABEL };
