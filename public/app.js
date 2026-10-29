/* St Columban's Library - librarian-controlled system (no student logins).
   Talks to server.js (Express + SQLite). */
(function () {
  var TONES = [['#F4DEDA', '#8F3028'], ['#FBEFC4', '#7A5A00'], ['#DCEBE2', '#28734D'], ['#E4E6EE', '#3C4A78']];
  var TITLES = { dash: 'Dashboard', catalog: 'Book catalogue', loans: 'Loans', students: 'Students', classes: 'Classes', add: 'Add books', reports: 'Reports', settings: 'Settings', help: 'Help & support' };
  var $ = function (id) { return document.getElementById(id); };
  var me = null, view = 'dash', books = [], loans = [], students = [], classes = [], cats = [], activity = [], bk = { count: 0, last: null };
  var rules = { maxLoans: 3, loanDays: 14, maxRenewals: 2, staffMaxLoans: 5, staffLoanDays: 30 };
  var reports = { top: [], lost: [], never: 0 };
  var lendBook = null, selClass = null, editBookId = null, stuMode = null, stuId = null;

  /* ---------- server ---------- */
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: {} };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().then(function (d) { return { r: r, d: d }; }, function () { return { r: r, d: null }; });
    }).then(function (x) {
      if (!x.r.ok) {
        var msg = x.d && x.d.error ? x.d.error : 'The server sent an unexpected reply (error ' + x.r.status + '). Stop it with Ctrl+C, make sure server.js is the newest version, then run npm start again.';
        var e = new Error(msg); e.status = x.r.status; throw e;
      }
      return x.d;
    });
  }
  function byName(a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); }
  function refresh() {
    return Promise.all([api('GET', '/api/books'), api('GET', '/api/loans'), api('GET', '/api/students'), api('GET', '/api/classes'),
      api('GET', '/api/categories'), api('GET', '/api/activity'), api('GET', '/api/settings'), api('GET', '/api/backup'), api('GET', '/api/reports')])
      .then(function (r) {
        books = r[0]; loans = r[1]; students = r[2]; classes = r[3].sort(byName); cats = r[4]; activity = r[5]; rules = r[6]; bk = r[7]; reports = r[8];
        if (!byId(classes, selClass)) selClass = classes.length ? classes[0].id : null;
        fillSelects(); render();
      }).catch(fail);
  }
  function fail(e) { if (e.status === 401) toLogin(); else toast(e.message || 'Could not reach the server. Is it still running?'); }
  function toast(m) {
    var t = $('toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 4000);
  }
  function done(msg) { return function () { toast(msg); return refresh(); }; }

  /* ---------- helpers ---------- */
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function fmt(ms) { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function ic(n) { return '<svg class="ic"><use href="#i-' + n + '"/></svg>'; }
  function tone(s) { var n = 0; s = String(s); for (var i = 0; i < s.length; i++) n += s.charCodeAt(i); var t = TONES[n % TONES.length]; return 'background:' + t[0] + ';color:' + t[1]; }
  function ago(ms) { var d = Math.floor((Date.now() - ms) / 864e5); return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d + ' days ago'; }
  function byId(list, id) { return list.filter(function (x) { return x.id === +id; })[0]; }
  function options(list, label) { return list.map(function (x) { return '<option value="' + x.id + '">' + esc(label ? label(x) : x.name) + '</option>'; }).join(''); }
  function restore(sel, v) { sel.value = v; if (sel.selectedIndex < 0) sel.selectedIndex = 0; }  // keep the choice, else pick the first option
  function keep(sel, html) { var v = sel.value; sel.innerHTML = html; restore(sel, v); }
  function limitFor(s) { return s.kind === 'staff' ? rules.staffMaxLoans : rules.maxLoans; }
  function placeOf(s) { return s.class || (s.kind === 'staff' ? 'Staff' : 'No class'); }
  function yr(b) { return b.year ? ' &middot; ' + b.year : ''; }
  function download(name, rows) {
    var csv = rows.map(function (r) {
      return r.map(function (c) { c = String(c == null ? '' : c); if (/^[=+\-@]/.test(c)) c = "'" + c; return '"' + c.replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); a.download = name; a.click();
  }

  /* ---------- sign in / out ---------- */
  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault(); $('authBtn').disabled = true;
    api('POST', '/api/login', { name: $('u').value.trim(), pass: $('p').value })
      .then(login).catch(function (err) { $('authErr').textContent = err.message; })
      .then(function () { $('authBtn').disabled = false; });
  });
  function login(user) {
    me = user; $('auth').hidden = true; $('app').hidden = false;
    $('avatar').textContent = user.name.charAt(0); $('whoName').textContent = user.name; $('whoRole').textContent = 'Librarian';
    show('dash'); return refresh();
  }
  function toLogin() { me = null; $('app').hidden = true; $('auth').hidden = false; $('authForm').reset(); $('authErr').textContent = ''; }
  $('logout').addEventListener('click', function () { api('POST', '/api/logout').catch(function () {}).then(toLogin); });

  /* ---------- navigation ---------- */
  function show(v) {
    view = v; var isDash = v === 'dash' || v === 'catalog';
    document.querySelectorAll('.view').forEach(function (s) { s.hidden = s.id !== (isDash ? 'dash' : v); });
    $('dash').dataset.mode = isDash ? v : '';
    document.querySelectorAll('nav [data-view]').forEach(function (b) { b.classList.toggle('on', b.dataset.view === v); });
    $('crumb').textContent = TITLES[v]; window.scrollTo(0, 0); render();
  }

  /* ---------- dropdowns ---------- */
  function catOptions(sel, classIdValue, allLabel) {
    var list = cats.filter(function (k) { return !classIdValue || k.class_id === +classIdValue; });
    var multi = !classIdValue;
    var html = (allLabel ? '<option value="">' + allLabel + '</option>' : '') + options(list, function (k) { return multi ? (byId(classes, k.class_id) || {}).name + ': ' + k.name : k.name; });
    sel.innerHTML = html || '<option value="">Add a category under Classes first</option>';
  }
  function fillSelects() {
    var clsHtml = options(classes);
    keep($('fclass'), '<option value="">All classes</option>' + clsHtml);
    var gv = $('genre').value; catOptions($('genre'), $('fclass').value, 'All categories'); restore($('genre'), gv);
    var firstWithCats = classes.filter(function (c) { return cats.some(function (k) { return k.class_id === c.id; }); })[0], hadClass = $('bookClass').value;
    keep($('bookClass'), clsHtml || '<option value="">Add a class first</option>');
    if (!hadClass && firstWithCats) $('bookClass').value = firstWithCats.id;   // start on a class that has categories
    var bv = $('bookCat').value; catOptions($('bookCat'), $('bookClass').value); restore($('bookCat'), bv);
    keep($('stuClass'), clsHtml || '<option value="">No class yet</option>');
    keep($('sclass'), '<option value="">All classes</option>' + clsHtml);
    keep($('clrClass'), '<option value="">All classes</option>' + clsHtml + '<option value="staff">Teachers / staff</option>');
  }
  $('fclass').addEventListener('change', function () { catOptions($('genre'), $('fclass').value, 'All categories'); render(); });
  $('bookClass').addEventListener('change', function () { catOptions($('bookCat'), $('bookClass').value); });
  $('bdClass').addEventListener('change', function () { catOptions($('bdCat'), $('bdClass').value); });

  /* ---------- rendering ---------- */
  function row(cover, tn, title, sub, pill, status, action, cls) {
    return '<li class="row ' + (cls || '') + '"><span class="cover" style="' + tone(tn) + '">' + cover + '</span><div class="info"><h3>' + title + '</h3><p>' + sub + '</p>' +
      (pill ? '<span class="pill">' + esc(pill) + '</span>' : '') + '</div><div class="act">' + status + action + '</div></li>';
  }
  function bookRow(b) {
    var st = '<span class="st ' + (b.available ? 'ok' : 'bad') + '">' + (b.available ? b.available + ' of ' + b.copies + ' available' : 'All copies out') + '</span>';
    var act = '<div class="btns"><button class="btn-soft" data-lend="' + b.id + '"' + (b.available ? '' : ' disabled') + '>Lend book</button>' +
      '<button class="ghost" data-edbook="' + b.id + '">Edit</button><button class="ghost" data-histbook="' + b.id + '">History</button><button class="ghost" data-delbook="' + b.id + '">Remove</button></div>';
    return row(esc(b.title.charAt(0)), b.class_name, esc(b.title), 'by ' + esc(b.author) + yr(b), b.class_name + ' \u00b7 ' + b.category, st, act);
  }
  function table(head, rows) {
    return '<table class="tbl"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }
  function tr(cells) { return '<tr>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }

  function render() {
    if (!me) return;
    var now = Date.now(), isDash = view === 'dash';
    var people = students.filter(function (s) { return !s.archived; });
    $('loanCount').textContent = loans.length;

    var h = new Date().getHours(), part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    $('greetTitle').textContent = isDash ? 'Good ' + part + ', Librarian' : 'Book catalogue';
    $('greetSub').textContent = isDash ? "Here's what's happening in your school library today." : 'Find a book in your school collection.';
    $('greetBtn').dataset.view = 'add'; $('greetBtn').textContent = '+ Add new book';

    var total = books.reduce(function (n, b) { return n + b.copies; }, 0), avail = books.reduce(function (n, b) { return n + b.available; }, 0);
    var overdue = loans.filter(function (l) { return l.due < now; }).length;
    function stat(l, n, s, i, c) { return '<div class="stat"><p>' + l + '</p><b>' + n + '</b><small class="' + (c || '') + '">' + s + '</small><i>' + ic(i) + '</i></div>'; }
    $('stats').innerHTML = stat('Total books', total, books.length + ' titles &middot; ' + people.length + ' borrowers', 'book') +
      stat('Books borrowed', loans.length, 'Currently with borrowers', 'swap') +
      stat('Available books', avail, 'Ready to lend', 'check', 'ok') +
      stat('Overdue returns', overdue, overdue ? 'Collect these soon' : 'Nothing overdue', 'clock');

    /* catalogue */
    var q = $('q').value.toLowerCase(), fc = $('fclass').value, g = $('genre').value, av = $('onlyAvail').checked;
    var list = books.filter(function (b) {
      return (!q || (b.title + ' ' + b.author).toLowerCase().indexOf(q) > -1) && (!fc || b.class_id === +fc) && (!g || b.category_id === +g) && (!av || b.available > 0);
    });
    $('count').textContent = list.length + (list.length === 1 ? ' book' : ' books') + ' found';
    $('viewAll').hidden = !isDash || list.length <= 6;
    var shown = isDash ? list.slice(0, 6) : list;
    $('list').innerHTML = shown.length ? shown.map(bookRow).join('') : '<li class="empty">No books match. Try clearing your search or filters.</li>';

    $('cats').innerHTML = classes.length ? classes.map(function (c) {
      return '<li data-cls="' + c.id + '" tabindex="0"><span class="cover" style="' + tone(c.name) + '">' + esc(c.name.charAt(0)) + '</span><div class="info"><h3>' + esc(c.name) + '</h3></div><span class="n">' + c.books + '</span></li>';
    }).join('') : '<li class="empty">No classes yet. Add one under Classes.</li>';
    $('recent').innerHTML = activity.length ? activity.map(function (a) {
      var t = a.lost || a.returned || a.borrowed;
      return '<li><span class="cover" style="' + tone(a.title) + '">' + ic(a.returned ? 'check' : 'swap') + '</span><div class="info"><h3>' + esc(a.title) + '</h3><p>' +
        (a.lost ? 'Lost by ' : a.returned ? 'Returned by ' : 'Lent to ') + esc(a.student) + '</p></div><span class="n">' + ago(t) + '</span></li>';
    }).join('') : '<li class="empty">No lending yet.</li>';

    /* loans */
    $('loanList').innerHTML = loans.length ? loans.map(function (l) {
      var b = byId(books, l.book_id); if (!b) return '';
      var late = l.due < now, canRenew = l.renewals < rules.maxRenewals;
      return row(esc(b.title.charAt(0)), b.class_name, esc(b.title), 'With <b>' + esc(l.student) + '</b> &middot; ' + esc(l.class || (l.kind === 'staff' ? 'Staff' : 'No class')) + ' &middot; ' + esc(l.adm), b.class_name + ' \u00b7 ' + b.category,
        '<span class="st ' + (late ? 'bad' : 'ok') + '">' + (late ? 'Overdue, was due ' : 'Due ') + fmt(l.due) + (l.renewals ? ' &middot; renewed ' + l.renewals + '\u00d7' : '') + '</span>',
        '<div class="btns"><button class="btn-soft" data-return="' + l.id + '">Return book</button><button class="ghost" data-renew="' + l.id + '"' + (canRenew ? '' : ' disabled') + '>Renew</button><button class="ghost" data-lost="' + l.id + '">Lost</button></div>');
    }).join('') : '<li class="empty">No books are out right now.</li>';

    /* students */
    var showArch = $('showArch').checked, sq = $('sq').value.toLowerCase(), sc = $('sclass').value;
    var sl = students.filter(function (s) {
      return (showArch ? !!s.archived : !s.archived) && (!sc || s.class_id === +sc) && (!sq || (s.name + ' ' + s.adm + ' ' + s.class).toLowerCase().indexOf(sq) > -1);
    });
    var nStaff = people.filter(function (s) { return s.kind === 'staff'; }).length;
    $('scount').textContent = (people.length - nStaff) + ' students and ' + nStaff + ' staff' + (showArch ? ' (showing archived)' : '');
    $('stuList').innerHTML = sl.length ? sl.map(function (s) {
      var badge = s.kind === 'staff' ? '<span class="badge-staff">Staff</span>' : '';
      if (s.archived) return row(esc(s.name.charAt(0)), s.name, esc(s.name) + badge, esc(s.adm) + ' &middot; left ' + fmt(s.archived) + (s.left_class ? ' (' + esc(s.left_class) + ')' : ''), '', '<span class="st">Archived</span>',
        '<div class="btns"><button class="ghost" data-histstu="' + s.id + '">History</button><button class="btn-soft" data-restore="' + s.id + '">Restore</button><button class="ghost" data-delstu="' + s.id + '">Delete</button></div>');
      return row(esc(s.name.charAt(0)), s.class || s.name, esc(s.name) + badge, esc(s.adm) + ' &middot; ' + esc(placeOf(s)), '',
        '<span class="st ' + (s.active >= limitFor(s) ? 'bad' : 'ok') + '">' + (s.active ? s.active + ' of ' + limitFor(s) + ' books out' : 'No books out') + '</span>',
        '<div class="btns"><button class="ghost" data-editstu="' + s.id + '">Edit</button><button class="ghost" data-histstu="' + s.id + '">History</button><button class="ghost" data-archstu="' + s.id + '">Archive</button></div>');
    }).join('') : '<li class="empty">' + (showArch ? 'No archived students.' : people.length ? 'No one matches.' : 'No students yet. Add one, or paste your class list from Excel.') + '</li>';

    /* classes + categories */
    $('classList').innerHTML = classes.map(function (c) {
      return row(esc(c.name.charAt(0)), c.name, esc(c.name), c.students + (c.students === 1 ? ' student' : ' students') + ' &middot; ' + c.books + (c.books === 1 ? ' book' : ' books'), '', '',
        '<div class="btns"><button class="btn-soft" data-selcls="' + c.id + '">Categories</button><button class="ghost" data-delcls="' + c.id + '">Remove</button></div>', c.id === selClass ? 'sel' : '');
    }).join('') || '<li class="empty">No classes yet. Add your first class below, for example Form 4.</li>';
    var sel = byId(classes, selClass);
    $('catTitle').textContent = sel ? 'Categories in ' + sel.name : 'Categories';
    $('catForm').hidden = !sel;
    var mine = cats.filter(function (k) { return k.class_id === selClass; });
    $('catList').innerHTML = !sel ? '<li class="empty">Add a class first, then select it to add categories.</li>' : mine.map(function (k) {
      return '<li class="row"><span class="cover" style="' + tone(k.name) + '">' + esc(k.name.charAt(0)) + '</span><div class="info"><h3>' + esc(k.name) + '</h3><p>' + k.books + (k.books === 1 ? ' book' : ' books') + '</p></div>' +
        '<div class="act"><button class="ghost" data-delcat="' + k.id + '">Remove</button></div></li>';
    }).join('') || '<li class="empty">No categories in ' + esc(sel.name) + ' yet. Add one below, such as Mathematics.</li>';

    renderReports(now);

    /* settings */
    ['maxLoans', 'loanDays', 'staffMaxLoans', 'staffLoanDays', 'maxRenewals'].forEach(function (k) { if (document.activeElement !== $(k)) $(k).value = rules[k]; });
    $('backupInfo').textContent = bk.last ? 'Last backup: ' + new Date(bk.last).toLocaleString() + ' (' + bk.count + ' saved).' : 'No backup has been made yet.';
  }

  function renderReports(now) {
    $('repSub').textContent = reports.never + (reports.never === 1 ? ' student has' : ' students have') + ' never borrowed a book.';
    var od = loans.filter(function (l) { return l.due < now; }).sort(function (a, b) { return a.due - b.due; });
    $('odBody').innerHTML = od.length ? table(['Class', 'Borrower', 'Book', 'Was due', 'Days late'], od.map(function (l) {
      var b = byId(books, l.book_id);
      return tr([esc(l.class || (l.kind === 'staff' ? 'Staff' : '')), esc(l.student) + ' <span class="muted">' + esc(l.adm) + '</span>', esc(b ? b.title : ''), fmt(l.due), Math.floor((now - l.due) / 864e5)]);
    })) : '<p class="muted">Nothing is overdue.</p>';

    var cv = $('clrClass').value, byStu = {};
    function inScope(sid, clsId, kind) { return !cv || (cv === 'staff' ? kind === 'staff' : +cv === clsId); }
    loans.forEach(function (l) {
      var s = byId(students, l.student_id); if (!s || !inScope(s.id, s.class_id, s.kind)) return;
      (byStu[s.id] = byStu[s.id] || { s: s, items: [] }).items.push(esc((byId(books, l.book_id) || {}).title || '') + (l.due < now ? ' (overdue)' : ''));
    });
    reports.lost.forEach(function (x) {
      var s = byId(students, x.student_id); if (!s || !inScope(s.id, s.class_id, s.kind)) return;
      (byStu[s.id] = byStu[s.id] || { s: s, items: [] }).items.push(esc(x.title) + ' <b>(LOST' + (x.note && x.note !== 'Lost' ? ': ' + esc(x.note) : '') + ')</b>');
    });
    var owing = Object.keys(byStu).map(function (k) { return byStu[k]; }).sort(function (a, b) { return a.s.name.localeCompare(b.s.name); });
    $('clrBody').innerHTML = owing.length ? '<p class="muted">Printed ' + fmt(now) + '</p>' + table(['Name', 'Adm no', 'Class', 'Still to settle'], owing.map(function (o) {
      return tr([esc(o.s.name), esc(o.s.adm), esc(placeOf(o.s)), o.items.join('<br>')]);
    })) : '<p class="muted">Everyone in this selection is clear.</p>';

    $('topBody').innerHTML = reports.top.length ? table(['#', 'Book', 'Times borrowed'], reports.top.map(function (b, i) {
      return tr([i + 1, esc(b.title) + ' <span class="muted">' + esc(b.author) + '</span>', b.n]);
    })) : '<p class="muted">No borrowing yet.</p>';

    $('lostBody').innerHTML = reports.lost.length ? table(['Book', 'Borrower', 'Reported', 'Note', ''], reports.lost.map(function (x) {
      return tr([esc(x.title), esc(x.student) + ' <span class="muted">' + esc(x.class) + '</span>', fmt(x.lost), esc(x.note), '<button class="ghost" data-found="' + x.id + '">Mark found</button>']);
    })) : '<p class="muted">No lost or damaged books.</p>';
  }
  // Search boxes redraw while typing only. (Redrawing again when the box loses focus swallowed the next button click.)
  ['q', 'sq'].forEach(function (id) { $(id).addEventListener('input', render); });
  ['genre', 'onlyAvail', 'sclass', 'showArch', 'clrClass'].forEach(function (id) { $(id).addEventListener('change', render); });

  /* ---------- lending ---------- */
  function pick() {
    var q = $('stuQ').value.toLowerCase(), pool = students.filter(function (s) { return !s.archived; });
    var l = pool.filter(function (s) { return !q || (s.name + ' ' + s.adm + ' ' + s.class).toLowerCase().indexOf(q) > -1; }).slice(0, 8);
    $('stuPick').innerHTML = !pool.length ? '<li class="empty">No students yet. Add or import students first.</li>' :
      l.length ? l.map(function (s) {
        var full = s.active >= limitFor(s);
        return '<li><button type="button" class="ghost" data-pick="' + s.id + '"' + (full ? ' disabled' : '') + '><span>' + esc(s.name) + (s.kind === 'staff' ? ' (staff)' : '') + '</span><span class="muted">' + (full ? 'at limit (' + s.active + ')' : esc(s.adm) + ' &middot; ' + esc(placeOf(s))) + '</span></button></li>';
      }).join('') : '<li class="empty">No one matches.</li>';
  }
  $('stuQ').addEventListener('input', pick);
  $('lendCancel').addEventListener('click', function () { $('lendDlg').close(); });

  /* ---------- edit book / edit student / history dialogs ---------- */
  function openBook(b) {
    editBookId = b.id;
    $('bdTitle').value = b.title; $('bdAuthor').value = b.author; $('bdYear').value = b.year || ''; $('bdCopies').value = b.copies;
    $('bdClass').innerHTML = options(classes); $('bdClass').value = b.class_id; catOptions($('bdCat'), b.class_id); $('bdCat').value = b.category_id;
    $('bookDlg').showModal();
  }
  $('bookForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('PUT', '/api/books/' + editBookId, { title: $('bdTitle').value, author: $('bdAuthor').value, categoryId: +$('bdCat').value, year: +$('bdYear').value || 0, copies: +$('bdCopies').value })
      .then(function () { $('bookDlg').close(); return done('Book updated.')(); }).catch(function (err) { toast(err.message); if (err.status === 401) fail(err); });
  });
  function openStu(s, mode) {
    stuMode = mode; stuId = s.id;
    $('sdTitle').textContent = mode === 'restore' ? 'Restore ' + s.name : 'Edit ' + s.name;
    $('sdName').value = s.name; $('sdAdm').value = s.adm; $('sdKind').value = s.kind;
    $('sdClass').innerHTML = '<option value="">No class</option>' + options(classes); $('sdClass').value = s.class_id || '';
    $('stuDlg').showModal();
  }
  $('stuEditForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { name: $('sdName').value, classId: $('sdClass').value ? +$('sdClass').value : null, kind: $('sdKind').value };
    var req = stuMode === 'restore' ? api('POST', '/api/students/' + stuId + '/restore', body) : api('PUT', '/api/students/' + stuId, body);
    req.then(function () { $('stuDlg').close(); return done(stuMode === 'restore' ? 'Restored.' : 'Saved.')(); }).catch(function (err) { toast(err.message); if (err.status === 401) fail(err); });
  });
  function openHist(title, query) {
    $('histTitle').textContent = title; $('histList').innerHTML = '<li class="muted">Loading...</li>'; $('histDlg').showModal();
    api('GET', '/api/history?' + query).then(function (rows) {
      $('histList').innerHTML = rows.length ? rows.map(function (r) {
        var status = r.lost ? 'LOST ' + fmt(r.lost) + (r.note ? ' (' + esc(r.note) + ')' : '') : r.returned ? 'Returned ' + fmt(r.returned) : 'Still out, due ' + fmt(r.due);
        return '<li><b>' + esc(r.title) + ' \u2014 ' + esc(r.student) + '</b><span class="muted">Borrowed ' + fmt(r.borrowed) + ' &middot; ' + status + (r.renewals ? ' &middot; renewed ' + r.renewals + '\u00d7' : '') + '</span></li>';
      }).join('') : '<li class="muted">Nothing borrowed yet.</li>';
    }).catch(function (err) { $('histDlg').close(); fail(err); });
  }

  /* ---------- move everyone up a class ---------- */
  function guessNext(c) {
    var m = c.name.match(/^(.*?)(\d+)(\D*)$/); if (!m) return null;
    var target = (m[1] + (+m[2] + 1) + m[3]).toLowerCase();
    return classes.filter(function (x) { return x.name.toLowerCase() === target; })[0] || null;
  }
  $('promoteBtn').addEventListener('click', function () {
    var withStudents = classes.filter(function (c) { return c.students > 0; });
    if (!withStudents.length) return toast('There are no students in any class yet.');
    $('promoList').innerHTML = withStudents.map(function (c) {
      var next = guessNext(c);
      var opts = '<option value="stay">Stays in ' + esc(c.name) + '</option>' +
        classes.filter(function (x) { return x.id !== c.id; }).map(function (x) { return '<option value="' + x.id + '"' + (next && next.id === x.id ? ' selected' : '') + '>Moves to ' + esc(x.name) + '</option>'; }).join('') +
        '<option value="leave">Leaves the school (archive)</option>';
      return '<li><span><b>' + esc(c.name) + '</b> <span class="muted">' + c.students + ' students</span></span><select data-from="' + c.id + '" aria-label="Where ' + esc(c.name) + ' goes">' + opts + '</select></li>';
    }).join('');
    $('promoDlg').showModal();
  });
  $('promoCancel').addEventListener('click', function () { $('promoDlg').close(); });
  $('promoGo').addEventListener('click', function () {
    var moves = [], leaving = 0;
    document.querySelectorAll('#promoList select').forEach(function (s) {
      if (s.value === 'stay') return;
      var c = byId(classes, s.dataset.from);
      if (s.value === 'leave') leaving += c.students;
      moves.push({ from: +s.dataset.from, to: s.value === 'leave' ? null : +s.value });
    });
    if (!moves.length) return $('promoDlg').close();
    if (leaving && !confirm(leaving + ' students will be archived because they leave the school. Their history is kept. Continue?')) return;
    api('POST', '/api/classes/promote', { moves: moves }).then(function (r) {
      $('promoDlg').close(); toast('Moved ' + r.moved + ' students up' + (r.left ? ' and archived ' + r.left + ' who left' : '') + '. A backup was saved first.'); return refresh();
    }).catch(function (e) { toast(e.message); if (e.status === 401) fail(e); });
  });

  /* ---------- Excel / CSV import (students and books) ---------- */
  function splitCsv(l) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < l.length; i++) {
      var ch = l[i];
      if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  }
  function parseRows(text, headerWord) {
    var rows = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).map(function (l) {
      return (l.indexOf('\t') > -1 ? l.split('\t') : splitCsv(l)).map(function (c) { return c.trim(); });
    });
    if (rows.length && headerWord.test(rows[0].join(' '))) rows.shift();      // skip a header row
    return rows;
  }
  function wireFile(fileId, textId) {
    $(fileId).addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader(); r.onload = function () { $(textId).value = r.result; }; r.readAsText(f);
    });
  }
  wireFile('impFile', 'impText'); wireFile('bimpFile', 'bimpText');
  function importMsg(r, what) {
    return 'Added ' + r.added + (r.skipped ? ', skipped ' + r.skipped + ' already in the system' : '') + (r.bad ? ', ' + r.bad + ' rows were missing ' + what : '') + '.';
  }
  $('impBtn').addEventListener('click', function () {
    var rows = parseRows($('impText').value, /name/i).map(function (r) { return { adm: r[0], name: r[1], class: r[2] || '', type: r[3] || '' }; });
    if (!rows.length) return toast('Paste your list first.');
    api('POST', '/api/students/import', { rows: rows }).then(function (r) { $('impText').value = ''; $('impFile').value = ''; toast(importMsg(r, 'an admission number or name')); return refresh(); }).catch(fail);
  });
  $('bimpBtn').addEventListener('click', function () {
    var rows = parseRows($('bimpText').value, /title/i).map(function (r) { return { title: r[0], author: r[1], class: r[2] || '', category: r[3] || '', year: r[4], copies: r[5] }; });
    if (!rows.length) return toast('Paste your book list first.');
    api('POST', '/api/books/import', { rows: rows }).then(function (r) { $('bimpText').value = ''; $('bimpFile').value = ''; toast(importMsg(r, 'a title or author')); return refresh(); }).catch(fail);
  });

  /* ---------- clicks ---------- */
  document.addEventListener('keydown', function (e) {
    var li = e.target.closest && e.target.closest('li[data-cls]');
    if (li && e.key === 'Enter') li.click();
  });
  function printCard(id) {
    var c = $(id); c.classList.add('pr-on'); document.body.classList.add('pr');
    var clean = function () { c.classList.remove('pr-on'); document.body.classList.remove('pr'); window.removeEventListener('afterprint', clean); };
    window.addEventListener('afterprint', clean); window.print();
  }
  document.addEventListener('click', function (e) {
    var t = e.target, el, d;
    if ((el = t.closest('[data-view]'))) return show(el.dataset.view);
    if ((el = t.closest('[data-close]'))) return $(el.dataset.close).close();
    if ((el = t.closest('li[data-cls]'))) { $('fclass').value = el.dataset.cls; catOptions($('genre'), el.dataset.cls, 'All categories'); show('catalog'); return; }
    if ((el = t.closest('button')) && (d = el.dataset)) {
      if (d.lend) { lendBook = byId(books, d.lend); $('lendTitle').textContent = 'Lend "' + lendBook.title + '"'; $('stuQ').value = ''; pick(); $('lendDlg').showModal(); $('stuQ').focus(); }
      else if (d.pick) {
        api('POST', '/api/loans', { bookId: lendBook.id, studentId: +d.pick }).then(function (r) {
          $('lendDlg').close(); toast('Lent to ' + r.student + '. Due ' + fmt(r.due) + '.'); return refresh();
        }).catch(function (err) { toast(err.message); if (err.status === 401) fail(err); else refresh(); });
      }
      else if (d.return) api('POST', '/api/loans/' + d.return + '/return').then(done('Book returned.')).catch(fail);
      else if (d.renew) api('POST', '/api/loans/' + d.renew + '/renew').then(function (r) { toast('Renewed. New due date: ' + fmt(r.due) + '.'); return refresh(); }).catch(fail);
      else if (d.lost) {
        var note = prompt('Mark this book as lost or damaged. Add a short note (optional):', 'Lost');
        if (note !== null) api('POST', '/api/loans/' + d.lost + '/lost', { note: note }).then(done('Marked as lost. It no longer counts against the borrower\'s limit.')).catch(fail);
      }
      else if (d.found) api('POST', '/api/loans/' + d.found + '/found').then(done('Marked as found and returned.')).catch(fail);
      else if (d.edbook) openBook(byId(books, d.edbook));
      else if (d.histbook) openHist('History: ' + byId(books, d.histbook).title, 'bookId=' + d.histbook);
      else if (d.histstu) openHist('History: ' + byId(students, d.histstu).name, 'studentId=' + d.histstu);
      else if (d.delbook) { var b = byId(books, d.delbook); if (confirm('Remove "' + b.title + '" from the catalogue? Its history is deleted too.')) api('DELETE', '/api/books/' + d.delbook).then(done('Book removed.')).catch(fail); }
      else if (d.editstu) openStu(byId(students, d.editstu), 'edit');
      else if (d.restore) openStu(byId(students, d.restore), 'restore');
      else if (d.archstu) { var s = byId(students, d.archstu); if (confirm('Archive ' + s.name + '? They will be hidden from lists but their history is kept.')) api('POST', '/api/students/' + s.id + '/archive').then(done('Archived.')).catch(fail); }
      else if (d.delstu) { var s2 = byId(students, d.delstu); if (confirm('Permanently delete ' + s2.name + ' and their borrowing history? This cannot be undone.')) api('DELETE', '/api/students/' + s2.id).then(done('Deleted.')).catch(fail); }
      else if (d.selcls) { selClass = +d.selcls; render(); }
      else if (d.delcls) { var cl = byId(classes, d.delcls); if (confirm('Remove the class "' + cl.name + '" and its categories?')) api('DELETE', '/api/classes/' + cl.id).then(done('Class removed.')).catch(fail); }
      else if (d.delcat) { var ct = byId(cats, d.delcat); if (confirm('Remove the category "' + ct.name + '"?')) api('DELETE', '/api/categories/' + ct.id).then(done('Category removed.')).catch(fail); }
      else if (d.print) printCard(d.print);
      else if (el.id === 'backupNow') api('POST', '/api/backup').then(done('Backup saved in the backups folder.')).catch(fail);
      else if (el.id === 'exportStu') download('students.csv', [['Admission no', 'Name', 'Class', 'Type']].concat(students.filter(function (s) { return !s.archived; }).map(function (s) { return [s.adm, s.name, s.class, s.kind]; })));
      else if (el.id === 'exportLoans') download('loans.csv', [['Book', 'Borrower', 'Admission no', 'Class', 'Borrowed', 'Due']].concat(loans.map(function (l) {
        var b = byId(books, l.book_id); return [b ? b.title : '', l.student, l.adm, l.class, fmt(l.borrowed), fmt(l.due)]; })));
    }
  });

  /* ---------- forms ---------- */
  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault(); var form = e.target, f = new FormData(form);
    api('POST', '/api/books', { title: f.get('title'), author: f.get('author'), categoryId: +$('bookCat').value, year: +f.get('year'), copies: +f.get('copies') })
      .then(function () { form.reset(); return done('Book added to the catalogue.')(); }).catch(fail);
  });
  $('stuForm').addEventListener('submit', function (e) {
    e.preventDefault(); var form = e.target, f = new FormData(form);
    api('POST', '/api/students', { adm: f.get('adm'), name: f.get('name'), classId: $('stuClass').value ? +$('stuClass').value : null, kind: $('stuKind').value })
      .then(function () { form.reset(); return done('Added.')(); }).catch(fail);
  });
  $('clsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', '/api/classes', { name: $('clsName').value }).then(function (r) { selClass = r.id; $('clsName').value = ''; return done('Class added. Now add its categories on the right.')(); }).catch(fail);
  });
  $('catForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', '/api/categories', { classId: selClass, name: $('catName').value }).then(function () { $('catName').value = ''; return done('Category added.')(); }).catch(fail);
  });
  $('rulesForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {}; ['maxLoans', 'loanDays', 'staffMaxLoans', 'staffLoanDays', 'maxRenewals'].forEach(function (k) { body[k] = +$(k).value; });
    api('POST', '/api/settings', body).then(done('Lending rules saved.')).catch(fail);
  });
  $('pwForm').addEventListener('submit', function (e) {
    e.preventDefault(); var form = e.target, f = new FormData(form);
    api('POST', '/api/password', { old: f.get('old'), next: f.get('next') }).then(function () { form.reset(); toast('Password changed.'); }).catch(fail);
  });

  /* ---------- start ---------- */
  api('GET', '/api/me').then(function (u) { if (u) login(u); }).catch(function () {});
})();
