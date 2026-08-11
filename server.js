const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const archiver = require("archiver");

const db = require("./db");
const { computeFindings } = require("./lib/checks");
const { applyBrowserImport, parseSleepingArrangementsRooms } = require("./lib/browserImport");
const { mergeTextFields, parseTextFields, fieldValue, fieldMaxLength } = require("./lib/textFields");
const { parseAmenities, parseCatalog, mergeAmenityCatalog, possibleAdditions } = require("./lib/amenities");
const { extractAirbnbListingId } = require("./lib/airbnbUrl");
const { rewriteText } = require("./lib/aiRewrite");
const { describeImage } = require("./lib/aiVision");
const mdv = require("./lib/mdv");
const elev8 = require("./lib/elev8");

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

// ---------- helpers ----------

function countUsers() {
  return db.prepare("SELECT COUNT(*) c FROM users").get().c;
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function loadCurrentUser(req, res, next) {
  if (req.session && req.session.userId) {
    const u = getUserById(req.session.userId);
    if (u) {
      req.currentUser = u;
      res.locals.user = u;
      return next();
    }
  }
  res.locals.user = null;
  next();
}
app.use(loadCurrentUser);

function requireSetupOrAuth(req, res, next) {
  const n = countUsers();
  if (n === 0 && req.path !== "/setup") return res.redirect("/setup");
  if (n > 0 && req.path === "/setup") return res.redirect("/login");
  next();
}
app.use(requireSetupOrAuth);

function requireAuth(req, res, next) {
  if (!req.currentUser) return res.redirect("/login");
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.currentUser || !roles.includes(req.currentUser.role)) {
      return res.status(403).send("Keine Berechtigung für diese Aktion.");
    }
    next();
  };
}

function devLoginEnabled() {
  // Standardmässig AN (Wunsch: sofortiger Zugriff ohne Passwort, auch produktiv).
  // Zum Deaktivieren in Railway die Variable DEV_LOGIN_ENABLED auf "false" setzen
  // (kein Redeploy nötig).
  return process.env.DEV_LOGIN_ENABLED !== "false";
}

function genPassword() {
  return crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

function withUserNames(proposals) {
  return proposals.map((p) => {
    const pb = getUserById(p.proposed_by);
    const rb = p.reviewed_by ? getUserById(p.reviewed_by) : null;
    return {
      ...p,
      proposed_by_name: pb ? pb.name : "?",
      reviewed_by_name: rb ? rb.name : null,
    };
  });
}

// ---------- setup / auth ----------

app.get("/setup", (req, res) => {
  if (countUsers() > 0) return res.redirect("/login");
  res.render("setup", { error: null, defaultEmail: "reto.wyss@elev8-suite.com" });
});

app.post("/setup", (req, res) => {
  if (countUsers() > 0) return res.redirect("/login");
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.render("setup", {
      error: "Bitte Name, E-Mail und ein Passwort mit mind. 8 Zeichen angeben.",
      defaultEmail: email || "",
    });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(name, email.toLowerCase().trim(), hash);
  req.session.userId = info.lastInsertRowid;
  res.redirect("/");
});

app.get("/login", (req, res) => {
  if (req.currentUser) return res.redirect("/");
  const devUsers = devLoginEnabled()
    ? db.prepare("SELECT id, name, email, role FROM users ORDER BY created_at").all()
    : [];
  res.render("login", { error: null, devLoginEnabled: devLoginEnabled(), devUsers });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || "", u.password_hash)) {
    return res.render("login", {
      error: "E-Mail oder Passwort ist falsch.",
      devLoginEnabled: devLoginEnabled(),
      devUsers: devLoginEnabled()
        ? db.prepare("SELECT id, name, email, role FROM users ORDER BY created_at").all()
        : [],
    });
  }
  req.session.userId = u.id;
  res.redirect("/");
});

