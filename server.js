const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite"); // built into Node 22.5+

const PORT = process.env.PORT || 3000;
const BACKUP_DIR = path.join(__dirname, "backups");

// ---- Database (a single file: library.db) ----
const db = new DatabaseSync(path.join(__dirname, "library.db"));
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL,
    hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member');
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL);
`);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
// Categories now live inside a class (e.g. Grade 10 > Maths). Replace the older flat table.
if (cols("categories").length && !cols("categories").includes("class_id")) db.exec("DROP TABLE categories");
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE, UNIQUE (class_id, name));
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '', year INTEGER NOT NULL, copies INTEGER NOT NULL,
    category_id INTEGER REFERENCES categories(id));
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY, adm TEXT UNIQUE COLLATE NOCASE NOT NULL,
    name TEXT NOT NULL, class TEXT NOT NULL DEFAULT '', class_id INTEGER REFERENCES classes(id),
    kind TEXT NOT NULL DEFAULT 'student', archived INTEGER, left_class TEXT NOT NULL DEFAULT '');
`);
// (the old "genre" and "class" text columns are kept only so older database files still open)
if (!cols("books").includes("category_id")) db.exec("ALTER TABLE books ADD COLUMN category_id INTEGER REFERENCES categories(id)");
if (!cols("students").includes("class_id")) db.exec("ALTER TABLE students ADD COLUMN class_id INTEGER REFERENCES classes(id)");
const oldLoans = cols("loans");
if (oldLoans.length && !oldLoans.includes("student_id")) db.exec("DROP TABLE loans");
db.exec(`
  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    borrowed INTEGER NOT NULL, due INTEGER NOT NULL, returned INTEGER,
    lost INTEGER, note TEXT NOT NULL DEFAULT '', renewals INTEGER NOT NULL DEFAULT 0);
`);
// Upgrade older database files with the newer columns
for (const [t, c, def] of [["students", "kind", "TEXT NOT NULL DEFAULT 'student'"], ["students", "archived", "INTEGER"],
  ["students", "left_class", "TEXT NOT NULL DEFAULT ''"], ["loans", "lost", "INTEGER"],
  ["loans", "note", "TEXT NOT NULL DEFAULT ''"], ["loans", "renewals", "INTEGER NOT NULL DEFAULT 0"]])
  if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);


const text = (v) => String(v ?? "").trim();
const getClass = db.prepare("SELECT id FROM classes WHERE name = ?");
const addClass = db.prepare("INSERT INTO classes (name) VALUES (?)");
const classId = (name) => { // find a class by name, creating it if needed
  name = text(name); if (!name) return null;
  return (getClass.get(name) || { id: addClass.run(name).lastInsertRowid }).id;
};
const addCat = db.prepare("INSERT OR IGNORE INTO categories (class_id, name) VALUES (?, ?)");
const getCat = db.prepare("SELECT id FROM categories WHERE class_id = ? AND name = ?");

// Upgrade older databases: put old books on a "General" shelf, turn old class text into real classes
for (const r of db.prepare("SELECT DISTINCT genre FROM books WHERE category_id IS NULL").all()) {
  const gen = classId("General"), name = r.genre || "Other";
  addCat.run(gen, name);
  db.prepare("UPDATE books SET category_id = ? WHERE category_id IS NULL AND genre = ?").run(getCat.get(gen, name).id, r.genre);
}
for (const r of db.prepare("SELECT DISTINCT class FROM students WHERE class_id IS NULL AND class != ''").all())
  db.prepare("UPDATE students SET class_id = ? WHERE class_id IS NULL AND class = ?").run(classId(r.class), r.class);

// First run: librarian account and a few sample books on a "General" shelf
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
  db.prepare("INSERT INTO users (name, hash, role) VALUES (?, ?, 'admin')").run("admin", bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10));
  console.log("Created librarian account. Username: admin. Change the password under Settings.");
}
if (!db.prepare("SELECT 1 FROM books LIMIT 1").get()) {
  const gen = classId("General"), add = db.prepare("INSERT INTO books (title, author, genre, year, copies, category_id) VALUES (?, ?, ?, ?, ?, ?)");
  [["Things Fall Apart", "Chinua Achebe", "Fiction", 1958, 3], ["Cosmos", "Carl Sagan", "Science", 1980, 1],
   ["Tumbo Lisilo Shiba", "Ken Walibora", "Fiction", 2017, 2], ["Unbowed", "Wangari Maathai", "History", 2006, 2],
   ["Song of Lawino", "Okot p’Bitek", "Poetry", 1966, 2], ["The Gruffalo", "Julia Donaldson", "Kids", 1999, 3]]
    .forEach((b) => { addCat.run(gen, b[2]); add.run(b[0], b[1], b[2], b[3], b[4], getCat.get(gen, b[2]).id); });
}

