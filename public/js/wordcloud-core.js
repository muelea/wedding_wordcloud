/**
 * Shared rectangular word-cloud packing and text geometry.
 * Live displays and product designs use their own available dimensions;
 * saved print output retains the editor's exact geometry.
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
  const ITALIC_SKEW_DEGREES = -12;
  const EMOJI_LENGTH_PENALTY = .92;

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

  function textStyle(options = {}) {
    return {
      fontWeight: Number(options.fontWeight) === 700 ? 700 : 400,
      fontStyle: options.fontStyle === 'italic' ? 'italic' : 'normal',
      underline: options.underline === true,
      linethrough: options.linethrough === true,
    };
  }

  function canvasFont(fontPx, fontFamily, options = {}) {
    return `${textStyle(options).fontWeight} ${fontPx}px ${fontFamily}`;
  }

  function isEmojiOnly(text) {
    const runs = EmojiCatalog?.parse?.(String(text || '')) || [];
    return runs.length > 0 && runs.every((run) => run.type === 'emoji');
  }

  function hasTextRun(text) {
    const runs = EmojiCatalog?.parse?.(String(text || '')) || [];
    return runs.some((run) => run.type === 'text' && run.text.trim());
  }

  function richTextRuns(text, fontPx, measureCtx, fontFamily = FONT_FAMILY, options = {}) {
    const size = Number(fontPx);
    if (!Number.isFinite(size) || size <= 0 || !measureCtx ||
        typeof measureCtx.measureText !== 'function') {
      throw new TypeError('A positive font size and a canvas measurement context are required');
    }
    measureCtx.font = canvasFont(size, fontFamily, options);
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

  function measureTextBox(text, fontPx, measureCtx, fontFamily = FONT_FAMILY, options = {}) {
    const size = Number(fontPx);
    const runs = richTextRuns(text, size, measureCtx, fontFamily, options);
    return {
      width: Math.max(1, runs.reduce((sum, run) => sum + run.width, 0)),
      height: Math.max(1, size * TEXT_LINE_HEIGHT),
      runs,
    };
  }

  function styledTextBox(box, options = {}) {
    const style = textStyle(options);
    return {
      width: box.width + (style.fontStyle === 'italic'
        ? box.height * Math.abs(Math.tan(ITALIC_SKEW_DEGREES * Math.PI / 180))
        : 0),
      height: box.height,
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
    const style = textStyle(options);
    const box = options.box || measureTextBox(text, fontPx, ctx, fontFamily, style);
    const startX = -box.width / 2;
    const emojiSize = fontPx * EMOJI_SIZE_RATIO;
    ctx.save();
    ctx.translate(x, y);
    if (style.fontStyle === 'italic') {
      ctx.transform(1, 0, Math.tan(ITALIC_SKEW_DEGREES * Math.PI / 180), 1, 0, 0);
    }
    ctx.font = canvasFont(fontPx, fontFamily, style);
    ctx.fillStyle = options.color || '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const run of box.runs) {
      const runX = startX + run.x;
      if (run.type === 'emoji') {
        const image = options.emojiImage?.(run) || EmojiCatalog?.getLoadedImage?.(run);
        drawContainedImage(ctx, image, runX, -emojiSize / 2, run.width, emojiSize);
      } else {
        ctx.fillText(run.text, runX, fontPx * TEXT_BASELINE_OFFSET);
        if (style.underline || style.linethrough) {
          ctx.strokeStyle = options.color || '#000000';
          ctx.lineWidth = Math.max(1, fontPx * .055);
          ctx.lineCap = 'butt';
          for (const lineY of [
            ...(style.underline ? [fontPx * .48] : []),
            ...(style.linethrough ? [fontPx * .03] : []),
          ]) {
            ctx.beginPath();
            ctx.moveTo(runX, lineY);
            ctx.lineTo(runX + run.width, lineY);
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
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
    // A single emoji is one grapheme but visually closer to a short word.
    // Treating it as length 1 made every count-1 emoji one of the largest
    // items, so several emoji were inevitably packed together at the centre.
    if (isEmojiOnly(word)) return EMOJI_LENGTH_PENALTY;
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

  function assignRotations(items) {
    let textIndex = 0;
    for (const item of items) {
      if (isEmojiOnly(item.word)) {
        item.rotated = false;
      } else {
        item.rotated = textIndex % ROTATE_EVERY_N === ROTATE_EVERY_N - 1;
        textIndex += 1;
      }
    }
  }

  // The legacy square entry point shares the complete rectangular layout.
  function layoutWords(words, side, measureCtx, colorFn) {
    return layoutWordsInArea(words, side, side, measureCtx, colorFn);
  }

  // Deterministic free-rectangle packing. Every candidate is inside the actual
  // rectangular print/display area, including its corners. Text, icons and
  // images use measured, rotated boxes and one common size multiplier.
  function layoutBoxesInArea(boxes, width, height) {
    if (!Array.isArray(boxes) || !boxes.length || !Number.isFinite(width) ||
        !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    if (boxes.some(box => ![box.width, box.height, box.priority].every(Number.isFinite) ||
        box.width <= 0 || box.height <= 0 || box.priority <= 0)) return [];
    const sized = boxes.map((box, index) => ({ ...box, index }))
      .sort((a, b) => b.priority - a.priority || a.index - b.index);
    const minSide = Math.min(width, height);
    const padding = minSide * Math.min(.007, .055 / Math.sqrt(sized.length));
    const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
    const contains = (a, b) => a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2;

    function tryScale(scale) {
      let free = [{ x1: 0, y1: 0, x2: width, y2: height }];
      const placed = [];
      for (const item of sized) {
        const w = item.width * scale + padding * 2;
        const h = item.height * scale + padding * 2;
        let best = null;
        let score = Infinity;
        for (const space of free) {
          const dw = space.x2 - space.x1 - w;
          const dh = space.y2 - space.y1 - h;
          if (dw < 0 || dh < 0) continue;
          // Keep the dominant word central. Subsequent words choose the best
          // fitting free rectangle; ties favour the centre, not a fixed corner.
          const x = clamp((width - w) / 2, space.x1, space.x2 - w);
          const y = clamp((height - h) / 2, space.y1, space.y2 - h);
          const distance = Math.abs((x + w / 2) / width - .5) +
            Math.abs((y + h / 2) / height - .5);
          const candidateScore = Math.min(dw / width, dh / height) +
            Math.max(dw / width, dh / height) * .05 + distance * .001;
          if (candidateScore < score) {
            score = candidateScore;
            best = { x1: x, y1: y, x2: x + w, y2: y + h };
          }
        }
        if (!best) return null;
        placed.push({ ...item, x: (best.x1 + best.x2) / 2,
          y: (best.y1 + best.y2) / 2, scale });
        const next = [];
        for (const space of free) {
          if (!overlaps(space, best)) { next.push(space); continue; }
          if (best.x1 > space.x1) next.push({ ...space, x2: best.x1 });
          if (best.x2 < space.x2) next.push({ ...space, x1: best.x2 });
          if (best.y1 > space.y1) next.push({ ...space, y2: best.y1 });
          if (best.y2 < space.y2) next.push({ ...space, y1: best.y2 });
        }
        // Split rectangles may overlap, but never intersect a placed item.
        // Remove contained duplicates to keep the search bounded in practice.
        free = next.filter((space, index) => !next.some((other, otherIndex) =>
          otherIndex !== index && contains(other, space) &&
          (!contains(space, other) || otherIndex < index)));
      }
      return placed;
    }

    let low = 0;
    let high = Math.min(...sized.map(item => Math.min(
      (width - padding * 2) / item.width, (height - padding * 2) / item.height
    )));
    // A complete grid is the deterministic fallback, including extreme word
    // lengths/aspect ratios. Partial layouts are never returned.
    const maxWidth = Math.max(...sized.map(item => item.width));
    const maxHeight = Math.max(...sized.map(item => item.height));
    let gridScale = 0;
    let columns = 1;
    for (let cols = 1; cols <= sized.length; cols++) {
      const rows = Math.ceil(sized.length / cols);
      const scale = Math.min((width / cols - padding * 2) / maxWidth,
        (height / rows - padding * 2) / maxHeight);
      if (scale > gridScale) { gridScale = scale; columns = cols; }
    }
    const rows = Math.ceil(sized.length / columns);
    const fallback = sized.map((item, index) => ({ ...item, scale: gridScale,
      x: (index % columns + .5) * width / columns,
      y: (Math.floor(index / columns) + .5) * height / rows }));
    let best = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const scale = (low + high) / 2;
      const candidate = tryScale(scale);
      if (candidate) {
        best = candidate;
        low = scale;
      } else high = scale;
    }
    return fitAreaBoxes(best || fallback, width, height).sort((a, b) => a.index - b.index);
  }

  function areaBounds(items, horizontalScale = 1) {
    return items.reduce((bounds, item) => ({
      x1: Math.min(bounds.x1, item.x * horizontalScale - item.width * item.scale / 2),
      x2: Math.max(bounds.x2, item.x * horizontalScale + item.width * item.scale / 2),
      y1: Math.min(bounds.y1, item.y - item.height * item.scale / 2),
      y2: Math.max(bounds.y2, item.y + item.height * item.scale / 2),
    }), { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity });
  }

  // Mean occupied box area in the four outer quarters. Unlike overall bounds,
  // this detects an ellipse that only touches the middle of each edge.
  function cornerCoverage(boxes, width, height) {
    let area = 0;
    for (const x of [0, width * .75]) {
      for (const y of [0, height * .75]) {
        for (const box of boxes) {
          area += Math.max(0, Math.min(x + width * .25, box.x2) - Math.max(x, box.x1)) *
            Math.max(0, Math.min(y + height * .25, box.y2) - Math.max(y, box.y1));
        }
      }
    }
    return area / (width * height * .25);
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

  function measureWords(words, measureCtx, colorFn) {
    if (!Array.isArray(words) || !words.length) return [];
    const getColor = colorFn || makeColorAssigner('pastel');
    const counts = words.map(([, count]) => count);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const sized = words.map(([word, count]) => ({ word,
      fontPx: 1000 * sizeForCount(word, count, minCount, maxCount, .24, 1),
    })).sort((a, b) => b.fontPx - a.fontPx);
    assignRotations(sized);
    const boxes = sized.map((item) => {
      const rotated = item.rotated;
      const textBox = measureTextBox(item.word, item.fontPx, measureCtx);
      return { ...item, rotated, textBox, color: getColor(item.word), priority: item.fontPx,
        width: rotated ? textBox.height : textBox.width,
        height: rotated ? textBox.width : textBox.height };
    });
    return boxes;
  }

  function finalizeWords(boxes) {
    return boxes.map(item => ({ ...item,
      fontPx: item.fontPx * item.scale,
      textBox: scaleTextBox(item.textBox, item.scale),
    }));
  }

  function layoutWordsInArea(words, width, height, measureCtx, colorFn) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    return finalizeWords(layoutBoxesInArea(measureWords(words, measureCtx, colorFn), width, height));
  }

  function escapeXML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function richTextSvg(text, x, y, fontPx, color, fontFamily, textBox, options = {}) {
    const style = textStyle(options);
    const box = textBox || {
      width: 1,
      runs: [{ type: 'text', text: String(text || ''), x: 0, width: 1 }],
    };
    const startX = x - box.width / 2;
    const contents = box.runs.map((run, index) => {
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
      const decorations = [
        ...(style.underline ? [fontPx * .48] : []),
        ...(style.linethrough ? [fontPx * .03] : []),
      ].map((offset) => `<line x1="${runX.toFixed(1)}" y1="${(y + offset).toFixed(1)}" ` +
        `x2="${(runX + run.width).toFixed(1)}" y2="${(y + offset).toFixed(1)}" ` +
        `stroke="${color}" stroke-width="${Math.max(1, fontPx * .055).toFixed(1)}"/>`).join('\n  ');
      const node = `<text x="${runX.toFixed(1)}" y="${(y + fontPx * TEXT_BASELINE_OFFSET).toFixed(1)}" ` +
        `font-size="${fontPx.toFixed(1)}" font-family="${fontFamily}" ` +
        `font-weight="${style.fontWeight}" fill="${color}" text-anchor="start">${escapeXML(run.text)}</text>`;
      return decorations ? `${node}\n  ${decorations}` : node;
    }).join('\n  ');
    if (style.fontStyle !== 'italic') return contents;
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) ` +
      `skewX(${ITALIC_SKEW_DEGREES}) translate(${(-x).toFixed(1)} ${(-y).toFixed(1)})">${contents}</g>`;
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
    ITALIC_SKEW_DEGREES,
    THEMES,
    makePaletteAssigner,
    makeColorAssigner,
    getFontSizeRange,
    sizeForCount,
    isEmojiOnly,
    hasTextRun,
    textStyle,
    richTextRuns,
    measureTextBox,
    styledTextBox,
    drawRichText,
    drawPlacedWord,
    richTextSvg,
    layoutWords,
    layoutWordsInArea,
    measureWords,
    finalizeWords,
    layoutBoxesInArea,
    cornerCoverage,
    buildSVG,
    escapeXML,
  };
});