// ---------- Dev-Login (ohne Passwort) ----------
// ACHTUNG: Auf Wunsch aktiv erlaubt, auch auf der produktiven App. Jede Person,
// die die URL kennt, kann sich damit ohne Passwort als beliebiger bestehender
// Benutzer anmelden. Deaktivierbar über die Umgebungsvariable
// DEV_LOGIN_ENABLED=false (siehe README).
app.post("/dev-login/:id", (req, res) => {
  if (!devLoginEnabled()) {
    return res.status(403).send("Dev-Login ist deaktiviert.");
  }
  const u = getUserById(req.params.id);
  if (!u) return res.status(404).send("Benutzer nicht gefunden.");
  req.session.userId = u.id;
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------- Browser-Extension (Info + Download) ----------
// Zip wird bei jedem Aufruf frisch aus browser-extension/ im Repo gepackt
// (kein separater Build-Schritt, kein "Zip vergessen zu aktualisieren" mehr
// möglich) — Version/Autor/Changelog kommen direkt aus manifest.json bzw.
// CHANGELOG.md, damit diese Seite nie vom tatsächlichen Code abweicht.
const EXTENSION_DIR = path.join(__dirname, "browser-extension");

function getExtensionManifest() {
  return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
}

app.get("/extension", requireAuth, (req, res) => {
  const manifest = getExtensionManifest();
  let changelog = "";
  try {
    changelog = fs.readFileSync(path.join(EXTENSION_DIR, "CHANGELOG.md"), "utf8");
  } catch (e) {
    changelog = "(kein CHANGELOG.md gefunden)";
  }
  res.render("extension", { version: manifest.version, changelog });
});

app.get("/extension/download", requireAuth, (req, res) => {
  const manifest = getExtensionManifest();
  res.attachment(`ota-qa-tool-browser-extension-v${manifest.version}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    // Header evtl. schon gesendet (Streaming) - dann nur noch Verbindung beenden.
    if (!res.headersSent) res.status(500);
    res.end();
    console.error("Extension-Zip-Fehler:", err);
  });
  archive.pipe(res);
  archive.directory(EXTENSION_DIR, false);
  archive.finalize();
});

// ---------- dashboard ----------

app.get("/", requireAuth, (req, res) => {
  const listingsRaw = db.prepare("SELECT * FROM listings ORDER BY created_at DESC").all();
  const listings = listingsRaw.map((l) => {
    const channels = db.prepare("SELECT * FROM channels WHERE listing_id = ?").all(l.id);
    let totalFindings = 0;
    let openProposals = 0;
    channels.forEach((ch) => {
      const rooms = db.prepare("SELECT * FROM rooms WHERE channel_id = ?").all(ch.id);
      totalFindings += computeFindings(ch, rooms).length;
      openProposals += db
        .prepare("SELECT COUNT(*) c FROM proposals WHERE channel_id = ? AND status = 'offen'")
        .get(ch.id).c;
    });
    return { ...l, channels, totalFindings, openProposals };
  });
  res.render("dashboard", { listings, msg: req.query.msg || null });
});

app.post("/listings", requireAuth, (req, res) => {
  const { name, note } = req.body;
  if (!name) return res.redirect("/");
  const info = db
    .prepare("INSERT INTO listings (name, note, created_by) VALUES (?, ?, ?)")
    .run(name, note || null, req.currentUser.id);
  res.redirect("/listings/" + info.lastInsertRowid);
});

// ---------- MyDataValue-Import ----------
// Holt alle Airbnb-Listings UND Booking.com-Objekte aus MyDataValue
// (server-seitig, eigene API-Zugangsdaten — siehe lib/mdv.js) und legt sie im
// QA-Tool an, statt sie manuell eintippen zu müssen. Abgleich läuft über
// channels.external_id (= MyDataValue/Airbnb listing_id bzw. Booking
// property_id): existiert schon ein Kanal mit dieser ID, wird nur die
// Roh-JSON (mdv_data) aktualisiert, statt ein Duplikat anzulegen — betrifft
// z. B. bereits manuell angelegte Test-Inserate, sobald deren ID mit einem
// MyDataValue-Eintrag übereinstimmt.
// otaChannelMap: Ergebnis von elev8.buildOtaChannelMap() — bildet
// "<platform>:<externalId>" auf eine gemeinsame Elev8-Listing-ID ab, sofern
// Elev8 dieses Objekt kennt. Damit landen Airbnb- und Booking.com-Kanal
// desselben physischen Objekts im selben QA-Tool-Inserat, statt je ein
// eigenes Inserat zu bekommen. Ist keine Zuordnung möglich (Map leer oder
// kein Treffer), verhält sich das exakt wie vorher: ein neues Inserat pro
// Kanal.
function upsertMdvChannel({ platform, externalId, displayName, rawItem, createdBy, otaChannelMap }) {
  const existing = db.prepare("SELECT id FROM channels WHERE platform = ? AND external_id = ?").get(platform, externalId);
  if (existing) {
    db.prepare("UPDATE channels SET mdv_data = ?, mdv_synced_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(rawItem),
      existing.id
    );
    return "updated";
  }

  const elev8ListingId = otaChannelMap ? otaChannelMap.get(`${platform}:${externalId}`) : null;
  let listingId = null;
  let outcome = "created";

  if (elev8ListingId) {
    const existingListing = db
      .prepare("SELECT id FROM listings WHERE elev8_listing_id = ?")
      .get(String(elev8ListingId));
    if (existingListing) {
      listingId = existingListing.id;
      outcome = "merged";
    }
  }

  if (!listingId) {
    const listingInfo = db
      .prepare("INSERT INTO listings (name, note, created_by, elev8_listing_id) VALUES (?, ?, ?, ?)")
      .run(displayName, "Automatisch aus MyDataValue importiert.", createdBy, elev8ListingId ? String(elev8ListingId) : null);
    listingId = listingInfo.lastInsertRowid;
  }

  db.prepare(
    "INSERT INTO channels (listing_id, platform, external_id, mdv_data, mdv_synced_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(listingId, platform, externalId, JSON.stringify(rawItem));
  return outcome;
}

app.post("/mdv/import", requireRole("admin"), async (req, res) => {
  try {
    const [airbnbListings, bookingProperties] = await Promise.all([
      mdv.listAllAirbnbListings(),
      mdv.listAllBookingProperties(),
    ]);

    // Elev8-Zusammenführung ist ein Best-Effort-Zusatz: schlägt sie fehl
    // (Token abgelaufen, API nicht erreichbar, ...), läuft der Import trotzdem
    // durch — dann eben ohne Zusammenführung (ein Inserat pro Plattform, wie
    // vor dieser Änderung), und die Person wird darüber informiert.
    let otaChannelMap = new Map();
    let elev8Warning = null;
    try {
      const elev8Listings = await elev8.fetchAllElev8Listings();
      if (elev8Listings) otaChannelMap = elev8.buildOtaChannelMap(elev8Listings);
      else elev8Warning = "Kein ELEV8_API_TOKEN konfiguriert — Import lief ohne Airbnb+Booking-Zusammenführung.";
    } catch (err) {
      elev8Warning =
        "Elev8-Zusammenführung fehlgeschlagen (" +
        ((err && err.message) || String(err)) +
        ") — Import lief ohne Zusammenführung, Airbnb und Booking.com können hier als getrennte Inserate erscheinen.";
    }

    let created = 0;
    let updated = 0;
    let merged = 0;
    for (const item of airbnbListings) {
      const outcome = upsertMdvChannel({
        platform: "airbnb",
        externalId: String(item.listing_id),
        displayName: item.nickname || item.listing_title || `Airbnb ${item.listing_id}`,
        rawItem: item,
        createdBy: req.currentUser.id,
        otaChannelMap,
      });
      if (outcome === "created") created++;
      else if (outcome === "merged") merged++;
      else updated++;
    }
    for (const item of bookingProperties) {
      const outcome = upsertMdvChannel({
        platform: "booking",
        externalId: String(item.property_id),
        displayName: item.name || `Booking.com ${item.property_id}`,
        rawItem: item,
        createdBy: req.currentUser.id,
        otaChannelMap,
      });
      if (outcome === "created") created++;
      else if (outcome === "merged") merged++;
      else updated++;
    }
    const summary =
      `MyDataValue-Import abgeschlossen: ${created} neue Inserate angelegt, ${merged} Kanäle zu einem ` +
      `bestehenden (Elev8-verknüpften) Inserat zusammengeführt, ${updated} bestehende Kanäle aktualisiert ` +
      `(von ${airbnbListings.length} Airbnb-Listings + ${bookingProperties.length} Booking.com-Objekten in MyDataValue).`;
    res.redirect("/?msg=" + encodeURIComponent(summary + (elev8Warning ? " Hinweis: " + elev8Warning : "")));
  } catch (err) {
    res.redirect(
      "/?msg=" + encodeURIComponent("Fehler beim MyDataValue-Import: " + ((err && err.message) || String(err)))
    );
  }
});

// ---------- MyDataValue-Übersicht + Recalculate-Jobs ----------
// Laut MyDataValue-Support (Martin Dawson) ist "recalculate-jobs" der
// wichtigste Endpunkt: er berechnet den Promotion-Stack für die gewählten
// Airbnb-Listings/Booking-Objekte neu (dieselbe Engine wie der nächtliche
// Auto-Refresh) und pusht das Ergebnis sofort live. Diese Seite listet alle
// per MyDataValue-Import verknüpften Kanäle zum Auswählen und zeigt die
// zuletzt gestarteten Jobs.
app.get("/mdv", requireRole("admin"), async (req, res) => {
  const linkedChannels = db
    .prepare(
      `SELECT c.id, c.platform, c.external_id, c.mdv_synced_at, l.name AS listing_name
       FROM channels c JOIN listings l ON l.id = c.listing_id
       WHERE c.external_id IS NOT NULL AND c.external_id != ''
       ORDER BY c.platform, l.name`
    )
    .all();
  let recentJobs = [];
  let jobsError = null;
  try {
    const page = await mdv.listRecalculateJobs({ limit: 10 });
    recentJobs = page.results || [];
  } catch (err) {
    jobsError = (err && err.message) || String(err);
  }
  res.render("mdv", { linkedChannels, recentJobs, jobsError, msg: req.query.msg || null });
});

app.post("/mdv/recalculate-jobs", requireRole("admin"), async (req, res) => {
  const ids = Array.isArray(req.body.channel_ids) ? req.body.channel_ids : req.body.channel_ids ? [req.body.channel_ids] : [];
  if (!ids.length) {
    return res.redirect("/mdv?msg=" + encodeURIComponent("Bitte mindestens ein Inserat auswählen."));
  }
  const rows = db
    .prepare(`SELECT id, platform, external_id FROM channels WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids);
  const listingIds = rows.filter((r) => r.platform === "airbnb").map((r) => r.external_id);
  const propertyIds = rows
    .filter((r) => r.platform === "booking")
    .map((r) => Number(r.external_id))
    .filter((n) => Number.isFinite(n));
  const submittedJobs = [];
  const errors = [];
  try {
    if (listingIds.length) {
      const job = await mdv.submitRecalculateJob({ channel: "airbnb", listingIds, skipUnavailable: true });
      submittedJobs.push(job);
    }
  } catch (err) {
    errors.push("Airbnb: " + ((err && err.message) || String(err)));
  }
  try {
    if (propertyIds.length) {
      const job = await mdv.submitRecalculateJob({ channel: "booking", propertyIds, skipUnavailable: true });
      submittedJobs.push(job);
    }
  } catch (err) {
    errors.push("Booking.com: " + ((err && err.message) || String(err)));
  }
  const parts = [];
  if (submittedJobs.length) {
    parts.push(
      `${submittedJobs.length} Recalculate-Job(s) gestartet: ${submittedJobs.map((j) => j.id).join(", ")}.`
    );
  }
  if (errors.length) parts.push("Fehler: " + errors.join(" / "));
  res.redirect("/mdv?msg=" + encodeURIComponent(parts.join(" ") || "Nichts zu tun."));
});

app.get("/mdv/recalculate-jobs/:jobId", requireRole("admin"), async (req, res) => {
  try {
    const job = await mdv.getRecalculateJob(req.params.jobId);
    res.render("mdv-job", { job, jobType: "Recalculate-Job", error: null });
  } catch (err) {
    res.render("mdv-job", { job: null, jobType: "Recalculate-Job", error: (err && err.message) || String(err) });
  }
});

// ---------- MyDataValue: "Mit MyDataValue verbinden" (OAuth 2.1 + PKCE) ----------
// Der Refresh-Token kann von MyDataValue-Seite jederzeit ungültig werden
// (z. B. bei Reaktivierung, Passwortwechsel oder einfach durch Ablauf).
// Statt dass ein Admin dann händisch einen Token per curl/Postman besorgen
// muss, meldet er sich hier einmal live mit seinem eigenen MyDataValue-Konto
// an; das Tool fängt den Autorisierungs-Code über die Redirect-URL ab und
// tauscht ihn serverseitig gegen einen neuen Refresh-Token, den es dann
// speichert. Der Assistent/Server sieht dabei nie das MyDataValue-Passwort.
const MDV_REDIRECT_URI = "https://web-production-362e.up.railway.app/mdv/oauth/callback";

app.get("/mdv/oauth/start", requireRole("admin"), (req, res) => {
  try {
    const { verifier, challenge } = mdv.generatePkcePair();
    const state = crypto.randomBytes(16).toString("hex");
    req.session.mdvOauthVerifier = verifier;
    req.session.mdvOauthState = state;
    const url = mdv.buildAuthorizeUrl({
      redirectUri: MDV_REDIRECT_URI,
      state,
      codeChallenge: challenge,
    });
    res.redirect(url);
  } catch (err) {
    res.redirect("/mdv?msg=" + encodeURIComponent("Verbindung zu MyDataValue konnte nicht gestartet werden: " + ((err && err.message) || String(err))));
  }
});

app.get("/mdv/oauth/callback", requireRole("admin"), async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const expectedState = req.session.mdvOauthState;
  const verifier = req.session.mdvOauthVerifier;
  delete req.session.mdvOauthState;
  delete req.session.mdvOauthVerifier;

  if (error) {
    return res.redirect(
      "/mdv?msg=" + encodeURIComponent(`MyDataValue-Autorisierung abgelehnt/fehlgeschlagen: ${error_description || error}`)
    );
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return res.redirect("/mdv?msg=" + encodeURIComponent("MyDataValue-Autorisierung fehlgeschlagen: ungültiger oder abgelaufener state-Wert. Bitte erneut versuchen."));
  }
  if (!verifier) {
    return res.redirect("/mdv?msg=" + encodeURIComponent("MyDataValue-Autorisierung fehlgeschlagen: PKCE-Verifier fehlt (Sitzung abgelaufen?). Bitte erneut versuchen."));
  }
  try {
    await mdv.exchangeAuthorizationCode({ code, redirectUri: MDV_REDIRECT_URI, codeVerifier: verifier });
    res.redirect("/mdv?msg=" + encodeURIComponent("Erfolgreich mit MyDataValue verbunden. Neuer Refresh-Token wurde gespeichert."));
  } catch (err) {
    res.redirect("/mdv?msg=" + encodeURIComponent("MyDataValue-Tokentausch fehlgeschlagen: " + ((err && err.message) || String(err))));
  }
});

// Hinweis: Die frueheren temporaeren Elev8-Suite-API-Probe-Routen
// (/admin/elev8-listings-dump, /admin/elev8-listing-detail/:id) wurden
// entfernt, nachdem ihr Zweck (ID-Normalisierung, Amenities-Check) erledigt
// war — insbesondere die Detail-Route gab ungefiltert auch sensible Felder
// (WLAN-Passwort, Zugangscodes, Stripe-/Seamlock-IDs) zurueck, was bei
// aktiviertem Dev-Login (Standard) ein unnoetiges Risiko war. Falls die
// Elev8-API spaeter wieder gebraucht wird (z. B. Basis-URL
// https://api.elev8-suite.com/api/v1, Bearer-Token in ELEV8_API_TOKEN),
// siehe Git-Historie fuer die frühere Implementierung.

// Die temporaere Probe-Route /admin/elev8-probe-ota-channels wurde entfernt,
// nachdem ihr Zweck erledigt war: sie diente nur dazu, die exakte Feldform
// von ota_channels herauszufinden (siehe lib/elev8.js für das Ergebnis:
// [{ ota_listing_id, channel_name: "AIRBNB"|"BOOKING_COM" }]).

// ---------- listing detail ----------

app.get("/listings/:id", requireAuth, (req, res) => {
  const listing = db.prepare("SELECT * FROM listings WHERE id = ?").get(req.params.id);
  if (!listing) return res.status(404).send("Inserat nicht gefunden.");
  let channelsRaw = db.prepare("SELECT * FROM channels WHERE listing_id = ? ORDER BY created_at").all(listing.id);
  // Nachträgliches Befüllen der Airbnb-Listing-ID bei Kanälen, die schon vor
  // dieser Automatik angelegt wurden und noch einen Link, aber keine ID haben.
  channelsRaw = channelsRaw.map((ch) => {
    if (ch.platform === "airbnb" && ch.url && !ch.external_id) {
      const derived = extractAirbnbListingId(ch.url);
      if (derived) {
        db.prepare("UPDATE channels SET external_id = ? WHERE id = ?").run(derived, ch.id);
        return { ...ch, external_id: derived };
      }
    }
    return ch;
  });
  const amenityCatalogRow = db.prepare("SELECT value FROM settings WHERE key = 'airbnb_amenity_catalog'").get();
  const amenityCatalog = parseCatalog(amenityCatalogRow && amenityCatalogRow.value);
  const channels = channelsRaw.map((ch) => {
    const rooms = db.prepare("SELECT * FROM rooms WHERE channel_id = ? ORDER BY sort_order, id").all(ch.id);
    const findings = computeFindings(ch, rooms);
    const proposals = withUserNames(
      db.prepare("SELECT * FROM proposals WHERE channel_id = ? ORDER BY created_at DESC").all(ch.id)
    );
    // Auf {value, maxLength} normalisieren, damit die View nicht zwischen
    // altem (reiner String) und neuem Speicherformat unterscheiden muss.
    const rawTextFieldsByPath = parseTextFields(ch.text_fields);
    const textFieldsByPath = {};
    Object.keys(rawTextFieldsByPath).forEach((p) => {
      const norm = {};
      Object.keys(rawTextFieldsByPath[p]).forEach((fid) => {
        const entry = rawTextFieldsByPath[p][fid];
        norm[fid] = { value: fieldValue(entry) || "", maxLength: fieldMaxLength(entry) };
      });
      textFieldsByPath[p] = norm;
    });
    const proposedTargets = new Set(
      proposals.filter((p) => p.target_field_id).map((p) => p.target_path + "::" + p.target_field_id)
    );
    // Ausstattung (nur Airbnb): aktuell gesetzte Merkmale + was laut dem über
    // alle gescannten Airbnb-Kanäle gewachsenen Katalog zusätzlich möglich
    // wäre (siehe lib/amenities.js und der amenity-catalog-Endpunkt).
    const amenities = ch.platform === "airbnb" ? parseAmenities(ch.amenities) : [];
    const possibleAmenities = ch.platform === "airbnb" ? possibleAdditions(amenityCatalog, amenities) : [];
    return { ...ch, rooms, findings, proposals, textFieldsByPath, proposedTargets, amenities, possibleAmenities };
  });
  const role = req.currentUser.role;
  res.render("listing", {
    listing,
    channels,
    canPropose: role === "admin" || role === "bearbeiter",
    canReview: role === "admin" || role === "pruefer",
    msg: req.query.msg || null,
  });
});

app.post("/listings/:id/delete", requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM listings WHERE id = ?").run(req.params.id);
  res.redirect("/");
});

