(function () {
  'use strict';
  var hero = document.querySelector('main > .hero');
  var header = document.getElementById('site-header');
  if (!hero || !header) return;

  function update() {
    var rect = hero.getBoundingClientRect();
    var headerBottom = header.getBoundingClientRect().bottom;
    header.classList.toggle('hero-visible', rect.bottom > headerBottom && rect.top < window.innerHeight);
  }

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  window.addEventListener('pageshow', update);
})();
