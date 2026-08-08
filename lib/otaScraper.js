// Server-seitiger Import direkt von den OTA-Seiten (Airbnb/Booking.com) mittels
// Playwright (echter, headless Chromium-Browser) statt einfachem HTML-Fetch.
//
// Grund: Airbnb und Booking.com laden die eigentlichen Inhalte erst per
// JavaScript nach. Ein einfacher fetch() bekommt daher fast nie die
// gesuchten Felder zu Gesicht (siehe lib/importer.js, alte Variante).
// Mit einem echten Browser sieht das Skript die Seite so, wie ein Gast sie
// sehen würde.
//
// WICHTIG:
// - Es werden ausschliesslich öffentlich sichtbare Felder gelesen (keine
//   Logins, keine Editor-internen Felder wie Fotorundgang-Zuordnung).
// - Wird eine Bot-Schutz-/Verifizierungsseite ("Are you a human", Captcha,
//   "ungewöhnlicher Verkehr" etc.) erkannt, wird NICHT versucht, diese zu
//   umgehen — es wird sauber abgebrochen und dem Nutzer gemeldet.
// - Jeder gelesene Wert ist als "bitte prüfen" zu behandeln; Airbnb/Booking.com
//   können ihre Seitenstruktur jederzeit ändern.

const { chromium } = require("playwright");

const BOT_BLOCK_PATTERNS = [
  /verify you.?re a human/i,
  /are you a human/i,
  /unusual traffic/i,
  /ungewöhnliche(n)? (aktivität|verkehr)/i,
  /bestätige.*mensch/i,
  /captcha/i,
  /access denied/i,
  /request blocked/i,
  /checking your browser/i,
];

function detectBotBlock(text) {
  return BOT_BLOCK_PATTERNS.some((re) => re.test(text));
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    // Erlaubt explizite Angabe des Browser-Binaries (z. B. fuer lokale
    // Entwicklung, wenn die installierte Playwright-Version nicht exakt zur
    // vorhandenen Browser-Revision passt). Im Docker-Image (Produktion) ist
    // das nicht gesetzt und Playwright nutzt seinen mitgelieferten Chromium.
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      locale: "de-CH",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

function numberNear(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(",", "."));
  }
  return null;
}

async function getBodyText(page) {
  // page.evaluate(() => document.body.innerText) kann racen, wenn die Seite
  // gerade (client-seitig) weiterleitet und "document.body" kurz null ist.
  // page.innerText('body') ist Playwrights eigene, auto-wartende Locator-API
  // und robuster; zusätzlich noch ein manueller Retry als zweite Absicherung.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.innerText("body", { timeout: 10000 });
    } catch (err) {
      if (attempt === 2) throw err;
      await page.waitForTimeout(1500);
    }
  }
}

function extractSection(text, headingPatterns, maxLen = 600) {
  for (const re of headingPatterns) {
    const m = re.exec(text);
    if (m) {
      const start = m.index + m[0].length;
      return text.slice(start, start + maxLen).trim();
    }
  }
  return null;
}

async function scrapeAirbnb(url) {
  const result = { ok: false, note: "", fields: {} };
  try {
    await withBrowser(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Cookie-Banner best-effort wegklicken, falls vorhanden (blockiert sonst nichts
      // Inhaltliches, aber schadet nicht).
      try {
        const cookieBtn = page.getByRole("button", { name: /accept|akzeptieren|zustimmen/i }).first();
        if (await cookieBtn.isVisible({ timeout: 3000 })) await cookieBtn.click({ timeout: 3000 });
      } catch (_) {}

      // Warten, bis wesentlicher Inhalt gerendert ist.
      try {
        await page.waitForFunction(
          () => /guests?|gäste|bedroom|schlafzimmer/i.test(document.body.innerText),
          { timeout: 15000 }
        );
      } catch (_) {
        // weiter versuchen, auch wenn das Warten timeoutet
      }

      const title = await page.title();
      const bodyText = await getBodyText(page);

      if (detectBotBlock(bodyText) || detectBotBlock(title)) {
        result.note =
          "Bot-Schutz/Verifizierung von Airbnb erkannt — automatischer Abruf abgebrochen (wird nicht umgangen). Bitte manuell im Editor prüfen.";
        return;
      }

      result.fields.title = title.replace(/\s*[-·|].*airbnb.*$/i, "").trim();

      const guests = numberNear(bodyText, [/(\d+)\s*(?:guests?|Gäste)/i]);
      const bedrooms = numberNear(bodyText, [/(\d+)\s*(?:bedrooms?|Schlafzimmer)\b/i]);
      const beds = numberNear(bodyText, [/(\d+)\s*(?:beds?|Betten)\b/i]);
      const bathrooms = numberNear(bodyText, [/(\d+(?:[.,]\d)?)\s*(?:baths?|bathrooms?|Bad(?:ezimmer)?)\b/i]);

      if (guests !== null) result.fields.guests = Math.round(guests);
      if (bedrooms !== null) result.fields.bedrooms = Math.round(bedrooms);
      if (beds !== null) result.fields.beds = Math.round(beds);
      if (bathrooms !== null) result.fields.bathrooms = bathrooms;

      const sleepSection = extractSection(bodyText, [
        /Where you.?ll sleep/i,
        /Wo (du|Sie) schlaf(en|st)/i,
        /Schlafmöglichkeiten/i,
      ]);
      if (sleepSection) result.fields.sleepingArrangementRaw = sleepSection;

      result.ok = Object.keys(result.fields).length > 1; // mehr als nur "title"
      result.note = result.ok
        ? "Automatisch per Headless-Browser von der öffentlichen Airbnb-Seite gelesen — bitte jeden Wert prüfen. Die zimmerweise Fotorundgang-Zuordnung ist weiterhin nicht öffentlich sichtbar."
        : "Auf der öffentlichen Airbnb-Seite konnten keine der bekannten Felder gefunden werden (Seitenstruktur evtl. geändert). Bitte manuell erfassen.";
    });
  } catch (err) {
    result.note = `Automatischer Airbnb-Import fehlgeschlagen (${err.message}).`;
  }
  return result;
}