// ---------- Alle Inserate löschen (Danger Zone) ----------
// Für einen kompletten Neustart nach einem MyDataValue-Re-Import (z. B. nach
// Einführung der Airbnb+Booking-Zusammenführung oben): löscht ALLE Inserate
// inkl. aller Kanäle/Zimmer/Vorschläge (cascadiert über die FKs in db.js).
// Zeigt vorher eine Übersicht inkl. manuell angelegter/kuratierter Inserate
// (mit echten Vorschlägen), damit klar ist, was mitgelöscht wird, und
// verlangt zusätzlich zum Login-als-Admin einen exakt eingetippten
// Bestätigungstext (Schutz gegen Klick aus Versehen).
const DELETE_ALL_CONFIRM_TEXT = "ALLE LÖSCHEN";

app.get("/admin/listings/delete-all", requireRole("admin"), (req, res) => {
  const listings = db.prepare("SELECT * FROM listings ORDER BY created_at DESC").all();
  const summary = listings.map((l) => {
    const channelCount = db.prepare("SELECT COUNT(*) c FROM channels WHERE listing_id = ?").get(l.id).c;
    const proposalCount = db
      .prepare(
        "SELECT COUNT(*) c FROM proposals WHERE channel_id IN (SELECT id FROM channels WHERE listing_id = ?)"
      )
      .get(l.id).c;
    const findingProposalCount = db
      .prepare(
        "SELECT COUNT(*) c FROM proposals WHERE status IN ('freigegeben','umgesetzt') AND channel_id IN (SELECT id FROM channels WHERE listing_id = ?)"
      )
      .get(l.id).c;
    return { ...l, channelCount, proposalCount, findingProposalCount };
  });
  const totals = {
    listings: listings.length,
    channels: db.prepare("SELECT COUNT(*) c FROM channels").get().c,
    proposals: db.prepare("SELECT COUNT(*) c FROM proposals").get().c,
    manuallyCurated: summary.filter((l) => l.note !== "Automatisch aus MyDataValue importiert.").length,
  };
  res.render("admin-delete-all", {
    summary,
    totals,
    confirmText: DELETE_ALL_CONFIRM_TEXT,
    msg: req.query.msg || null,
  });
});

