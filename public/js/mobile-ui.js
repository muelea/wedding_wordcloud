'use strict';

(function initializeMobileViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;

  function synchronizeViewport() {
    const height = viewport?.height || window.innerHeight;
    const offsetTop = viewport?.offsetTop || 0;
    const keyboardInset = viewport
      ? Math.max(0, window.innerHeight - height - offsetTop)
      : 0;

    root.style.setProperty('--ww-visual-viewport-height', `${height}px`);
    root.style.setProperty('--ww-keyboard-inset', `${keyboardInset}px`);
  }

  synchronizeViewport();
  window.addEventListener('resize', synchronizeViewport, { passive: true });
  window.addEventListener('orientationchange', synchronizeViewport, { passive: true });
  viewport?.addEventListener('resize', synchronizeViewport, { passive: true });
  viewport?.addEventListener('scroll', synchronizeViewport, { passive: true });
})();
