// Verwaltet die generisch erfasste "alle Texte im Inserat"-Ablage
// (channels.text_fields, JSON). Die Extension liest auf jeder Airbnb-Editor-
// Unterseite (Title, Description-Unterpanels, ...) alle sichtbaren
// <textarea>/<input>-Felder per HTML-id aus; hier wird das pro Pfad
// zusammengeführt, ohne ältere, bereits erfasste Seiten zu überschreiben.

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
      if (f && f.id) pageFields[f.id] = f.value ?? "";
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

module.exports = { mergeTextFields, parseTextFields };
