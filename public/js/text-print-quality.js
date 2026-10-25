(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./wordcloud-core') : root.WordCloudCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TextPrintQuality = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  // Shared by automatic placement and advisory checks. Manual editing stays
  // unrestricted; this is product guidance, not a provider guarantee.
  const MIN_PT = 10;
  const CAPACITY_MESSAGE = 'Für alle Elemente wurde auf dieser Druckfläche keine Anordnung mit mindestens 10 pt gefunden. Wählt ein größeres Produkt, reduziert Texte im Druckdesign oder gestaltet bewusst mit kleinerer Schrift. Die Live-Wortwolke bleibt vollständig.';
  function findings(design, dpi) {
    if (!Array.isArray(design) || !Number.isFinite(dpi) || dpi <= 0) return [];
    return design.filter(item => (!item.type || item.type === 'text') &&
      !core.isEmojiOnly(item.text) && item.text?.trim() &&
      Number.isFinite(item.fontSize) && item.fontSize > 0)
      .map(item => ({ id: item.id, pt: item.fontSize * 72 / dpi }))
      .filter(item => item.pt < MIN_PT - 1e-8)
      .map(item => ({ ...item, level: item.pt < 6 ? 'tiny' : item.pt < 8 ? 'low' : 'small' }))
      .sort((a, b) => a.pt - b.pt);
  }
  function evaluate(design, dpi) {
    if (!Array.isArray(design) || !Number.isFinite(dpi) || dpi <= 0) return null;
    const sizes = design.filter(item => (!item.type || item.type === 'text') &&
      !core.isEmojiOnly(item.text) && item.text?.trim() &&
      Number.isFinite(item.fontSize) && item.fontSize > 0)
      .map(item => item.fontSize * 72 / dpi);
    if (!sizes.length) return null;
    const small = sizes.filter(size => size < MIN_PT - 1e-8).length;
    const tiny = sizes.filter(size => size < 8).length;
    return { minPt: Math.min(...sizes), small, tiny, level: tiny ? 'low' : small ? 'small' : 'good' };
  }
  return { MIN_PT, CAPACITY_MESSAGE, findings, evaluate };
});