app.post("/admin/listings/delete-all", requireRole("admin"), (req, res) => {
  if ((req.body.confirm_text || "").trim() !== DELETE_ALL_CONFIRM_TEXT) {
    return res.redirect(
      "/admin/listings/delete-all?msg=" +
        encodeURIComponent(`Abgebrochen: Bestätigungstext stimmte nicht exakt mit "${DELETE_ALL_CONFIRM_TEXT}" überein.`)
    );
  }
  const info = db.prepare("DELETE FROM listings").run();
  res.redirect(
    "/?msg=" +
      encodeURIComponent(`${info.changes} Inserat(e) inkl. aller Kanäle, Zimmer und Vorschläge gelöscht.`)
  );
});

app.post("/listings/:id/channels", requireAuth, (req, res) => {
  const { platform, url } = req.body;
  // Airbnb-Listing-ID (für die Browser-Extension) direkt aus dem Link
  // übernehmen, statt sie ein zweites Mal manuell abtippen zu lassen — bei
  // den meisten Airbnb-Inseraten ist es dieselbe Zahl wie in der
  // Host-Editor-URL. Bleibt trotzdem editierbar (siehe lib/airbnbUrl.js).
  const externalId = platform === "airbnb" ? extractAirbnbListingId(url) : null;
  db.prepare("INSERT INTO channels (listing_id, platform, url, external_id) VALUES (?, ?, ?, ?)").run(
    req.params.id,
    platform,
    url || null,
    externalId
  );
  res.redirect("/listings/" + req.params.id);
});

