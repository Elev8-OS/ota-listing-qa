const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "app.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','bearbeiter','pruefer')),
  must_change_password INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('airbnb','booking')),
  url TEXT,
  declared_bedrooms INTEGER DEFAULT 0,
  declared_beds INTEGER DEFAULT 0,
  declared_bathrooms REAL DEFAULT 0,
  declared_guests INTEGER DEFAULT 0,
  last_imported_at TEXT,
  import_note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  room_type TEXT NOT NULL CHECK(room_type IN ('schlafzimmer','wohnzimmer','sonstiges')),
  photo_count INTEGER DEFAULT 0,
  hat_schlafgelegenheit INTEGER DEFAULT 1,
  bed_count INTEGER DEFAULT 1,
  sleep_capacity INTEGER DEFAULT 2,
  declared_bed_type TEXT DEFAULT '',
  photo_bed_type TEXT DEFAULT '',
  in_schlafgelegenheiten INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  title TEXT NOT NULL,
  proposed_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','freigegeben','abgelehnt','umgesetzt')),
  proposed_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  review_comment TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

-- Key/Value-Ablage fuer Dinge wie den rotierenden MyDataValue-Refresh-Token.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migration: neue Spalte für den roh ausgelesenen "Where you'll sleep" /
// "Room types" Textblock aus dem Live-Import (Playwright), zum Abgleich mit
// den manuell erfassten Zimmern. ALTER TABLE ADD COLUMN ist in SQLite nicht
// idempotent, daher try/catch für bereits existierende Installationen.
try {
  db.exec("ALTER TABLE channels ADD COLUMN live_sleeping_text TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Migration: MyDataValue-Anbindung. external_id = Airbnb listing_id bzw.
// Booking.com property_id in MyDataValue (nicht aus der huebschen URL ableitbar,
// muss manuell eingetragen werden). mdv_data = letzte Rohantwort als JSON,
// mdv_synced_at = Zeitpunkt der letzten Synchronisierung.
for (const stmt of [
  "ALTER TABLE channels ADD COLUMN external_id TEXT",
  "ALTER TABLE channels ADD COLUMN mdv_data TEXT",
  "ALTER TABLE channels ADD COLUMN mdv_synced_at TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// Migration: Browser-Extension-Import. live_source unterscheidet, woher
// live_sleeping_text zuletzt stammt ('scraper' = öffentlicher Playwright-Import,
// 'extension' = QA-Tool-Chrome-Extension aus dem eingeloggten Host-Editor).
// external_id (oben) wird hierfür wiederverwendet: bei Airbnb die Listing-ID
// aus der Editor-URL (.../hosting/listings/editor/<external_id>/...).
try {
  db.exec("ALTER TABLE channels ADD COLUMN live_source TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Migration: generische Text-Erfassung ("alle Texte im Inserat"). Die
// Extension liest auf jeder Airbnb-Editor-Unterseite (Title, Description +
// deren Unterpanels Listing description/Your property/Guest access/...) alle
// vorhandenen <textarea>/<input>-Felder mit ihrer HTML-id aus. text_fields
// speichert das als JSON: { "<Pfad, z.B. /details/description>": { "<id>": "<Wert>" } }.
// Darauf bauen die neuen Text-Vorschläge auf (siehe proposals.target_path/
// target_field_id) — Freigabe läuft über das bestehende Vier-Augen-Prinzip,
// der Rückschreib-Schritt in Airbnb passiert wieder über die Extension.
try {
  db.exec("ALTER TABLE channels ADD COLUMN text_fields TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}
for (const stmt of [
  "ALTER TABLE proposals ADD COLUMN target_path TEXT",
  "ALTER TABLE proposals ADD COLUMN target_field_id TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// Migration: Extension-Versionsstand pro Kanal speichern, mitgeschickt von
// background.js (chrome.runtime.getManifest().version). Zeigt im QA-Tool auf
// einen Blick, ob eine Person noch mit einer veralteten, lokal entpackten
// Extension arbeitet (chrome://extensions "Neu laden" aktualisiert nur den
// aktuellen Ordnerinhalt, das passiert leicht unbemerkt — live erlebt).
try {
  db.exec("ALTER TABLE channels ADD COLUMN last_extension_version TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Migration: Zusammenführung von Airbnb- und Booking.com-Kanälen desselben
// physischen Objekts zu einem einzigen Inserat beim MyDataValue-Import.
// elev8_listing_id = die Objekt-ID aus der Elev8-Suite-API (item.id), sofern
// Elev8 dieses Objekt kennt und über sein `ota_channels`-Feld verknüpft hat
// (siehe lib/elev8.js) — sonst NULL (z. B. Marken, die Elev8 nicht kennt).
try {
  db.exec("ALTER TABLE listings ADD COLUMN elev8_listing_id TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_listings_elev8_listing_id ON listings(elev8_listing_id)");
} catch (e) {
  // Index ist optional (kleine Datenmenge) - Fehler hier nicht fatal.
}

// Migration: Airbnb-"Amenities" (Ausstattung). Die Extension liest auf der
// Editor-Unterseite .../details/amenities die vollständige, bereits gesetzte
// Liste ("You've added these to your listing so far") mit Name + Kurz-
// beschreibung pro Merkmal aus. amenities speichert das pro Kanal als JSON:
// [{name, description}]. Der GLOBALE Katalog aller jemals gesehenen Namen
// (für "was wäre zusätzlich möglich") liegt in der bestehenden settings-
// Tabelle unter dem Key "airbnb_amenity_catalog" (siehe lib/amenities.js) --
// dafür ist keine eigene Spalte/Tabelle nötig.
try {
  db.exec("ALTER TABLE channels ADD COLUMN amenities TEXT");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

module.exports = db;