// ---- Settings (lending rules) ----
const DEFAULTS = { maxLoans: 3, loanDays: 14, maxRenewals: 2, staffMaxLoans: 5, staffLoanDays: 30 };
const LIMITS = { maxLoans: [1, 50], loanDays: [1, 365], maxRenewals: [0, 10], staffMaxLoans: [1, 50], staffLoanDays: [1, 365] };
const setting = (k, d) => { const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(k); return r ? +r.value : d; };
const rules = () => Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, setting(k, d)]));
const rulesFor = (kind) => { const r = rules(); return kind === "staff" ? { max: r.staffMaxLoans, days: r.staffLoanDays, renew: r.maxRenewals } : { max: r.maxLoans, days: r.loanDays, renew: r.maxRenewals }; };
const ACTIVE = "l.returned IS NULL AND l.lost IS NULL"; // with a borrower right now (lost copies are neither active nor available)

// ---- Backups (consistent snapshots of library.db in the backups folder) ----
function backup(label) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const file = path.join(BACKUP_DIR, `library-${stamp}${label ? "-" + label : ""}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().slice(0, -20).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  return file;
}
function dailyBackup() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0"), today = `library-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const have = fs.existsSync(BACKUP_DIR) && fs.readdirSync(BACKUP_DIR).some((f) => f.startsWith(today));
  if (!have) try { backup("auto"); } catch (e) { console.warn("Backup failed:", e.message); }
}
dailyBackup(); setInterval(dailyBackup, 6 * 36e5).unref();

// ---- App setup ----
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-only-secret-change-me",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 7 * 864e5 },
}));
app.use(express.static(path.join(__dirname, "public")));
const needAdmin = (req, res, next) => (req.session.user?.role === "admin" ? next() : res.status(401).json({ error: "Please sign in." }));
const AVAIL = "copies - (SELECT COUNT(*) FROM loans l WHERE l.book_id = books.id AND l.returned IS NULL)";

// ---- Librarian login (no student accounts, no sign-up) ----
app.post("/api/login", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE name = ? AND role = 'admin'").get(text(req.body.name));
  if (!u || !bcrypt.compareSync(String(req.body.pass || ""), u.hash)) return res.status(401).json({ error: "Wrong username or password." });
  req.session.user = { id: u.id, name: u.name, role: u.role };
  res.json(req.session.user);
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json(req.session.user || null));
app.post("/api/password", needAdmin, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
  if (!bcrypt.compareSync(String(req.body.old || ""), u.hash)) return res.status(400).json({ error: "Current password is wrong." });
  const next = String(req.body.next || "");
  if (next.length < 6) return res.status(400).json({ error: "New password needs at least 6 characters." });
  db.prepare("UPDATE users SET hash = ? WHERE id = ?").run(bcrypt.hashSync(next, 10), u.id);
  res.json({ ok: true });
});

// ---- Settings and backups ----
app.get("/api/settings", needAdmin, (req, res) => res.json(rules()));
app.post("/api/settings", needAdmin, (req, res) => {
  const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const vals = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Math.floor(+req.body[k]);
    if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `Each rule needs a number between ${lo} and ${hi}.` });
    vals[k] = v;
  }
  for (const [k, v] of Object.entries(vals)) put.run(k, String(v));
  res.json(rules());
});
app.get("/api/backup", needAdmin, (req, res) => {
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort() : [];
  const last = files.length ? fs.statSync(path.join(BACKUP_DIR, files[files.length - 1])).mtimeMs : null;
  res.json({ count: files.length, last });
});
app.post("/api/backup", needAdmin, (req, res) => res.json({ name: path.basename(backup("manual")) }));
app.get("/api/backup/download", needAdmin, (req, res) => res.download(backup("download")));

