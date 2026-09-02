(function (root) {
  'use strict';

  function applyVariables(palette, document = root.document) {
    if (!palette || !document?.documentElement) return;
    const style = document.documentElement.style;
    style.setProperty('--primary', palette.colors[0]);
    style.setProperty('--accent', palette.colors[4]);
    style.setProperty('--bg', palette.background[0]);
    style.setProperty('--bg2', palette.background[1]);
    style.setProperty('--rad1', palette.background[2]);
    style.setProperty('--rad2', palette.background[3]);
    document.documentElement.dataset.palette = palette.key;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = palette.background[0];
  }

  function restoredKey(storageKey, palettes, defaultKey) {
    try {
      const stored = root.localStorage?.getItem(storageKey);
      return palettes[stored] ? stored : defaultKey;
    } catch {
      return defaultKey;
    }
  }

  function restore(storageKey, palettes, defaultKey, document = root.document) {
    const key = restoredKey(storageKey, palettes, defaultKey);
    document?.documentElement?.classList.add('ww-theme-booting');
    applyVariables(palettes[key], document);
    return key;
  }

  function finishBoot(document = root.document) {
    root.requestAnimationFrame?.(() => root.requestAnimationFrame?.(() => {
      document?.documentElement?.classList.remove('ww-theme-booting');
    }));
  }

  root.WolkenworteTheme = Object.freeze({ applyVariables, finishBoot, restore, restoredKey });
})(typeof window !== 'undefined' ? window : globalThis);
