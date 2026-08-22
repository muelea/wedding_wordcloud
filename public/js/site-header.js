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
})();
