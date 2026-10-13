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

    menu.querySelectorAll('[data-ww-menu-picker]').forEach(function (picker) {
      var anchor = picker.querySelector('summary');
      var popup = picker.querySelector('[data-ww-menu-popup]');
      if (typeof popup?.showPopover !== 'function') return;
      popup.setAttribute('popover', 'manual');

      function placePopup() {
        if (!popup.matches(':popover-open')) return;
        var rect = anchor.getBoundingClientRect();
        var viewport = window.visualViewport;
        var left = (viewport?.offsetLeft || 0) + 8;
        var top = (viewport?.offsetTop || 0) + 8;
        var right = left + (viewport?.width || window.innerWidth) - 16;
        var bottom = top + (viewport?.height || window.innerHeight) - 16;
        var width = Math.min(Number(popup.dataset.popupWidth) || rect.width, right - left);
        var below = Math.max(0, bottom - rect.bottom - 8);
        var above = Math.max(0, rect.top - top - 8);
        popup.style.width = width + 'px';
        var opensAbove = below < popup.scrollHeight && above > below;
        popup.style.maxHeight = Math.min(bottom - top, opensAbove ? above : below) + 'px';
        popup.style.left = Math.max(left, Math.min(rect.right - width, right - width)) + 'px';
        var height = popup.getBoundingClientRect().height;
        popup.style.top = Math.max(top, Math.min(bottom - height, opensAbove ? rect.top - 8 - height : rect.bottom + 8)) + 'px';
      }

      picker.addEventListener('toggle', function () {
        if (picker.open && menu.open) {
          menu.querySelectorAll('[data-ww-menu-picker]').forEach(function (other) {
            if (other !== picker) other.open = false;
          });
          if (!popup.matches(':popover-open')) popup.showPopover();
          placePopup();
        } else if (popup.matches(':popover-open')) popup.hidePopover();
      });
      window.addEventListener('resize', placePopup);
      window.addEventListener('scroll', placePopup, true);
      window.visualViewport?.addEventListener('resize', placePopup);
      window.visualViewport?.addEventListener('scroll', placePopup);
    });

    function closeMenu(focus) {
      if (!menu.open) return;
      menu.querySelectorAll('details').forEach(function (picker) {
        picker.open = false;
      });
      menu.open = false;
      if (focus) trigger.focus();
    }

    menu.addEventListener('toggle', function () {
      setLabel(trigger, menu.open ? 'Menü schließen' : 'Menü öffnen');
      trigger.setAttribute('aria-expanded', String(menu.open));
      if (!menu.open) {
        menu.querySelectorAll('details').forEach(function (picker) { picker.open = false; });
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
      if (event.defaultPrevented || menu.querySelector('details[open]')) return;
      event.preventDefault();
      closeMenu(true);
    });
  });
})();
