/* ============================================================
   SWEET FLYPAPER — SHARED JAVASCRIPT
   Runs on every page. Loads nav + footer and scroll reveal.
   ============================================================ */
 
async function loadGlobals() {
  const [navData, footerData] = await Promise.all([
    fetch('/nav.html').then(r => r.text()),
    fetch('/footer.html').then(r => r.text())
  ]);
  
  const navPlaceholder = document.getElementById('nav-placeholder');
  const footerPlaceholder = document.getElementById('footer-placeholder');
  
  if (navPlaceholder) navPlaceholder.innerHTML = navData;
  if (footerPlaceholder) footerPlaceholder.innerHTML = footerData;
  
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