function getListingIdForChannel(channelId) {
  const ch = db.prepare("SELECT listing_id FROM channels WHERE id = ?").get(channelId);
  return ch ? ch.listing_id : null;
}

app.post("/channels/:id/delete", requireAuth, (req, res) => {
  const listingId = getListingIdForChannel(req.params.id);
  db.prepare("DELETE FROM channels WHERE id = ?").run(req.params.id);
  res.redirect("/listings/" + listingId);
});

app.post("/channels/:id/summary", requireAuth, (req, res) => {
  const { declared_bedrooms, declared_beds, declared_bathrooms, declared_guests } = req.body;
  db.prepare(
    "UPDATE channels SET declared_bedrooms=?, declared_beds=?, declared_bathrooms=?, declared_guests=? WHERE id=?"
  ).run(
    Number(declared_bedrooms) || 0,
    Number(declared_beds) || 0,
    Number(declared_bathrooms) || 0,
    Number(declared_guests) || 0,
    req.params.id
  );
  res.redirect("/listings/" + getListingIdForChannel(req.params.id));
});

app.post("/channels/:id/external-id", requireAuth, (req, res) => {
  const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
  if (!ch) return res.status(404).send("Kanal nicht gefunden.");
  db.prepare("UPDATE channels SET external_id = ? WHERE id = ?").run(
    (req.body.external_id || "").trim() || null,
    ch.id
  );
  res.redirect("/listings/" + ch.listing_id);
});

// ---------- Browser-Extension-Import (echter, eingeloggter Host-Browser) ----------
// Die QA-Tool-Chrome-Extension läuft in der eigenen, bereits eingeloggten
// Airbnb-Session der Person (siehe README) und sendet die im Host-Editor
// sichtbaren Felder hierher. Authentifizierung erfolgt NICHT über die normale
// Session/Cookies (die Extension läuft auf airbnb.com, nicht auf dieser App),
// sondern über einen gemeinsamen API-Key in der Umgebungsvariable
// EXTENSION_API_KEY. Ohne gesetzten Key ist dieser Endpunkt deaktiviert.
function requireExtensionApiKey(req, res, next) {
  const expected = process.env.EXTENSION_API_KEY;
  if (!expected) {
    return res.status(503).json({ ok: false, error: "Browser-Extension-Import ist nicht konfiguriert (EXTENSION_API_KEY fehlt)." });
  }
  const provided = req.get("X-API-Key") || "";
  if (provided !== expected) {
    return res.status(401).json({ ok: false, error: "Ungültiger oder fehlender API-Key." });
  }
  next();
}

app.get("/api/browser-import/ping", requireExtensionApiKey, (req, res) => {
  res.json({ ok: true, app: "ota-qa-tool" });
});

// Vom "Automatischer Scan"-Bereich der Extension (options.js) abgefragt:
// welche Kanäle eines Portals (aktuell nur "airbnb", da Booking.com sich
// nicht unbeaufsichtigt automatisieren lässt — Login-Sperre bei
// Skript-Navigation, siehe README) haben bereits eine externe ID (=
// Airbnb-Listing-ID) hinterlegt? Der Scan kann NUR bereits im QA-Tool
// angelegte Kanäle befüllen (siehe findChannelByExternalId unten, 404 ohne
// Treffer) — er legt bewusst keine neuen Kanäle/Inserate selbst an.
app.get("/api/browser-import/scan-targets", requireExtensionApiKey, (req, res) => {
  const platform = (req.query.platform || "airbnb").trim();
  const rows = db
    .prepare(
      `SELECT channels.id AS channel_id, channels.external_id AS external_id, channels.listing_id AS listing_id,
              listings.name AS listing_name
       FROM channels
       JOIN listings ON listings.id = channels.listing_id
       WHERE channels.platform = ? AND channels.external_id IS NOT NULL AND channels.external_id != ''
       ORDER BY listings.name`
    )
    .all(platform);
  res.json({ ok: true, items: rows });
});

function findChannelByExternalId(platform, external_id) {
  return db.prepare("SELECT * FROM channels WHERE platform = ? AND external_id = ?").get(platform, String(external_id));
}

// Von der Extension auf .../details/photo-tour/<room-id>/beds abgefragt:
// welche Zimmer/Betten-Werte stehen für diesen Kanal aktuell im QA-Tool
// ("rooms"-Tabelle) — das sind die Werte, die auf den Betten-Editor-Seiten
// vorausgewählt werden sollen (siehe content.js, "Freigegebene Werte hier
// einfüllen" auf Betten-Seiten). Anders als bei Text-Vorschlägen gibt es für
// diese Werte bewusst KEIN eigenes Vier-Augen-"proposals"-Freigabe-Objekt —
// die "rooms"-Tabelle selbst (von eingeloggten QA-Tool-Personen über
// /rooms/:id/update korrigiert, oder automatisch aus dem Scan befüllt) ist
// hier bereits die geprüfte Quelle.
app.get("/api/browser-import/room-targets", requireExtensionApiKey, (req, res) => {
  const { platform, external_id } = req.query;
  if (!platform || !external_id) {
    return res.status(400).json({ ok: false, error: "platform und external_id sind erforderlich." });
  }
  const ch = findChannelByExternalId(platform, external_id);
  if (!ch) {
    return res.status(404).json({ ok: false, error: "Kein passender Kanal gefunden." });
  }
  const rows = db
    .prepare("SELECT name, room_type, bed_count, declared_bed_type, sleep_capacity FROM rooms WHERE channel_id = ?")
    .all(ch.id);
  res.json({ ok: true, items: rows });
});

