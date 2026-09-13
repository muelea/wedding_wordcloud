(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteCloudWordActions = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function containsPoint(item, point, padding = 0) {
    const scale = Number(item?.scale);
    const width = Number(item?.width) * scale;
    const height = Number(item?.height) * scale;
    const x = Number(item?.x);
    const y = Number(item?.y);
    if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) return false;
    return Math.abs(Number(point?.x) - x) <= width / 2 + padding &&
      Math.abs(Number(point?.y) - y) <= height / 2 + padding;
  }

  function hitTestPlacedWord(items, point, padding = 0) {
    if (!Array.isArray(items) || !Number.isFinite(Number(point?.x)) ||
        !Number.isFinite(Number(point?.y))) return null;
    const safePadding = Math.max(0, Number(padding) || 0);
    // Prefer the painted box before considering the larger touch target. This
    // keeps neighbouring words unambiguous even on compact mobile layouts.
    for (const extra of safePadding ? [0, safePadding] : [0]) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (containsPoint(items[index], point, extra)) return items[index];
      }
    }
    return null;
  }

  return Object.freeze({ containsPoint, hitTestPlacedWord });
});
