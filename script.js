/* ============================================================
   SWEET FLYPAPER â€” SHARED JAVASCRIPT
   Runs on every page. Loads nav + footer and scroll reveal.
   ============================================================ */
 
async function loadGlobals() {
  const [navData, footerData] = await Promise.all([
    fetch('/nav.html?v=rental-nav-v12').then(r => r.text()),
    fetch('/footer.html?v=6').then(r => r.text())
  ]);
  
  const navPlaceholder = document.getElementById('nav-placeholder');
  const footerPlaceholder = document.getElementById('footer-placeholder');
  
  if (navPlaceholder) {
    navPlaceholder.innerHTML = navData;
    // Skip link lands on whatever follows the nav, so no page needs its own target.
    const main = navPlaceholder.nextElementSibling;
    const skip = navPlaceholder.querySelector('.sf-skip-link');
    if (main && skip) {
      if (!main.id) main.id = 'sf-main';
      main.tabIndex = -1;
      skip.href = '#' + main.id;
    }
  }
  if (footerPlaceholder) footerPlaceholder.innerHTML = footerData;
  window.SFCart.refresh();

  if (window.Tally) window.Tally.loadEmbeds();
}
 
function initScrollReveal() {
  const revealEls = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  revealEls.forEach(el => observer.observe(el));
}

loadGlobals().then(() => {
  initScrollReveal();
});

/* ============================================================
   CART: one shared cart for every shop page (items + dates).
   Stored in localStorage so it follows the renter between pages.
   checkout.html reads and writes the same key.
   ============================================================ */
window.SFCart = (function () {
  const KEY = 'sf_shop_cart';
  let mem = { qty: {}, s: '', e: '' };
  const clean = (c) => {
    const qty = {};
    Object.keys((c && c.qty) || {}).forEach((id) => { const n = Math.floor(Number(c.qty[id])); if (n > 0) qty[id] = Math.min(n, 20); });
    return { qty, s: (c && c.s) || '', e: (c && c.e) || '' };
  };
  const read = () => {
    try { const raw = localStorage.getItem(KEY); if (raw) return clean(JSON.parse(raw)); } catch (err) { /* private mode */ }
    return clean(mem);
  };
  const write = (c) => {
    mem = clean(c);
    try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (err) { /* private mode */ }
    window.dispatchEvent(new CustomEvent('sfcart'));
    return mem;
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const part = (iso) => ({ y: +iso.slice(0, 4), m: +iso.slice(5, 7) - 1, d: +iso.slice(8, 10) });
  const fmtDates = (s, e) => {
    if (!s || !e) return '';
    const a = part(s), b = part(e);
    if (a.y === b.y && a.m === b.m) return MONTHS[a.m] + ' ' + a.d + ' – ' + b.d;
    return MONTHS[a.m] + ' ' + a.d + ' – ' + MONTHS[b.m] + ' ' + b.d;
  };
  const todayDenver = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
  const nextDay = (iso) => new Date(Date.parse(iso + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  const count = () => Object.values(read().qty).reduce((a, b) => a + b, 0);

  function refresh() {
    const c = read(), n = count(), dates = fmtDates(c.s, c.e);
    document.querySelectorAll('.sf-nav-cart').forEach((a) => {
      const badge = a.querySelector('.sf-cart-count'), small = a.querySelector('.sf-cart-dates');
      if (badge) { badge.textContent = n; badge.hidden = !n; }
      if (small) {
        small.textContent = dates || (n ? 'Add dates' : '');
        small.hidden = !small.textContent;
      }
      a.setAttribute('aria-label', 'Cart, ' + n + (n === 1 ? ' item' : ' items') + (dates ? ', ' + dates : ''));
    });
  }
  window.addEventListener('sfcart', refresh);
  window.addEventListener('storage', (ev) => { if (ev.key === KEY) refresh(); });

  // Drop ids that are no longer in the catalog (old links, retired packages).
  fetch('/catalog.json').then((r) => r.json()).then((cat) => {
    const ok = new Set(); cat.groups.forEach((g) => g.items.forEach((i) => ok.add(i.id)));
    const c = read(), keep = {};
    let changed = false;
    Object.keys(c.qty).forEach((id) => { if (ok.has(id)) keep[id] = c.qty[id]; else changed = true; });
    if (changed) write({ qty: keep, s: c.s, e: c.e });
  }).catch(() => {});

  return {
    read, write, count, refresh, fmtDates, todayDenver, nextDay,
    has: (id) => !!read().qty[id],
    add(id, n) { const c = read(); c.qty[id] = Math.min(20, (c.qty[id] || 0) + (n || 1)); return write(c); },
    remove(id) { const c = read(); delete c.qty[id]; return write(c); },
    setDates(s, e) { const c = read(); c.s = s || ''; c.e = e || ''; return write(c); },
    clear() { return write({ qty: {}, s: '', e: '' }); }
  };
})();
