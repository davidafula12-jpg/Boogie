const GENRES = { Fiction:"#2a7f7a", Science:"#3e5c8a", History:"#b07a1e", Poetry:"#7a3e6b", Kids:"#c2503f" };
const DAYS = 14;

// ---- Data (saved in this browser with localStorage) ----
const DEFAULT = {
  users: [
    { name:"admin", pass:"admin123", role:"admin" },
    { name:"user",  pass:"user123",  role:"member" },
  ],
  books: [
    { id:1, title:"Things Fall Apart", author:"Chinua Achebe", genre:"Fiction", year:1958, copies:3 },
    { id:2, title:"Cosmos", author:"Carl Sagan", genre:"Science", year:1980, copies:1 },
    { id:3, title:"Tumbo Lisilo Shiba", author:"Ken Walibora", genre:"Fiction", year:2017, copies:2 },
    { id:4, title:"Unbowed", author:"Wangari Maathai", genre:"History", year:2006, copies:2 },
    { id:5, title:"Song of Lawino", author:"Okot p’Bitek", genre:"Poetry", year:1966, copies:2 },
    { id:6, title:"The Gruffalo", author:"Julia Donaldson", genre:"Kids", year:1999, copies:3 },
  ],
  loans: [],   // { id: bookId, user: name, due: timestamp }
  me: null,    // who is signed in
};
let S;
try { S = JSON.parse(localStorage.getItem("hd-library")) || structuredClone(DEFAULT); }
catch { S = structuredClone(DEFAULT); }
const save = () => localStorage.setItem("hd-library", JSON.stringify(S));

// ---- Helpers ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const me = () => S.users.find((u) => u.name === S.me);
const isAdmin = () => me()?.role === "admin";
const left = (b) => b.copies - S.loans.filter((l) => l.id === b.id).length;
const myLoan = (id) => S.loans.find((l) => l.id === id && l.user === S.me);
const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day:"numeric", month:"short" });
const dueText = (l) => l.due < Date.now() ? `<span class="stock none">Overdue since ${fmt(l.due)}</span>` : `<span class="stock in">Due ${fmt(l.due)}</span>`;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---- Rendering ----
function bookRow(b) {
  const n = left(b);
  let btn;
  if (isAdmin()) btn = `<button class="danger" data-remove="${b.id}">Remove</button>`;
  else if (myLoan(b.id)) btn = `<button class="ghost" data-return="${b.id}">Return</button>`;
  else btn = `<button class="primary" data-borrow="${b.id}" ${n < 1 ? "disabled" : ""}>${n < 1 ? "Unavailable" : "Borrow"}</button>`;
  const stock = n > 0 ? `<span class="stock in">${n} of ${b.copies} available</span>` : `<span class="stock none">All copies out</span>`;
  return `<li class="book" style="--c:${GENRES[b.genre] || "#888"}">
    <h3>${esc(b.title)}</h3><p>${esc(b.author)}</p><p>${esc(b.genre)}, ${esc(b.year)}</p>
    <div class="act">${stock}${btn}</div></li>`;
}

function loanRow(l, showUser) {
  const b = S.books.find((x) => x.id === l.id);
  if (!b) return "";
  return `<li class="book" style="--c:${GENRES[b.genre] || "#888"}">
    <h3>${esc(b.title)}</h3><p>${esc(b.author)}</p>${showUser ? `<p>Borrowed by ${esc(l.user)}</p>` : ""}
    <div class="act">${dueText(l)}<button class="ghost" data-return="${b.id}" data-user="${esc(l.user)}">${showUser ? "Mark returned" : "Return"}</button></div></li>`;
}