// ---- Classes (e.g. Form 4, Grade 10) and their categories (subjects) ----
app.get("/api/classes", needAdmin, (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name,
    (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS students,
    (SELECT COUNT(*) FROM books b JOIN categories k ON k.id = b.category_id WHERE k.class_id = c.id) AS books
    FROM classes c ORDER BY c.name`).all());
});
app.post("/api/classes", needAdmin, (req, res) => {
  const name = text(req.body.name);
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: "Class name needs 2 to 40 characters." });
  if (getClass.get(name)) return res.status(409).json({ error: "That class already exists." });
  res.json({ id: addClass.run(name).lastInsertRowid });
});
app.post("/api/classes/promote", needAdmin, (req, res) => {
  const moves = Array.isArray(req.body.moves) ? req.body.moves : [];
  const ids = db.prepare("SELECT id FROM students WHERE class_id = ? AND archived IS NULL"), out = db.prepare("SELECT 1 FROM loans l WHERE student_id = ? AND " + ACTIVE);
  const plan = [];
  for (const m of moves) {
    const from = +m.from, to = m.to === null || m.to === undefined ? null : +m.to;
    if (to === from) continue;
    if (to !== null && !db.prepare("SELECT 1 FROM classes WHERE id = ?").get(to)) return res.status(400).json({ error: "A destination class no longer exists." });
    plan.push({ to, ids: ids.all(from).map((r) => r.id) });
  }
  const blocked = plan.filter((p) => p.to === null).flatMap((p) => p.ids).filter((id) => out.get(id)).length;
  if (blocked) return res.status(409).json({ error: `${blocked} leaving student${blocked === 1 ? " still has" : "s still have"} books out. Collect them first.` });
  backup("before-promotion");
  let moved = 0, left = 0;
  db.exec("BEGIN");
  try {
    for (const p of plan) for (const id of p.ids) {
      if (p.to === null) { db.prepare("UPDATE students SET archived = ?, left_class = (SELECT name FROM classes WHERE id = students.class_id), class_id = NULL WHERE id = ?").run(Date.now(), id); left++; }
      else { db.prepare("UPDATE students SET class_id = ? WHERE id = ?").run(p.to, id); moved++; }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: "Could not move the students. Nothing was changed." }); }
  res.json({ moved, left });
});
app.delete("/api/classes/:id", needAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Class not found." });
  if (db.prepare("SELECT 1 FROM students WHERE class_id = ?").get(c.id)) return res.status(409).json({ error: "This class still has students. Move them first." });
  if (db.prepare("SELECT 1 FROM books b JOIN categories k ON k.id = b.category_id WHERE k.class_id = ?").get(c.id)) return res.status(409).json({ error: "This class still has books. Remove or move them first." });
  db.prepare("DELETE FROM classes WHERE id = ?").run(c.id);
  res.json({ ok: true });
});
app.get("/api/categories", needAdmin, (req, res) => {
  res.json(db.prepare(`SELECT k.id, k.class_id, k.name, (SELECT COUNT(*) FROM books b WHERE b.category_id = k.id) AS books
                       FROM categories k ORDER BY k.name`).all());
});
app.post("/api/categories", needAdmin, (req, res) => {
  const name = text(req.body.name), cid = +req.body.classId;
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: "Category name needs 2 to 40 characters." });
  if (!db.prepare("SELECT 1 FROM classes WHERE id = ?").get(cid)) return res.status(400).json({ error: "Choose a class first." });
  if (getCat.get(cid, name)) return res.status(409).json({ error: "That class already has this category." });
  addCat.run(cid, name); res.json({ ok: true });
});
app.delete("/api/categories/:id", needAdmin, (req, res) => {
  const n = db.prepare("SELECT COUNT(*) AS n FROM books WHERE category_id = ?").get(req.params.id).n;
  if (n) return res.status(409).json({ error: `Move or remove its ${n} book${n === 1 ? "" : "s"} first.` });
  db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Books ----
const BOOKS = `SELECT books.id, books.title, books.author, books.year, books.copies, books.category_id,
  k.name AS category, k.class_id, c.name AS class_name, ${AVAIL} AS available
  FROM books JOIN categories k ON k.id = books.category_id JOIN classes c ON c.id = k.class_id`;
app.get("/api/books", needAdmin, (req, res) => res.json(db.prepare(BOOKS + " ORDER BY books.title").all()));
app.post("/api/books", needAdmin, (req, res) => {
  const { title, author, categoryId, year, copies } = req.body;
  if (!text(title) || !text(author) || !(+year > 0) || !(+copies > 0)) return res.status(400).json({ error: "Fill in every field." });
  const k = db.prepare("SELECT * FROM categories WHERE id = ?").get(+categoryId);
  if (!k) return res.status(400).json({ error: "Choose a class and a category. Add them under Classes if the list is empty." });
  const r = db.prepare("INSERT INTO books (title, author, genre, year, copies, category_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(text(title), text(author), k.name, +year, +copies, k.id);
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/books/:id", needAdmin, (req, res) => {
  const { title, author, categoryId, year, copies } = req.body;
  if (!text(title) || !text(author) || !(+year >= 0) || !(+copies > 0)) return res.status(400).json({ error: "Fill in every field." });
  const k = db.prepare("SELECT * FROM categories WHERE id = ?").get(+categoryId);
  if (!k) return res.status(400).json({ error: "Choose a class and a category." });
  const out = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND returned IS NULL").get(req.params.id).n;
  if (+copies < out) return res.status(409).json({ error: `${out} cop${out === 1 ? "y is" : "ies are"} out or lost, so copies can't be fewer than ${out}.` });
  db.prepare("UPDATE books SET title = ?, author = ?, genre = ?, year = ?, copies = ?, category_id = ? WHERE id = ?")
    .run(text(title), text(author), k.name, +year, Math.floor(+copies), k.id, req.params.id);
  res.json({ ok: true });
});
app.post("/api/books/import", needAdmin, (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 5000) return res.status(400).json({ error: "Paste between 1 and 5000 books." });
  const has = db.prepare("SELECT 1 FROM books WHERE category_id = ? AND title = ? COLLATE NOCASE AND author = ? COLLATE NOCASE");
  const ins = db.prepare("INSERT INTO books (title, author, genre, year, copies, category_id) VALUES (?, ?, ?, ?, ?, ?)");
  let added = 0, skipped = 0, bad = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) { // classes and categories that do not exist yet are created automatically
      const title = text(r.title), author = text(r.author);
      if (!title || !author) { bad++; continue; }
      const cid = classId(r.class) || classId("General"), name = text(r.category) || "Other";
      addCat.run(cid, name);
      const k = getCat.get(cid, name).id;
      if (has.get(k, title, author)) { skipped++; continue; }
      ins.run(title, author, name, Math.max(0, Math.floor(+r.year) || 0), Math.max(1, Math.floor(+r.copies) || 1), k); added++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: "Import failed. Nothing was saved." }); }
  res.json({ added, skipped, bad });
});
app.delete("/api/books/:id", needAdmin, (req, res) => {
  if (db.prepare("SELECT 1 FROM loans l WHERE book_id = ? AND " + ACTIVE).get(req.params.id))
    return res.status(409).json({ error: "Some copies are still out. Return them first." });
  db.prepare("DELETE FROM books WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Students and staff (records only, they never sign in) ----
const kindOf = (v) => (v === "staff" ? "staff" : "student");
app.get("/api/students", needAdmin, (req, res) => {
  res.json(db.prepare(`SELECT s.id, s.adm, s.name, s.class_id, COALESCE(c.name, '') AS class, s.kind, s.archived, s.left_class,
    (SELECT COUNT(*) FROM loans l WHERE l.student_id = s.id AND ${ACTIVE}) AS active
    FROM students s LEFT JOIN classes c ON c.id = s.class_id ORDER BY c.name, s.name`).all());
});
const validClass = (v) => (v === null || v === undefined || v === "" ? null : db.prepare("SELECT id FROM classes WHERE id = ?").get(+v)?.id ?? false);
app.post("/api/students", needAdmin, (req, res) => {
  const adm = text(req.body.adm), name = text(req.body.name), cid = validClass(req.body.classId);
  if (!adm || !name) return res.status(400).json({ error: "ID/admission number and name are required." });
  if (cid === false) return res.status(400).json({ error: "That class does not exist." });
  if (db.prepare("SELECT 1 FROM students WHERE adm = ?").get(adm)) return res.status(409).json({ error: "Someone with that admission number already exists (they may be archived)." });
  db.prepare("INSERT INTO students (adm, name, class_id, kind) VALUES (?, ?, ?, ?)").run(adm, name, cid, kindOf(req.body.kind));
  res.json({ ok: true });
});
app.post("/api/students/import", needAdmin, (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 5000) return res.status(400).json({ error: "Paste between 1 and 5000 people." });
  const has = db.prepare("SELECT 1 FROM students WHERE adm = ?"), ins = db.prepare("INSERT INTO students (adm, name, class_id, kind) VALUES (?, ?, ?, ?)");
  let added = 0, skipped = 0, bad = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) { // classes in the list that do not exist yet are created automatically
      const adm = text(r.adm), name = text(r.name);
      if (!adm || !name) { bad++; continue; }
      if (has.get(adm)) { skipped++; continue; }
      ins.run(adm, name, classId(r.class), /staff|teacher/i.test(text(r.type)) ? "staff" : "student"); added++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: "Import failed. Nothing was saved." }); }
  res.json({ added, skipped, bad });
});
app.put("/api/students/:id", needAdmin, (req, res) => {
  const name = text(req.body.name), cid = validClass(req.body.classId);
  if (!name) return res.status(400).json({ error: "Name is required." });
  if (cid === false) return res.status(400).json({ error: "That class does not exist." });
  db.prepare("UPDATE students SET name = ?, class_id = ?, kind = ? WHERE id = ?").run(name, cid, kindOf(req.body.kind), req.params.id);
  res.json({ ok: true });
});
app.post("/api/students/:id/archive", needAdmin, (req, res) => { // a leaver: hidden from lists, history kept
  if (db.prepare("SELECT 1 FROM loans l WHERE student_id = ? AND " + ACTIVE).get(req.params.id))
    return res.status(409).json({ error: "They still have books out. Return them first." });
  db.prepare("UPDATE students SET archived = ?, left_class = COALESCE((SELECT name FROM classes WHERE id = students.class_id), ''), class_id = NULL WHERE id = ?").run(Date.now(), req.params.id);
  res.json({ ok: true });
});
app.post("/api/students/:id/restore", needAdmin, (req, res) => {
  const cid = validClass(req.body.classId);
  if (cid === false) return res.status(400).json({ error: "That class does not exist." });
  db.prepare("UPDATE students SET archived = NULL, left_class = '', class_id = ?, kind = ? WHERE id = ?").run(cid, kindOf(req.body.kind), req.params.id);
  res.json({ ok: true });
});
app.delete("/api/students/:id", needAdmin, (req, res) => { // permanent: also deletes their loan history
  if (db.prepare("SELECT 1 FROM loans l WHERE student_id = ? AND " + ACTIVE).get(req.params.id))
    return res.status(409).json({ error: "They still have books out. Return them first." });
  db.prepare("DELETE FROM students WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Loans (the librarian lends and receives books) ----
app.get("/api/loans", needAdmin, (req, res) => {
  res.json(db.prepare(`SELECT l.id, l.book_id, l.student_id, l.borrowed, l.due, l.renewals, s.name AS student, s.kind, COALESCE(c.name, '') AS class, s.adm
    FROM loans l JOIN students s ON s.id = l.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE ${ACTIVE} ORDER BY l.due`).all());
});
app.get("/api/activity", needAdmin, (req, res) => {
  res.json(db.prepare(`SELECT l.id, b.title, s.name AS student, l.borrowed, l.returned, l.lost
    FROM loans l JOIN books b ON b.id = l.book_id JOIN students s ON s.id = l.student_id
    ORDER BY MAX(l.borrowed, COALESCE(l.returned, 0), COALESCE(l.lost, 0)) DESC LIMIT 6`).all());
});
app.get("/api/history", needAdmin, (req, res) => { // everything one student or one book has been through
  const w = [], p = [];
  if (req.query.studentId) { w.push("l.student_id = ?"); p.push(+req.query.studentId); }
  if (req.query.bookId) { w.push("l.book_id = ?"); p.push(+req.query.bookId); }
  if (!w.length) return res.status(400).json({ error: "Choose a student or a book." });
  res.json(db.prepare(`SELECT l.id, b.title, s.name AS student, s.adm, l.borrowed, l.due, l.returned, l.lost, l.note, l.renewals
    FROM loans l JOIN books b ON b.id = l.book_id JOIN students s ON s.id = l.student_id
    WHERE ${w.join(" AND ")} ORDER BY l.borrowed DESC LIMIT 300`).all(...p));
});
app.post("/api/loans", needAdmin, (req, res) => {
  const bookId = +req.body.bookId, studentId = +req.body.studentId;
  const book = db.prepare(`SELECT books.*, ${AVAIL} AS available FROM books WHERE id = ?`).get(bookId);
  const stu = db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
  if (!book) return res.status(404).json({ error: "Book not found." });
  if (!stu) return res.status(404).json({ error: "Student not found." });
  if (stu.archived) return res.status(409).json({ error: `${stu.name} is archived. Restore them first.` });
  if (book.available < 1) return res.status(409).json({ error: "All copies are out." });
  if (db.prepare("SELECT 1 FROM loans l WHERE book_id = ? AND student_id = ? AND " + ACTIVE).get(bookId, studentId))
    return res.status(409).json({ error: `${stu.name} already has this book.` });
  const { max, days } = rulesFor(stu.kind);
  const has = db.prepare("SELECT COUNT(*) AS n FROM loans l WHERE student_id = ? AND " + ACTIVE).get(studentId).n;
  if (has >= max) return res.status(409).json({ error: `${stu.name} already has ${has} book${has === 1 ? "" : "s"} out. The limit is ${max}.` });
  const now = Date.now(), due = now + days * 864e5;
  db.prepare("INSERT INTO loans (book_id, student_id, borrowed, due) VALUES (?, ?, ?, ?)").run(bookId, studentId, now, due);
  res.json({ ok: true, student: stu.name, due });
});
const activeLoan = (id) => db.prepare("SELECT l.* FROM loans l WHERE l.id = ? AND " + ACTIVE).get(id);
app.post("/api/loans/:id/return", needAdmin, (req, res) => {
  const loan = activeLoan(req.params.id);
  if (!loan) return res.status(404).json({ error: "Loan not found." });
  db.prepare("UPDATE loans SET returned = ? WHERE id = ?").run(Date.now(), loan.id);
  res.json({ ok: true });
});
app.post("/api/loans/:id/renew", needAdmin, (req, res) => {
  const loan = activeLoan(req.params.id);
  if (!loan) return res.status(404).json({ error: "Loan not found." });
  const stu = db.prepare("SELECT * FROM students WHERE id = ?").get(loan.student_id), { days, renew } = rulesFor(stu.kind);
  if (loan.renewals >= renew) return res.status(409).json({ error: `This loan has already been renewed ${loan.renewals} time${loan.renewals === 1 ? "" : "s"}. That is the limit.` });
  const due = Math.max(loan.due, Date.now()) + days * 864e5;
  db.prepare("UPDATE loans SET due = ?, renewals = renewals + 1 WHERE id = ?").run(due, loan.id);
  res.json({ ok: true, due });
});
app.post("/api/loans/:id/lost", needAdmin, (req, res) => { // lost or damaged: stays out of circulation, frees the borrower's limit
  const loan = activeLoan(req.params.id);
  if (!loan) return res.status(404).json({ error: "Loan not found." });
  db.prepare("UPDATE loans SET lost = ?, note = ? WHERE id = ?").run(Date.now(), text(req.body.note).slice(0, 200), loan.id);
  res.json({ ok: true });
});
app.post("/api/loans/:id/found", needAdmin, (req, res) => {
  const r = db.prepare("UPDATE loans SET lost = NULL, returned = ? WHERE id = ? AND lost IS NOT NULL AND returned IS NULL").run(Date.now(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: "That lost record was not found." });
  res.json({ ok: true });
});

// ---- Reports ----
app.get("/api/reports", needAdmin, (req, res) => {
  res.json({
    top: db.prepare(`SELECT b.id, b.title, b.author, COUNT(l.id) AS n FROM books b JOIN loans l ON l.book_id = b.id GROUP BY b.id ORDER BY n DESC, b.title LIMIT 10`).all(),
    lost: db.prepare(`SELECT l.id, b.title, s.id AS student_id, s.name AS student, s.adm, s.class_id, s.kind, COALESCE(c.name, NULLIF(s.left_class, ''), '') AS class, l.lost, l.note
      FROM loans l JOIN books b ON b.id = l.book_id JOIN students s ON s.id = l.student_id LEFT JOIN classes c ON c.id = s.class_id
      WHERE l.lost IS NOT NULL AND l.returned IS NULL ORDER BY l.lost DESC`).all(),
    never: db.prepare(`SELECT COUNT(*) AS n FROM students s WHERE s.archived IS NULL AND s.kind = 'student' AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.student_id = s.id)`).get().n,
  });
});

// Anything else under /api, and any unexpected crash, answers in plain language
app.use("/api", (req, res) => res.status(404).json({ error: "The server doesn't know that request. Stop it with Ctrl+C and run npm start again." }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "The server hit a problem. Check the terminal window for details." }); });

app.listen(PORT, () => console.log(`Library running at http://localhost:${PORT}`));
