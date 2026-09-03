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
      family: 'Wolkenworte Classic',
      cssFamily: '"Wolkenworte Classic", Georgia, "Times New Roman", serif',
      svgFamily: "'Wolkenworte Classic', Georgia, 'Times New Roman', serif",
      file: '/assets/design-fonts/gelasio/Gelasio.ttf',
      boldFile: '/assets/design-fonts/gelasio/Gelasio-Bold.ttf',
      format: 'truetype',
    }),
    Object.freeze({
      key: 'lora',
      label: 'Lora',
      description: 'Elegant und warm',
      family: 'Wolkenworte Lora',
      cssFamily: '"Wolkenworte Lora", Georgia, serif',
      svgFamily: "'Wolkenworte Lora', Georgia, serif",
      file: '/assets/design-fonts/lora/Lora.ttf',
      boldFile: '/assets/design-fonts/lora/Lora-Bold.ttf',
      format: 'truetype',
    }),
    Object.freeze({
      key: 'montserrat',
      label: 'Montserrat',
      description: 'Modern und klar',
      family: 'Wolkenworte Montserrat',
      cssFamily: '"Wolkenworte Montserrat", Arial, sans-serif',
      svgFamily: "'Wolkenworte Montserrat', Arial, sans-serif",
      file: '/assets/design-fonts/montserrat/Montserrat.ttf',
      boldFile: '/assets/design-fonts/montserrat/Montserrat-Bold.ttf',
      format: 'truetype',
    }),
    Object.freeze({
      key: 'caveat',
      label: 'Caveat',
      description: 'Persönlich und handschriftlich',
      family: 'Wolkenworte Caveat',
      cssFamily: '"Wolkenworte Caveat", cursive',
      svgFamily: "'Wolkenworte Caveat', cursive",
      file: '/assets/design-fonts/caveat/Caveat.ttf',
      boldFile: '/assets/design-fonts/caveat/Caveat-Bold.ttf',
      format: 'truetype',
    }),
    Object.freeze({
      key: 'baloo-2',
      label: 'Baloo 2',
      description: 'Weich und verspielt',
      family: 'Wolkenworte Baloo 2',
      cssFamily: '"Wolkenworte Baloo 2", sans-serif',
      svgFamily: "'Wolkenworte Baloo 2', sans-serif",
      file: '/assets/design-fonts/baloo-2/Baloo2.ttf',
      boldFile: '/assets/design-fonts/baloo-2/Baloo2-Bold.ttf',
      format: 'truetype',
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

  async function loadFont(key, fontSet, timeoutMs = 10000) {
    if (!fontSet || typeof fontSet.load !== 'function') throw new Error('design_font_unavailable');
    let timer;
    try {
      const faces = await Promise.race([
        Promise.all([
          fontSet.load(`400 16px "${get(key).family}"`, 'Wolkenworte'),
          fontSet.load(`700 16px "${get(key).family}"`, 'Wolkenworte'),
        ]).then((loaded) => loaded.flat()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('design_font_timeout')), timeoutMs);
        }),
      ]);
      // FontFaceSet.load also resolves successfully with [] when no @font-face
      // matches. That must not permit an OS fallback in a printable design.
      if (!faces?.length || faces.some(face => face.status !== 'loaded')) {
        throw new Error('design_font_unavailable');
      }
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    DEFAULT_FONT_KEY,
    FONTS,
    has,
    get,
    normalizeKey,
    cssFamily,
    svgFamily,
    loadFont,
  });
});
