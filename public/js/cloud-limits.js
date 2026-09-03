(function (root, factory) {
  const limits = factory();
  if (typeof module === 'object' && module.exports) module.exports = limits;
  else root.CloudLimits = limits;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return Object.freeze({
    MAX_EVENT_UNIQUE_WORDS: 500,
    MAX_EVENT_CONTRIBUTIONS: 5000,
    MAX_OWNER_CONTRIBUTIONS: 500,
    // Two copies of a full cloud plus room for personal additions.
    MAX_DESIGN_ELEMENTS: 1200,
    // Geometric floor, not a claim of readability. Physical type size is
    // evaluated separately against each product's print-file DPI.
    MIN_PRINT_FONT_SIZE: 1,
  });
});