// Gleicht die von der Extension auf .../details/sleeping-arrangements
// gelesenen Räume (siehe lib/browserImport.js, parseSleepingArrangementsRooms)
// mit der "rooms"-Tabelle ab: bestehendes Zimmer (Zuordnung per Name, Gross-/
// Kleinschreibung egal) wird aktualisiert, neues Zimmer wird angelegt. So
// befüllt sich die Zimmer-Tabelle, gegen die computeFindings() rechnet, bei
// jedem automatischen Scan von selbst, statt von Hand nachgepflegt werden zu
// müssen — macht den Konsistenz-Check (Kopfzeile vs. Fotorundgang/Sleeping
// arrangements) erst tatsächlich nutzbar. photo_count/photo_bed_type eines
// bereits bestehenden Zimmers werden bewusst nicht angerührt (die kommen
// weiterhin aus der Fotorundgang-Erfassung bzw. manueller Foto-Prüfung).
function syncRoomsFromScan(channelId, parsedRooms) {
  if (!parsedRooms || !parsedRooms.length) return 0;
  const existing = db.prepare("SELECT * FROM rooms WHERE channel_id = ?").all(channelId);
  let count = 0;
  for (const r of parsedRooms) {
    const match = existing.find((e) => e.name && e.name.trim().toLowerCase() === r.name.trim().toLowerCase());
    if (match) {
      db.prepare(
        `UPDATE rooms SET room_type=?, bed_count=?, sleep_capacity=?, declared_bed_type=?, hat_schlafgelegenheit=?, in_schlafgelegenheiten=1 WHERE id=?`
      ).run(r.room_type, r.bed_count, r.sleep_capacity, r.declared_bed_type, r.hat_schlafgelegenheit, match.id);
    } else {
      db.prepare(
        `INSERT INTO rooms (channel_id, name, room_type, photo_count, hat_schlafgelegenheit, bed_count, sleep_capacity, declared_bed_type, photo_bed_type, in_schlafgelegenheiten)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, '', 1)`
      ).run(channelId, r.name, r.room_type, r.hat_schlafgelegenheit, r.bed_count, r.sleep_capacity, r.declared_bed_type);
    }
    count++;
  }
  return count;
}

app.post("/api/browser-import", requireExtensionApiKey, (req, res) => {
  const { platform, external_id, fields } = req.body || {};
  if (!platform || !external_id) {
    return res.status(400).json({ ok: false, error: "platform und external_id sind erforderlich." });
  }
  const ch = findChannelByExternalId(platform, external_id);
  if (!ch) {
    return res.status(404).json({
      ok: false,
      error: `Kein Kanal mit platform=${platform} und external_id=${external_id} gefunden. Bitte im QA-Tool beim passenden Kanal die externe ID hinterlegen.`,
    });
  }
  const result = applyBrowserImport(fields || {});
  const d = result.declared;

  // Generische Text-Erfassung ("alle Texte im Inserat"): jedes <textarea>/
  // <input> mit HTML-id, das die Extension auf der aktuellen Editor-Unterseite
  // gefunden hat (fields.page = URL-Pfad, fields.rawTextInputs = [{id, value}]).
  let textFieldsCount = 0;
  let newTextFieldsJson = ch.text_fields;
  if (fields && fields.page && Array.isArray(fields.rawTextInputs) && fields.rawTextInputs.length) {
    newTextFieldsJson = mergeTextFields(ch.text_fields, fields.page, fields.rawTextInputs);
    textFieldsCount = fields.rawTextInputs.length;
  }
  // Airbnb-"Amenities" (Ausstattung): fields.amenities = [{name, description}],
  // von der Extension auf .../details/amenities gelesen (siehe content.js).
  // Speichert die aktuelle Liste beim Kanal UND führt neu gesehene Namen in
  // den globalen, über alle Airbnb-Kanäle wachsenden Katalog zusammen (siehe
  // lib/amenities.js) — Grundlage für "was wäre zusätzlich möglich" im
  // QA-Tool sowie für den amenity-catalog-Endpunkt unten.
  let amenitiesCount = 0;
  let newAmenitiesJson = ch.amenities;
  if (fields && Array.isArray(fields.amenities) && fields.amenities.length) {
    newAmenitiesJson = JSON.stringify(fields.amenities);
    amenitiesCount = fields.amenities.length;
    const existingCatalogJson = db.prepare("SELECT value FROM settings WHERE key = 'airbnb_amenity_catalog'").get();
    const mergedCatalogJson = mergeAmenityCatalog(
      existingCatalogJson && existingCatalogJson.value,
      fields.amenities.map((a) => a && a.name).filter(Boolean)
    );
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('airbnb_amenity_catalog', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(mergedCatalogJson);
  }

  // Zimmer/Betten aus "Sleeping arrangements" (v1.7.0): fields.sleepingArrangementsRooms
  // = [{room, bedsText}], von der Extension auf .../details/sleeping-arrangements
  // gelesen (siehe content.js). Befüllt/aktualisiert die Zimmer-Tabelle direkt.
  let roomsCount = 0;
  if (fields && Array.isArray(fields.sleepingArrangementsRooms) && fields.sleepingArrangementsRooms.length) {
    roomsCount = syncRoomsFromScan(ch.id, parseSleepingArrangementsRooms(fields.sleepingArrangementsRooms));
  }

  const ok = result.ok || textFieldsCount > 0 || amenitiesCount > 0 || roomsCount > 0;

  db.prepare(
    `UPDATE channels SET
       declared_bedrooms = COALESCE(?, declared_bedrooms),
       declared_beds = COALESCE(?, declared_beds),
       declared_bathrooms = COALESCE(?, declared_bathrooms),
       declared_guests = COALESCE(?, declared_guests),
       live_sleeping_text = COALESCE(?, live_sleeping_text),
       live_source = CASE WHEN ? IS NOT NULL THEN 'extension' ELSE live_source END,
       text_fields = ?,
       amenities = ?,
       last_imported_at = datetime('now'),
       import_note = ?,
       last_extension_version = COALESCE(?, last_extension_version)
     WHERE id = ?`
  ).run(
    d.bedrooms,
    d.beds,
    d.bathrooms,
    d.guests,
    result.liveText,
    result.liveText,
    newTextFieldsJson,
    newAmenitiesJson,
    roomsCount > 0
      ? `${roomsCount} Zimmer aus "Sleeping arrangements" abgeglichen. ${result.note}`
      : amenitiesCount > 0
        ? `${amenitiesCount} Ausstattungsmerkmal(e) gelesen. ${result.note}`
        : textFieldsCount > 0
          ? `${textFieldsCount} Textfeld(er) von "${fields.page}" gelesen. ${result.note}`
          : result.note,
    req.body && req.body.extension_version ? String(req.body.extension_version) : null,
    ch.id
  );
  res.json({ ok, channel_id: ch.id, listing_id: ch.listing_id, note: result.note, textFieldsCount, amenitiesCount, roomsCount });
});

// Vom content.js abgefragt (vor dem Erfassen der Amenities-Seite) UND von der
// QA-Tool-Ansicht selbst genutzt: der über alle gescannten Airbnb-Kanäle
// gewachsene Katalog aller jemals gesehenen Ausstattungsnamen (siehe
// lib/amenities.js — Airbnb liefert nirgends eine vollständige Liste "aller
// möglichen" Merkmale, deshalb wächst dieser Katalog aus echten Scans).
app.get("/api/browser-import/amenity-catalog", requireExtensionApiKey, (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'airbnb_amenity_catalog'").get();
  res.json({ ok: true, items: parseCatalog(row && row.value) });
});

// Die Extension klickt auf der Fotorundgang-Seite eines Raums automatisch
// durch jedes Foto (liest dabei nur — es wird nirgends "Save" geklickt) und
// schickt für jedes Foto dessen Editor-Pfad (enthält die feste, eindeutige
// Foto-ID: .../photo-tour/<raum>/space-photo/<foto>) plus Bild-URL hierher.
// Für jedes Foto lässt Claude-Vision einen Alt-Text-Vorschlag erzeugen und
// legt ihn unter demselben {path, field_id:"alt-text-input"}-Schema ab wie
// die generische Texterfassung — dieselbe Anzeige/Vier-Augen-Freigabe/
// Rückschreib-Mechanik greift dadurch unverändert. Läuft sequenziell (nicht
// parallel), um die Claude-API nicht zu überlasten; pro Aufruf max. 40 Fotos.
app.post("/api/browser-import/photos", requireExtensionApiKey, async (req, res) => {
  const { platform, external_id, room_label, items } = req.body || {};
  if (!platform || !external_id) {
    return res.status(400).json({ ok: false, error: "platform und external_id sind erforderlich." });
  }
  const ch = findChannelByExternalId(platform, external_id);
  if (!ch) {
    return res.status(404).json({ ok: false, error: "Kein passender Kanal gefunden." });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: "Keine Fotos übergeben." });
  }
  const capped = items.slice(0, 40);
  const results = [];
  let textFieldsJson = ch.text_fields;
  for (const item of capped) {
    if (!item || !item.path || !item.imageUrl) {
      results.push({ path: item && item.path, ok: false, error: "Pfad oder Bild-URL fehlt." });
      continue;
    }
    const described = await describeImage({ imageUrl: item.imageUrl, roomName: room_label });
    if (described.ok) {
      textFieldsJson = mergeTextFields(textFieldsJson, item.path, [{ id: "alt-text-input", value: described.text }]);
    }
    results.push({ path: item.path, ok: described.ok, error: described.ok ? undefined : described.error });
  }
  const successCount = results.filter((r) => r.ok).length;
  db.prepare(
    `UPDATE channels SET text_fields = ?, last_imported_at = datetime('now'), import_note = ? WHERE id = ?`
  ).run(
    textFieldsJson,
    `${successCount}/${capped.length} Alt-Text-Vorschläge per Claude-Vision erstellt${room_label ? ` (Raum: ${room_label})` : ""}.`,
    ch.id
  );
  res.json({ ok: successCount > 0, channel_id: ch.id, listing_id: ch.listing_id, successCount, total: capped.length, results });
});

