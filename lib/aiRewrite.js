// KI-Umformulierung für die "alle Texte im Inserat"-Funktion. Ruft die
// Claude-API (Anthropic Messages API) direkt per fetch auf — kein SDK, um
// keine zusätzliche Abhängigkeit/Docker-Build-Zeit zu brauchen.
//
// Bewusst zwei Stellschrauben per Umgebungsvariable, ohne Code-Änderung
// änderbar (Railway-Variable ändern → Container startet neu, kein Rebuild):
//   - AI_REWRITE_SYSTEM_PROMPT: die eigentliche Persona/Anweisung. Wenn nicht
//     gesetzt, wird ein neutraler Standard-Prompt verwendet (siehe unten).
//     Reto hat angekündigt, den eigentlichen Prompt/die Persona separat zu
//     liefern — dafür einfach diese Variable in Railway setzen.
//   - AI_REWRITE_MODEL: Modellname, falls ein anderes Claude-Modell als der
//     Standard verwendet werden soll.
//
// ANTHROPIC_API_KEY ist Pflicht — ohne sie liefert rewriteText() einen
// klaren Fehler zurück statt eines kryptischen HTTP-Fehlers.

const DEFAULT_SYSTEM_PROMPT = `Du hilfst dabei, Texte für ein Ferienwohnungs-Inserat (Airbnb) zu verbessern.
Schreibe den gegebenen Text auf Deutsch neu: klar, einladend, professionell und ohne Marketing-Übertreibungen.
Erfinde keine neuen Fakten (Zimmerzahl, Ausstattung, Lage, Regeln) — nutze nur, was im Text und im
mitgelieferten Kontext bereits steht. Behalte die ungefähre Länge des Originaltexts bei, ausser der
Kontext deutet klar auf zu wenig/zu viel Text hin. Gib ausschliesslich den neuen Text zurück, ohne
Anführungszeichen, Erklärungen oder Vorbemerkungen.`;

function buildContextBlock({ channel, currentPath, currentFieldId, otherFields }) {
  const lines = [];
  lines.push(
    `Kanal: ${channel.platform}${channel.url ? " (" + channel.url + ")" : ""}`
  );
  lines.push(
    `Eckdaten laut Inserat-Kopfzeile: ${channel.declared_bedrooms ?? "?"} Schlafzimmer, ${
      channel.declared_beds ?? "?"
    } Betten, ${channel.declared_bathrooms ?? "?"} Badezimmer, max. ${channel.declared_guests ?? "?"} Gäste.`
  );
  if (otherFields.length) {
    lines.push("Andere bereits erfasste Texte desselben Inserats (zur Konsistenz, nicht 1:1 übernehmen):");
    otherFields.forEach((f) => {
      lines.push(`- [${f.path} · ${f.fieldId}]: ${f.value.slice(0, 500)}`);
    });
  }
  lines.push(`Zu überarbeitendes Feld: ${currentPath} · ${currentFieldId}`);
  return lines.join("\n");
}

async function rewriteText({ channel, currentText, currentPath, currentFieldId, otherFields }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        "KI-Umformulierung ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt in den Railway-Umgebungsvariablen).",
    };
  }
  if (!currentText || !currentText.trim()) {
    return { ok: false, error: "Kein Ausgangstext zum Umformulieren vorhanden." };
  }

  // WICHTIG: "claude-3-5-sonnet-latest" existiert nicht mehr (Claude-API
  // antwortete live mit 404 "model: claude-3-5-sonnet-latest") — per
  // Anthropic-Doku bestätigt aktuelles, gültiges Standardmodell:
  // "claude-sonnet-5".
  const model = process.env.AI_REWRITE_MODEL || "claude-sonnet-5";
  const systemPrompt = process.env.AI_REWRITE_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const contextBlock = buildContextBlock({
    channel,
    currentPath,
    currentFieldId,
    otherFields: otherFields || [],
  });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Kontext:\n${contextBlock}\n\nOriginaltext:\n${currentText}`,
          },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: `Claude-API-Fehler (${res.status}): ${data && data.error && data.error.message ? data.error.message : "unbekannt"}`,
      };
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) {
      return { ok: false, error: "Claude hat keinen Text zurückgegeben." };
    }
    return { ok: true, text, model };
  } catch (err) {
    return { ok: false, error: "Netzwerkfehler beim Aufruf der Claude-API: " + String((err && err.message) || err) };
  }
}

module.exports = { rewriteText, DEFAULT_SYSTEM_PROMPT };
