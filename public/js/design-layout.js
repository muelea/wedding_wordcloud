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
    return { x, y, width, height };
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

  function transformItem(item, source, target, id) {
    const xScale = target.width / source.width;
    const yScale = target.height / source.height;
    const sizeScale = Math.min(xScale, yScale);
    const transformed = {
      ...item,
      id,
      x: round(target.x + (item.x - source.x) * xScale),
      y: round(target.y + (item.y - source.y) * yScale),
    };
    if (item.type === 'image') {
      transformed.width = round(Math.max(48, item.width * sizeScale));
      transformed.height = round(Math.max(48, item.height * sizeScale));
    } else if (item.type === 'icon') {
      transformed.size = round(Math.max(48, item.size * sizeScale));
    } else {
      transformed.fontSize = round(Math.max(12, item.fontSize * sizeScale));
    }
    return transformed;
  }

  function transformDesign(design, fromSlots, toSlots) {
    if (!Array.isArray(design) || !design.length) return [];
    const sources = normalizedSlots(fromSlots);
    const targets = normalizedSlots(toSlots);
    if (!sources.length || !targets.length) return design.map((item) => ({ ...item }));

    const usedIds = new Set(design.map((item) => String(item.id || '')).filter(Boolean));
    const duplicateAcrossTargets = sources.length === 1 && targets.length > 1;
    const transformed = [];

    for (const item of design) {
      const sourceIndex = nearestSlotIndex(item, sources);
      const source = sources[sourceIndex];
      const destinations = duplicateAcrossTargets
        ? targets
        : [targets[Math.min(sourceIndex, targets.length - 1)]];

      destinations.forEach((target, destinationIndex) => {
        const id = destinationIndex === 0 ? item.id : copyId(item, usedIds);
        transformed.push(transformItem(item, source, target, id));
      });
    }
    return transformed;
  }

  return { transformDesign };
});
