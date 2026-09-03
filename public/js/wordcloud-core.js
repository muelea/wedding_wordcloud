/**
 * Shared spiral + collision-detection word-cloud layout engine.
 *
 * Ported unchanged (algorithmically) from the original prototype's
 * display.ejs. This is the one piece of the prototype explicitly called
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
 * Pure/stateless: unlike the prototype's display page (which kept a
 * module-level `wordColors` Map), color assignment is passed in as a
 * `colorFn(word)` callback so this module has no hidden state and is
 * safe to reuse across concurrent events on the server.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./emoji-catalog.js'));
  } else {
    root.WordCloudCore = factory(root.WolkenworteEmoji);
  }
})(typeof self !== 'undefined' ? self : this, function (EmojiCatalog) {
  'use strict';

  const FONT_FAMILY = '"Wolkenworte Classic", Georgia, "Times New Roman", serif';
  // Same font list, but with single quotes — FONT_FAMILY's double quotes
  // would prematurely close the SVG's font-family="..." XML attribute.
  const SVG_FONT_FAMILY = "'Wolkenworte Classic', Georgia, 'Times New Roman', serif";
  // One product-design text geometry contract for browser packing, the
  // editor boundary guard, canvas previews and the immutable SVG renderer.
  // Fabric's centred IText line box is slightly taller than the nominal font
  // size, while Canvas/SVG use an alphabetic baseline.
  const TEXT_LINE_HEIGHT = 1.18;
  const TEXT_BASELINE_OFFSET = 0.34;
  const EMOJI_SIZE_RATIO = 1;

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

  function richTextRuns(text, fontPx, measureCtx, fontFamily = FONT_FAMILY) {
    const size = Number(fontPx);
    if (!Number.isFinite(size) || size <= 0 || !measureCtx ||
        typeof measureCtx.measureText !== 'function') {
      throw new TypeError('A positive font size and a canvas measurement context are required');
    }
    measureCtx.font = `${size}px ${fontFamily}`;
    const sourceRuns = EmojiCatalog?.parse
      ? EmojiCatalog.parse(String(text || ''))
      : [{ type: 'text', text: String(text || '') }];
    let cursor = 0;
    return sourceRuns.map((run) => {
      const width = run.type === 'emoji'
        ? size * EMOJI_SIZE_RATIO
        : Math.max(0, Number(measureCtx.measureText(run.text).width) || 0);
      const measured = { ...run, x: cursor, width };
      cursor += width;
      return measured;
    });
  }

  function measureTextBox(text, fontPx, measureCtx, fontFamily = FONT_FAMILY) {
    const size = Number(fontPx);
    const runs = richTextRuns(text, size, measureCtx, fontFamily);
    return {
      width: Math.max(1, runs.reduce((sum, run) => sum + run.width, 0)),
      height: Math.max(1, size * TEXT_LINE_HEIGHT),
      runs,
    };
  }

  function scaleTextBox(box, scale) {
    return {
      width: box.width * scale,
      height: box.height * scale,
      runs: box.runs.map((run) => ({ ...run, x: run.x * scale, width: run.width * scale })),
    };
  }

  function drawContainedImage(ctx, image, x, y, width, height) {
    if (!image) return;
    const sourceWidth = image.naturalWidth || image.width || width;
    const sourceHeight = image.naturalHeight || image.height || height;
    const scale = Math.min(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    ctx.drawImage(
      image,
      x + (width - drawWidth) / 2,
      y + (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
  }

  function drawRichText(ctx, text, x, y, fontPx, options = {}) {
    const fontFamily = options.fontFamily || FONT_FAMILY;
    const box = options.box || measureTextBox(text, fontPx, ctx, fontFamily);
    const startX = x - box.width / 2;
    const emojiSize = fontPx * EMOJI_SIZE_RATIO;
    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.fillStyle = options.color || '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const run of box.runs) {
      const runX = startX + run.x;
      if (run.type === 'emoji') {
        const image = options.emojiImage?.(run) || EmojiCatalog?.getLoadedImage?.(run);
        drawContainedImage(ctx, image, runX, y - emojiSize / 2, run.width, emojiSize);
      } else {
        ctx.fillText(run.text, runX, y + fontPx * TEXT_BASELINE_OFFSET);
      }
    }
    return box;
  }

  function drawPlacedWord(ctx, placed, options = {}) {
    ctx.save();
    if (placed.rotated) {
      ctx.translate(placed.x, placed.y);
      ctx.rotate(-Math.PI / 2);
      drawRichText(ctx, placed.word, 0, 0, placed.fontPx, {
        ...options,
        color: placed.color,
        box: placed.textBox,
      });
    } else {
      drawRichText(ctx, placed.word, placed.x, placed.y, placed.fontPx, {
        ...options,
        color: placed.color,
        box: placed.textBox,
      });
    }
    ctx.restore();
  }

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
    const length = EmojiCatalog?.graphemeLength
      ? EmojiCatalog.graphemeLength(word)
      : String(word || '').length;
    return clamp(1 - Math.max(0, length - 5) * 0.018, 0.6, 1);
  }

  // Frequency affects size smoothly and absolutely rather than in relative
  // tiers. This avoids two surprising behaviors: a second vote no longer
  // jumps straight to the maximum merely because it is the current leader,
  // and removing one contribution always makes that word measurably smaller
  // without causing unrelated words to resize. The curve rises quickly at
  // event-sized counts and then eases towards the maximum.
  function sizeForCount(word, count, minCount, maxCount, minPx, maxPx) {
    const safeCount = Math.max(1, Number(count) || 1);
    const frequencyRatio = 0.32 + 0.68 * (1 - Math.exp(-(safeCount - 1) / 8));
    const base = minPx + frequencyRatio * (maxPx - minPx);
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
        const textBox = measureTextBox(item.word, fontPx, measureCtx);
        const textHalf = textBox.width / 2 + side * 0.004;
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
          if (!collides) { spot = { x, y, halfW, halfH, textBox }; break; }
        }
        if (!spot) fontPx *= 0.82; // didn't fit at this size — shrink and retry
      }
      if (!spot) continue; // extremely unlikely after 8 shrink attempts

      placed.push({
        word: item.word, fontPx, rotated: item.rotated, x: spot.x, y: spot.y,
        x1: spot.x - spot.halfW, x2: spot.x + spot.halfW,
        y1: spot.y - spot.halfH, y2: spot.y + spot.halfH,
        color: getColor(item.word),
        textBox: spot.textBox,
      });
    }
    return placed;
  }

  // One deterministic rectangular packer for both the initial cloud and the
  // current editor design. Callers measure their own text/image/icon boxes
  // once; all sizes then share one multiplier (no font or aspect-ratio drift).
  function layoutBoxesInArea(boxes, width, height) {
    if (!Array.isArray(boxes) || !boxes.length || !Number.isFinite(width) ||
        !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    if (boxes.some(box => ![box.width, box.height, box.priority].every(Number.isFinite) ||
        box.width <= 0 || box.height <= 0 || box.priority <= 0)) return [];
    const sized = boxes.map((box, index) => ({ ...box, index }))
      .sort((a, b) => b.priority - a.priority || a.index - b.index);
    const minSide = Math.min(width, height);
    // A fixed percentage would spend most of a dense cloud's space on gaps.
    const collisionPadding = Math.max(2, minSide * Math.min(.01, .1 / Math.sqrt(sized.length)));
    const steps = Math.max(3200, Math.min(9000, 1200 + sized.length * 140));
    const spiral = Array.from({ length: steps }, (_, step) => {
      const radius = Math.sqrt(step / (steps - 1));
      return { x: radius * Math.cos(step * .37), y: radius * Math.sin(step * .37) };
    });

    function tryScale(items, scale) {
      const placed = [];
      const cx = width / 2;
      const cy = height / 2;
      // Spatial buckets keep dense clouds from checking every prior box at
      // every spiral point. This changes only lookup cost, not placements.
      const cellSize = minSide / Math.sqrt(items.length);
      const columns = Math.ceil(width / cellSize);
      const rows = Math.ceil(height / cellSize);
      const cells = new Array(columns * rows);
      const cellsFor = box => ({
        x1: Math.max(0, Math.floor(box.x1 / cellSize)),
        x2: Math.min(columns - 1, Math.floor(box.x2 / cellSize)),
        y1: Math.max(0, Math.floor(box.y1 / cellSize)),
        y2: Math.min(rows - 1, Math.floor(box.y2 / cellSize)),
      });
      const collides = box => {
        const range = cellsFor(box);
        for (let y = range.y1; y <= range.y2; y++) {
          for (let x = range.x1; x <= range.x2; x++) {
            if (cells[y * columns + x]?.some(other => !(box.x2 < other.x1 ||
                box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2))) return true;
          }
        }
        return false;
      };
      for (const item of items) {
        const halfW = item.width * scale / 2 + collisionPadding;
        const halfH = item.height * scale / 2 + collisionPadding;
        const maxX = width / 2 - halfW;
        const maxY = height / 2 - halfH;
        if (maxX < 0 || maxY < 0) return null;
        let spot = null;
        for (const point of spiral) {
          const x = cx + maxX * point.x;
          const y = cy + maxY * point.y;
          const box = { x1: x - halfW, x2: x + halfW, y1: y - halfH, y2: y + halfH };
          if (!collides(box)) {
            spot = { ...item, x, y, scale, ...box };
            break;
          }
        }
        if (!spot) return null;
        placed.push(spot);
        const range = cellsFor(spot);
        for (let y = range.y1; y <= range.y2; y++) {
          for (let x = range.x1; x <= range.x2; x++) {
            (cells[y * columns + x] ||= []).push(spot);
          }
        }
      }
      return placed;
    }

    function search(items) {
      let best = null;
      let low = 0;
      let high = Math.min(...items.map(item => Math.min(
        (width - collisionPadding * 2) / item.width,
        (height - collisionPadding * 2) / item.height
      )));
      for (let attempt = 0; attempt < 14; attempt++) {
        const scale = (low + high) / 2;
        const candidate = tryScale(items, scale);
        if (candidate) { best = candidate; low = scale; }
        else high = scale;
      }
      return best && fitAreaBoxes(best, width, height);
    }

    // Keep the original font-size-first spiral as the baseline. In wide print
    // areas, also try tall elements last so they can flank the horizontal words
    // instead of splitting them in the middle. Adopt only a larger result.
    let best = search(sized);
    if (width > height * 1.25 && sized.length <= 80) {
      const uprightFirst = [...sized].sort((a, b) =>
        Number(a.height > a.width * 1.5) - Number(b.height > b.width * 1.5) ||
        b.priority - a.priority || a.index - b.index);
      if (uprightFirst.some((item, index) => item.index !== sized[index].index)) {
        const candidate = search(uprightFirst);
        if (candidate && (!best || candidate[0].scale > best[0].scale * 1.005)) best = candidate;
      }
    }
    return best ? best.sort((a, b) => a.index - b.index) : [];
  }

  function areaBounds(items, horizontalScale = 1) {
    return items.reduce((bounds, item) => ({
      x1: Math.min(bounds.x1, item.x * horizontalScale - item.width * item.scale / 2),
      x2: Math.max(bounds.x2, item.x * horizontalScale + item.width * item.scale / 2),
      y1: Math.min(bounds.y1, item.y - item.height * item.scale / 2),
      y2: Math.max(bounds.y2, item.y + item.height * item.scale / 2),
    }), { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity });
  }

  function fitAreaBoxes(items, width, height) {
    const inset = Math.min(width, height) * .012;
    const bounds = areaBounds(items);
    const fitScale = Math.min((width - inset * 2) / (bounds.x2 - bounds.x1),
      (height - inset * 2) / (bounds.y2 - bounds.y1));
    const fitted = items.map(item => ({ ...item,
      x: (item.x - (bounds.x1 + bounds.x2) / 2) * fitScale,
      y: (item.y - (bounds.y1 + bounds.y2) / 2) * fitScale,
      scale: item.scale * fitScale,
    }));
    // Widen centre spacing, never the artwork. Check the entire envelope: an
    // interior word can be wider than the leftmost/rightmost centre's word.
    const span = Math.max(...fitted.map(item => item.x)) - Math.min(...fitted.map(item => item.x));
    let low = 1;
    let high = span > 0 ? Math.max(1, (width - inset * 2) / span) : 1;
    for (let attempt = 0; attempt < 18; attempt++) {
      const scale = (low + high) / 2;
      const expanded = areaBounds(fitted, scale);
      if (expanded.x2 - expanded.x1 <= width - inset * 2) low = scale;
      else high = scale;
    }
    const expanded = areaBounds(fitted, low);
    const centerX = (expanded.x1 + expanded.x2) / 2;
    return fitted.map(item => {
      const x = width / 2 + item.x * low - centerX;
      const y = height / 2 + item.y;
      return { ...item, x, y,
        x1: x - item.width * item.scale / 2, x2: x + item.width * item.scale / 2,
        y1: y - item.height * item.scale / 2, y2: y + item.height * item.scale / 2 };
    });
  }

  function layoutWordsInArea(words, width, height, measureCtx, colorFn) {
    if (!Array.isArray(words) || !words.length || width <= 0 || height <= 0) return [];
    const getColor = colorFn || makeColorAssigner('pastel');
    const counts = words.map(([, count]) => count);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const sized = words.map(([word, count]) => ({ word,
      fontPx: 1000 * sizeForCount(word, count, minCount, maxCount, .24, 1),
    })).sort((a, b) => b.fontPx - a.fontPx);
    const boxes = sized.map((item, index) => {
      const rotated = index % ROTATE_EVERY_N === ROTATE_EVERY_N - 1;
      const textBox = measureTextBox(item.word, item.fontPx, measureCtx);
      return { ...item, rotated, textBox, color: getColor(item.word), priority: item.fontPx,
        width: rotated ? textBox.height : textBox.width,
        height: rotated ? textBox.width : textBox.height };
    });
    return layoutBoxesInArea(boxes, width, height).map(item => ({ ...item,
      fontPx: item.fontPx * item.scale,
      textBox: scaleTextBox(item.textBox, item.scale),
    }));
  }

  function escapeXML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function richTextSvg(text, x, y, fontPx, color, fontFamily, textBox, options = {}) {
    const box = textBox || {
      width: 1,
      runs: [{ type: 'text', text: String(text || ''), x: 0, width: 1 }],
    };
    const startX = x - box.width / 2;
    return box.runs.map((run, index) => {
      const runX = startX + run.x;
      if (run.type === 'emoji') {
        const geometry = {
          x: runX,
          y: y - fontPx * EMOJI_SIZE_RATIO / 2,
          width: run.width,
          height: fontPx * EMOJI_SIZE_RATIO,
          id: `emoji-${index}`,
        };
        if (typeof options.emojiSvg === 'function') return options.emojiSvg(run, geometry);
        const href = EmojiCatalog?.assetUrl?.(run) || '';
        return `<image data-emoji="${run.key}" x="${geometry.x.toFixed(1)}" y="${geometry.y.toFixed(1)}" ` +
          `width="${geometry.width.toFixed(1)}" height="${geometry.height.toFixed(1)}" ` +
          `preserveAspectRatio="xMidYMid meet" href="${escapeXML(href)}"/>`;
      }
      return `<text x="${runX.toFixed(1)}" y="${(y + fontPx * TEXT_BASELINE_OFFSET).toFixed(1)}" ` +
        `font-size="${fontPx.toFixed(1)}" font-family="${fontFamily}" ` +
        `fill="${color}" text-anchor="start">${escapeXML(run.text)}</text>`;
    }).join('\n  ');
  }

  function buildSVG(placed, side, theme, options = {}) {
    let defs = '', bg;
    if (theme === 'neon') {
      bg = `<rect width="${side}" height="${side}" fill="#000000"/>`;
    } else {
      defs = `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="60%" y2="100%">` +
        `<stop offset="0%" stop-color="#eef6f4"/><stop offset="100%" stop-color="#ddeee9"/>` +
        `</linearGradient></defs>`;
      bg = `<rect width="${side}" height="${side}" fill="url(#bg)"/>`;
    }
    const texts = placed.map((p, placedIndex) => {
      const contents = richTextSvg(
        p.word,
        p.x,
        p.y,
        p.fontPx,
        p.color,
        SVG_FONT_FAMILY,
        p.textBox,
        {
          ...options,
          emojiSvg: typeof options.emojiSvg === 'function'
            ? (run, geometry) => options.emojiSvg(run, { ...geometry, id: `word-${placedIndex}-${geometry.id}` })
            : null,
        }
      );
      return p.rotated
        ? `<g transform="rotate(-90 ${p.x.toFixed(1)} ${p.y.toFixed(1)})">${contents}</g>`
        : contents;
    }).join('\n  ');

    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">\n` +
      `  ${defs}\n  ${bg}\n  ${texts}\n</svg>`;
  }

  return {
    FONT_FAMILY,
    SVG_FONT_FAMILY,
    TEXT_LINE_HEIGHT,
    TEXT_BASELINE_OFFSET,
    EMOJI_SIZE_RATIO,
    THEMES,
    makePaletteAssigner,
    makeColorAssigner,
    getFontSizeRange,
    sizeForCount,
    richTextRuns,
    measureTextBox,
    drawRichText,
    drawPlacedWord,
    richTextSvg,
    layoutWords,
    layoutWordsInArea,
    layoutBoxesInArea,
    buildSVG,
    escapeXML,
  };
});
