(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./wordcloud-core') : root.WordCloudCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TextPrintQuality = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  // Product guidance, not provider guarantees. These physical type-size
  // thresholds should be calibrated with printed samples of the bundled fonts.
  function evaluate(design, dpi) {
    if (!Array.isArray(design) || !Number.isFinite(dpi) || dpi <= 0) return null;
    const sizes = design.filter(item => (!item.type || item.type === 'text') &&
      !core.isEmojiOnly(item.text) && item.text?.trim() &&
      Number.isFinite(item.fontSize) && item.fontSize > 0)
      .map(item => item.fontSize * 72 / dpi);
    if (!sizes.length) return null;
    const small = sizes.filter(size => size < 8).length;
    const tiny = sizes.filter(size => size < 6).length;
    return { minPt: Math.min(...sizes), small, tiny, level: tiny ? 'low' : small ? 'small' : 'good' };
  }
  return { evaluate };
});