// ---------- Text-Vorschläge ("alle Texte im Inserat") ----------
// Jedes erfasste Textfeld (siehe oben) kann als Vier-Augen-Vorschlag
// eingereicht werden — genau wie die automatisch erkannten Befunde weiter
// unten, nur dass der Ausgangstext hier eine freie Umformulierung ist
// (von Hand oder mit KI-Unterstützung entworfen) statt eines Konsistenz-Fixes.
app.post("/channels/:id/propose-text", requireRole("admin", "bearbeiter"), (req, res) => {
  const { path: targetPath, field_id, proposed_text, label } = req.body;
  if (!targetPath || !field_id || !proposed_text) {
    return res.status(400).send("Pfad, Feld-ID und Text sind erforderlich.");
  }
  db.prepare(
    `INSERT INTO proposals (channel_id, finding_key, title, proposed_text, proposed_by, target_path, target_field_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.id,
    `text:${targetPath}::${field_id}`,
    label || `Text: ${field_id}`,
    proposed_text,
    req.currentUser.id,
    targetPath,
    field_id
  );
  res.redirect("/listings/" + getListingIdForChannel(req.params.id));
});

// KI-Umformulierung eines erfassten Textfelds. Nutzt den aktuellen Text plus
// Kontext (Eckdaten, andere bereits erfasste Texte desselben Kanals) — der
// eigentliche Prompt/die Persona kommt (bis auf Weiteres ein neutraler
// Standard-Prompt) aus lib/aiRewrite.js bzw. der Umgebungsvariable
// AI_REWRITE_SYSTEM_PROMPT. Liefert nur einen Vorschlag zurück, ändert nichts
// an der Datenbank oder an Airbnb — die Person prüft/bearbeitet den Vorschlag
// im Textfeld, bevor sie ihn zur Vier-Augen-Freigabe einreicht.
app.post("/channels/:id/ai-rewrite", requireRole("admin", "bearbeiter"), async (req, res) => {
  const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
  if (!ch) return res.status(404).json({ ok: false, error: "Kanal nicht gefunden." });
  const { path: targetPath, field_id } = req.body || {};
  if (!targetPath || !field_id) {
    return res.status(400).json({ ok: false, error: "Pfad und Feld-ID sind erforderlich." });
  }
  const allFields = parseTextFields(ch.text_fields);
  const fieldEntry = (allFields[targetPath] || {})[field_id];
  const currentText = fieldValue(fieldEntry);
  if (currentText === undefined) {
    return res.status(404).json({ ok: false, error: "Dieses Textfeld wurde nicht (mehr) erfasst." });
  }
  // Zeichenlimit (z. B. 50 bei Airbnb-Titeln) kommt aus dem nativen
  // maxlength-Attribut, das die Extension beim Erfassen mitgespeichert hat —
  // wird an die KI durchgereicht, damit der Vorschlag von vornherein passt
  // statt nachträglich in Airbnb selbst abgeschnitten zu werden.
  const maxLength = fieldMaxLength(fieldEntry);
  const otherFields = [];
  Object.keys(allFields).forEach((p) => {
    Object.keys(allFields[p]).forEach((fid) => {
      if (p === targetPath && fid === field_id) return;
      otherFields.push({ path: p, fieldId: fid, value: fieldValue(allFields[p][fid]) || "" });
    });
  });
  const result = await rewriteText({
    channel: ch,
    currentText,
    currentPath: targetPath,
    currentFieldId: field_id,
    otherFields: otherFields.slice(0, 6),
    maxLength,
  });
  res.json(result);
});

// Von der Extension abgefragt: welche freigegebenen Text-Vorschläge warten
// noch darauf, in Airbnb eingetragen zu werden? Optional nach aktuellem
// Editor-Pfad gefiltert, damit die Extension nur das einfüllt, was auf der
// gerade offenen Seite überhaupt existiert.
app.get("/api/browser-import/pending-writeback", requireExtensionApiKey, (req, res) => {
  const { platform, external_id, path: currentPath } = req.query;
  if (!platform || !external_id) {
    return res.status(400).json({ ok: false, error: "platform und external_id sind erforderlich." });
  }
  const ch = findChannelByExternalId(platform, external_id);
  if (!ch) {
    return res.status(404).json({ ok: false, error: "Kein passender Kanal gefunden." });
  }
  let rows = db
    .prepare(
      "SELECT id, target_path, target_field_id, proposed_text, title FROM proposals WHERE channel_id = ? AND status = 'freigegeben' AND target_field_id IS NOT NULL"
    )
    .all(ch.id);
  if (currentPath) rows = rows.filter((r) => r.target_path === currentPath);
  res.json({ ok: true, items: rows });
});

app.post("/channels/:id/rooms", requireAuth, (req, res) => {
  const b = req.body;
  db.prepare(
    `INSERT INTO rooms (channel_id, name, room_type, photo_count, hat_schlafgelegenheit, bed_count, sleep_capacity, declared_bed_type, photo_bed_type, in_schlafgelegenheiten)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(
    req.params.id,
    b.name,
    b.room_type,
    Number(b.photo_count) || 0,
    Number(b.bed_count) || 0,
    Number(b.sleep_capacity) || 0,
    b.declared_bed_type || "",
    b.photo_bed_type || "",
    b.in_schlafgelegenheiten ? 1 : 0
  );
  res.redirect("/listings/" + getListingIdForChannel(req.params.id));
});

app.post("/rooms/:id/update", requireAuth, (req, res) => {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).send("Zimmer nicht gefunden.");
  const b = req.body;
  db.prepare(
    `UPDATE rooms SET name=?, room_type=?, photo_count=?, bed_count=?, sleep_capacity=?, declared_bed_type=?, photo_bed_type=?, in_schlafgelegenheiten=? WHERE id=?`
  ).run(
    b.name,
    b.room_type,
    Number(b.photo_count) || 0,
    Number(b.bed_count) || 0,
    Number(b.sleep_capacity) || 0,
    b.declared_bed_type || "",
    b.photo_bed_type || "",
    b.in_schlafgelegenheiten ? 1 : 0,
    room.id
  );
  res.redirect("/listings/" + getListingIdForChannel(room.channel_id));
});

