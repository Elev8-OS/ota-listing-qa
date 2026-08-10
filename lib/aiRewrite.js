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
//
// Zeichenlimits (seit 2026-08-10): Airbnb begrenzt viele Textfelder hart
// (z. B. Titel auf 50 Zeichen) — die Extension liest dieses Limit direkt aus
// dem maxlength-Attribut des jeweiligen Feldes und reicht es hier als
// maxLength durch. Reine Höflichkeitsbitten im Prompt reichen nicht
// zuverlässig ("behalte ungefähr die Länge bei" hilft nicht, wenn das Limit
// enger ist als der Originaltext) — deshalb: explizite Zeichengrenze im
// Prompt, ein Korrektur-Versuch, falls die erste Antwort trotzdem zu lang
// ist, und als letzte Absicherung ein hartes, wortgrenzen-schonendes
// Abschneiden, damit garantiert nie ein Text zurückgeht, der das Limit
// überschreitet (das würde Airbnb sonst selbst und unkontrolliert tun).

const DEFAULT_SYSTEM_PROMPT = `Du hilfst dabei, Texte für ein Ferienwohnungs-Inserat (Airbnb) zu verbessern.
Schreibe den gegebenen Text auf Deutsch neu: klar, einladend, professionell und ohne Marketing-Übertreibungen.
Erfinde keine neuen Fakten (Zimmerzahl, Ausstattung, Lage, Regeln) — nutze nur, was im Text und im
mitgelieferten Kontext bereits steht. Behalte die ungefähre Länge des Originaltexts bei, ausser der
Kontext deutet klar auf zu wenig/zu viel Text hin oder nennt ein Zeichenlimit. Gib ausschliesslich den
neuen Text zurück, ohne Anführungszeichen, Erklärungen oder Vorbemerkungen.`;

function buildContextBlock({ channel, currentPath, currentFieldId, otherFields, maxLength }) {
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
  if (maxLength) {
    lines.push(
      `HARTES ZEICHENLIMIT für dieses Feld: maximal ${maxLength} Zeichen (inkl. Leerzeichen und Satzzeichen) — ` +
        `das ist Airbnbs technische Obergrenze für dieses Feld, kein Stilwunsch. Ein längerer Text wird von ` +
        `Airbnb abgeschnitten oder die Änderung abgelehnt. Halte den neuen Text unbedingt innerhalb dieser ` +
        `Grenze, auch wenn dafür deutlich gekürzt werden muss.`
    );
  }
  return lines.join("\n");
}

// Schneidet, falls trotz Anweisung + Retry immer noch zu lang, an der letzten
// Wortgrenze innerhalb des Limits ab (statt mitten im Wort), damit wenigstens
// kein halbes Wort übrig bleibt. Reine Sicherheitsnetz-Funktion — im
// Normalfall sollte es nie so weit kommen.
function hardTruncate(text, maxLength) {
  if (!maxLength || text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const safe = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return safe.trimEnd();
}

async function rewriteText({ channel, currentText, currentPath, currentFieldId, otherFields, maxLength }) {
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
    maxLength: maxLength || null,
  });

  async function callClaude(userContent) {
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
          messages: [{ role: "user", content: userContent }],
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
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: "Netzwerkfehler beim Aufruf der Claude-API: " + String((err && err.message) || err) };
    }
  }

  const first = await callClaude(`Kontext:\n${contextBlock}\n\nOriginaltext:\n${currentText}`);
  if (!first.ok) return first;

  let text = first.text;
  let truncated = false;

  if (maxLength && text.length > maxLength) {
    // Ein Retry-Versuch mit explizitem Hinweis auf die Ueberlaenge — Claude
    // haelt sich damit in aller Regel ans Limit. Nur falls das immer noch
    // nicht reicht, greift das harte Abschneiden als letzte Absicherung.
    const retry = await callClaude(
      `Kontext:\n${contextBlock}\n\nOriginaltext:\n${currentText}\n\nDein vorheriger Versuch war ${text.length} ` +
        `Zeichen lang — das sind ${text.length - maxLength} Zeichen zu viel. Formuliere bitte erneut, ` +
        `dieses Mal maximal ${maxLength} Zeichen insgesamt.`
    );
    if (retry.ok && retry.text.length <= maxLength) {
      text = retry.text;
    } else {
      text = hardTruncate(retry.ok ? retry.text : text, maxLength);
      truncated = true;
    }
  }

  return { ok: true, text, model, maxLength: maxLength || null, length: text.length, truncated };
}

module.exports = { rewriteText, DEFAULT_SYSTEM_PROMPT };
