(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteEmojiVirtualGrid = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function positiveInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function windowRange({
    itemCount,
    scrollTop,
    viewportHeight,
    columns = 8,
    rowHeight = 40,
    overscanRows = 2,
  }) {
    const count = Math.max(0, Math.floor(Number(itemCount)) || 0);
    const columnCount = positiveInteger(columns, 8);
    const height = positiveInteger(rowHeight, 40);
    const overscan = Math.max(0, Math.floor(Number(overscanRows)) || 0);
    const top = Math.max(0, Number(scrollTop) || 0);
    const viewport = Math.max(0, Number(viewportHeight) || 0);
    const totalRows = Math.ceil(count / columnCount);
    const firstRow = Math.max(0, Math.floor(top / height) - overscan);
    const lastRow = Math.min(
      totalRows,
      Math.ceil((top + viewport) / height) + overscan
    );
    return Object.freeze({
      start: Math.min(count, firstRow * columnCount),
      end: Math.min(count, lastRow * columnCount),
      totalHeight: totalRows * height,
      totalRows,
    });
  }

  return Object.freeze({ windowRange });
});