app.post("/rooms/:id/delete", requireAuth, (req, res) => {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).send("Zimmer nicht gefunden.");
  const listingId = getListingIdForChannel(room.channel_id);
  db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
  res.redirect("/listings/" + listingId);
});

// ---------- findings -> proposals (4-Augen) ----------

app.post("/channels/:id/propose", requireRole("admin", "bearbeiter"), (req, res) => {
  const { finding_key, title, proposed_text } = req.body;
  db.prepare(
    "INSERT INTO proposals (channel_id, finding_key, title, proposed_text, proposed_by) VALUES (?, ?, ?, ?, ?)"
  ).run(req.params.id, finding_key, title, proposed_text, req.currentUser.id);
  res.redirect("/listings/" + getListingIdForChannel(req.params.id));
});

function getProposal(id) {
  return db.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
}

app.post("/proposals/:id/approve", requireRole("admin", "pruefer"), (req, res) => {
  const p = getProposal(req.params.id);
  if (!p) return res.status(404).send("Vorschlag nicht gefunden.");
  if (p.proposed_by === req.currentUser.id) {
    return res.status(403).send("Du kannst deinen eigenen Vorschlag nicht freigeben (Vier-Augen-Prinzip).");
  }
  db.prepare(
    "UPDATE proposals SET status='freigegeben', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?"
  ).run(req.currentUser.id, p.id);
  res.redirect("/listings/" + getListingIdForChannel(p.channel_id));
});

app.post("/proposals/:id/reject", requireRole("admin", "pruefer"), (req, res) => {
  const p = getProposal(req.params.id);
  if (!p) return res.status(404).send("Vorschlag nicht gefunden.");
  if (p.proposed_by === req.currentUser.id) {
    return res.status(403).send("Du kannst deinen eigenen Vorschlag nicht selbst ablehnen/prüfen.");
  }
  db.prepare(
    "UPDATE proposals SET status='abgelehnt', reviewed_by=?, reviewed_at=datetime('now'), review_comment=? WHERE id=?"
  ).run(req.currentUser.id, req.body.review_comment || null, p.id);
  res.redirect("/listings/" + getListingIdForChannel(p.channel_id));
});

app.post("/proposals/:id/done", requireAuth, (req, res) => {
  const p = getProposal(req.params.id);
  if (!p) return res.status(404).send("Vorschlag nicht gefunden.");
  if (p.status !== "freigegeben") return res.status(400).send("Nur freigegebene Vorschläge können als umgesetzt markiert werden.");
  db.prepare("UPDATE proposals SET status='umgesetzt' WHERE id=?").run(p.id);
  res.redirect("/listings/" + getListingIdForChannel(p.channel_id));
});

// ---------- users (admin) ----------

app.get("/users", requireRole("admin"), (req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at").all();
  res.render("users", { users, msg: req.query.msg || null });
});

app.post("/users", requireRole("admin"), (req, res) => {
  const { name, email, role } = req.body;
  const tempPassword = genPassword();
  const hash = bcrypt.hashSync(tempPassword, 10);
  try {
    db.prepare(
      "INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)"
    ).run(name, email.toLowerCase().trim(), hash, role);
  } catch (e) {
    return res.redirect("/users?msg=" + encodeURIComponent("Fehler: E-Mail existiert bereits."));
  }
  res.redirect(
    "/users?msg=" +
      encodeURIComponent(`Benutzer ${name} angelegt. Temporäres Passwort (bitte sicher weiterleiten): ${tempPassword}`)
  );
});

app.post("/users/:id/role", requireRole("admin"), (req, res) => {
  db.prepare("UPDATE users SET role=? WHERE id=?").run(req.body.role, req.params.id);
  res.redirect("/users");
});

app.post("/users/:id/reset-password", requireRole("admin"), (req, res) => {
  const tempPassword = genPassword();
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?").run(hash, req.params.id);
  const u = getUserById(req.params.id);
  res.redirect(
    "/users?msg=" +
      encodeURIComponent(`Neues temporäres Passwort für ${u.name}: ${tempPassword}`)
  );
});

app.post("/users/:id/delete", requireRole("admin"), (req, res) => {
  if (Number(req.params.id) === req.currentUser.id) {
    return res.redirect("/users?msg=" + encodeURIComponent("Du kannst dich nicht selbst löschen."));
  }
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.redirect("/users");
});

// ---------- account ----------

app.get("/account", requireAuth, (req, res) => {
  res.render("account", { msg: req.query.msg || null, error: req.query.error || null });
});

app.post("/account/password", requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!bcrypt.compareSync(current_password || "", req.currentUser.password_hash)) {
    return res.redirect("/account?error=" + encodeURIComponent("Aktuelles Passwort ist falsch."));
  }
  if (!new_password || new_password.length < 8) {
    return res.redirect("/account?error=" + encodeURIComponent("Neues Passwort muss mind. 8 Zeichen haben."));
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?").run(hash, req.currentUser.id);
  res.redirect("/account?msg=" + encodeURIComponent("Passwort geändert."));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OTA QA-Tool läuft auf Port ${PORT}`);
});
