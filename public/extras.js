// Optional extras. Wrapped so it can never clash with or break app.js.
(function () {
  try {
    var g = function (id) { return document.getElementById(id); };
    var fire = function (el) {
      if (!el) return;
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
    };
    var on = function (id, fn) { var el = g(id); if (el) el.addEventListener('click', fn); };

    on('showPw', function () {
      var p = g('p'), show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      g('showPw').textContent = show ? 'Hide' : 'Show';
    });
    on('qAvail', function () { g('onlyAvail').checked = true; fire(g('onlyAvail')); });
    on('qClear', function () {
      g('q').value = ''; g('onlyAvail').checked = false; g('genre').selectedIndex = 0;
      fire(g('q')); fire(g('onlyAvail')); fire(g('genre'));
    });
    on('qFocus', function () { g('q').focus(); });
    on('toTop', function () { window.scrollTo({top: 0, behavior: 'smooth'}); });
    document.querySelectorAll('.goCatalog').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = document.querySelector('nav [data-view="catalog"]'); if (n) n.click();
      });
    });
  } catch (e) { console.warn('extras.js:', e); }
})();
