/**
 * Shared spiral + collision-detection word-cloud layout engine.
 *
 * Ported unchanged (algorithmically) from the original prototype's
 * display.html. This is the one piece of the prototype explicitly called
 * out as a real strength: the same layoutWords()/buildSVG() functions
 * drive both the live on-screen canvas render and the print-ready SVG
 * export, so the two are always visually identical by construction.
 *
 * Loaded two ways:
 *   - In the browser via <script src="/js/wordcloud-core.js"></script>,
 *     exposing `window.WordCloudCore`.
 *   - In Node (tests, and potentially a future server-side export) via
 *     require('./wordcloud-core.js').
 *
 * Pure/stateless: unlike the prototype's display.html (which kept a
 * module-level `wordColors` Map), color assignment is passed in as a
 * `colorFn(word)` callback so this module has no hidden state and is
 * safe to reuse across concurrent events on the server.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.WordCloudCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FONT_FAMILY = 'Georgia, "Times New Roman", "Apple Color Emoji", "Segoe UI Emoji", serif';
  // Same font list, but with single quotes — FONT_FAMILY's double quotes
  // would prematurely close the SVG's font-family="..." XML attribute.
  const SVG_FONT_FAMILY = "Georgia, 'Times New Roman', 'Apple Color Emoji', 'Segoe UI Emoji', serif";

  const THEMES = {
    pastel: {
      colors: [
        '#9c1c4c', '#d1607e', '#c1922f', '#400f26',
        '#b9436a', '#a67a3f', '#7c1f42', '#e0899e',
        '#8a7178', '#d9a84e',
      ],
    },
    neon: {
      colors: [
        '#ff10f0', '#00fff2', '#bf00ff', '#39ff14',
        '#ffea00', '#ff073a', '#0aff99', '#ff6ec7',
        '#00b3ff', '#ff9500',
      ],
    },
  };

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function makePaletteAssigner(colors) {
    const palette = Array.isArray(colors) && colors.length ? colors : THEMES.pastel.colors;
    const assigned = new Map();
    return function getWordColor(word) {
      if (!assigned.has(word)) {
        assigned.set(word, palette[assigned.size % palette.length]);
      }
      return assigned.get(word);
    };
  }

  function makeColorAssigner(theme) {
    return makePaletteAssigner((THEMES[theme] || THEMES.pastel).colors);
  }

  // Scale font sizes to the available area per word so a crowded cloud
  // shrinks to fit and a sparse one grows to fill the square nicely.
  function getFontSizeRange(words, side) {
    const density = Math.sqrt((side * side) / words.length);
    const maxPx = clamp(density * 0.85, side * 0.05, side * 0.30);
    // Floor is a % of side (not a fixed px) so it stays readable at both the
    // on-screen size (~700px) and the much larger SVG export canvas (2000px).
    const minPx = clamp(maxPx * 0.24, side * 0.022, maxPx * 0.5);
    return { minPx, maxPx };
  }

  // Longer words are scaled down a bit relative to short ones of the same
  // frequency, so a single long word can't dominate/overflow the square.
  function lengthPenalty(word) {
    return clamp(1 - Math.max(0, word.length - 5) * 0.018, 0.6, 1);
  }

  // Only 4 distinct sizes. Ratio is measured against a floored spread, not
  // the raw max — otherwise a word jumped straight to the biggest tier the
  // moment it equaled a still-tiny current max (e.g. after just its 2nd
  // submission). Flooring the spread means a word needs a real lead over
  // the rest, not just one extra vote early on, before it reads as "big".
  const SIZE_TIERS = [0.3, 0.5, 0.72, 1];
  const MIN_TIER_SPREAD = 6;

  function sizeForCount(word, count, minCount, maxCount, minPx, maxPx) {
    let tierRatio;
    if (maxCount === minCount) {
      tierRatio = 0.6; // no variation yet — keep everything one pleasant size
    } else {
      const spread = Math.max(maxCount - minCount, MIN_TIER_SPREAD);
      const ratio = clamp((count - minCount) / spread, 0, 1);
      const tierIndex = Math.min(SIZE_TIERS.length - 1, Math.floor(ratio * SIZE_TIERS.length));
      tierRatio = SIZE_TIERS[tierIndex];
    }
    const base = minPx + tierRatio * (maxPx - minPx);
    return Math.max(minPx, base * lengthPenalty(word));
  }

  // Exactly 1 in 5 words rotated (20%) — a per-word probability (e.g. a
  // hash-based coin flip) can easily land near 50/50 by chance with the
  // small word counts typical of an event like this, so rotation is
  // assigned by rank in the sorted list instead, which is exact regardless
  // of how many words there are. Also spreads rotated words evenly across
  // the size spectrum rather than clustering them at one end.
  const ROTATE_EVERY_N = 5;

  // Shared spiral+collision layout used by both the live canvas and the SVG
  // export, so the two are always identical by construction — and retries
  // at a smaller size instead of ever dropping a word that doesn't fit.
  //
  // `measureCtx` must provide `.font` (settable) and `.measureText(str)`
  // returning `{ width }` — a real CanvasRenderingContext2D in the browser,
  // or a stub with the same shape in tests.
  // `colorFn(word)` returns a CSS color string for a word (see
  // makeColorAssigner above for the default browser/export behavior).
  function layoutWords(words, side, measureCtx, colorFn) {
    const getColor = colorFn || makeColorAssigner('pastel');
    const counts = words.map(([, c]) => c);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);
    const { minPx, maxPx } = getFontSizeRange(words, side);

    const sized = words
      .map(([word, count]) => ({ word, fontPx: sizeForCount(word, count, minCount, maxCount, minPx, maxPx) }))
      .sort((a, b) => b.fontPx - a.fontPx);

    sized.forEach((item, i) => { item.rotated = (i % ROTATE_EVERY_N === ROTATE_EVERY_N - 1); });

    const placed = [];
    const cx = side / 2, cy = side / 2;
    const maxRadius = side * 0.72;
    const steps = 2000;

    for (const item of sized) {
      let fontPx = item.fontPx;
      let spot = null;

      for (let attempt = 0; attempt < 8 && !spot; attempt++) {
        measureCtx.font = `${fontPx}px ${FONT_FAMILY}`;
        const textHalf = measureCtx.measureText(item.word).width / 2 + side * 0.004;
        const fontHalf = fontPx / 2 + side * 0.004;
        // Rotated words occupy a footprint with width/height swapped.
        const halfW = item.rotated ? fontHalf : textHalf;
        const halfH = item.rotated ? textHalf : fontHalf;

        for (let t = 0; t < steps; t++) {
          const angle = 0.3 * t;
          const radius = (maxRadius / Math.sqrt(steps)) * Math.sqrt(t);
          const x = cx + radius * Math.cos(angle);
          const y = cy + radius * Math.sin(angle);
          const box = { x1: x - halfW, x2: x + halfW, y1: y - halfH, y2: y + halfH };
          if (box.x1 < 0 || box.y1 < 0 || box.x2 > side || box.y2 > side) continue;
          const collides = placed.some((p) =>
            !(box.x2 < p.x1 || box.x1 > p.x2 || box.y2 < p.y1 || box.y1 > p.y2));
          if (!collides) { spot = { x, y, halfW, halfH }; break; }
        }
        if (!spot) fontPx *= 0.82; // didn't fit at this size — shrink and retry
      }
      if (!spot) continue; // extremely unlikely after 8 shrink attempts

      placed.push({
        word: item.word, fontPx, rotated: item.rotated, x: spot.x, y: spot.y,
        x1: spot.x - spot.halfW, x2: spot.x + spot.halfW,
        y1: spot.y - spot.halfH, y2: spot.y + spot.halfH,
        color: getColor(item.word),
      });
    }
    return placed;
  }

  function escapeXML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildSVG(placed, side, theme) {
    let defs = '', bg;
    if (theme === 'neon') {
      bg = `<rect width="${side}" height="${side}" fill="#000000"/>`;
    } else {
      defs = `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="60%" y2="100%">` +
        `<stop offset="0%" stop-color="#eef6f4"/><stop offset="100%" stop-color="#ddeee9"/>` +
        `</linearGradient></defs>`;
      bg = `<rect width="${side}" height="${side}" fill="url(#bg)"/>`;
    }
    const texts = placed.map((p) => {
      const rotate = p.rotated ? ` transform="rotate(-90 ${p.x.toFixed(1)} ${p.y.toFixed(1)})"` : '';
      return `<text x="${p.x.toFixed(1)}" y="${(p.y + p.fontPx * 0.34).toFixed(1)}" ` +
        `font-size="${p.fontPx.toFixed(1)}" font-family="${SVG_FONT_FAMILY}" ` +
        `fill="${p.color}" text-anchor="middle"${rotate}>${escapeXML(p.word)}</text>`;
    }).join('\n  ');

    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">\n` +
      `  ${defs}\n  ${bg}\n  ${texts}\n</svg>`;
  }

  return {
    FONT_FAMILY,
    SVG_FONT_FAMILY,
    THEMES,
    makePaletteAssigner,
    makeColorAssigner,
    getFontSizeRange,
    sizeForCount,
    layoutWords,
    buildSVG,
    escapeXML,
  };
});
