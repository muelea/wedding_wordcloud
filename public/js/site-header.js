(function () {
  'use strict';

  var headers = document.querySelectorAll('.ww-site-header');
  if (!headers.length) return;

  function updateHeaderState() {
    var scrolled = window.scrollY > 4;
    headers.forEach(function (header) {
      header.classList.toggle('scrolled', scrolled);
    });
  }

  updateHeaderState();
  window.addEventListener('scroll', updateHeaderState, { passive: true });

  document.querySelectorAll('.landing-menu-toggle').forEach(function (toggle) {
    var header = toggle.closest('.ww-site-header');
    var menu = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!header || !menu) return;

    function closeMenu() {
      header.classList.remove('landing-menu-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Seitennavigation öffnen');
    }

    toggle.addEventListener('click', function () {
      var isOpen = header.classList.toggle('landing-menu-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', isOpen ? 'Seitennavigation schließen' : 'Seitennavigation öffnen');
    });
    menu.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });
  });
})();