async function scrapeBooking(url) {
  const result = { ok: false, note: "", fields: {} };
  try {
    await withBrowser(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      try {
        const cookieBtn = page.getByRole("button", { name: /accept|akzeptieren|zustimmen/i }).first();
        if (await cookieBtn.isVisible({ timeout: 3000 })) await cookieBtn.click({ timeout: 3000 });
      } catch (_) {}

      try {
        await page.waitForFunction(
          () => /guests?|gäste|bedroom|schlafzimmer|max\.? (?:occupancy|belegung)/i.test(document.body.innerText),
          { timeout: 15000 }
        );
      } catch (_) {}

      const title = await page.title();
      const bodyText = await getBodyText(page);

      if (detectBotBlock(bodyText) || detectBotBlock(title)) {
        result.note =
          "Bot-Schutz/Verifizierung von Booking.com erkannt — automatischer Abruf abgebrochen (wird nicht umgangen). Bitte manuell im Editor prüfen.";
        return;
      }

      result.fields.title = title.replace(/\s*[-·|].*booking\.com.*$/i, "").trim();

      const guests = numberNear(bodyText, [/(?:max\.?\s*)?(\d+)\s*(?:guests?|Gäste|persons?|Personen)/i]);
      const bedrooms = numberNear(bodyText, [/(\d+)\s*(?:bedrooms?|Schlafzimmer)\b/i]);
      const beds = numberNear(bodyText, [/(\d+)\s*(?:beds?|Betten)\b/i]);
      const bathrooms = numberNear(bodyText, [/(\d+(?:[.,]\d)?)\s*(?:bathrooms?|Bad(?:ezimmer)?)\b/i]);

      if (guests !== null) result.fields.guests = Math.round(guests);
      if (bedrooms !== null) result.fields.bedrooms = Math.round(bedrooms);
      if (beds !== null) result.fields.beds = Math.round(beds);
      if (bathrooms !== null) result.fields.bathrooms = bathrooms;

      const roomSection = extractSection(bodyText, [
        /Choose your room/i,
        /Zimmer wählen/i,
        /Room types?/i,
      ]);
      if (roomSection) result.fields.sleepingArrangementRaw = roomSection;

      result.ok = Object.keys(result.fields).length > 1;
      result.note = result.ok
        ? "Automatisch per Headless-Browser von der öffentlichen Booking.com-Seite gelesen — bitte jeden Wert prüfen."
        : "Auf der öffentlichen Booking.com-Seite konnten keine der bekannten Felder gefunden werden (Seitenstruktur evtl. geändert). Bitte manuell erfassen.";
    });
  } catch (err) {
    result.note = `Automatischer Booking.com-Import fehlgeschlagen (${err.message}).`;
  }
  return result;
}

async function fetchLiveOtaData(platform, url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, note: "Kein gültiger Link angegeben – Import übersprungen.", fields: {} };
  }
  if (platform === "airbnb") return scrapeAirbnb(url);
  if (platform === "booking") return scrapeBooking(url);
  return { ok: false, note: "Unbekannte Plattform.", fields: {} };
}

module.exports = { fetchLiveOtaData };
