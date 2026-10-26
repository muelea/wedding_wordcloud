(function () {
  'use strict';
  var hero = document.querySelector('main > .hero');
  var header = document.getElementById('site-header');
  if (!hero || !header) return;

  function update() {
    var rect = hero.getBoundingClientRect();
    var headerBounds = header.getBoundingClientRect();
    var headerBottom = headerBounds.bottom;
    document.documentElement.style.setProperty('--landing-header-height', headerBounds.height + 'px');
    header.classList.toggle('hero-visible', rect.bottom > headerBottom && rect.top < window.innerHeight);
  }

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  window.addEventListener('pageshow', update);
  if (window.ResizeObserver) new window.ResizeObserver(update).observe(header);
})();
