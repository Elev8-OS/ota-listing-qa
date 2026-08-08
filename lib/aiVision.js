// Erzeugt einen Alt-Text-Vorschlag ("visual description") für ein einzelnes
// Foto per Claude-Vision. Airbnb hat dafür pro Foto ein eigenes, bisher
// leeres Feld (HTML-id "alt-text-input", max. 250 Zeichen, Platzhaltertext
// "Describe the space, style, and objects as pictured.") — live im
// Host-Editor gefunden. Anders als bei lib/aiRewrite.js gibt es hier keinen
// vorhandenen Text zum Umformulieren; Claude muss das Bild selbst ansehen.
//
// Nutzt dieselbe ANTHROPIC_API_KEY wie lib/aiRewrite.js. Eigene, optionale
// Stellschrauben (Railway-Variable, kein Redeploy-Zwang):
//   - AI_ALTTEXT_SYSTEM_PROMPT: Persona/Anweisung für die Bildbeschreibung.
//   - AI_REWRITE_MODEL (wiederverwendet): Modell muss Vision unterstützen —
//     alle aktuellen Claude-Modelle tun das.

const DEFAULT_ALTTEXT_PROMPT = `Du beschreibst Fotos aus einem Ferienwohnungs-Inserat (Airbnb) für das
"Add a visual description"-Feld (Bildbeschreibung/Alt-Text). Beschreibe auf Englisch, sachlich und knapp,
was auf dem Bild zu sehen ist: Raum, Möbel, Materialien, Stil, auffällige Details. Keine Marketing-Sprache,
keine Übertreibungen, keine erfundenen Fakten. Maximal 250 Zeichen. Gib ausschliesslich den Beschreibungstext
zurück, ohne Anführungszeichen oder Erklärungen.`;

async function fetchImageAsBase64(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Bild konnte nicht geladen werden (HTTP ${res.status}).`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mediaType: contentType.split(";")[0] };
}

async function describeImage({ imageUrl, roomName }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "KI-Bildbeschreibung ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt in den Railway-Umgebungsvariablen).",
    };
  }
  if (!imageUrl) {
    return { ok: false, error: "Keine Bild-URL übergeben." };
  }

  // WICHTIG: "claude-3-5-sonnet-latest" existiert nicht mehr (Claude-API
  // antwortete live mit 404 "model: claude-3-5-sonnet-latest") — per
  // Anthropic-Doku bestätigt aktuelles, gültiges Standardmodell:
  // "claude-sonnet-5".
  const model = process.env.AI_REWRITE_MODEL || "claude-sonnet-5";
  const systemPrompt = process.env.AI_ALTTEXT_SYSTEM_PROMPT || DEFAULT_ALTTEXT_PROMPT;

  let image;
  try {
    image = await fetchImageAsBase64(imageUrl);
  } catch (err) {
    return { ok: false, error: "Bild konnte nicht geladen werden: " + String((err && err.message) || err) };
  }

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
        max_tokens: 300,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: image.base64 },
              },
              {
                type: "text",
                text: roomName
                  ? `Dieses Foto gehört zum Raum/Bereich "${roomName}" des Inserats. Beschreibe es.`
                  : "Beschreibe dieses Foto.",
              },
            ],
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
      .join(" ")
      .trim()
      .slice(0, 250);
    if (!text) {
      return { ok: false, error: "Claude hat keine Beschreibung zurückgegeben." };
    }
    return { ok: true, text, model };
  } catch (err) {
    return { ok: false, error: "Netzwerkfehler beim Aufruf der Claude-API: " + String((err && err.message) || err) };
  }
}

module.exports = { describeImage, DEFAULT_ALTTEXT_PROMPT };
