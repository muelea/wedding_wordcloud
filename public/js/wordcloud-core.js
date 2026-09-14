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
    function getWordColor(word) {
      if (!assigned.has(word)) {
        assigned.set(word, palette[assigned.size % palette.length]);
      }
      return assigned.get(word);
    }
    // Keep the palette available to the shared post-layout color pass without
    // coupling the geometry engine to a particular product/theme catalog.
    getWordColor.palette = [...palette];
    return getWordColor;
  }

  function makeColorAssigner(theme) {
    return makePaletteAssigner((THEMES[theme] || THEMES.pastel).colors);
  }

  function colorKey(color) {
    return typeof color === 'string' ? color.trim().toLowerCase() : '';
  }

  function spatialColorNodes(items) {
    return items.map((item, index) => {
      if (!item || item.colorable === false || item.emoji === true) return null;
      const x1 = Number(item.x1);
      const x2 = Number(item.x2);
      const y1 = Number(item.y1);
      const y2 = Number(item.y2);
      if (![x1, x2, y1, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
      return {
        index,
        x1,
        x2,
        y1,
        y2,
        width: x2 - x1,
        height: y2 - y1,
        prominence: Math.sqrt((x2 - x1) * (y2 - y1)),
        preferred: colorKey(item.color),
        fixed: item.colorLocked === true && Boolean(colorKey(item.color)),
      };
    }).filter(Boolean);
  }

  function spatialColorDistance(first, second) {
    const dx = Math.max(0, first.x1 - second.x2, second.x1 - first.x2);
    const dy = Math.max(0, first.y1 - second.y2, second.y1 - first.y2);
    const localScale = Math.max(1,
      (Math.min(first.width, first.height) + Math.min(second.width, second.height)) / 2);
    return Math.hypot(dx, dy) / localScale;
  }

  // Recolor a finished layout instead of weakening its packing. A bounded
  // nearest-neighbour graph represents what people perceive as "next to";
  // deterministic graph coloring then avoids equal colors wherever the
  // available palette permits it. Explicit editor colors can be locked.
  function spreadPaletteColors(items, colors) {
    if (!Array.isArray(items)) return [];
    const result = items.map((item) => ({ ...item }));
    const palette = [];
    const paletteKeys = [];
    for (const color of Array.isArray(colors) ? colors : []) {
      const key = colorKey(color);
      if (!key || paletteKeys.includes(key)) continue;
      palette.push(color);
      paletteKeys.push(key);
    }
    if (!palette.length) return result;

    const nodes = spatialColorNodes(result);
    if (!nodes.length) return result;
    if (palette.length === 1) {
      nodes.forEach((node) => {
        if (!node.fixed) result[node.index].color = palette[0];
      });
      return result;
    }

    const adjacency = nodes.map(() => new Map());
    const neighbourCount = Math.min(8, nodes.length - 1);
    nodes.forEach((node, nodeIndex) => {
      const nearest = nodes.map((other, otherIndex) => ({
        otherIndex,
        distance: otherIndex === nodeIndex ? Infinity : spatialColorDistance(node, other),
      })).sort((a, b) => a.distance - b.distance || a.otherIndex - b.otherIndex)
        .slice(0, neighbourCount);
      for (const { otherIndex, distance } of nearest) {
        const weight = 1 / (.2 + distance);
        adjacency[nodeIndex].set(otherIndex,
          Math.max(adjacency[nodeIndex].get(otherIndex) || 0, weight));
        adjacency[otherIndex].set(nodeIndex,
          Math.max(adjacency[otherIndex].get(nodeIndex) || 0, weight));
      }
    });

    const assigned = new Array(nodes.length).fill('');
    const paletteCounts = new Array(palette.length).fill(0);
    const remaining = new Set();
    nodes.forEach((node, nodeIndex) => {
      if (node.fixed) {
        assigned[nodeIndex] = node.preferred;
        const paletteIndex = paletteKeys.indexOf(node.preferred);
        if (paletteIndex >= 0) paletteCounts[paletteIndex] += 1;
      } else {
        remaining.add(nodeIndex);
      }
    });

    function conflictCost(nodeIndex, candidate) {
      let cost = 0;
      for (const [otherIndex, weight] of adjacency[nodeIndex]) {
        if (assigned[otherIndex] === candidate) cost += weight;
      }
      return cost;
    }

    while (remaining.size) {
      let selected = -1;
      let selectedSaturation = -1;
      let selectedDegree = -1;
      let selectedProminence = -1;
      for (const nodeIndex of remaining) {
        const neighbourColors = new Set();
        let degree = 0;
        for (const [otherIndex, weight] of adjacency[nodeIndex]) {
          if (assigned[otherIndex]) neighbourColors.add(assigned[otherIndex]);
          degree += weight;
        }
        const node = nodes[nodeIndex];
        if (neighbourColors.size > selectedSaturation ||
            (neighbourColors.size === selectedSaturation && degree > selectedDegree) ||
            (neighbourColors.size === selectedSaturation && degree === selectedDegree &&
              node.prominence > selectedProminence) ||
            (neighbourColors.size === selectedSaturation && degree === selectedDegree &&
              node.prominence === selectedProminence && node.index < nodes[selected]?.index)) {
          selected = nodeIndex;
          selectedSaturation = neighbourColors.size;
          selectedDegree = degree;
          selectedProminence = node.prominence;
        }
      }

      const preferredIndex = paletteKeys.indexOf(nodes[selected].preferred);
      let chosen = 0;
      let chosenConflict = Infinity;
      let chosenPreference = Infinity;
      let chosenCount = Infinity;
      for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex += 1) {
        const conflict = conflictCost(selected, paletteKeys[paletteIndex]);
        const preference = paletteIndex === preferredIndex ? 0 : 1;
        const count = paletteCounts[paletteIndex];
        if (conflict < chosenConflict - 1e-9 ||
            (Math.abs(conflict - chosenConflict) <= 1e-9 && count < chosenCount) ||
            (Math.abs(conflict - chosenConflict) <= 1e-9 && count === chosenCount && preference < chosenPreference)) {
          chosen = paletteIndex;
          chosenConflict = conflict;
          chosenPreference = preference;
          chosenCount = count;
        }
      }
      assigned[selected] = paletteKeys[chosen];
      paletteCounts[chosen] += 1;
      remaining.delete(selected);
    }

    // A few strictly improving passes resolve avoidable conflicts introduced
    // by the greedy order without risking oscillation or unbounded work.
    for (let pass = 0; pass < 3; pass += 1) {
      let improved = false;
      nodes.forEach((node, nodeIndex) => {
        if (node.fixed) return;
        const currentIndex = paletteKeys.indexOf(assigned[nodeIndex]);
        let bestIndex = currentIndex;
        let bestCost = conflictCost(nodeIndex, assigned[nodeIndex]);
        for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex += 1) {
          const cost = conflictCost(nodeIndex, paletteKeys[paletteIndex]);
          if (cost < bestCost - 1e-9) {
            bestIndex = paletteIndex;
            bestCost = cost;
          }
        }
        if (bestIndex === currentIndex) return;
        paletteCounts[currentIndex] -= 1;
        paletteCounts[bestIndex] += 1;
        assigned[nodeIndex] = paletteKeys[bestIndex];
        improved = true;
      });
      if (!improved) break;
    }

    // Preserve the palette's even distribution whenever a no-worse color is
    // available. The bound also covers custom palettes with fixed colors.
    for (let pass = 0; pass < nodes.length; pass += 1) {
      let balanced = false;
      nodes.forEach((node, nodeIndex) => {
        if (node.fixed) return;
        const currentIndex = paletteKeys.indexOf(assigned[nodeIndex]);
        const currentCost = conflictCost(nodeIndex, assigned[nodeIndex]);
        for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex += 1) {
          if (paletteCounts[currentIndex] <= paletteCounts[paletteIndex] + 1 ||
              conflictCost(nodeIndex, paletteKeys[paletteIndex]) > currentCost + 1e-9) continue;
          paletteCounts[currentIndex] -= 1;
          paletteCounts[paletteIndex] += 1;
          assigned[nodeIndex] = paletteKeys[paletteIndex];
          balanced = true;
          break;
        }
      });
      if (!balanced) break;
    }

    nodes.forEach((node, nodeIndex) => {
      if (node.fixed) return;
      const paletteIndex = paletteKeys.indexOf(assigned[nodeIndex]);
      result[node.index].color = palette[paletteIndex];
    });
    return result;
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

  // Deterministic, shape-aware packing. Items receive distributed ideal
  // positions and search outwards from those positions on a bounded grid.
  // This avoids the two characteristic failures of the old free-rectangle
  // packer: a few early splits could strand a large empty region, and runs of
  // equally-sized emoji were funnelled through four repeating anchors. Exact
  // rectangle collision checks remain authoritative; the grid is only a
  // bounded source of candidate positions.
  function layoutBoxesInArea(boxes, width, height) {
    if (!Array.isArray(boxes) || !boxes.length || !Number.isFinite(width) ||
        !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    if (boxes.some(box => ![box.width, box.height, box.priority].every(Number.isFinite) ||
        box.width <= 0 || box.height <= 0 || box.priority <= 0)) return [];
    const sized = boxes.map((box, index) => ({ ...box, index }))
      .sort((a, b) => b.priority - a.priority || a.index - b.index);
    const minSide = Math.min(width, height);
    const padding = minSide * Math.min(.007, .055 / Math.sqrt(sized.length));
    const emojiCount = sized.filter(item => item.emoji).length;
    const dominant = sized.length === 1 || sized[0].priority > sized[1].priority * 1.05;

    // MaxRects-style free-rectangle packing remains one member of the
    // portfolio. It is particularly strong for very small sets and for
    // irregular mixes of long and short labels. The distributed placer below
    // wins when it improves the measured result; keeping both avoids making a
    // single heuristic responsible for every cloud shape.
    function freeRectangleCandidates() {
      const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
      const contains = (a, b) => a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2;
      const emojiSpacing = Math.min(.4, .9 / Math.sqrt(Math.max(1, emojiCount)));
      const emojiAnchors = [[.2, .2], [.8, .8], [.8, .2], [.2, .8]];

      function tryLegacyScale(scale, order = sized, variant = 0) {
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
            const targetX = scatterEmoji ? width * emojiAnchor[0] - w / 2
              : (!placed.length && dominant) || !variant ? (width - w) / 2
              : variant === 1 ? (space.x1 + space.x2 - w) / 2 : space.x1;
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
                Math.hypot((x + w / 2 - other.x) / width,
                  (y + h / 2 - other.y) / height));
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
      let best = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const scale = (low + high) / 2;
        const candidate = tryLegacyScale(scale);
        if (candidate) {
          best = candidate;
          low = scale;
        } else high = scale;
      }
      if (!best) return [];
      const result = spreadAreaBoxes(best, width, height);
      const results = [result];
      const minimumScale = result[0].scale * .9;
      const initialQuality = layoutQuality(result, width, height);
      if (sized.length > 2 && !isLayoutBalanced(initialQuality, sized.length)) {
        const tail = sized.slice(1);
        const orders = [sized,
          [sized[0], ...tail.slice().sort((a, b) =>
            b.width * b.height - a.width * a.height || a.index - b.index)],
          [sized[0], ...tail.slice().sort((a, b) =>
            Math.max(b.width, b.height) - Math.max(a.width, a.height) || a.index - b.index)]];
        if (emojiCount > 1) orders.push([sized[0], ...tail.filter(item => item.emoji),
          ...tail.filter(item => !item.emoji).sort((a, b) =>
            b.width * b.height - a.width * a.height || a.index - b.index)]);
        else orders.push(orders[1]);
        orders.forEach((order, index) => {
          for (const ratio of [1, .94, .88]) {
            const candidate = tryLegacyScale(low * ratio, order,
              index === 0 ? 1 : index === 3 ? (emojiCount > 1 ? 3 : 1) : 2);
            if (!candidate) continue;
            const fitted = spreadAreaBoxes(candidate, width, height);
            if (fitted[0].scale >= minimumScale) results.push(fitted);
          }
        });
      }
      return results;
    }
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

    function radicalInverse(value, base) {
      let result = 0;
      let factor = 1 / base;
      while (value > 0) {
        result += (value % base) * factor;
        value = Math.floor(value / base);
        factor /= base;
      }
      return result;
    }

    const emojiAnchorCache = new Map();
    function blueNoiseEmojiAnchors(count, variant) {
      const key = `${count}:${variant}`;
      if (emojiAnchorCache.has(key)) return emojiAnchorCache.get(key);
      const side = clamp(Math.ceil(Math.sqrt(count) * 4), 12, 48);
      const points = [];
      for (let row = 0; row < side; row++) {
        for (let column = 0; column < side; column++) {
          points.push([
            .06 + .88 * column / Math.max(1, side - 1),
            .06 + .88 * row / Math.max(1, side - 1),
          ]);
        }
      }
      const seed = [
        .06 + .88 * radicalInverse(variant + 1, 2),
        .06 + .88 * radicalInverse(variant + 1, 3),
      ];
      const anchors = [];
      const used = new Uint8Array(points.length);
      const nearestSquared = new Float64Array(points.length);
      nearestSquared.fill(Infinity);
      let bestIndex = 0;
      let seedDistance = Infinity;
      for (let index = 0; index < points.length; index++) {
        const distance = (points[index][0] - seed[0]) ** 2 +
          (points[index][1] - seed[1]) ** 2;
        if (distance < seedDistance) {
          seedDistance = distance;
          bestIndex = index;
        }
      }
      while (anchors.length < count) {
        used[bestIndex] = 1;
        const selected = points[bestIndex];
        anchors.push(selected);
        bestIndex = -1;
        let bestDistance = -1;
        for (let index = 0; index < points.length; index++) {
          if (used[index]) continue;
          const distance = (points[index][0] - selected[0]) ** 2 +
            (points[index][1] - selected[1]) ** 2;
          nearestSquared[index] = Math.min(nearestSquared[index], distance);
          if (nearestSquared[index] > bestDistance + 1e-12) {
            bestDistance = nearestSquared[index];
            bestIndex = index;
          }
        }
      }
      emojiAnchorCache.set(key, anchors);
      return anchors;
    }

    function distributedAnchor(index, count, variant, emoji) {
      if (emoji) {
        // Deterministic farthest-point sampling approximates blue noise: each
        // new emoji claims the largest remaining gap. Unlike a Halton sequence,
        // it also controls the nearest pairs that people perceive as a cluster.
        return blueNoiseEmojiAnchors(count, variant)[index];
      }
      if (index === 0) return [.5, .5];
      if (variant >= 4 && count > 10) {
        // Half of the bounded variants use an all-area sequence for text too.
        // It gives the candidate selector a deliberately different topology
        // whose tail reaches rectangular corners instead of orbiting them.
        const offsetX = ((variant - 4) * .2360679775) % 1;
        const offsetY = ((variant - 4) * .4142135624) % 1;
        return [
          .04 + .92 * ((radicalInverse(index + 1, 2) + offsetX) % 1),
          .04 + .92 * ((radicalInverse(index + 1, 3) + offsetY) % 1),
        ];
      }
      // Map a golden-angle sunflower to a square boundary. Unlike an ellipse,
      // this fills rectangular corners as the rank approaches the long tail.
      const progress = Math.sqrt((index + .35) / Math.max(1, count));
      const extent = count <= 10 && emojiCount === 0 ? .3 : .46;
      const direction = variant % 2 ? -1 : 1;
      const theta = direction * index * 2.399963229728653 + variant * .67;
      const cosine = Math.cos(theta);
      const sine = Math.sin(theta);
      const edge = Math.max(Math.abs(cosine), Math.abs(sine), 1e-6);
      return [
        .5 + extent * progress * cosine / edge,
        .5 + extent * progress * sine / edge,
      ];
    }

    function orderedItems(variant) {
      if (emojiCount > 1 && variant % 4 === 3) {
        const first = sized[0];
        const tail = sized.slice(1);
        return [first, ...tail.filter(item => item.emoji), ...tail.filter(item => !item.emoji)
          .sort((a, b) => b.width * b.height - a.width * a.height || a.index - b.index)];
      }
      if (variant % 3 === 1) {
        return sized.slice().sort((a, b) => b.priority - a.priority ||
          b.width * b.height - a.width * a.height || a.index - b.index);
      }
      if (variant % 3 === 2) {
        return sized.slice().sort((a, b) => b.priority - a.priority ||
          Math.max(b.width, b.height) - Math.max(a.width, a.height) || a.index - b.index);
      }
      return sized;
    }

    const targetPoints = clamp(Math.ceil(sized.length * 32), 4096, 18000);
    const candidateColumns = Math.max(24, Math.round(Math.sqrt(targetPoints * width / height)));
    const candidateRows = Math.max(24, Math.round(targetPoints / candidateColumns));
    const searchRadius = Math.max(candidateColumns, candidateRows);
    const bucketRows = clamp(Math.ceil(Math.sqrt(sized.length) * 2.5), 24, 64);
    const bucketColumns = clamp(Math.round(bucketRows * width / height), 24, 128);

    function tryScale(scale, variant) {
      const order = orderedItems(variant);
      const placed = [];
      const buckets = Array.from({ length: bucketRows * bucketColumns }, () => []);
      const seen = new Int32Array(order.length);
      let seenRevision = 0;
      let emojiIndex = 0;
      let textIndex = 0;

      function collides(rect) {
        const left = clamp(Math.floor(rect.x1 / width * bucketColumns), 0, bucketColumns - 1);
        const right = clamp(Math.floor((rect.x2 - 1e-7) / width * bucketColumns), 0, bucketColumns - 1);
        const top = clamp(Math.floor(rect.y1 / height * bucketRows), 0, bucketRows - 1);
        const bottom = clamp(Math.floor((rect.y2 - 1e-7) / height * bucketRows), 0, bucketRows - 1);
        seenRevision += 1;
        for (let row = top; row <= bottom; row++) {
          for (let col = left; col <= right; col++) {
            for (const placedIndex of buckets[row * bucketColumns + col]) {
              if (seen[placedIndex] === seenRevision) continue;
              seen[placedIndex] = seenRevision;
              const other = placed[placedIndex];
              if (rect.x1 < other.collisionX2 && rect.x2 > other.collisionX1 &&
                  rect.y1 < other.collisionY2 && rect.y2 > other.collisionY1) return true;
            }
          }
        }
        return false;
      }

      function insert(rect, placedIndex) {
        const left = clamp(Math.floor(rect.x1 / width * bucketColumns), 0, bucketColumns - 1);
        const right = clamp(Math.floor((rect.x2 - 1e-7) / width * bucketColumns), 0, bucketColumns - 1);
        const top = clamp(Math.floor(rect.y1 / height * bucketRows), 0, bucketRows - 1);
        const bottom = clamp(Math.floor((rect.y2 - 1e-7) / height * bucketRows), 0, bucketRows - 1);
        for (let row = top; row <= bottom; row++) {
          for (let col = left; col <= right; col++) buckets[row * bucketColumns + col].push(placedIndex);
        }
      }

      for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
        const item = order[orderIndex];
        const collisionWidth = item.width * scale + padding * 2;
        const collisionHeight = item.height * scale + padding * 2;
        if (collisionWidth > width || collisionHeight > height) return null;
        const isDominant = orderIndex === 0 && dominant;
        const anchor = isDominant ? [.5, .5] : distributedAnchor(
          item.emoji ? emojiIndex++ : textIndex++,
          item.emoji ? emojiCount : sized.length - emojiCount,
          variant,
          item.emoji
        );
        const anchorColumn = Math.round(anchor[0] * (candidateColumns - 1));
        const anchorRow = Math.round(anchor[1] * (candidateRows - 1));
        let best = null;

        function consider(column, row) {
          if (column < 0 || column >= candidateColumns || row < 0 || row >= candidateRows) return false;
          const x = collisionWidth / 2 + column / Math.max(1, candidateColumns - 1) *
            (width - collisionWidth);
          const y = collisionHeight / 2 + row / Math.max(1, candidateRows - 1) *
            (height - collisionHeight);
          const rect = { x1: x - collisionWidth / 2, x2: x + collisionWidth / 2,
            y1: y - collisionHeight / 2, y2: y + collisionHeight / 2 };
          if (collides(rect)) return false;
          best = { x, y, rect };
          return true;
        }

        if (!consider(anchorColumn, anchorRow)) {
          outer: for (let radius = 1; radius <= searchRadius; radius++) {
            const reverse = (variant + orderIndex + radius) % 2;
            for (let step = -radius; step <= radius; step++) {
              const along = reverse ? -step : step;
              if (consider(anchorColumn + along, anchorRow - radius) ||
                  consider(anchorColumn - along, anchorRow + radius) ||
                  consider(anchorColumn - radius, anchorRow - along) ||
                  consider(anchorColumn + radius, anchorRow + along)) break outer;
            }
          }
        }
        if (!best) return null;
        const next = { ...item, x: best.x, y: best.y, scale,
          collisionX1: best.rect.x1, collisionX2: best.rect.x2,
          collisionY1: best.rect.y1, collisionY2: best.rect.y2 };
        placed.push(next);
        insert(best.rect, placed.length - 1);
      }
      return placed.map(({ collisionX1, collisionX2, collisionY1, collisionY2, ...item }) => item);
    }

    function redistributeEmoji(layout) {
      if (emojiCount <= 1) return layout;
      const fixed = layout.filter(item => !item.emoji);
      const lockedEmoji = dominant && sized[0].emoji
        ? layout.filter(item => item.index === sized[0].index) : [];
      const emoji = layout.filter(item => item.emoji && !lockedEmoji.includes(item)).sort((a, b) =>
        b.width * b.height * b.scale * b.scale - a.width * a.height * a.scale * a.scale ||
        a.index - b.index);
      const anchors = blueNoiseEmojiAnchors(emoji.length + lockedEmoji.length, 17);
      const placedEmoji = lockedEmoji.slice();
      const gap = padding * .6;

      for (let emojiIndex = 0; emojiIndex < emoji.length; emojiIndex++) {
        const item = emoji[emojiIndex];
        const itemWidth = item.width * item.scale;
        const itemHeight = item.height * item.scale;
        const target = anchors[emojiIndex + lockedEmoji.length];
        let best = null;
        let bestScore = -Infinity;
        for (let row = 0; row < candidateRows; row++) {
          const y = itemHeight / 2 + row / Math.max(1, candidateRows - 1) *
            (height - itemHeight);
          for (let column = 0; column < candidateColumns; column++) {
            const x = itemWidth / 2 + column / Math.max(1, candidateColumns - 1) *
              (width - itemWidth);
            const rect = { x1: Math.max(0, x - itemWidth / 2),
              x2: Math.min(width, x + itemWidth / 2),
              y1: Math.max(0, y - itemHeight / 2),
              y2: Math.min(height, y + itemHeight / 2) };
            const intersects = other => rect.x1 - gap < other.x2 && rect.x2 + gap > other.x1 &&
              rect.y1 - gap < other.y2 && rect.y2 + gap > other.y1;
            const collision = fixed.some(intersects) || placedEmoji.some(intersects);
            if (collision) continue;
            let nearest = 1;
            for (const other of placedEmoji) {
              nearest = Math.min(nearest, Math.hypot(
                (x - other.x) / width, (y - other.y) / height));
            }
            const targetDistance = Math.hypot(x / width - target[0], y / height - target[1]);
            const score = nearest - targetDistance * .18;
            if (score > bestScore + 1e-12) {
              bestScore = score;
              best = { ...item, x, y, ...rect };
            }
          }
        }
        if (!best) return layout;
        placedEmoji.push(best);
      }
      return fixed.concat(placedEmoji).sort((a, b) => a.index - b.index);
    }

    const dimensionLimit = Math.min(...sized.map(item => Math.min(
      (width - padding * 2) / item.width,
      (height - padding * 2) / item.height
    )));
    const totalArea = sized.reduce((sum, item) => sum +
      (item.width + padding * 2) * (item.height + padding * 2), 0);
    const areaLimit = Math.sqrt(width * height * .82 / Math.max(1, totalArea));
    const highLimit = Math.min(dimensionLimit, areaLimit * 1.35);
    const variantCount = sized.length <= 80 ? 8
      : sized.length <= 200 ? 5 : emojiCount > 1 ? 4 : 3;
    const candidates = [];

    // Free-rectangle splitting grows sharply on capacity-sized clouds. The
    // spatial-grid family is both faster and more reliable there.
    if (sized.length <= 120) {
      candidates.push(...freeRectangleCandidates());
    }

    for (let variant = 0; variant < variantCount; variant++) {
      let low = 0;
      let high = highLimit;
      let best = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const scale = (low + high) / 2;
        const candidate = tryScale(scale, variant);
        if (candidate) {
          best = candidate;
          low = scale;
        } else high = scale;
      }
      if (best) candidates.push(fitAreaBoxes(best, width, height));
    }

    if (!candidates.length) candidates.push(fitAreaBoxes(fallback, width, height));
    const largestScale = Math.max(...candidates.map(candidate => candidate[0].scale));
    const scoredCandidates = candidates.map(candidate =>
      ({ candidate, quality: layoutQuality(candidate, width, height) }));
    let eligible = scoredCandidates.filter(entry => entry.candidate[0].scale >= largestScale * .9);
    const smallestEmptyRegion = Math.min(...eligible.map(entry => entry.quality.emptyRegion));
    if (sized.length > 10 || emojiCount <= 1) {
      const filled = eligible.filter(entry => entry.quality.emptyRegion <=
        smallestEmptyRegion + (sized.length <= 10 ? .012 : .008));
      if (filled.length) eligible = filled;
    }
    // Emoji distribution is a constraint, not a cosmetic tie-breaker. If at
    // least one similarly-sized candidate keeps the lower tail of nearest-
    // neighbour distances healthy, a denser but visibly clustered candidate
    // is not allowed to win on occupied area alone.
    if (emojiCount > 1 && eligible.some(entry => entry.quality.separation >= .8)) {
      eligible = eligible.filter(entry => entry.quality.separation >= .8);
    }
    let result = eligible[0].candidate;
    let quality = eligible[0].quality.score;
    for (const entry of eligible.slice(1)) {
      if (entry.quality.score > quality + 1e-9) {
        result = entry.candidate;
        quality = entry.quality.score;
      }
    }
    if (emojiCount > 1 && emojiCount <= 80) {
      const before = layoutQuality(result, width, height);
      const redistributed = redistributeEmoji(result);
      const after = layoutQuality(redistributed, width, height);
      const emptyAllowance = sized.length <= 10 ? .06 : .015;
      if (after.separation > before.separation + .025 &&
          after.emptyRegion <= before.emptyRegion + emptyAllowance) result = redistributed;
      const redistributedQuality = layoutQuality(result, width, height);
      if (redistributedQuality.separation < .8) {
        // If full-size local repair cannot resolve the cluster, admit a second
        // tier of blue-noise candidates. The 18% cap is deliberately bounded:
        // relative contribution sizes remain exact, while the lower global
        // scale buys both continuous fill and visibly even emoji placement.
        const distributed = scoredCandidates.filter(entry =>
          entry.candidate[0].scale >= largestScale * .82 &&
          entry.quality.separation >= .8 &&
          entry.quality.emptyRegion <= redistributedQuality.emptyRegion +
            (sized.length <= 10 ? .06 : .02))
          .sort((a, b) => b.quality.score - a.quality.score);
        if (distributed.length) result = distributed[0].candidate;
      }
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
      const nearest = emoji.map((box, index) => {
        let nearest = 1;
        for (let other = 0; other < emoji.length; other++) {
          if (other === index) continue;
          nearest = Math.min(nearest, Math.hypot(
            (box.x1 + box.x2 - emoji[other].x1 - emoji[other].x2) / (2 * width),
            (box.y1 + box.y2 - emoji[other].y1 - emoji[other].y2) / (2 * height)));
        }
        return Math.min(1, nearest / target);
      }).sort((a, b) => a - b);
      const lowerTail = nearest[Math.floor((nearest.length - 1) * .2)];
      const mean = nearest.reduce((sum, distance) => sum + distance, 0) / nearest.length;
      separation = lowerTail * .7 + mean * .3;
    }
    const emptyRegion = largestEmptyRegion(boxes, width, height);
    return { coverage, corners, worstRegion: Math.min(...regions), separation, emptyRegion,
      score: coverage + Math.min(...corners) * (sparse ? .05 : .2) + Math.min(...regions) * .35 -
        Math.sqrt(variance) * .2 + separation * .45 - emptyRegion * 4 };
  }

  function spreadAreaBoxes(items, width, height) {
    const inset = Math.min(width, height) * .012;
    const bounds = areaBounds(items);
    const fitScale = Math.min((width - inset * 2) / (bounds.x2 - bounds.x1),
      (height - inset * 2) / (bounds.y2 - bounds.y1));
    const fitted = items.map(item => ({ ...item,
      x: (item.x - (bounds.x1 + bounds.x2) / 2) * fitScale,
      y: (item.y - (bounds.y1 + bounds.y2) / 2) * fitScale,
      scale: item.scale * fitScale,
    }));
    const spread = items.length > 10;
    const span = spread ? Math.max(...fitted.map(item => item.x)) -
      Math.min(...fitted.map(item => item.x)) : 0;
    let low = 1;
    let high = span > 0 ? Math.max(1, (width - inset * 2) / span) : 1;
    for (let attempt = 0; attempt < 18; attempt++) {
      const scale = (low + high) / 2;
      const expanded = areaBounds(fitted, scale);
      if (expanded.x2 - expanded.x1 <= width - inset * 2) low = scale;
      else high = scale;
    }
    const horizontalScale = low;
    const verticalSpan = spread ? Math.max(...fitted.map(item => item.y)) -
      Math.min(...fitted.map(item => item.y)) : 0;
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
    // A small, capped centre-spacing adjustment lets rectangular print areas
    // reach their edge contract without changing artwork or relative font
    // sizes. The former unbounded expansion could tear open the interior; 4%
    // is enough to absorb grid quantisation while distributed anchors remain
    // responsible for the actual shape.
    let horizontalScale = 1;
    let verticalScale = 1;
    if (items.length > 10) {
      let low = 1;
      let high = 1.04;
      for (let attempt = 0; attempt < 12; attempt++) {
        const scale = (low + high) / 2;
        const trial = areaBounds(fitted, scale);
        if (trial.x2 - trial.x1 <= width * .984) low = scale;
        else high = scale;
      }
      horizontalScale = low;
      low = 1;
      high = 1.04;
      for (let attempt = 0; attempt < 12; attempt++) {
        const scale = (low + high) / 2;
        const trial = areaBounds(fitted, horizontalScale, scale);
        if (trial.y2 - trial.y1 <= height * .956) low = scale;
        else high = scale;
      }
      verticalScale = low;
    }
    const expanded = areaBounds(fitted, horizontalScale, verticalScale);
    const centerX = (expanded.x1 + expanded.x2) / 2;
    const centerY = (expanded.y1 + expanded.y2) / 2;
    return fitted.map(item => {
      const x = width / 2 + item.x * horizontalScale - centerX;
      const y = height / 2 + item.y * verticalScale - centerY;
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
    const assignColor = colorFn || makeColorAssigner('pastel');
    const placed = finalizeWords(layoutBoxesInArea(
      measureWords(words, measureCtx, assignColor), width, height
    ));
    return spreadPaletteColors(placed, assignColor.palette);
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
    spreadPaletteColors,
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
