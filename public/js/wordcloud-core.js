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
    const emojiCount = sized.filter(item => item.emoji).length;
    const emojiSpacing = Math.min(.4, .9 / Math.sqrt(Math.max(1, emojiCount)));
    const emojiAnchors = [[.2, .2], [.8, .8], [.8, .2], [.2, .8]];
    const dominant = sized.length === 1 || sized[0].priority > sized[1].priority * 1.05;

    function tryScale(scale, order = sized, variant = 0) {
      let free = [{ x1: 0, y1: 0, x2: width, y2: height }];
      const placed = [];
      const placedEmoji = [];
      for (const item of order) {
        const w = item.width * scale + padding * 2;
        const h = item.height * scale + padding * 2;
        let best = null;
        let score = Infinity;
        const anchor = placed.length % 4;
        const emojiAnchor = emojiAnchors[placedEmoji.length % 4];
        const scatterEmoji = placed.length && item.emoji && variant === 3;
        for (const space of free) {
          const dw = space.x2 - space.x1 - w;
          const dh = space.y2 - space.y1 - h;
          if (dw < 0 || dh < 0) continue;
          // Keep the dominant word central. Subsequent words choose the best
          // fitting free rectangle; ties favour the centre, not a fixed corner.
          const targetX = scatterEmoji ? width * emojiAnchor[0] - w / 2
            : (!placed.length && dominant) || !variant ? (width - w) / 2
            : variant === 1 ? (space.x1 + space.x2 - w) / 2
              : space.x1;
          const targetY = scatterEmoji ? height * emojiAnchor[1] - h / 2
            : (!placed.length && dominant) || !variant ? (height - h) / 2
            : variant === 1 ? (space.y1 + space.y2 - h) / 2
              : sized.length <= 10 || anchor < 2 ? space.y1 : space.y2 - h;
          const x = clamp(targetX, space.x1, space.x2 - w);
          const y = clamp(targetY, space.y1, space.y2 - h);
          const distance = Math.abs((x + w / 2) / width - .5) +
            Math.abs((y + h / 2) / height - .5);
          let separation = emojiSpacing;
          if (item.emoji) {
            for (const other of placedEmoji) separation = Math.min(separation,
              Math.hypot((x + w / 2 - other.x) / width, (y + h / 2 - other.y) / height));
          }
          const candidateScore = Math.min(dw / width, dh / height) +
            Math.max(dw / width, dh / height) * .05 + distance * .001 +
            (1 - separation / emojiSpacing) * .3;
          if (candidateScore < score) {
            score = candidateScore;
            best = { x1: x, y1: y, x2: x + w, y2: y + h };
          }
        }
        if (!best) return null;
        placed.push({ ...item, x: (best.x1 + best.x2) / 2,
          y: (best.y1 + best.y2) / 2, scale });
        if (item.emoji) placedEmoji.push(placed[placed.length - 1]);
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
    let result = fitAreaBoxes(best || fallback, width, height);
    const initialQuality = layoutQuality(result, width, height);
    let quality = initialQuality.score;
    const minimumScale = result[0].scale * .9;
    // Reuse the successful scale search. At most four alternative orders/anchors,
    // each with at most three fit attempts, bound the extra work even at 500
    // words. A clearly dominant contribution stays central; equally weighted
    // words can start at an edge when that fills the rectangle better.
    const balanced = isLayoutBalanced(initialQuality, sized.length);
    if (best && sized.length > 2 && !balanced) {
      const tail = sized.slice(1);
      const orders = [sized,
        [sized[0], ...tail.slice().sort((a, b) => b.width * b.height - a.width * a.height || a.index - b.index)],
        [sized[0], ...tail.slice().sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || a.index - b.index)]];
      if (emojiCount > 1) orders.push([sized[0], ...tail.filter(item => item.emoji),
        ...tail.filter(item => !item.emoji).sort((a, b) => b.width * b.height - a.width * a.height || a.index - b.index)]);
      orders.forEach((order, index) => {
        for (const ratio of [1, .94, .88]) {
          const candidate = tryScale(low * ratio, order, index === 0 ? 1 : index === 3 ? 3 : 2);
          if (!candidate) continue;
          const fitted = fitAreaBoxes(candidate, width, height);
          const candidateQuality = layoutQuality(fitted, width, height);
          const nextQuality = candidateQuality.score;
          if (fitted[0].scale >= minimumScale && nextQuality > quality + .001) {
            result = fitted;
            quality = nextQuality;
          }
          // A fitting arrangement may still contain a hole. Try the remaining
          // bounded scales unless this arrangement already meets the target.
          if (isLayoutBalanced(candidateQuality, sized.length)) break;
        }
      });
    }
    return result.sort((a, b) => a.index - b.index);
  }

  function areaBounds(items, horizontalScale = 1, verticalScale = 1) {
    return items.reduce((bounds, item) => ({
      x1: Math.min(bounds.x1, item.x * horizontalScale - item.width * item.scale / 2),
      x2: Math.max(bounds.x2, item.x * horizontalScale + item.width * item.scale / 2),
      y1: Math.min(bounds.y1, item.y * verticalScale - item.height * item.scale / 2),
      y2: Math.max(bounds.y2, item.y * verticalScale + item.height * item.scale / 2),
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

  function largestEmptyRegion(boxes, width, height) {
    // Mark intersecting cells conservatively, then find the largest empty
    // rectangle with a histogram sweep. Work is bounded by a fixed grid;
    // individual letters' counters and normal line spacing are not holes.
    const side = 64;
    const occupied = new Uint8Array(side * side);
    for (const box of boxes) {
      const left = clamp(Math.floor(box.x1 / width * side), 0, side);
      const right = clamp(Math.ceil(box.x2 / width * side), 0, side);
      const top = clamp(Math.floor(box.y1 / height * side), 0, side);
      const bottom = clamp(Math.ceil(box.y2 / height * side), 0, side);
      for (let row = top; row < bottom; row++) occupied.fill(1, row * side + left, row * side + right);
    }
    const heights = new Uint8Array(side);
    let largest = 0;
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        heights[col] = occupied[row * side + col] ? 0 : heights[col] + 1;
      }
      const stack = [];
      for (let col = 0; col <= side; col++) {
        const height = col === side ? 0 : heights[col];
        while (stack.length && heights[stack[stack.length - 1]] > height) {
          const previous = stack.pop();
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          largest = Math.max(largest, heights[previous] * (col - left));
        }
        stack.push(col);
      }
    }
    return largest / (side * side);
  }

  function isLayoutBalanced(quality, count) {
    return quality.emptyRegion <= (count <= 10 ? .08 : .025) &&
      (count <= 10 || Math.min(...quality.corners) >= .4) &&
      quality.worstRegion >= .45 && quality.separation >= .8;
  }

  function layoutQuality(boxes, width, height) {
    const sparse = boxes.length <= 10;
    if (sparse && boxes.length) {
      // A few words should form one centred composition. Judge its interior,
      // not the intentional outer margins left by proportional fitting.
      const left = Math.min(...boxes.map(box => box.x1));
      const top = Math.min(...boxes.map(box => box.y1));
      width = Math.max(...boxes.map(box => box.x2)) - left;
      height = Math.max(...boxes.map(box => box.y2)) - top;
      boxes = boxes.map(box => ({ ...box,
        x1: box.x1 - left, x2: box.x2 - left, y1: box.y1 - top, y2: box.y2 - top }));
    }
    // A fixed 4x4 occupancy grid measures each corner and all nine overlapping
    // quarter-area regions. A full opposite corner cannot conceal a bare one.
    const cells = Array(16).fill(0);
    let area = 0;
    for (const box of boxes) {
      area += (box.x2 - box.x1) * (box.y2 - box.y1);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          cells[row * 4 + col] += Math.max(0, Math.min((col + 1) * width / 4, box.x2) - Math.max(col * width / 4, box.x1)) *
            Math.max(0, Math.min((row + 1) * height / 4, box.y2) - Math.max(row * height / 4, box.y1)) / (width * height / 16);
        }
      }
    }
    const regions = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        regions.push((cells[row * 4 + col] + cells[row * 4 + col + 1] +
          cells[(row + 1) * 4 + col] + cells[(row + 1) * 4 + col + 1]) / 4);
      }
    }
    // Outer 25%-wide corner cells also catch smaller empty corner patches.
    const corners = [cells[0], cells[3], cells[12], cells[15]];
    const coverage = area / (width * height);
    const variance = cells.reduce((sum, cell) => sum + (cell - coverage) ** 2, 0) / 16;
    const emoji = boxes.filter(box => box.emoji);
    let separation = 1;
    if (emoji.length > 1) {
      const target = Math.min(.4, .9 / Math.sqrt(emoji.length));
      separation = emoji.reduce((sum, box, index) => {
        let nearest = 1;
        for (let other = 0; other < emoji.length; other++) {
          if (other === index) continue;
          nearest = Math.min(nearest, Math.hypot(
            (box.x1 + box.x2 - emoji[other].x1 - emoji[other].x2) / (2 * width),
            (box.y1 + box.y2 - emoji[other].y1 - emoji[other].y2) / (2 * height)));
        }
        return sum + Math.min(1, nearest / target);
      }, 0) / emoji.length;
    }
    const emptyRegion = largestEmptyRegion(boxes, width, height);
    return { coverage, corners, worstRegion: Math.min(...regions), separation, emptyRegion,
      score: coverage + Math.min(...corners) * (sparse ? .05 : .2) + Math.min(...regions) * .35 -
        Math.sqrt(variance) * .2 + separation * .12 - emptyRegion * 4 };
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
    // Expand centre spacing on both axes, never the artwork. Check the envelope: an
    // interior word can be wider than the leftmost/rightmost centre's word.
    // Sparse clouds keep their natural spacing and balanced outer margins.
    const spread = items.length > 10;
    const span = spread ? Math.max(...fitted.map(item => item.x)) - Math.min(...fitted.map(item => item.x)) : 0;
    let low = 1;
    let high = span > 0 ? Math.max(1, (width - inset * 2) / span) : 1;
    for (let attempt = 0; attempt < 18; attempt++) {
      const scale = (low + high) / 2;
      const expanded = areaBounds(fitted, scale);
      if (expanded.x2 - expanded.x1 <= width - inset * 2) low = scale;
      else high = scale;
    }
    const horizontalScale = low;
    const verticalSpan = spread ? Math.max(...fitted.map(item => item.y)) - Math.min(...fitted.map(item => item.y)) : 0;
    low = 1;
    high = verticalSpan > 0 ? Math.max(1, (height - inset * 2) / verticalSpan) : 1;
    for (let attempt = 0; attempt < 18; attempt++) {
      const scale = (low + high) / 2;
      const expanded = areaBounds(fitted, horizontalScale, scale);
      if (expanded.y2 - expanded.y1 <= height - inset * 2) low = scale;
      else high = scale;
    }
    const expanded = areaBounds(fitted, horizontalScale, low);
    const centerX = (expanded.x1 + expanded.x2) / 2;
    const centerY = (expanded.y1 + expanded.y2) / 2;
    return fitted.map(item => {
      const x = width / 2 + item.x * horizontalScale - centerX;
      const y = height / 2 + item.y * low - centerY;
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
      return { ...item, rotated, textBox, emoji: isEmojiOnly(item.word), color: getColor(item.word), priority: item.fontPx,
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
    layoutQuality,
    isLayoutBalanced,
    buildSVG,
    escapeXML,
  };
});
