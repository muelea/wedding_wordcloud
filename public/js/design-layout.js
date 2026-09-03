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

  function repackItemsInSlot(items, slot, measureContext, fontFamily) {
    if (!items.length) return [];
    const boxes = items.map(item => {
      const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
      return { ...dimensions, emoji: WordCloudCore.isEmojiOnly(item.text), priority: item.type === 'image' || item.type === 'icon'
        ? Math.sqrt(dimensions.width * dimensions.height) : item.fontSize };
    });
    // The editor rounds to 0.1 print pixels. That must not make another click
    // shuffle an already centred, full-size cloud into an equivalent layout.
    // Keep a safe existing arrangement unless repacking makes it meaningfully
    // larger. This also protects a manually composed, equally good design.
    const current = items.map((item, index) => ({
      emoji: boxes[index].emoji,
      x1: item.x - boxes[index].width / 2, x2: item.x + boxes[index].width / 2,
      y1: item.y - boxes[index].height / 2, y2: item.y + boxes[index].height / 2,
    }));
    const safe = current.every((box, index) =>
      box.x1 >= slot.x && box.x2 <= slot.x + slot.width &&
      box.y1 >= slot.y && box.y2 <= slot.y + slot.height &&
      current.slice(0, index).every(other => !boxesOverlap(box, other)));
    const bounds = {
      x1: Math.min(...current.map(box => box.x1)), x2: Math.max(...current.map(box => box.x2)),
      y1: Math.min(...current.map(box => box.y1)), y2: Math.max(...current.map(box => box.y2)),
    };
    const inset = Math.min(slot.width, slot.height) * .012;
    const centred = Math.abs((bounds.x1 + bounds.x2) / 2 - slot.x - slot.width / 2) < .5 &&
      Math.abs((bounds.y1 + bounds.y2) / 2 - slot.y - slot.height / 2) < .5;
    const fullSize = (items.length <= 10 ? Math.min : Math.max)(
      (slot.width - inset * 2) / (bounds.x2 - bounds.x1),
      (slot.height - inset * 2) / (bounds.y2 - bounds.y1)
    ) < 1.03;
    const currentQuality = WordCloudCore.layoutQuality(current.map(box => ({
      emoji: box.emoji,
      x1: box.x1 - slot.x, x2: box.x2 - slot.x,
      y1: box.y1 - slot.y, y2: box.y2 - slot.y,
    })), slot.width, slot.height);
    // Use the same hole/balance check as the live packer. Filled corners alone
    // must not preserve an internal gap on repeated fit-area clicks.
    if (safe && centred && fullSize && WordCloudCore.isLayoutBalanced(currentQuality, items.length)) {
      return items.map(item => ({ ...item }));
    }
    const packed = WordCloudCore.layoutBoxesInArea(boxes, slot.width, slot.height);
    if (packed.length !== items.length ||
        packed.some((box, index) => box.scale < minimumScale(items[index]))) {
      return items.map(item => ({ ...item }));
    }
    const packedQuality = WordCloudCore.layoutQuality(packed, slot.width, slot.height);
    if (safe && centred && packed[0].scale <= 1.01 &&
        currentQuality.score >= packedQuality.score - .025) {
      return items.map(item => ({ ...item }));
    }
    return items.map((item, index) => scaleItem(item, packed[index].scale,
      slot.x + packed[index].x, slot.y + packed[index].y));
  }

  function optimizeItemsInSlot(items, slot, measureContext, fontFamily) {
    // Round-trip through the same 0.1px representation as Fabric/JSON before
    // accepting a layout. Tiny metric rounding can change which free rectangle
    // fits best. Return only a fixed point, so a second click cannot improve or
    // reshuffle the result. A bounded failure leaves the source untouched.
    let current = items;
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = repackItemsInSlot(current, slot, measureContext, fontFamily);
      if (JSON.stringify(next) === JSON.stringify(current)) return next;
      current = next;
    }
    return items.map(item => ({ ...item }));
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

  function applyLayoutAction(design, slots, measureContext, options = {}) {
    const targets = normalizedSlots(slots);
    return targets.some((slot) => slot.optimize)
      ? optimizeDesign(design, targets, measureContext, options)
      : arrangeDesign(design, targets, measureContext, options);
  }

  return { applyLayoutAction, optimizeDesign };
});
