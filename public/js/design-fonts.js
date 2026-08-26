(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DesignFonts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DEFAULT_FONT_KEY = 'classic';
  const FONTS = Object.freeze([
    Object.freeze({
      key: DEFAULT_FONT_KEY,
      label: 'Klassisch',
      description: 'Zeitlos und vertraut',
      family: 'Georgia',
      cssFamily: 'Georgia, "Times New Roman", "Apple Color Emoji", "Segoe UI Emoji", serif',
      svgFamily: "Georgia, 'Times New Roman', 'Apple Color Emoji', 'Segoe UI Emoji', serif",
      file: null,
    }),
    Object.freeze({
      key: 'lora',
      label: 'Lora',
      description: 'Elegant und warm',
      family: 'Wolkenworte Lora',
      cssFamily: '"Wolkenworte Lora", Georgia, serif',
      svgFamily: "'Wolkenworte Lora', Georgia, serif",
      file: '/assets/design-fonts/lora/Lora.ttf',
    }),
    Object.freeze({
      key: 'montserrat',
      label: 'Montserrat',
      description: 'Modern und klar',
      family: 'Wolkenworte Montserrat',
      cssFamily: '"Wolkenworte Montserrat", Arial, sans-serif',
      svgFamily: "'Wolkenworte Montserrat', Arial, sans-serif",
      file: '/assets/design-fonts/montserrat/Montserrat.ttf',
    }),
    Object.freeze({
      key: 'caveat',
      label: 'Caveat',
      description: 'Persönlich und handschriftlich',
      family: 'Wolkenworte Caveat',
      cssFamily: '"Wolkenworte Caveat", cursive',
      svgFamily: "'Wolkenworte Caveat', cursive",
      file: '/assets/design-fonts/caveat/Caveat.ttf',
    }),
    Object.freeze({
      key: 'baloo-2',
      label: 'Baloo 2',
      description: 'Weich und verspielt',
      family: 'Wolkenworte Baloo 2',
      cssFamily: '"Wolkenworte Baloo 2", sans-serif',
      svgFamily: "'Wolkenworte Baloo 2', sans-serif",
      file: '/assets/design-fonts/baloo-2/Baloo2.ttf',
    }),
  ]);
  const FONT_BY_KEY = new Map(FONTS.map((font) => [font.key, font]));

  function has(key) {
    return typeof key === 'string' && FONT_BY_KEY.has(key);
  }

  function get(key) {
    return FONT_BY_KEY.get(key) || FONT_BY_KEY.get(DEFAULT_FONT_KEY);
  }

  function normalizeKey(key) {
    return has(key) ? key : DEFAULT_FONT_KEY;
  }

  function cssFamily(key) {
    return get(key).cssFamily;
  }

  function svgFamily(key) {
    return get(key).svgFamily;
  }

  return Object.freeze({
    DEFAULT_FONT_KEY,
    FONTS,
    has,
    get,
    normalizeKey,
    cssFamily,
    svgFamily,
  });
});
