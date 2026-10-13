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

  document.querySelectorAll('[data-ww-site-menu]').forEach(function (menu) {
    var trigger = menu.querySelector('[data-ww-site-menu-trigger]');
    if (!trigger) return;

    function closeMenu(focus) {
      if (!menu.open) return;
      menu.querySelectorAll('[data-language-picker]').forEach(function (picker) {
        picker.open = false;
      });
      menu.open = false;
      if (focus) trigger.focus();
    }

    menu.addEventListener('toggle', function () {
      setLabel(trigger, menu.open ? 'Menü schließen' : 'Menü öffnen');
      trigger.setAttribute('aria-expanded', String(menu.open));
      if (menu.open) {
        var cloudSettings = document.getElementById('display-page-menu');
        if (cloudSettings) cloudSettings.open = false;
      } else {
        menu.querySelectorAll('[data-language-picker]').forEach(function (picker) { picker.open = false; });
      }
    });
    menu.querySelectorAll('a:not([data-language-code])').forEach(function (link) {
      link.addEventListener('click', function () { closeMenu(false); });
    });
    document.addEventListener('pointerdown', function (event) {
      if (menu.open && !menu.contains(event.target)) closeMenu(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !menu.open || document.querySelector('dialog[open]')) return;
      if (menu.querySelector('[data-language-picker][open]')) return;
      event.preventDefault();
      closeMenu(true);
    });
  });
})();
