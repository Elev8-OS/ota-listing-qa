const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const db = require("./db");
const { computeFindings } = require("./lib/checks");
const { fetchPublicListingData } = require("./lib/importer");

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
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
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || "", u.password_hash)) {
    return res.render("login", { error: "E-Mail oder Passwort ist falsch." });
  }
  req.session.userId = u.id;
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
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

// ---------- listing detail ----------

app.get("/listings/:id", requireAuth, (req, res) => {
  const listing = db.prepare("SELECT * FROM listings WHERE id = ?").get(req.params.id);
  if (!listing) return res.status(404).send("Inserat nicht gefunden.");
  const channelsRaw = db.prepare("SELECT * FROM channels WHERE listing_id = ? ORDER BY created_at").all(listing.id);
  const channels = channelsRaw.map((ch) => {
    const rooms = db.prepare("SELECT * FROM rooms WHERE channel_id = ? ORDER BY sort_order, id").all(ch.id);
    const findings = computeFindings(ch, rooms);
    const proposals = withUserNames(
      db.prepare("SELECT * FROM proposals WHERE channel_id = ? ORDER BY created_at DESC").all(ch.id)
    );
    return { ...ch, rooms, findings, proposals };
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

app.post("/listings/:id/channels", requireAuth, (req, res) => {
  const { platform, url } = req.body;
  db.prepare("INSERT INTO channels (listing_id, platform, url) VALUES (?, ?, ?)").run(
    req.params.id,
    platform,
    url || null
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

app.post("/channels/:id/import", requireAuth, async (req, res) => {
  const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
  if (!ch) return res.status(404).send("Kanal nicht gefunden.");
  const result = await fetchPublicListingData(ch.url);
  const f = result.fields || {};
  db.prepare(
    `UPDATE channels SET
       declared_bedrooms = COALESCE(?, declared_bedrooms),
       declared_beds = COALESCE(?, declared_beds),
       declared_bathrooms = COALESCE(?, declared_bathrooms),
       declared_guests = COALESCE(?, declared_guests),
       last_imported_at = datetime('now'),
       import_note = ?
     WHERE id = ?`
  ).run(
    f.bedrooms ?? null,
    f.beds ?? null,
    f.bathrooms ?? null,
    f.guests ?? null,
    result.note,
    ch.id
  );
  res.redirect("/listings/" + ch.listing_id + "?msg=" + encodeURIComponent("Import ausgeführt."));
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