function render() {
  const q = $("#q").value.trim().toLowerCase(), g = $("#genre").value, only = $("#onlyAvail").checked;
  const found = S.books.filter((b) => (!q || (b.title + " " + b.author).toLowerCase().includes(q))
    && (g === "All" || b.genre === g) && (!only || left(b) > 0));
  $("#count").textContent = `${found.length} ${found.length === 1 ? "book" : "books"}`;
  $("#list").innerHTML = found.length ? found.map(bookRow).join("") : `<li class="empty">No books match. Try a different search or clear the filters.</li>`;

  const mine = S.loans.filter((l) => l.user === S.me);
  $("#loanCount").textContent = mine.length;
  $("#loanList").innerHTML = mine.length ? mine.map((l) => loanRow(l, false)).join("")
    : `<li class="empty">You haven’t borrowed anything yet. Find a book in the catalog and select Borrow.</li>`;
  $("#allList").innerHTML = S.loans.length ? S.loans.map((l) => loanRow(l, true)).join("")
    : `<li class="empty">No books are out right now.</li>`;
}

// ---- Screens ----
function show(view) {
  $$(".top nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
}
function enter() {
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#who").textContent = `${S.me} (${me().role})`;
  $$("[data-admin]").forEach((b) => (b.hidden = !isAdmin()));
  $$("[data-member]").forEach((b) => (b.hidden = isAdmin()));
  show("catalog"); render();
}
function leave() { $("#app").hidden = true; $("#auth").hidden = false; }

// ---- Sign in / create account ----
let signup = false;
const authErr = (m) => ($("#authErr").textContent = m);
$("#authSwitch").addEventListener("click", () => {
  signup = !signup; authErr("");
  $("#authBtn").textContent = signup ? "Create account" : "Sign in";
  $("#authTitle").textContent = signup ? "Create a member account." : "Sign in to borrow books.";
  $("#authSwitch").textContent = signup ? "Already have an account? Sign in" : "New here? Create an account";
  $("#p").autocomplete = signup ? "new-password" : "current-password";
});
$("#authForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#u").value.trim(), pass = $("#p").value;
  if (signup) {
    if (name.length < 3) return authErr("Username needs at least 3 characters.");
    if (pass.length < 6) return authErr("Password needs at least 6 characters.");
    if (S.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) return authErr("That username is taken. Choose another.");
    S.users.push({ name, pass, role:"member" }); S.me = name;
  } else {
    const u = S.users.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.pass === pass);
    if (!u) return authErr("Wrong username or password.");
    S.me = u.name;
  }
  authErr(""); save(); e.target.reset(); enter();
});
$("#logout").addEventListener("click", () => { S.me = null; save(); leave(); });

// ---- Borrow / return / remove ----
document.addEventListener("click", (e) => {
  const { borrow, remove } = e.target.dataset, ret = e.target.dataset.return;
  if (borrow) {
    const b = S.books.find((x) => x.id == borrow);
    if (!b || left(b) < 1 || myLoan(b.id)) return;
    S.loans.push({ id: b.id, user: S.me, due: Date.now() + DAYS * 864e5 });
    save(); render(); toast(`Borrowed “${b.title}”`);
  }
  if (ret) {
    const who = e.target.dataset.user || S.me;
    S.loans = S.loans.filter((l) => !(l.id == ret && l.user === who));
    save(); render(); toast("Returned");
  }
  if (remove && isAdmin()) {
    const b = S.books.find((x) => x.id == remove);
    if (!confirm(`Remove “${b.title}” from the catalog?`)) return;
    S.books = S.books.filter((x) => x.id !== b.id); S.loans = S.loans.filter((l) => l.id !== b.id);
    save(); render(); toast("Book removed");
  }
});

// ---- Tabs, filters, add-a-book ----
$$(".top nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
$("#genre").innerHTML = ["All", ...Object.keys(GENRES)].map((g) => `<option>${g}</option>`).join("");
$("#addForm select").innerHTML = Object.keys(GENRES).map((g) => `<option>${g}</option>`).join("");
["#q", "#genre", "#onlyAvail"].forEach((s) => $(s).addEventListener("input", render));
$("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!isAdmin()) return;
  const f = new FormData(e.target);
  S.books.push({ id: Date.now(), title: f.get("title").trim(), author: f.get("author").trim(),
    genre: f.get("genre"), year: +f.get("year"), copies: +f.get("copies") });
  save(); render(); e.target.reset(); toast("Added to catalog"); show("catalog");
});

// ---- Start ----
if (S.me && me()) enter(); else leave();
