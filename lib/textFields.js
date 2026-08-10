// Verwaltet die generisch erfasste "alle Texte im Inserat"-Ablage
// (channels.text_fields, JSON). Die Extension liest auf jeder Airbnb-Editor-
// Unterseite (Title, Description-Unterpanels, ...) alle sichtbaren
// <textarea>/<input>-Felder per HTML-id aus; hier wird das pro Pfad
// zusammengeführt, ohne ältere, bereits erfasste Seiten zu überschreiben.
//
// Seit 2026-08-10 wird pro Feld zusätzlich das native maxlength-Attribut
// mitgespeichert (z. B. 50 Zeichen beim Airbnb-Titel) — Airbnb (und
// vermutlich künftig auch Booking.com, sobald dessen Extension existiert)
// setzt für viele Textfelder ein hartes Zeichenlimit, das die KI beim
// Umformulieren einhalten muss und das im QA-Tool sichtbar sein soll, statt
// dass jemand das erst beim Speichern in Airbnb selbst merkt. Ältere,
// bereits gespeicherte Einträge sind noch reine Strings (ohne Limit-Info) —
// fieldValue()/fieldMaxLength() lesen beide Formate.

function mergeTextFields(existingJson, path, rawTextInputs) {
  let data = {};
  if (existingJson) {
    try {
      data = JSON.parse(existingJson) || {};
    } catch (e) {
      data = {};
    }
  }
  if (path && Array.isArray(rawTextInputs) && rawTextInputs.length) {
    const pageFields = { ...(data[path] || {}) };
    rawTextInputs.forEach((f) => {
      if (f && f.id) {
        pageFields[f.id] = {
          value: f.value ?? "",
          maxLength: typeof f.maxLength === "number" && f.maxLength > 0 ? f.maxLength : null,
        };
      }
    });
    data[path] = pageFields;
  }
  return JSON.stringify(data);
}

function parseTextFields(json) {
  if (!json) return {};
  try {
    return JSON.parse(json) || {};
  } catch (e) {
    return {};
  }
}

// Normalisiert einen Feld-Eintrag auf den Textwert. Alte, vor dem
// maxLength-Tracking gespeicherte Einträge sind ein reiner String; neue sind
// {value, maxLength}.
function fieldValue(entry) {
  if (entry == null) return undefined;
  return typeof entry === "string" ? entry : entry.value;
}

// Liefert das bekannte Zeichenlimit für einen Feld-Eintrag, oder null, wenn
// keines bekannt ist (z. B. altes Format, oder Airbnb hat für dieses Feld
// gar kein maxlength-Attribut gesetzt).
function fieldMaxLength(entry) {
  if (entry == null || typeof entry === "string") return null;
  return typeof entry.maxLength === "number" ? entry.maxLength : null;
}

module.exports = { mergeTextFields, parseTextFields, fieldValue, fieldMaxLength };
