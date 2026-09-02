(function () {
  'use strict';

  var headers = document.querySelectorAll('.ww-site-header');
  if (!headers.length) return;

  function setLabel(element, source) {
    if (window.WolkenworteI18n?.setAttribute) {
      window.WolkenworteI18n.setAttribute(element, 'aria-label', source);
    } else {
      element.setAttribute('aria-label', source);
    }
  }

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
      setLabel(toggle, 'Seitennavigation öffnen');
    }

    toggle.addEventListener('click', function () {
      var isOpen = header.classList.toggle('landing-menu-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      setLabel(toggle, isOpen ? 'Seitennavigation schließen' : 'Seitennavigation öffnen');
    });
    menu.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });
  });
})();
