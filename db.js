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

module.exports = db;
