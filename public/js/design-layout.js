(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DesignLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

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
    const type = item.type === 'image' ? 'foto' : item.type === 'icon' ? 'motiv' : 'wort';
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
      width = Math.max(1, Number(item.width) || 48);
      height = Math.max(1, Number(item.height) || 48);
    } else if (item.type === 'icon') {
      width = height = Math.max(1, Number(item.size) || 48);
    } else {
      const fontSize = Math.max(1, Number(item.fontSize) || 12);
      if (measureContext) {
        const itemFontFamily = typeof fontFamily === 'function'
          ? fontFamily(item)
          : fontFamily;
        measureContext.font = `${fontSize}px ${itemFontFamily}`;
        width = Math.max(1, measureContext.measureText(String(item.text || '')).width);
      } else {
        width = Math.max(1, String(item.text || '').length * fontSize * .58);
      }
      // Fabric's IText line box is slightly taller than its nominal font size.
      // Reserve that real height so a fitted word never gets nudged by the
      // editor's boundary guard after packing.
      height = fontSize * 1.18;
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
      return Math.max(48 / Math.max(1, Number(item.width) || 48),
        48 / Math.max(1, Number(item.height) || 48));
    }
    if (item.type === 'icon') return 48 / Math.max(1, Number(item.size) || 48);
    return 12 / Math.max(1, Number(item.fontSize) || 12);
  }

  function boxesOverlap(first, second) {
    return !(first.x2 <= second.x1 || first.x1 >= second.x2 ||
      first.y2 <= second.y1 || first.y1 >= second.y2);
  }

  function packAtScale(items, slot, scale, measureContext, fontFamily, gap) {
    const placed = [];
    const centerX = slot.x + slot.width / 2;
    const centerY = slot.y + slot.height / 2;
    const steps = Math.max(1800, Math.min(6000, 1000 + items.length * 70));

    for (const descriptor of items) {
      const dimensions = itemDimensions(descriptor.item, scale, measureContext, fontFamily);
      const halfWidth = dimensions.width / 2;
      const halfHeight = dimensions.height / 2;
      const collisionHalfWidth = halfWidth + gap;
      const collisionHalfHeight = halfHeight + gap;
      const maxX = slot.width / 2 - collisionHalfWidth;
      const maxY = slot.height / 2 - collisionHalfHeight;
      if (maxX < 0 || maxY < 0) return null;

      let position = null;
      for (let step = 0; step < steps; step += 1) {
        const progress = step / Math.max(1, steps - 1);
        const radius = Math.sqrt(progress);
        const angle = step * .37 + descriptor.index * 1.7;
        const x = centerX + maxX * radius * Math.cos(angle);
        const y = centerY + maxY * radius * Math.sin(angle);
        const collisionBox = {
          x1: x - collisionHalfWidth,
          x2: x + collisionHalfWidth,
          y1: y - collisionHalfHeight,
          y2: y + collisionHalfHeight,
        };
        if (placed.some((other) => boxesOverlap(collisionBox, other.collisionBox))) continue;
        position = { x, y, collisionBox };
        break;
      }
      if (!position) return null;
      placed.push({
        ...descriptor,
        x: position.x,
        y: position.y,
        halfWidth,
        halfHeight,
        collisionBox: position.collisionBox,
      });
    }
    return placed;
  }

  function scaleItem(item, scale, x, y) {
    const optimized = { ...item, x: round(x), y: round(y) };
    if (item.type === 'image') {
      optimized.width = round(Math.max(48, (Number(item.width) || 48) * scale));
      optimized.height = round(Math.max(48, (Number(item.height) || 48) * scale));
    } else if (item.type === 'icon') {
      optimized.size = round(Math.max(48, (Number(item.size) || 48) * scale));
    } else {
      optimized.fontSize = round(Math.max(12, (Number(item.fontSize) || 12) * scale));
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

  function optimizeItemsInSlot(items, slot, measureContext, fontFamily) {
    if (!items.length) return [];
    const minSide = Math.min(slot.width, slot.height);
    const gap = Math.max(2, minSide * .008);
    const sorted = items
      .map((item, index) => {
        const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
        return { item, index, area: dimensions.width * dimensions.height };
      })
      .sort((first, second) => second.area - first.area || first.index - second.index);

    const lowerBound = Math.max(...items.map(minimumScale));
    const upperBound = Math.min(...items.map((item) => {
      const dimensions = itemDimensions(item, 1, measureContext, fontFamily);
      return Math.min(
        Math.max(0, slot.width - gap * 2) / dimensions.width,
        Math.max(0, slot.height - gap * 2) / dimensions.height
      );
    }));
    if (!Number.isFinite(upperBound) || upperBound < lowerBound) {
      return items.map((item) => ({ ...item }));
    }

    let best = packAtScale(sorted, slot, lowerBound, measureContext, fontFamily, gap);
    if (!best) return items.map((item) => ({ ...item }));
    let low = lowerBound;
    let high = upperBound;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidateScale = (low + high) / 2;
      const candidate = packAtScale(sorted, slot, candidateScale, measureContext, fontFamily, gap);
      if (candidate) {
        best = candidate;
        low = candidateScale;
      } else {
        high = candidateScale;
      }
    }

    const bounds = best.reduce((result, item) => ({
      x1: Math.min(result.x1, item.x - item.halfWidth),
      x2: Math.max(result.x2, item.x + item.halfWidth),
      y1: Math.min(result.y1, item.y - item.halfHeight),
      y2: Math.max(result.y2, item.y + item.halfHeight),
    }), { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity });
    const inset = minSide * .012;
    const contentWidth = Math.max(1, bounds.x2 - bounds.x1);
    const contentHeight = Math.max(1, bounds.y2 - bounds.y1);
    const fitScale = Math.min(
      (slot.width - inset * 2) / contentWidth,
      (slot.height - inset * 2) / contentHeight
    );
    const sourceCenterX = (bounds.x1 + bounds.x2) / 2;
    const sourceCenterY = (bounds.y1 + bounds.y2) / 2;
    const targetCenterX = slot.x + slot.width / 2;
    const targetCenterY = slot.y + slot.height / 2;
    const packedByIndex = new Map(best.map((item) => [item.index, item]));

    return items.map((item, index) => {
      const packed = packedByIndex.get(index);
      return scaleItem(
        item,
        low * fitScale,
        targetCenterX + (packed.x - sourceCenterX) * fitScale,
        targetCenterY + (packed.y - sourceCenterY) * fitScale
      );
    });
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
