(function (root, factory) {
  'use strict';

  const wordCloudCore = typeof module === 'object' && module.exports
    ? require('./wordcloud-core.js')
    : root.WordCloudCore;
  const cloudLimits = typeof module === 'object' && module.exports
    ? require('./cloud-limits.js')
    : root.CloudLimits;
  const api = factory(wordCloudCore, cloudLimits);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DesignLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function (WordCloudCore, CloudLimits) {
  'use strict';

  const MIN_PRINT_FONT_SIZE = CloudLimits.MIN_PRINT_FONT_SIZE;
  const MAX_FONT_ADJUSTMENT = .20;
  const HORIZONTAL_BREATHING_RATIO = .1;
  const VERTICAL_BREATHING_RATIO = .035;

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function normalizeSlot(slot) {
    const width = Number(slot?.width ?? slot?.side);
    const height = Number(slot?.height ?? slot?.side);
    const x = Number(slot?.x);
    const y = Number(slot?.y);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { x, y, width, height, optimize: slot?.optimize === true };
  }

  function normalizedSlots(slots) {
    return Array.isArray(slots) ? slots.map(normalizeSlot).filter(Boolean) : [];
  }

  function nearestSlotIndex(item, slots) {
    const containingIndex = slots.findIndex((slot) => (
      item.x >= slot.x && item.x <= slot.x + slot.width &&
      item.y >= slot.y && item.y <= slot.y + slot.height
    ));
    if (containingIndex >= 0) return containingIndex;

    let nearestIndex = 0;
    let nearestDistance = Infinity;
    slots.forEach((slot, index) => {
      const dx = (item.x - (slot.x + slot.width / 2)) / slot.width;
      const dy = (item.y - (slot.y + slot.height / 2)) / slot.height;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    return nearestIndex;
  }

  function copyId(item, usedIds) {
    const type = item.type === 'icon' ? 'motiv' : item.type === 'image' ? 'bild' : 'wort';
    const base = String(item.id || type).slice(0, 48);
    let index = 2;
    let candidate = `${base}-seite-${index}`;
    while (usedIds.has(candidate)) {
      index += 1;
      candidate = `${base}-seite-${index}`;
    }
    usedIds.add(candidate);
    return candidate;
  }

  function itemDimensions(item, scale, measureContext, fontFamily) {
    let width;
    let height;
    if (item.type === 'image') {
      width = Math.max(1, Number(item.width) || 24);
      height = Math.max(1, Number(item.height) || 24);
    } else if (item.type === 'icon') {
      width = height = Math.max(1, Number(item.size) || 48);
    } else {
      const fontSize = Math.max(1, Number(item.fontSize) || 12);
      if (measureContext) {
        const itemFontFamily = typeof fontFamily === 'function'
          ? fontFamily(item)
          : fontFamily;
        const textBox = WordCloudCore.measureTextBox(
          item.text,
          fontSize,
          measureContext,
          itemFontFamily,
          item
        );
        const styledBox = WordCloudCore.styledTextBox(textBox, item);
        width = styledBox.width;
        height = styledBox.height;
      } else {
        width = Math.max(1, String(item.text || '').length * fontSize * .58);
        height = fontSize * WordCloudCore.TEXT_LINE_HEIGHT;
        if (item.fontStyle === 'italic') {
          width += height * Math.abs(Math.tan(WordCloudCore.ITALIC_SKEW_DEGREES * Math.PI / 180));
        }
      }
    }

    const radians = (Number(item.angle) || 0) * Math.PI / 180;
    const cosine = Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians));
    return {
      width: (width * cosine + height * sine) * scale,
      height: (width * sine + height * cosine) * scale,
      // Turning a word must not turn its entire length into a padding halo.
      spacingHeight: (item.type === 'image' ? Math.min(width, height) : height) * scale,
    };
  }

  function minimumScale(item) {
    if (item.type === 'image') {
      return 24 / Math.max(1, Math.min(Number(item.width) || 24, Number(item.height) || 24));
    }
    if (item.type === 'icon') return 48 / Math.max(1, Number(item.size) || 48);
    return MIN_PRINT_FONT_SIZE / Math.max(1, Number(item.fontSize) || 12);
  }

  function boxesOverlap(first, second) {
    return !(first.x2 <= second.x1 || first.x1 >= second.x2 ||
      first.y2 <= second.y1 || first.y1 >= second.y2);
  }

  function isVerticalText(item) {
    return item.type !== 'image' && item.type !== 'icon' && !WordCloudCore.isEmojiOnly(item.text) &&
      Math.abs((Number(item.angle) || 0) % 180) === 90;
  }

  // Centre distance misses parallel words whose long edges nearly touch.
  // Reserve room between overlapping vertical spans for horizontal text,
  // without penalizing upright words that sit above and below one another.
  function verticalPairPressure(first, second, slot) {
    const overlap = Math.min(first.y2, second.y2) - Math.max(first.y1, second.y1);
    const height = Math.min(first.height, second.height);
    if (overlap <= height * .2) return 0;
    const gap = Math.max(0, first.x1 - second.x2, second.x1 - first.x2);
    const clearance = Math.max(Math.min(slot.width, slot.height) * .09,
      (first.width + second.width) * .8);
    return Math.max(0, 1 - gap / clearance) * Math.min(1, overlap / (height * .5));
  }

  function verticalNeighbourPressure(items, boxes, slot) {
    const vertical = boxes.filter((_, index) => isVerticalText(items[index]));
    if (vertical.length < 2) return 0;
    const pressures = vertical.map((box, index) => Math.max(0,
      ...vertical.filter((_, other) => other !== index).map(other => verticalPairPressure(box, other, slot))));
    // A tight pair must not disappear inside an otherwise well-spread average.
    return Math.max(...pressures) * .6 + pressures.reduce((sum, value) => sum + value, 0) / vertical.length * .4;
  }

  function scaleItem(item, scale, x, y) {
    const optimized = { ...item, x: round(x), y: round(y) };
    if (item.type === 'image') {
      const imageScale = Math.max(scale, minimumScale(item));
      optimized.width = round((Number(item.width) || 24) * imageScale);
      optimized.height = round((Number(item.height) || 24) * imageScale);
    } else if (item.type === 'icon') {
      optimized.size = round(Math.max(48, (Number(item.size) || 48) * scale));
    } else {
      optimized.fontSize = Math.max(MIN_PRINT_FONT_SIZE,
        Math.floor((Number(item.fontSize) || 12) * scale * 10) / 10);
      if (Number.isFinite(item.layoutFontSize)) optimized.layoutFontSize = round(item.layoutFontSize * scale);
    }
    return optimized;
  }

  function fitItemsInSlot(items, slot, measureContext, fontFamily) {
    if (!items.length) return [];
    const bounds = items.reduce((result, item) => {
      const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
      return {
        x1: Math.min(result.x1, item.x - dimensions.width / 2),
        x2: Math.max(result.x2, item.x + dimensions.width / 2),
        y1: Math.min(result.y1, item.y - dimensions.height / 2),
        y2: Math.max(result.y2, item.y + dimensions.height / 2),
      };
    }, { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity });
    const sourceWidth = Math.max(1, bounds.x2 - bounds.x1);
    const sourceHeight = Math.max(1, bounds.y2 - bounds.y1);
    const inset = Math.max(2, Math.min(slot.width, slot.height) * .025);
    const xScale = Math.max(0, slot.width - inset * 2) / sourceWidth;
    const yScale = Math.max(0, slot.height - inset * 2) / sourceHeight;
    const sizeScale = Math.min(xScale, yScale);
    const sourceCenterX = (bounds.x1 + bounds.x2) / 2;
    const sourceCenterY = (bounds.y1 + bounds.y2) / 2;
    const targetCenterX = slot.x + slot.width / 2;
    const targetCenterY = slot.y + slot.height / 2;

    return items.map((item) => scaleItem(
      item,
      sizeScale,
      targetCenterX + (item.x - sourceCenterX) * xScale,
      targetCenterY + (item.y - sourceCenterY) * yScale
    ));
  }

  function arrangeDesign(design, slots, measureContext, options = {}) {
    if (!Array.isArray(design) || !design.length) return [];
    const targets = normalizedSlots(slots);
    if (!targets.length) return design.map((item) => ({ ...item }));
    const fontFamily = options.fontFamily || 'Georgia, "Times New Roman", serif';
    if (targets.length === 1) {
      return fitItemsInSlot(design, targets[0], measureContext, fontFamily);
    }

    const grouped = targets.map(() => []);
    design.forEach((item) => grouped[nearestSlotIndex(item, targets)].push(item));
    const populatedGroups = grouped.filter((group) => group.length);
    const usedIds = new Set(design.map((item) => String(item.id || '')).filter(Boolean));

    if (populatedGroups.length === 1) {
      return targets.flatMap((target, targetIndex) => (
        fitItemsInSlot(design, target, measureContext, fontFamily).map((item) => ({
          ...item,
          id: targetIndex === 0 ? item.id : copyId(item, usedIds),
        }))
      ));
    }

    return grouped.flatMap((group, index) => (
      fitItemsInSlot(group, targets[index], measureContext, fontFamily)
    ));
  }

  function designBoxes(items, measureContext, fontFamily) {
    return items.map(item => {
      const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
      return { ...dimensions, emoji: WordCloudCore.isEmojiOnly(item.text),
        x1: item.x - dimensions.width / 2, x2: item.x + dimensions.width / 2,
        y1: item.y - dimensions.height / 2, y2: item.y + dimensions.height / 2 };
    });
  }

  function cachedMeasurements(context) {
    if (!context) return context;
    // One fill only: font loading or later edits get a fresh cache. Return
    // actual Canvas metrics, including glyph bounds, never estimated widths.
    const measured = new Map();
    let font = context.font;
    return {
      get font() { return font; },
      set font(value) { font = value; },
      measureText(text) {
        const key = JSON.stringify([font, text]);
        if (!measured.has(key)) {
          if (measured.size >= 8192) measured.clear();
          context.font = font;
          measured.set(key, context.measureText(text));
        }
        return measured.get(key);
      },
    };
  }

  function breathingRoomPressure(boxes) {
    let total = 0;
    let neighbours = 0;
    boxes.forEach((box, index) => boxes.slice(0, index).forEach(other => {
      const across = Math.max(0, box.x1 - other.x2, other.x1 - box.x2);
      const down = Math.max(0, box.y1 - other.y2, other.y1 - box.y2);
      const horizontal = (box.spacingHeight + other.spacingHeight) * HORIZONTAL_BREATHING_RATIO;
      const vertical = (box.spacingHeight + other.spacingHeight) * VERTICAL_BREATHING_RATIO;
      if (across > horizontal * 2 || down > vertical * 2) return;
      total += Math.max(0, 1 - Math.max(across / horizontal, down / vertical));
      neighbours++;
    }));
    return neighbours ? total / neighbours : 0;
  }

  function columnAlignment(boxes) {
    const text = boxes.filter(box => !box.emoji && box.width > box.height * 1.5);
    if (text.length < 12 || boxes.length > 120) return 0;
    const largestHeight = Math.max(...text.map(box => box.height));
    const totalWeight = text.reduce((sum, box) => sum + (box.height / largestHeight) ** 2, 0);
    let aligned = 0;
    text.forEach((box, index) => text.slice(0, index).forEach(other => {
      const across = Math.abs((box.x1 + box.x2 - other.x1 - other.x2) / 2);
      const down = Math.abs((box.y1 + box.y2 - other.y1 - other.y2) / 2);
      const tolerance = Math.min(box.height, other.height) * .45;
      if (down > (box.height + other.height) * .5 && down < (box.height + other.height) * 2) {
        aligned += Math.max(0, 1 - across / tolerance) * box.height * other.height / largestHeight ** 2;
      }
    }));
    return Math.min(1, aligned / totalWeight);
  }

  // Print fill deliberately scores the complete safe area, even for one or
  // two words. The live engine's compact-composition objective stays intact.
  function printLayoutQuality(boxes, width, height, fast = false) {
    const cells = Array(16).fill(0);
    let area = 0;
    for (const box of boxes) {
      area += (box.x2 - box.x1) * (box.y2 - box.y1);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          cells[row * 4 + col] += Math.max(0, Math.min((col + 1) * width / 4, box.x2) -
            Math.max(col * width / 4, box.x1)) * Math.max(0,
            Math.min((row + 1) * height / 4, box.y2) - Math.max(row * height / 4, box.y1)) /
            (width * height / 16);
        }
      }
    }
    const coverage = area / (width * height);
    const corners = [cells[0], cells[3], cells[12], cells[15]];
    const regions = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) regions.push((cells[row * 4 + col] +
        cells[row * 4 + col + 1] + cells[(row + 1) * 4 + col] + cells[(row + 1) * 4 + col + 1]) / 4);
    }
    const variance = cells.reduce((sum, cell) => sum + (cell - coverage) ** 2, 0) / 16;
    const emoji = boxes.filter(box => box.emoji);
    let separation = 1;
    if (emoji.length > 1) {
      const target = Math.min(.4, .9 / Math.sqrt(emoji.length));
      const nearest = emoji.map((box, index) => {
        let distance = 1;
        for (let other = 0; other < emoji.length; other++) {
          if (other === index) continue;
          distance = Math.min(distance, Math.hypot(
            (box.x1 + box.x2 - emoji[other].x1 - emoji[other].x2) / (2 * width),
            (box.y1 + box.y2 - emoji[other].y1 - emoji[other].y2) / (2 * height)));
        }
        return Math.min(1, distance / target);
      }).sort((a, b) => a - b);
      separation = nearest[Math.floor((nearest.length - 1) * .2)] * .7 +
        nearest.reduce((sum, distance) => sum + distance, 0) / nearest.length * .3;
    }
    // A fixed raster bounds scoring work independently of product DPI.
    const side = !fast && boxes.length <= 120 ? 64 : 32;
    const occupied = new Uint8Array(side * side);
    for (const box of boxes) {
      const left = Math.max(0, Math.min(side, Math.floor(box.x1 / width * side)));
      const right = Math.max(0, Math.min(side, Math.ceil(box.x2 / width * side)));
      const top = Math.max(0, Math.min(side, Math.floor(box.y1 / height * side)));
      const bottom = Math.max(0, Math.min(side, Math.ceil(box.y2 / height * side)));
      for (let row = top; row < bottom; row++) occupied.fill(1, row * side + left, row * side + right);
    }
    const heights = new Uint8Array(side);
    let largest = 0;
    for (let row = 0; row < side; row++) {
      const stack = [];
      for (let col = 0; col < side; col++) heights[col] = occupied[row * side + col] ? 0 : heights[col] + 1;
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
    let emptyRegion = largest / (side * side);
    if (!fast && boxes.length <= 12) {
      // Sparse prints expose narrow full-height gaps that a raster can miss.
      // An edge sweep is small here, and remains independent of product DPI.
      const ys = [...new Set([0, height, ...boxes.flatMap(box => [box.y1, box.y2])])]
        .filter(y => y >= 0 && y <= height).sort((a, b) => a - b);
      const ordered = boxes.slice().sort((a, b) => a.x1 - b.x1);
      let emptyArea = 0;
      for (let top = 0; top < ys.length; top++) for (let bottom = top + 1; bottom < ys.length; bottom++) {
        let right = 0;
        for (const box of ordered) {
          if (box.y1 >= ys[bottom] || box.y2 <= ys[top]) continue;
          emptyArea = Math.max(emptyArea, Math.max(0, box.x1 - right) * (ys[bottom] - ys[top]));
          right = Math.max(right, box.x2);
        }
        emptyArea = Math.max(emptyArea, (width - right) * (ys[bottom] - ys[top]));
      }
      emptyRegion = emptyArea / (width * height);
    }
    const alignment = columnAlignment(boxes);
    return { coverage, corners, separation, emptyRegion, alignment,
      score: coverage * 1.6 + Math.min(...corners) * .15 + Math.min(...regions) * .3 -
        Math.sqrt(variance) * .15 + separation * .25 - emptyRegion * 3 - alignment * .6 };
  }

  function rowCandidate(items, slot, measureContext, fontFamily) {
    // Exact subset partitioning is useful for sparse phrase-heavy designs.
    // It is capped at twelve elements; capacity clouds use the bounded packer.
    if (items.length > 12) return null;
    const boxes = designBoxes(items, measureContext, fontFamily);
    const total = (1 << items.length) - 1;
    const widths = new Float64Array(total + 1);
    const heights = new Float64Array(total + 1);
    const counts = new Uint8Array(total + 1);
    const emoji = new Uint8Array(total + 1);
    const inset = Math.max(2, Math.min(slot.width, slot.height) * .012);
    const gap = Math.max(1, Math.min(slot.width, slot.height) * .018);
    for (let mask = 1; mask <= total; mask++) {
      const bit = mask & -mask;
      const index = Math.log2(bit);
      const rest = mask ^ bit;
      widths[mask] = widths[rest] + boxes[index].width + boxes[index].spacingHeight * HORIZONTAL_BREATHING_RATIO * 2;
      heights[mask] = Math.max(heights[rest], boxes[index].height + boxes[index].spacingHeight * VERTICAL_BREATHING_RATIO * 2);
      counts[mask] = counts[rest] + 1;
      emoji[mask] = emoji[rest] + Number(boxes[index].emoji);
    }
    function partition(scale) {
      const dp = new Float64Array(total + 1);
      dp.fill(Infinity);
      dp[0] = 0;
      const chosen = new Int32Array(total + 1);
      const waste = new Float64Array(total + 1);
      waste.fill(Infinity);
      waste[0] = 0;
      for (let mask = 1; mask <= total; mask++) {
        const first = mask & -mask;
        for (let row = mask; row; row = (row - 1) & mask) {
          if (!(row & first) || emoji[row] > 2 ||
              widths[row] * scale + (counts[row] - 1) * gap > slot.width - inset * 2) continue;
          const rest = mask ^ row;
          const height = heights[row] * scale + (rest ? gap : 0) + dp[rest];
          const rowWidth = widths[row] * scale + (counts[row] - 1) * gap;
          const imbalance = (1 - rowWidth / (slot.width - inset * 2)) ** 2 + waste[rest];
          if (height < dp[mask] - 1e-7 || (Math.abs(height - dp[mask]) < 1e-7 && imbalance < waste[mask])) {
            dp[mask] = height; chosen[mask] = row; waste[mask] = imbalance;
          }
        }
      }
      if (dp[total] > slot.height - inset * 2) return null;
      const rows = [];
      for (let mask = total; mask; mask ^= chosen[mask]) rows.push(chosen[mask]);
      return { rows, height: dp[total] };
    }
    let low = 0;
    let high = Math.min(...boxes.map(box => Math.min(
      (slot.width - inset * 2) / box.width, (slot.height - inset * 2) / box.height)));
    let best = null;
    for (let attempt = 0; attempt < 16; attempt++) {
      const scale = (low + high) / 2;
      const candidate = partition(scale);
      if (candidate) { low = scale; best = candidate; } else high = scale;
    }
    if (!best || items.some(item => low < minimumScale(item))) return null;
    const rowOrders = [best.rows, best.rows.slice().reverse(),
      best.rows.slice().sort((a, b) => widths[b] - widths[a]),
      best.rows.slice().sort((a, b) => heights[b] - heights[a])];
    // Cyclic orders and alternating emoji sides provide different balances
    // without a factorial permutation search or random reshuffling.
    for (let offset = 1; offset < Math.min(best.rows.length, 6); offset++) {
      rowOrders.push(best.rows.slice(offset).concat(best.rows.slice(0, offset)));
    }
    if (best.rows.length <= 5) {
      function permutations(prefix, remaining) {
        if (rowOrders.length >= 28) return;
        if (!remaining.length) { rowOrders.push(prefix); return; }
        remaining.forEach((row, index) => permutations(prefix.concat(row), remaining.filter((_, other) => other !== index)));
      }
      permutations([], best.rows);
    }
    let result = null;
    let score = -Infinity;
    const uniqueOrders = [...new Map(rowOrders.map(rows => [rows.join(','), rows])).values()];
    for (const rows of uniqueOrders) {
      const variants = emoji[total] ? (best.rows.length <= 5 ? 16 : 4) : 1;
      for (let arrangement = 0; arrangement < variants * 3; arrangement++) {
        const variant = arrangement % variants;
        const spread = Math.floor(arrangement / variants) / 2;
        const placed = Array(items.length);
        const local = Array(items.length);
        let top = (slot.height - best.height) / 2;
        rows.forEach((row, rowIndex) => {
          const indexes = items.map((_, index) => index).filter(index => row & (1 << index));
          const side = variants === 16 ? (variant >> (rowIndex % 4)) & 1
            : variant < 2 ? (rowIndex + variant) % 2 : variant - 2;
          indexes.sort((a, b) => (side ? 1 : -1) * (Number(boxes[b].emoji) - Number(boxes[a].emoji)) || a - b);
          if (emoji[row] === 2 && indexes.length > 2) {
            const artwork = indexes.filter(index => boxes[index].emoji);
            const text = indexes.filter(index => !boxes[index].emoji);
            indexes.splice(0, indexes.length, artwork[side], ...text, artwork[1 - side]);
          }
          const extra = counts[row] > 1 ? Math.max(0, slot.width - inset * 2 -
            widths[row] * low - (counts[row] - 1) * gap) * spread : 0;
          const rowGap = gap + extra / Math.max(1, counts[row] - 1);
          let left = (slot.width - widths[row] * low - (counts[row] - 1) * gap - extra) / 2;
          for (const index of indexes) {
            const box = boxes[index];
            const width = box.width * low;
            const height = box.height * low;
            const reservedWidth = width + box.spacingHeight * low * HORIZONTAL_BREATHING_RATIO * 2;
            const x = left + reservedWidth / 2;
            const y = top + heights[row] * low / 2;
            placed[index] = scaleItem(items[index], low, slot.x + x, slot.y + y);
            local[index] = { width, height, emoji: box.emoji,
              x1: x - width / 2, x2: x + width / 2, y1: y - height / 2, y2: y + height / 2 };
            left += reservedWidth + rowGap;
          }
          top += heights[row] * low + gap;
        });
        const quality = printLayoutQuality(local, slot.width, slot.height, true);
        if (quality.score > score) { result = placed; score = quality.score; }
      }
    }
    return result;
  }

  function relaxHorizontalSpacing(items, slot, measureContext, fontFamily) {
    if (items.length < 2 || items.length > 120) return items.map(item => ({ ...item }));
    const result = items.map(item => ({ ...item }));
    const boxes = designBoxes(result, measureContext, fontFamily);
    const rows = [];
    // Only group items whose centres share a horizontal band. Staggered
    // neighbours remain obstacles, rather than being forced into a row.
    boxes.map((box, index) => ({ box, index })).sort((a, b) =>
      result[a.index].y - result[b.index].y || result[a.index].x - result[b.index].x)
      .forEach(({ box, index }) => {
        const row = rows.find(group => group.every(other => Math.abs(result[index].y - result[other].y) <=
          Math.min(box.height, boxes[other].height) * .25));
        if (row) row.push(index);
        else rows.push([index]);
      });
    const inset = Math.max(1, Math.min(slot.width, slot.height) * .012);
    for (const row of rows) {
      if (row.length < 2) continue;
      row.sort((a, b) => result[a].x - result[b].x || a - b);
      const members = new Set(row);
      const gaps = row.slice(1).map((index, offset) => {
        const first = boxes[row[offset]];
        const second = boxes[index];
        const gap = second.x1 - first.x2;
        return { gap, extra: Math.max(0, Math.min(first.height, second.height) * .22 - gap) };
      });
      if (!gaps.some(gap => gap.extra > .1)) continue;
      const limits = row.map(index => {
        const box = boxes[index];
        const half = box.width / 2;
        let low = Math.min(result[index].x, slot.x + inset + half);
        let high = Math.max(result[index].x, slot.x + slot.width - inset - half);
        boxes.forEach((other, otherIndex) => {
          if (members.has(otherIndex) || other.y1 >= box.y2 || other.y2 <= box.y1) return;
          if (other.x2 <= box.x1) low = Math.max(low, other.x2 + half);
          else if (other.x1 >= box.x2) high = Math.min(high, other.x1 - half);
        });
        return { low: Math.ceil((low - 1e-7) * 10) / 10, high: Math.floor((high + 1e-7) * 10) / 10 };
      });
      function offsets(fraction) {
        const values = [0];
        gaps.forEach((gap, index) => values.push(values[index] +
          (boxes[row[index]].width + boxes[row[index + 1]].width) / 2 + gap.gap + gap.extra * fraction));
        return values;
      }
      function feasible(values) {
        let left = limits[0].low;
        for (let index = 0; index < row.length; index++) {
          if (index) left = Math.max(limits[index].low, left + values[index] - values[index - 1]);
          if (left > limits[index].high + 1e-7) return false;
        }
        return true;
      }
      let fraction = 1;
      if (!feasible(offsets(fraction))) {
        let low = 0;
        let high = 1;
        if (!feasible(offsets(0))) continue;
        for (let attempt = 0; attempt < 16; attempt++) {
          const middle = (low + high) / 2;
          if (feasible(offsets(middle))) low = middle;
          else high = middle;
        }
        fraction = low;
      }
      const values = offsets(fraction);
      const pools = [];
      // Bounded isotonic projection opens the requested gaps with the least
      // overall movement. It borrows outer whitespace without full justification
      // or changing fonts, emoji sizes, row order or vertical positions.
      const value = pool => Math.max(pool.low, Math.min(pool.high, pool.sum / pool.count));
      row.forEach((index, offset) => {
        pools.push({ start: offset, end: offset, count: 1, sum: result[index].x - values[offset],
          low: limits[offset].low - values[offset], high: limits[offset].high - values[offset] });
        while (pools.length > 1 && value(pools[pools.length - 2]) > value(pools[pools.length - 1])) {
          const second = pools.pop();
          const first = pools.pop();
          pools.push({ start: first.start, end: second.end, count: first.count + second.count,
            sum: first.sum + second.sum, low: Math.max(first.low, second.low), high: Math.min(first.high, second.high) });
        }
      });
      for (const pool of pools) {
        for (let offset = pool.start; offset <= pool.end; offset++) {
          const index = row[offset];
          result[index].x = round(value(pool) + values[offset]);
          boxes[index].x1 = result[index].x - boxes[index].width / 2;
          boxes[index].x2 = result[index].x + boxes[index].width / 2;
        }
      }
    }
    const safe = boxes.every((box, index) => box.x1 >= slot.x && box.x2 <= slot.x + slot.width &&
      box.y1 >= slot.y && box.y2 <= slot.y + slot.height &&
      boxes.slice(0, index).every(other => !boxesOverlap(box, other)));
    return safe ? result : items.map(item => ({ ...item }));
  }

  function staggerItems(items, slot, measureContext, fontFamily) {
    if (items.length < 12 || items.length > 120) return items.map(item => ({ ...item }));
    const result = items.map(item => ({ ...item }));
    const boxes = designBoxes(result, measureContext, fontFamily);
    const inset = Math.max(1, Math.min(slot.width, slot.height) * .012);
    const targets = result.map((item, index) => {
      // Stable per-entry offsets, independent of time or browser randomness.
      // They break repeated centre lines without stretching words or jittering
      // the layout on reload. Every move below still has measured clearance.
      let hash = 2166136261;
      for (const character of String(item.text || item.id || index)) {
        hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
      }
      const across = ((hash >>> 0) % 65521) / 65521 * 2 - 1;
      const down = ((hash >>> 8) % 65521) / 65521 * 2 - 1;
      return { x: item.x + across * Math.min(slot.width * .065, boxes[index].height * 1.1),
        y: item.y + down * Math.min(slot.height * .018, boxes[index].height * .15) };
    });
    const order = result.map((_, index) => index).sort((a, b) =>
      boxes[b].height - boxes[a].height || a - b);
    // Coordinate relaxation keeps the complete existing packing as its seed.
    // Alternate the order so earlier items do not monopolize shared slack.
    for (let sweep = 0; sweep < 3; sweep++) {
      for (const index of sweep % 2 ? order.slice().reverse() : order) {
        const item = result[index];
        const box = boxes[index];
        // Keep the packer's deliberately separated artwork anchors intact.
        // Moving emoji inward can otherwise disqualify an improved text layout.
        if (box.emoji || item.type === 'image' || item.type === 'icon') continue;
        for (const axis of ['x', 'y']) {
          const half = (axis === 'x' ? box.width : box.height) / 2;
          let low = slot[axis] + inset + half;
          let high = slot[axis] + (axis === 'x' ? slot.width : slot.height) - inset - half;
          boxes.forEach((other, otherIndex) => {
            if (otherIndex === index) return;
            const horizontal = (box.spacingHeight + other.spacingHeight) * HORIZONTAL_BREATHING_RATIO;
            const vertical = (box.spacingHeight + other.spacingHeight) * VERTICAL_BREATHING_RATIO;
            if (axis === 'x') {
              if (box.y1 - vertical >= other.y2 || box.y2 + vertical <= other.y1) return;
              if (other.x2 <= box.x1) low = Math.max(low, other.x2 + horizontal + half);
              else if (other.x1 >= box.x2) high = Math.min(high, other.x1 - horizontal - half);
            } else {
              if (box.x1 - horizontal >= other.x2 || box.x2 + horizontal <= other.x1) return;
              if (other.y2 <= box.y1) low = Math.max(low, other.y2 + vertical + half);
              else if (other.y1 >= box.y2) high = Math.min(high, other.y1 - vertical - half);
            }
          });
          low = Math.ceil((low - 1e-7) * 10) / 10;
          high = Math.floor((high + 1e-7) * 10) / 10;
          if (low > high) continue;
          item[axis] = round(Math.max(low, Math.min(high, targets[index][axis])));
          box[axis + '1'] = item[axis] - half;
          box[axis + '2'] = item[axis] + half;
        }
      }
    }
    return result;
  }

  // Complement free-rectangle packing with distributed anchors. Place vertical
  // labels first, then compare the nearest free grid positions at a common
  // scale. Exact rectangles, rather than the grid, decide collision safety.
  function distributedRotationCandidate(items, slot, measureContext, fontFamily, variant) {
    if (items.length > 120) return null;
    const dimensions = items.map(item => itemDimensions(item, 1, measureContext, fontFamily));
    const vertical = items.map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type !== 'image' && item.type !== 'icon' &&
        !WordCloudCore.isEmojiOnly(item.text) && Math.abs((item.angle || 0) % 180) === 90)
      .sort((a, b) => dimensions[b.index].height - dimensions[a.index].height || a.index - b.index);
    if (vertical.length < 2) return null;
    const rotated = new Set(vertical.map(entry => entry.index));
    const emoji = items.map((_, index) => index).filter(index => WordCloudCore.isEmojiOnly(items[index].text));
    const rest = items.map((_, index) => index).filter(index => !rotated.has(index) && !emoji.includes(index))
      .sort((a, b) => (items[b].fontSize || Math.sqrt(dimensions[b].width * dimensions[b].height)) -
        (items[a].fontSize || Math.sqrt(dimensions[a].width * dimensions[a].height)) ||
        String(items[a].text || items[a].id).localeCompare(String(items[b].text || items[b].id), 'en') || a - b);
    const gap = Math.min(slot.width, slot.height) * .006;
    const columns = 56, rows = 24;
    function tryScale(scale) {
      const occupied = [];
      const positions = Array(items.length);
      function place(index, anchor) {
        const box = dimensions[index];
        const upright = rotated.has(index);
        const width = (box.width + box.spacingHeight * .2) * scale + gap;
        const height = (box.height + box.spacingHeight * .08) * scale + gap;
        if (width > slot.width || height > slot.height) return false;
        function fits(x, y) {
          const rectangle = { width, height, upright,
            x1: x - width / 2, x2: x + width / 2, y1: y - height / 2, y2: y + height / 2 };
          if (occupied.some(other => boxesOverlap(rectangle, other) ||
              (upright && other.upright && verticalPairPressure(rectangle, other, slot) > .05))) return false;
          occupied.push(rectangle); positions[index] = { x, y }; return true;
        }
        const x = width / 2 + anchor[0] * (slot.width - width);
        const y = height / 2 + anchor[1] * (slot.height - height);
        if (fits(x, y)) return true;
        let best = null, distance = Infinity;
        for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
          const px = width / 2 + column / (columns - 1) * (slot.width - width);
          const py = height / 2 + row / (rows - 1) * (slot.height - height);
          const score = ((px - x) / slot.width) ** 2 + ((py - y) / slot.height) ** 2;
          const rectangle = { width, height,
            x1: px - width / 2, x2: px + width / 2, y1: py - height / 2, y2: py + height / 2 };
          if (score >= distance || occupied.some(other => boxesOverlap(rectangle, other) ||
              (upright && other.upright && verticalPairPressure(rectangle, other, slot) > .05))) continue;
          best = { x: px, y: py }; distance = score;
        }
        return best ? fits(best.x, best.y) : false;
      }
      for (const [rank, { index }] of vertical.entries()) {
        const anchor = [.1 + .8 * ((rank * .61803398875 + variant * .19) % 1),
          .12 + .76 * ((rank * .754877666 + variant * .31) % 1)];
        if (!place(index, anchor)) return null;
      }
      for (const [rank, index] of emoji.entries()) {
        const anchor = emoji.length <= 4 ? [[.12, .18], [.87, .28], [.6, .83], [.2, .8]][rank]
          : [.08 + .84 * ((rank * .61803398875) % 1), .08 + .84 * ((rank * .754877666) % 1)];
        if (!place(index, anchor)) return null;
      }
      for (const [rank, index] of rest.entries()) {
        const leaderAnchors = variant >= 4 ? [[.2, .16], [.77, .84], [.78, .15], [.25, .84]]
          : variant % 2 ? [[.18, .3], [.84, .7], [.61, .24], [.35, .78]]
          : [[.27, .42], [.76, .22], [.42, .74], [.88, .61]];
        const anchor = rank < 4 ? leaderAnchors[rank]
          : [.08 + .84 * ((rank * .61803398875 + .43 + variant * .13) % 1),
          .08 + .84 * ((rank * .754877666 + .47 + variant * .23) % 1)];
        if (!place(index, anchor)) return null;
      }
      return positions;
    }
    let low = 0;
    let high = Math.min(...dimensions.map(box => Math.min(slot.width / box.width, slot.height / box.height)),
      Math.sqrt(slot.width * slot.height / dimensions.reduce((sum, box) => sum + box.width * box.height, 0)));
    let best = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      const scale = (low + high) / 2;
      const placed = tryScale(scale);
      if (placed) { low = scale; best = placed; } else high = scale;
    }
    if (!best || items.some(item => low < minimumScale(item))) return null;
    return items.map((item, index) => scaleItem(item, low, slot.x + best[index].x, slot.y + best[index].y));
  }

  // Stage two operates on the selected packing, rather than starting a new
  // layout. Only facing neighbours participate: distant words on the other
  // side of the design are not spacing constraints. A single physical gap is
  // shared by left/right and top/bottom, including the vertical text accents.
  function spacingNeighbours(boxes, slot, gap) {
    return boxes.map((box, index) => {
      const faces = [[], [], [], []];
      boxes.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        const dx = Math.max(box.x1 - other.x2, other.x1 - box.x2);
        const dy = Math.max(box.y1 - other.y2, other.y1 - box.y2);
        for (const [axis, cross, face] of [['x', 'y', 0], ['y', 'x', 2]]) {
          const overlap = Math.min(box[cross + '2'], other[cross + '2']) -
            Math.max(box[cross + '1'], other[cross + '1']);
          const nearCorner = dx >= 0 && dy >= 0 && Math.max(dx, dy) < gap * .3 &&
            axis === (dx >= dy ? 'x' : 'y');
          if (overlap <= .1 && !nearCorner) continue;
          const sign = other[axis + '2'] <= box[axis + '1'] ? -1
            : other[axis + '1'] >= box[axis + '2'] ? 1 : 0;
          if (!sign) continue;
          const distance = sign < 0 ? box[axis + '1'] - other[axis + '2']
            : other[axis + '1'] - box[axis + '2'];
          faces[face + (sign > 0 ? 1 : 0)].push({ index: otherIndex, axis, sign, distance,
            weight: .25 + Math.max(0, overlap) / Math.min(box[cross === 'x' ? 'width' : 'height'],
              other[cross === 'x' ? 'width' : 'height']) });
        }
      });
      return faces.flatMap((neighbours, face) => {
        if (neighbours.length) {
          const nearest = Math.min(...neighbours.map(entry => entry.distance));
          return neighbours.filter(entry => entry.distance <= nearest + gap * 2);
        }
        const axis = face < 2 ? 'x' : 'y';
        const sign = face % 2 ? 1 : -1;
        const edge = slot[axis] + (sign > 0 ? slot[axis === 'x' ? 'width' : 'height'] : 0);
        return [{ index: -1, axis, sign, edge, weight: .35,
          distance: sign > 0 ? edge - box[axis + '2'] : box[axis + '1'] - edge }];
      });
    });
  }

  function printInkBox(item, box, measureContext, fontFamily) {
    // Line boxes contain font leading; balancing those boxes alone leaves
    // visibly larger vertical gaps. Measure the actual glyphs for spacing,
    // while retaining the conservative line boxes as hard safety bounds.
    let left = -box.width / 2, right = box.width / 2;
    let top = -box.height / 2, bottom = box.height / 2;
    if (item.type !== 'image' && item.type !== 'icon' && measureContext &&
        item.fontStyle !== 'italic' && !item.underline && !item.linethrough) {
      const family = typeof fontFamily === 'function' ? fontFamily(item) : fontFamily;
      const measured = WordCloudCore.measureTextBox(item.text, item.fontSize, measureContext, family, item);
      left = -measured.width / 2; right = measured.width / 2;
      top = -measured.height / 2; bottom = measured.height / 2;
      if (box.emoji) {
        left = top = -item.fontSize * WordCloudCore.EMOJI_SIZE_RATIO / 2;
        right = bottom = -left;
      } else if (measured.runs.every(run => run.type === 'text')) {
        const ink = measureContext.measureText(item.text);
        const values = [ink.actualBoundingBoxLeft, ink.actualBoundingBoxRight,
          ink.actualBoundingBoxAscent, ink.actualBoundingBoxDescent];
        if (values.every(Number.isFinite) && ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent > 0 &&
            ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight > 0) {
          left = -measured.width / 2 - ink.actualBoundingBoxLeft;
          right = -measured.width / 2 + ink.actualBoundingBoxRight;
          top = item.fontSize * WordCloudCore.TEXT_BASELINE_OFFSET - ink.actualBoundingBoxAscent;
          bottom = item.fontSize * WordCloudCore.TEXT_BASELINE_OFFSET + ink.actualBoundingBoxDescent;
        }
      }
      const radians = (Number(item.angle) || 0) * Math.PI / 180;
      const corners = [[left, top], [left, bottom], [right, top], [right, bottom]].map(([x, y]) =>
        [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)]);
      left = Math.min(...corners.map(point => point[0])); right = Math.max(...corners.map(point => point[0]));
      top = Math.min(...corners.map(point => point[1])); bottom = Math.max(...corners.map(point => point[1]));
    }
    return { x1: item.x + left, x2: item.x + right, y1: item.y + top, y2: item.y + bottom,
      width: right - left, height: bottom - top };
  }

  function balancePrintSpacing(items, slot, measureContext, fontFamily) {
    if (items.length < 2 || items.length > CloudLimits.MAX_DESIGN_ELEMENTS) return items.map(item => ({ ...item }));
    const result = items.map(item => ({ ...item }));
    let boxes = designBoxes(result, measureContext, fontFamily);
    const shortSides = boxes.map(box => Math.min(box.width, box.height)).sort((a, b) => a - b);
    const typical = shortSides[Math.floor(shortSides.length / 2)];
    const gap = Math.max(.5, typical * .35);
    const inset = Math.max(4, Math.min(slot.width, slot.height) * .004);
    boxes.forEach((box, index) => { box.ink = printInkBox(result[index], box, measureContext, fontFamily); });
    const constraints = result.map(() => []);
    if (items.length <= 120) boxes.forEach((box, index) => boxes.slice(0, index).forEach((other, otherIndex) => {
      const dx = Math.max(box.x1 - other.x2, other.x1 - box.x2);
      const dy = Math.max(box.y1 - other.y2, other.y1 - box.y2);
      if (dx < 0 && dy < 0) return;
      const axis = dx >= 0 && (dy < 0 || dx > dy) ? 'x' : 'y';
      const sign = other[axis + '2'] <= box[axis + '1'] ? -1 : 1;
      // Preserve a separating axis for every pair throughout the solve. Tiny
      // legacy gutters can grow without making the initial system infeasible.
      const minimum = Math.max(0, Math.min(.5, (axis === 'x' ? dx : dy) * .8) - .2);
      const inkDistance = sign < 0 ? box.ink[axis + '1'] - other.ink[axis + '2']
        : other.ink[axis + '1'] - box.ink[axis + '2'];
      const minimumInk = Math.max(0, Math.min(gap * .25, inkDistance * .95));
      constraints[index].push({ index: otherIndex, axis, sign, minimum, minimumInk });
      constraints[otherIndex].push({ index, axis, sign: -sign, minimum, minimumInk });
    }));
    const original = result.map(item => ({ x: item.x, y: item.y }));
    const leaders = result.map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type !== 'image' && item.type !== 'icon' && !WordCloudCore.isEmojiOnly(item.text))
      .sort((a, b) => (b.item.layoutFontSize || b.item.fontSize) - (a.item.layoutFontSize || a.item.fontSize) ||
        String(a.item.text).localeCompare(String(b.item.text), 'en')).slice(0, 4).map(entry => entry.index);
    function quality(measured) {
      return printLayoutQuality(measured.map(box => ({ ...box,
        x1: box.x1 - slot.x, x2: box.x2 - slot.x, y1: box.y1 - slot.y, y2: box.y2 - slot.y })),
      slot.width, slot.height);
    }
    function spacingError(measured) {
      const neighbours = spacingNeighbours(measured.map(box => box.ink), slot, gap).flat();
      const weight = neighbours.reduce((sum, entry) => sum + entry.weight, 0);
      return Math.sqrt(neighbours.reduce((sum, entry) =>
        sum + entry.weight * (entry.distance - gap) ** 2, 0) / weight) / typical;
    }
    const before = quality(boxes);
    const score = measured => {
      const layout = quality(measured);
      const xs = leaders.map(index => (measured[index].x1 + measured[index].x2) / 2);
      const span = xs.length > 1 ? (Math.max(...xs) - Math.min(...xs)) / slot.width : 1;
      return spacingError(measured) + layout.emptyRegion * 4 + layout.alignment * .8 +
        Math.max(0, before.coverage - layout.coverage) * 2 + (items.length >= 12 ? Math.max(0, .4 - span) : 0) +
        (items.length > 12 && items.length <= 120 ? verticalNeighbourPressure(result, measured, slot) * .8 : 0);
    };
    let best = items.map(item => ({ ...item }));
    let bestScore = score(boxes);
    const order = result.map((_, index) => index);
    const sweeps = items.length <= 120 ? 32 : 8;
    for (let sweep = 0; sweep < sweeps; sweep++) {
      const neighbours = spacingNeighbours(boxes.map(box => box.ink), slot, gap);
      for (const index of sweep % 2 ? order.slice().reverse() : order) {
        const item = result[index];
        let box = boxes[index];
        for (const axis of ['x', 'y']) {
          const half = box[axis === 'x' ? 'width' : 'height'] / 2;
          let low = slot[axis] + inset + half;
          let high = slot[axis] + slot[axis === 'x' ? 'width' : 'height'] - inset - half;
          low = Math.max(low, slot[axis] + inset - (box.ink[axis + '1'] - item[axis]));
          high = Math.min(high, slot[axis] + slot[axis === 'x' ? 'width' : 'height'] - inset -
            (box.ink[axis + '2'] - item[axis]));
          if (items.length > 120) {
            // Capacity prints use position-only relaxation and current facing
            // obstacles, avoiding a quadratic stored constraint graph.
            const cross = axis === 'x' ? 'y' : 'x';
            boxes.forEach((other, otherIndex) => {
              if (otherIndex === index || box[cross + '1'] >= other[cross + '2'] ||
                  box[cross + '2'] <= other[cross + '1']) return;
              if (other[axis + '2'] <= box[axis + '1']) low = Math.max(low, other[axis + '2'] + .2 + half);
              else high = Math.min(high, other[axis + '1'] - .2 - half);
            });
          }
          for (const constraint of constraints[index]) {
            if (constraint.axis !== axis) continue;
            const other = boxes[constraint.index];
            if (constraint.sign < 0) low = Math.max(low, other[axis + '2'] + constraint.minimum + half,
              other.ink[axis + '2'] + constraint.minimumInk - (box.ink[axis + '1'] - item[axis]));
            else high = Math.min(high, other[axis + '1'] - constraint.minimum - half,
              other.ink[axis + '1'] - constraint.minimumInk - (box.ink[axis + '2'] - item[axis]));
          }
          let weight = .025;
          let target = original[index][axis] * weight;
          for (const neighbour of neighbours[index]) {
            if (neighbour.axis !== axis) continue;
            const edge = neighbour.index < 0 ? neighbour.edge
              : boxes[neighbour.index].ink[axis + (neighbour.sign > 0 ? '1' : '2')];
            const offset = box.ink[axis + (neighbour.sign > 0 ? '2' : '1')] - item[axis];
            target += (edge - neighbour.sign * gap - offset) * neighbour.weight;
            weight += neighbour.weight;
          }
          if (axis === 'x' && result.length >= 12 && result.length <= 120 &&
              !box.emoji && box.width > box.height * 1.5 && item.type !== 'image' && item.type !== 'icon') {
            boxes.forEach((other, otherIndex) => {
              if (otherIndex === index || other.emoji || other.width <= other.height * 1.5 ||
                  result[otherIndex].type === 'image' || result[otherIndex].type === 'icon') return;
              const down = Math.abs(item.y - result[otherIndex].y);
              const tolerance = Math.min(box.height, other.height) * .85;
              const across = item.x - result[otherIndex].x;
              if (down <= (box.height + other.height) * .5 || down >= (box.height + other.height) * 2 ||
                  Math.abs(across) >= tolerance) return;
              const sign = across === 0 ? (index > otherIndex ? 1 : -1) : Math.sign(across);
              const pull = Math.min(box.height, other.height) / typical;
              target += (result[otherIndex].x + sign * tolerance) * pull;
              weight += pull;
            });
          }
          if (axis === 'x' && result.length >= 12 && leaders.includes(index)) {
            const xs = leaders.map(leader => result[leader].x);
            const left = Math.min(...xs), right = Math.max(...xs);
            if (right - left < slot.width * .4 && (item.x === left || item.x === right)) {
              target += item.x === left ? right - slot.width * .4 : left + slot.width * .4;
              weight += 1;
            }
          }
          if (axis === 'x' && result.length > 12 && result.length <= 120 && isVerticalText(item)) {
            boxes.forEach((other, otherIndex) => {
              if (otherIndex === index || !isVerticalText(result[otherIndex])) return;
              const pressure = verticalPairPressure(box, other, slot);
              if (!pressure) return;
              const sign = item.x < result[otherIndex].x ? -1 : 1;
              const clearance = Math.max(Math.min(slot.width, slot.height) * .09, (box.width + other.width) * .8);
              target += (result[otherIndex].x + sign * ((box.width + other.width) / 2 + clearance)) * pressure * 2;
              weight += pressure * 2;
            });
          }
          low = Math.ceil((low - 1e-7) * 10) / 10;
          high = Math.floor((high + 1e-7) * 10) / 10;
          if (low > high) continue;
          const position = round(Math.max(low, Math.min(high, target / weight)));
          box.ink[axis + '1'] += position - item[axis];
          box.ink[axis + '2'] += position - item[axis];
          item[axis] = position;
          box[axis + '1'] = item[axis] - half;
          box[axis + '2'] = item[axis] + half;
        }
        if (items.length > 120 || item.type === 'image' || item.type === 'icon' || !item.layoutFontSize || sweep % 4) continue;
        let numerator = 0;
        let denominator = 0;
        for (const neighbour of neighbours[index]) {
          const axis = neighbour.axis;
          const coefficient = neighbour.sign *
            (box.ink[axis + (neighbour.sign > 0 ? '2' : '1')] - item[axis]) / item.fontSize;
          const edge = neighbour.index < 0 ? neighbour.edge
            : boxes[neighbour.index].ink[axis + (neighbour.sign > 0 ? '1' : '2')];
          numerator += neighbour.weight * coefficient * (neighbour.sign * (edge - item[axis]) - gap);
          denominator += neighbour.weight * coefficient ** 2;
        }
        const regularizer = denominator * .03;
        if (!(denominator > 0)) continue;
        const proposed = Math.max(MIN_PRINT_FONT_SIZE, item.layoutFontSize * (1 - MAX_FONT_ADJUSTMENT),
          Math.min(item.layoutFontSize * (1 + MAX_FONT_ADJUSTMENT),
            (numerator + regularizer * item.layoutFontSize) / (denominator + regularizer)));
        let maximum = proposed / item.fontSize;
        for (const axis of ['x', 'y']) {
          const half = box[axis === 'x' ? 'width' : 'height'] / 2;
          maximum = Math.min(maximum, (item[axis] - slot[axis] - inset) / half,
            (slot[axis] + slot[axis === 'x' ? 'width' : 'height'] - item[axis] - inset) / half);
        }
        for (const constraint of constraints[index]) {
          const axis = constraint.axis;
          const other = boxes[constraint.index];
          const edge = other[axis + (constraint.sign > 0 ? '1' : '2')];
          maximum = Math.min(maximum, (constraint.sign * (edge - item[axis]) - constraint.minimum) /
            (box[axis === 'x' ? 'width' : 'height'] / 2));
        }
        // Two-percent reference steps cap font trials at 21 sizes per word.
        // Position relaxation remains continuous; dozens of almost identical
        // native font instances do not improve a visible gap.
        const step = Math.max(.1, item.layoutFontSize * .02);
        const fontSize = Math.max(MIN_PRINT_FONT_SIZE, item.layoutFontSize * (1 - MAX_FONT_ADJUSTMENT),
          Math.floor(Math.floor((item.fontSize * maximum + 1e-7) / step) * step * 10) / 10);
        if (Math.abs(fontSize - item.fontSize) < .1) continue;
        const measured = designBoxes([{ ...item, fontSize }], measureContext, fontFamily)[0];
        measured.ink = printInkBox({ ...item, fontSize }, measured, measureContext, fontFamily);
        if (measured.x1 < slot.x + inset || measured.x2 > slot.x + slot.width - inset ||
            measured.y1 < slot.y + inset || measured.y2 > slot.y + slot.height - inset ||
            measured.ink.x1 < slot.x + inset || measured.ink.x2 > slot.x + slot.width - inset ||
            measured.ink.y1 < slot.y + inset || measured.ink.y2 > slot.y + slot.height - inset ||
            constraints[index].some(constraint => {
              const axis = constraint.axis;
              const other = boxes[constraint.index];
              return constraint.sign < 0 ? measured[axis + '1'] < other[axis + '2'] + constraint.minimum ||
                measured.ink[axis + '1'] < other.ink[axis + '2'] + constraint.minimumInk
                : measured[axis + '2'] > other[axis + '1'] - constraint.minimum ||
                measured.ink[axis + '2'] > other.ink[axis + '1'] - constraint.minimumInk;
            }) ||
            boxes.some((other, otherIndex) => otherIndex !== index && boxesOverlap(measured, other))) continue;
        item.fontSize = fontSize;
        boxes[index] = measured;
      }
      if (sweep % 4 !== 3) continue;
      const after = quality(boxes);
      const nextScore = score(boxes);
      if (nextScore < bestScore && after.coverage >= before.coverage * .93 &&
          after.emptyRegion <= before.emptyRegion + .01 &&
          after.alignment <= Math.max(.1, before.alignment + .03) &&
          after.corners.every((coverage, index) => coverage >= Math.min(.45, before.corners[index]))) {
        best = result.map(item => ({ ...item }));
        bestScore = nextScore;
      }
    }
    return best;
  }

  function optimizeItemsInSlot(items, slot, measureContext, fontFamily) {
    if (!items.length) return [];
    measureContext = cachedMeasurements(measureContext);
    // Preferred sizes are working-draft metadata, not print geometry. Keep
    // them through subsequent clicks so the 20% allowance cannot compound.
    const preferred = items.map(item => {
      if (item.type === 'image' || item.type === 'icon') return { ...item };
      const reference = Number(item.layoutFontSize);
      const ratio = item.fontSize / reference;
      const fontSize = Number.isFinite(reference) && reference >= 1 &&
        ratio >= 1 - MAX_FONT_ADJUSTMENT - .002 && ratio <= 1 + MAX_FONT_ADJUSTMENT + .002
        ? reference : item.fontSize;
      return { ...item, fontSize, layoutFontSize: fontSize };
    });
    const leadingIndices = preferred.map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type !== 'image' && item.type !== 'icon' && !WordCloudCore.isEmojiOnly(item.text))
      .sort((a, b) => b.item.fontSize - a.item.fontSize ||
        String(a.item.text).localeCompare(String(b.item.text), 'en') || a.index - b.index)
      .slice(0, 4).map(entry => entry.index);
    function quality(design) {
      if (!Array.isArray(design) || design.length !== items.length) return null;
      const boxes = designBoxes(design, measureContext, fontFamily);
      const safe = boxes.every((box, index) => box.x1 >= slot.x && box.x2 <= slot.x + slot.width &&
        box.y1 >= slot.y && box.y2 <= slot.y + slot.height &&
        boxes.slice(0, index).every(other => !boxesOverlap(box, other)));
      if (!safe) return null;
      const bounds = { x1: Math.min(...boxes.map(box => box.x1)), x2: Math.max(...boxes.map(box => box.x2)),
        y1: Math.min(...boxes.map(box => box.y1)), y2: Math.max(...boxes.map(box => box.y2)) };
      const deviation = design.reduce((sum, item) => sum + (item.layoutFontSize > 0
        ? Math.abs(Math.log(item.fontSize / item.layoutFontSize)) : 0), 0) / design.length;
      const result = { ...printLayoutQuality(boxes.map(box => ({ ...box,
        x1: box.x1 - slot.x, x2: box.x2 - slot.x, y1: box.y1 - slot.y, y2: box.y2 - slot.y })),
      slot.width, slot.height), bounds };
      result.score -= deviation * .15;
      result.pressure = breathingRoomPressure(boxes);
      result.score -= result.pressure * .45;
      result.verticalNeighbours = items.length > 12 && items.length <= 120
        ? verticalNeighbourPressure(design, boxes, slot) : 0;
      result.shortVerticals = boxes.filter((box, index) => isVerticalText(design[index]) && box.height <= box.width * 3.5).length;
      result.score -= result.verticalNeighbours * .6;
      const leadingX = leadingIndices.map(index => design[index].x);
      result.leadingSpread = leadingX.length > 1 ? (Math.max(...leadingX) - Math.min(...leadingX)) / slot.width : 1;
      if (items.length >= 12) result.score -= Math.max(0, .4 - result.leadingSpread);
      return result;
    }
    function fingerprint(design, revision = 11) {
      // Working-draft provenance only. Include all geometry and measured font
      // choices so any edit/product change invalidates it; never trust it in
      // place of the measured overlap/boundary checks above.
      const fields = [slot.x, slot.y, slot.width, slot.height,
        design.map(item => [item.id, item.type || 'text', item.text || item.icon || '',
          round(item.x), round(item.y), round(item.angle || 0),
          round(item.fontSize || item.size || 0), round(item.width || 0), round(item.height || 0),
          round(item.layoutFontSize || 0),
          typeof fontFamily === 'function' ? fontFamily(item) : fontFamily,
          item.fontWeight || 400, item.fontStyle || 'normal', !!item.underline, !!item.linethrough])];
      if (revision >= 2) fields.unshift(revision);
      const geometry = JSON.stringify(fields);
      let hash = 2166136261;
      let second = 5381;
      for (let index = 0; index < geometry.length; index++) {
        hash = Math.imul(hash ^ geometry.charCodeAt(index), 16777619);
        second = Math.imul(second, 33) ^ geometry.charCodeAt(index);
      }
      return `${(hash >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
    }
    if (items[0].layoutFingerprint === fingerprint(items) && quality(items)) {
      return items.map(item => ({ ...item }));
    }
    function finish(design) {
      if (!design || !quality(design)) return null;
      const filled = design.map(item => item.type === 'image' || item.type === 'icon' ? { ...item }
        : { ...item, layoutFontSize: item.layoutFontSize || item.fontSize });
      // Enlarge text into genuine free space, retaining image proportions and
      // a fixed preferred-size reference. Exact measured bounds decide safety.
      if (filled.length <= 120) {
        const boxes = designBoxes(filled, measureContext, fontFamily);
        const gap = Math.max(.2, Math.min(slot.width, slot.height) * .002);
        const order = filled.map((_, index) => index).sort((a, b) =>
          boxes[a].width * boxes[a].height - boxes[b].width * boxes[b].height || a - b);
        for (const index of order) {
          const item = filled[index];
          if (item.type === 'image' || item.type === 'icon') continue;
          let low = item.fontSize;
          const current = boxes[index];
          // Estimate the nearest boundary/neighbor analytically. This avoids
          // measuring sixteen huge fonts on blanket/poster canvases when the
          // first measured proposal already fits. Actual metrics still decide
          // acceptance; non-linear rounding falls back to bounded bisection.
          let factor = Math.min((1 + MAX_FONT_ADJUSTMENT) * item.layoutFontSize / low,
            2 * (item.x - slot.x - 1) / current.width,
            2 * (slot.x + slot.width - item.x - 1) / current.width,
            2 * (item.y - slot.y - 1) / current.height,
            2 * (slot.y + slot.height - item.y - 1) / current.height);
          boxes.forEach((other, otherIndex) => {
            if (otherIndex === index) return;
            const acrossDistance = Math.max(item.x - other.x2, other.x1 - item.x);
            const downDistance = Math.max(item.y - other.y2, other.y1 - item.y);
            const across = Math.min(2 * (acrossDistance - gap) / current.width,
              2 * (acrossDistance - other.spacingHeight * HORIZONTAL_BREATHING_RATIO) /
                (current.width + current.spacingHeight * HORIZONTAL_BREATHING_RATIO * 2));
            const down = Math.min(2 * (downDistance - gap) / current.height,
              2 * (downDistance - other.spacingHeight * VERTICAL_BREATHING_RATIO) /
                (current.height + current.spacingHeight * VERTICAL_BREATHING_RATIO * 2));
            factor = Math.min(factor, Math.max(across, down));
          });
          let high = Math.floor(low * Math.max(1, factor) * 10) / 10;
          function fits(fontSize) {
            const dimensions = itemDimensions({ ...item, fontSize }, 1, measureContext, fontFamily);
            const box = { ...dimensions, emoji: current.emoji,
              x1: item.x - dimensions.width / 2, x2: item.x + dimensions.width / 2,
              y1: item.y - dimensions.height / 2, y2: item.y + dimensions.height / 2 };
            return box.x1 >= slot.x + 1 && box.x2 <= slot.x + slot.width - 1 &&
              box.y1 >= slot.y + 1 && box.y2 <= slot.y + slot.height - 1 &&
              boxes.every((other, otherIndex) => {
                if (otherIndex === index) return true;
                const horizontal = Math.max(gap, (box.spacingHeight + other.spacingHeight) * HORIZONTAL_BREATHING_RATIO);
                const vertical = Math.max(gap, (box.spacingHeight + other.spacingHeight) * VERTICAL_BREATHING_RATIO);
                return !boxesOverlap({ x1: box.x1 - horizontal, x2: box.x2 + horizontal,
                  y1: box.y1 - vertical, y2: box.y2 + vertical }, other);
              });
          }
          if (high > low && fits(high)) low = high;
          else for (let attempt = 0; attempt < 16 && high - low >= .05; attempt++) {
            const fontSize = (low + high) / 2;
            if (fits(fontSize)) low = fontSize;
            else high = fontSize;
          }
          item.fontSize = Math.floor(low * 10) / 10;
          boxes[index] = designBoxes([item], measureContext, fontFamily)[0];
        }
      }
      const measured = quality(filled);
      if (!measured) return null;
      const dx = slot.x + slot.width / 2 - (measured.bounds.x1 + measured.bounds.x2) / 2;
      const dy = slot.y + slot.height / 2 - (measured.bounds.y1 + measured.bounds.y2) / 2;
      const centred = filled.map(item => ({ ...item, x: round(item.x + dx), y: round(item.y + dy) }));
      const spaced = relaxHorizontalSpacing(quality(centred) ? centred : filled, slot, measureContext, fontFamily);
      return quality(spaced) ? spaced : filled;
    }
    const candidates = [];
    const add = design => {
      const candidate = finish(design);
      if (!candidate) return;
      candidates.push(candidate);
      const staggered = staggerItems(candidate, slot, measureContext, fontFamily);
      const before = quality(candidate);
      const after = quality(staggered);
      if (after && after.corners.every((coverage, index) => coverage >= Math.min(.45, before.corners[index]))) {
        candidates.push(staggered);
      }
    };
    function packedCandidate(reference, placement = 'importance') {
      const topSize = Math.max(...reference.map(item => item.fontSize || 0));
      const packed = WordCloudCore.layoutBoxesInArea(reference.map(item => {
        const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
        return { width: dimensions.width + dimensions.spacingHeight * HORIZONTAL_BREATHING_RATIO * 2,
          height: dimensions.height + dimensions.spacingHeight * VERTICAL_BREATHING_RATIO * 2, emoji: WordCloudCore.isEmojiOnly(item.text),
          priority: placement === 'neutral' ? 1 : placement === 'area' ? Math.sqrt(dimensions.width * dimensions.height)
            : placement === 'accents' && Math.abs((item.angle || 0) % 180) === 90 ? Math.max(item.fontSize || 0, topSize * .8)
            : item.type === 'image' || item.type === 'icon'
            ? Math.sqrt(dimensions.width * dimensions.height) : item.fontSize };
      }), slot.width, slot.height);
      if (packed.length !== reference.length || packed.some((box, index) =>
        box.scale < minimumScale(reference[index]))) return null;
      return reference.map((item, index) => scaleItem(item, packed[index].scale,
        slot.x + packed[index].x, slot.y + packed[index].y));
    }
    add(packedCandidate(preferred));
    const horizontal = preferred.map(item => item.type !== 'image' && item.type !== 'icon' &&
      (Number(item.angle) || 0) % 90 === 0 ? { ...item, angle: 0 } : { ...item });
    if (items.some((item, index) => item.angle !== horizontal[index].angle)) {
      add(packedCandidate(horizontal));
    }
    if (items.length > 12 && items.length <= 120) {
      // Placement priority is independent of printed size. Compare additional
      // orders so a tiny font-metric difference cannot force every candidate
      // into the same centre stack. Actual sizes retain their preferred ratios.
      add(packedCandidate(horizontal, 'neutral'));
      add(packedCandidate(horizontal, 'area'));
    }
    add(rowCandidate(horizontal, slot, measureContext, fontFamily));
    const rotatable = horizontal.map((item, index) => ({ item, index,
      box: itemDimensions(item, 1, measureContext, fontFamily) }))
      .filter(({ item, box }) => item.type !== 'image' && item.type !== 'icon' &&
        !WordCloudCore.isEmojiOnly(item.text) && (Number(item.angle) || 0) === 0 && box.width > box.height * 1.5)
      .sort((a, b) => a.box.width / a.box.height - b.box.width / b.box.height || a.index - b.index);
    const textCount = horizontal.filter(item => item.type !== 'image' && item.type !== 'icon' &&
      !WordCloudCore.isEmojiOnly(item.text)).length;
    const textSizes = horizontal.filter(item => item.type !== 'image' && item.type !== 'icon' &&
      !WordCloudCore.isEmojiOnly(item.text)).map(item => item.fontSize || 0).sort((a, b) => a - b);
    const medianSize = textSizes[Math.floor(textSizes.length / 2)];
    // Short medium-sized labels add staggered vertical accents; restricting
    // rotations to tiny text favors long phrases with nearly full-height spans.
    function rotationAccents(pool) {
      const singleWords = pool.filter(entry => !/\s/u.test(entry.item.text));
      return singleWords.length >= Math.max(2, Math.round(textCount * .2)) ? singleWords : pool;
    }
    const accents = rotationAccents(rotatable.filter(entry => entry.item.fontSize <= medianSize));
    const mediumAccents = rotationAccents(rotatable.filter(entry => entry.item.fontSize <= medianSize * 1.2 &&
      !leadingIndices.includes(entry.index)));
    const verticalTarget = Math.min(Math.max(accents.length, mediumAccents.length), Math.max(1,
      Math.min(Math.round(textCount * .2), Math.floor(rotatable.length * .45))));
    if (rotatable.length >= 3) {
      // Wide, dense designs should keep their prominent words easy to read.
      // Try short upright labels as vertical accents instead of
      // turning the leading words into another column-like structure.
      // Sparse clouds need to try short labels above the median too. Their
      // similar sizes are often the best fit for the print's height; retain
      // prominent outliers horizontally when vote weights differ strongly.
      const sparseChoices = rotatable.filter(entry => entry.item.fontSize <= medianSize * 1.2);
      function rotationChoice(source, variant) {
        const count = Math.max(2, Math.min(source.length, verticalTarget + (variant === 0 ? -1 : variant === 3 ? 1 : 0)));
        const pool = source.slice(0, Math.min(source.length, count * 2));
        return { variant, rotated: new Set(Array.from({ length: count }, (_, index) =>
          pool[(Math.floor(index * pool.length / count) + variant) % pool.length]?.index).filter(index => index !== undefined)) };
      }
      const choices = items.length <= 12
        ? sparseChoices.slice(0, 5).map((entry, variant) => ({ variant, rotated: new Set([entry.index]) }))
        : Array.from({ length: items.length > 120 ? 1 : 4 }, (_, variant) => rotationChoice(accents, variant));
      if (items.length > 12 && items.length <= 120) {
        // Keep the smaller-word portfolio too: medium accents must improve the
        // composition rather than replace a better-filled candidate outright.
        choices.push(...[0, 2].map(variant => rotationChoice(mediumAccents, variant)));
      }
      if (items.length <= 12) choices.push({ variant: choices.length,
        rotated: new Set(sparseChoices.slice(0, 2).map(entry => entry.index)) });
      for (const { variant, rotated } of choices) {
        const reference = horizontal.map((item, index) => rotated.has(index)
          ? { ...item, angle: -90, fontSize: item.fontSize * (1 - MAX_FONT_ADJUSTMENT) } : item);
        add(packedCandidate(reference));
        if (items.length > 12 && items.length <= 120) add(packedCandidate(reference, 'neutral'));
        if (items.length > 12 && items.length <= 120) add(packedCandidate(reference, 'area'));
        if (items.length > 12 && items.length <= 120) add(packedCandidate(reference, 'accents'));
        if (items.length > 12 && items.length <= 120) {
          add(distributedRotationCandidate(reference, slot, measureContext, fontFamily, variant));
          add(distributedRotationCandidate(reference, slot, measureContext, fontFamily, variant + 4));
        }
        if (items.length <= 8) add(rowCandidate(reference, slot, measureContext, fontFamily));
        if (items.length <= 12 && rotated.size === 1 && slot.width > slot.height * 1.5) {
          // A tall accent need not split a sparse design into two cramped
          // columns. Compare it beside a row packing of the remaining phrases.
          const index = [...rotated][0];
          const dimensions = itemDimensions(reference[index], 1, measureContext, fontFamily);
          const inset = Math.max(4, Math.min(slot.width, slot.height) * .012);
          const scaleLimit = (slot.height - inset * 2) / dimensions.height;
          const reserve = dimensions.width * scaleLimit + inset * 2;
          const rest = reference.filter((_, itemIndex) => itemIndex !== index);
          for (const left of [true, false]) {
            const area = { ...slot, x: slot.x + (left ? reserve : 0), width: slot.width - reserve };
            if (area.width <= 0) continue;
            const rows = rowCandidate(rest, area, measureContext, fontFamily);
            if (!rows) continue;
            const anchor = rest.findIndex(item => item.layoutFontSize > 0);
            if (anchor < 0) continue;
            const scale = rows[anchor].layoutFontSize / rest[anchor].layoutFontSize;
            if (scale > scaleLimit) continue;
            const accent = scaleItem(reference[index], scale, slot.x + (left ? reserve / 2 : slot.width - reserve / 2),
              slot.y + slot.height / 2);
            const withAccent = rows.slice();
            withAccent.splice(index, 0, accent);
            add(withAccent);
          }
        }
      }
    }
    if (items.length > 12 && items.length <= 120 && rotatable.length >= 3) {
      // Preserve a strong first layout when a short accent can turn in its
      // existing pocket. Repacking every other word is unnecessary in this
      // case, and can otherwise sacrifice a well-filled corner.
      const seeds = candidates.filter(design => design.every(item => !item.angle))
        .map(design => ({ design, quality: quality(design) }))
        .sort((a, b) => b.quality.score - a.quality.score).slice(0, 3);
      for (const seed of seeds) {
        const measured = designBoxes(seed.design, measureContext, fontFamily);
        measured.forEach((box, index) => { box.ink = printInkBox(seed.design[index], box, measureContext, fontFamily); });
        const median = horizontal.map(item => item.fontSize || 0).sort((a, b) => a - b)[Math.floor(horizontal.length / 2)];
        for (const { index } of rotatable.filter(entry => entry.item.fontSize <= median).slice(0, 4)) {
          const source = seed.design[index];
          for (const factor of [1, .8]) {
            const accent = { ...source, angle: -90,
              fontSize: Math.max(source.layoutFontSize * (1 - MAX_FONT_ADJUSTMENT), source.fontSize * factor) };
            const box = designBoxes([accent], measureContext, fontFamily)[0];
            const ink = printInkBox(accent, box, measureContext, fontFamily);
            if (box.x1 < slot.x || box.x2 > slot.x + slot.width || box.y1 < slot.y || box.y2 > slot.y + slot.height ||
                measured.some((other, otherIndex) => {
                  if (otherIndex === index) return false;
                  const clearance = Math.min(ink.width, ink.height, other.ink.width, other.ink.height) * .1;
                  const across = Math.max(0, ink.x1 - other.ink.x2, other.ink.x1 - ink.x2);
                  const down = Math.max(0, ink.y1 - other.ink.y2, other.ink.y1 - ink.y2);
                  return boxesOverlap(box, other) || (across < clearance && down < clearance);
                })) continue;
            const turned = seed.design.map((item, itemIndex) => itemIndex === index ? accent : { ...item });
            candidates.push(turned);
            break;
          }
        }
      }
    }
    // A limiting phrase can constrain the common scale. Try shrinking the
    // two strongest width/height constraints, retaining the unmodified
    // preferred-size reference. Subsequent growth may recover that space,
    // but every text stays within 80–120% of the same overall scale.
    const limiting = horizontal.map((item, index) => ({ item, index,
      box: itemDimensions(item, 1, measureContext, fontFamily) }))
      .filter(({ item }) => item.type !== 'image' && item.type !== 'icon' && !WordCloudCore.isEmojiOnly(item.text))
      .sort((a, b) => Math.max(b.box.width / slot.width, b.box.height / slot.height) -
        Math.max(a.box.width / slot.width, a.box.height / slot.height) || a.index - b.index);
    for (const entry of limiting.slice(0, items.length <= 12 ? 2 : 1)) {
      const reference = horizontal.map((item, index) => index === entry.index
        ? { ...item, fontSize: item.fontSize * (1 - MAX_FONT_ADJUSTMENT) } : item);
      add(packedCandidate(reference));
      if (items.length <= 12) add(rowCandidate(reference, slot, measureContext, fontFamily));
    }
    if (!candidates.length) return items.map(item => ({ ...item }));
    const scored = candidates.map(design => ({ design, quality: quality(design) }));
    let eligible = scored;
    const verticalCount = design => design.filter(item => item.type !== 'image' && item.type !== 'icon' &&
      !WordCloudCore.isEmojiOnly(item.text) && Math.abs((Number(item.angle) || 0) % 180) === 90).length;
    // Count actual text, never emoji or uploaded artwork. Several vertical
    // words should participate in a dense composition with a horizontal majority.
    const mixed = scored.filter(entry => verticalCount(entry.design) > 0);
    const minimumVertical = textCount >= 12 ? Math.max(2, verticalTarget - 1) : 1;
    const balancedMix = mixed.filter(entry => verticalCount(entry.design) >= minimumVertical &&
      verticalCount(entry.design) <= Math.max(1, Math.floor(textCount * .35)));
    if (balancedMix.length) eligible = balancedMix;
    else if (mixed.length && rotatable.length >= 3) eligible = mixed;
    function verticalSpread(design) {
      const vertical = design.filter(item => item.type !== 'image' && item.type !== 'icon' &&
        !WordCloudCore.isEmojiOnly(item.text) && Math.abs((Number(item.angle) || 0) % 180) === 90);
      if (vertical.length < 2) return 0;
      const across = (Math.max(...vertical.map(item => item.x)) - Math.min(...vertical.map(item => item.x))) / slot.width;
      const down = (Math.max(...vertical.map(item => item.y)) - Math.min(...vertical.map(item => item.y))) / slot.height;
      const inside = vertical.filter(item => item.x > slot.x + slot.width * .2 &&
        item.x < slot.x + slot.width * .8).length;
      const target = Math.min(.3, .65 / Math.sqrt(vertical.length));
      const separation = vertical.reduce((sum, item, index) => sum + Math.min(1,
        Math.min(...vertical.filter((_, other) => other !== index).map(other =>
          Math.hypot((item.x - other.x) / slot.width, (item.y - other.y) / slot.height))) / target), 0) / vertical.length;
      const score = (Math.min(1, across / .55) * .7 + Math.min(1, down / .4) * .3) * .35 +
        Math.min(1, inside / Math.max(1, Math.floor(vertical.length / 3))) * .15 + separation * .5;
      return inside >= Math.min(2, Math.floor(vertical.length / 3)) ? score : score * .75;
    }
    eligible.forEach(entry => { entry.quality.score += verticalSpread(entry.design) * .15 -
      Math.abs(verticalCount(entry.design) - verticalTarget) / Math.max(1, verticalTarget) * .05; });
    const spatialMix = eligible.filter(entry => verticalSpread(entry.design) >= .8);
    if (spatialMix.length) eligible = spatialMix;
    const spreadLeaders = eligible.filter(entry => entry.quality.leadingSpread >= .35);
    if (spreadLeaders.length && items.length >= 12) eligible = spreadLeaders;
    // A dense legacy packing can inflate box coverage by grouping upright
    // words. Do not let that baseline veto an already well-filled mixed layout.
    const minimumMixCoverage = Math.min(.5, Math.max(...eligible.map(entry => entry.quality.coverage)) * .82);
    const unclustered = items.length > 12 && items.length <= 120 ? eligible.filter(entry => entry.quality.verticalNeighbours <= .12 &&
      entry.quality.coverage >= minimumMixCoverage &&
      entry.quality.emptyRegion < .05 && entry.quality.alignment <= .2) : [];
    if (unclustered.length) eligible = unclustered;
    const variedSpans = items.length > 12 && items.length <= 120 ? eligible.filter(entry =>
      entry.quality.shortVerticals >= Math.min(2, Math.ceil(verticalCount(entry.design) * .25)) &&
      entry.quality.coverage > .5 && entry.quality.emptyRegion < .05 &&
      entry.quality.verticalNeighbours <= .12 && entry.quality.alignment <= .15) : [];
    if (variedSpans.length) eligible = variedSpans;
    if (eligible.some(entry => entry.quality.separation >= .8)) eligible = eligible.filter(entry => entry.quality.separation >= .8);
    // A visibly stacked centre is not rescued by a few extra percent of box
    // coverage. Prefer a similarly filled, staggered candidate when available;
    // a large empty band still disqualifies it. Sparse row layouts are exempt.
    const fullest = Math.max(...eligible.map(entry => entry.quality.coverage));
    const smallestHole = Math.min(...eligible.map(entry => entry.quality.emptyRegion));
    const staggered = eligible.filter(entry => entry.quality.alignment <= .1 &&
      entry.quality.coverage >= fullest * (unclustered.length ? .96 : .8) &&
      entry.quality.emptyRegion <= smallestHole + .02);
    if (staggered.length) eligible = staggered;
    // Keep all four corners participating when a comparable candidate can do
    // so; improved average density must not strand one corner of the print.
    const comparableCoverage = Math.max(...eligible.map(entry => entry.quality.coverage)) * .85;
    const comparableHole = Math.min(...eligible.map(entry => entry.quality.emptyRegion)) + .012;
    const filledCorners = eligible.filter(entry => entry.quality.corners.every(coverage => coverage > .45) &&
      entry.quality.coverage >= comparableCoverage && entry.quality.emptyRegion <= comparableHole);
    if (filledCorners.length) eligible = filledCorners;
    const smallestEligibleHole = Math.min(...eligible.map(entry => entry.quality.emptyRegion));
    const closePockets = eligible.filter(entry => entry.quality.emptyRegion <= smallestEligibleHole + .003 &&
      entry.quality.coverage >= Math.max(...eligible.map(entry => entry.quality.coverage)) * .9);
    if (closePockets.length) eligible = closePockets;
    const spreadAccents = eligible.filter(entry => verticalSpread(entry.design) >= .8 &&
      entry.quality.coverage >= Math.max(...eligible.map(entry => entry.quality.coverage)) * .9);
    if (spreadAccents.length) eligible = spreadAccents;
    eligible.sort((a, b) => b.quality.score - a.quality.score);
    let best = eligible[0];
    const current = quality(items);
    // Retain an equally good composition, including after Fabric/JSON
    // rounding. Fill still repairs overlaps, undersizing and displaced work.
    if (current && current.score >= best.quality.score - .015 &&
        Math.abs((current.bounds.x1 + current.bounds.x2) / 2 - slot.x - slot.width / 2) < .5 &&
        Math.abs((current.bounds.y1 + current.bounds.y2) / 2 - slot.y - slot.height / 2) < .5 &&
        (current.alignment <= .1 || best.quality.alignment > .1) &&
        (current.corners.every(coverage => coverage > .45) || !best.quality.corners.every(coverage => coverage > .45)) &&
        (current.separation >= .8 || best.quality.separation < .8) &&
        current.verticalNeighbours <= best.quality.verticalNeighbours + .02 &&
        (verticalSpread(items) >= .8 || verticalSpread(best.design) < .8) &&
        (verticalCount(items) >= minimumVertical || !balancedMix.length)) best.design = items.map(item => ({ ...item }));
    // The first stage chooses the packing. Only then balance all four faces
    // together, close pockets with bounded size changes, and measure again.
    let polished = eligible.slice(0, items.length > 120 ? 1 : items.length <= 12 ? 6 : 3).map(entry => {
      const design = balancePrintSpacing(entry.design, slot, measureContext, fontFamily);
      const completedQuality = quality(design);
      // Equalizing glyph gaps must not undo the useful coverage that made a
      // mixed short/long accent layout eligible in the first place.
      return variedSpans.length && completedQuality && completedQuality.coverage <= .5
        ? entry : { design, quality: completedQuality };
    }).filter(entry => entry.quality);
    const wellSpacedCorners = polished.filter(entry => entry.quality.corners.every(coverage => coverage > .45));
    if (wellSpacedCorners.length) polished = wellSpacedCorners;
    const separated = polished.filter(entry => entry.quality.separation >= .8);
    if (separated.length) polished = separated;
    const natural = polished.filter(entry => entry.quality.alignment <= .1);
    if (natural.length) polished = natural;
    const distributed = polished.filter(entry => verticalSpread(entry.design) >= .8);
    if (distributed.length) polished = distributed;
    const isolated = polished.filter(entry => entry.quality.verticalNeighbours <= .12);
    if (isolated.length) polished = isolated;
    const wideLeaders = polished.filter(entry => entry.quality.leadingSpread >= .35);
    if (wideLeaders.length && items.length >= 12) polished = wideLeaders;
    // Choose on the completed geometry. A good first packing can have less
    // freedom to equalize its gaps than another equally good starting point.
    polished.sort((a, b) => (b.quality.score + b.quality.pressure * .45 + verticalSpread(b.design) * .15) -
      (a.quality.score + a.quality.pressure * .45 + verticalSpread(a.design) * .15));
    if (polished.length) best = polished[0];
    const completed = best.design;
    completed[0].layoutFingerprint = fingerprint(completed);
    return completed;
  }

  function optimizeDesign(design, slots, measureContext, options = {}) {
    if (!Array.isArray(design) || !design.length) return [];
    const targets = normalizedSlots(slots);
    if (!targets.length) return design.map((item) => ({ ...item }));
    const fontFamily = options.fontFamily || 'Georgia, "Times New Roman", serif';
    const grouped = targets.map(() => []);
    design.forEach((item, index) => {
      grouped[nearestSlotIndex(item, targets)].push({ item, index });
    });

    const optimizedByIndex = new Map();
    grouped.forEach((group, slotIndex) => {
      const optimized = optimizeItemsInSlot(
        group.map(({ item }) => item),
        targets[slotIndex],
        measureContext,
        fontFamily
      );
      group.forEach(({ index }, itemIndex) => optimizedByIndex.set(index, optimized[itemIndex]));
    });
    return design.map((item, index) => optimizedByIndex.get(index) || { ...item });
  }

  function spreadDesignColors(design, colors, measureContext, options = {}) {
    if (!Array.isArray(design)) return [];
    const fontFamily = options.fontFamily || 'Georgia, "Times New Roman", serif';
    const boxes = design.map((item) => {
      const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
      return {
        ...item,
        colorable: item.type !== 'image' &&
          (item.type === 'icon' || !WordCloudCore.isEmojiOnly(item.text)),
        x1: item.x - dimensions.width / 2,
        x2: item.x + dimensions.width / 2,
        y1: item.y - dimensions.height / 2,
        y2: item.y + dimensions.height / 2,
      };
    });
    return WordCloudCore.spreadPaletteColors(boxes, colors).map((item, index) => {
      const colored = { ...design[index] };
      if (item.color != null && design[index].type !== 'image') colored.color = item.color;
      return colored;
    });
  }

  function applyLayoutAction(design, slots, measureContext, options = {}) {
    const targets = normalizedSlots(slots);
    return targets.some((slot) => slot.optimize)
      ? optimizeDesign(design, targets, measureContext, options)
      : arrangeDesign(design, targets, measureContext, options);
  }

  // Restore an older draft into updated print guidelines without repacking it
  // or moving its words independently. Already-safe designs stay byte-for-byte
  // unchanged; approved server snapshots are never rewritten by this helper.
  function fitDesignToSafeArea(design, area, measureContext, options = {}) {
    if (!design.length) return { design, adjusted: false };
    const boxes = design.map(item => {
      const box = itemDimensions(item, 1, measureContext, options.fontFamily);
      return { left: item.x - box.width / 2, right: item.x + box.width / 2,
        top: item.y - box.height / 2, bottom: item.y + box.height / 2 };
    });
    const left = Math.min(...boxes.map(box => box.left));
    const right = Math.max(...boxes.map(box => box.right));
    const top = Math.min(...boxes.map(box => box.top));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    if (left >= area.x && right <= area.x + area.width &&
        top >= area.y && bottom <= area.y + area.height) return { design, adjusted: false };
    const scale = Math.min(1, (area.width - 4) / (right - left), (area.height - 4) / (bottom - top));
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    return { adjusted: true, design: design.map(item => scaleItem(item, scale,
      area.x + area.width / 2 + (item.x - centerX) * scale,
      area.y + area.height / 2 + (item.y - centerY) * scale)) };
  }

  return { applyLayoutAction, optimizeDesign, spreadDesignColors, fitDesignToSafeArea, printLayoutQuality,
    balancePrintSpacing };
});
