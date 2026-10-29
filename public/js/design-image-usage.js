(function (root) {
  'use strict';
  function create({ element, getDesigns, imageData = root.DesignImageData }) {
    if (!element || !imageData) return null;
    const counter = element.querySelector('[data-image-usage]');
    const feedback = element.querySelector('[data-image-feedback]');
    const cache = new Map();
    const view = element.ownerDocument.defaultView;
    let measured = false;
    function text(target, source, params = {}) {
      if (root.WolkenworteI18n) root.WolkenworteI18n.setText(target, source, params);
      else target.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
    }
    function clearError() { feedback.hidden = true; feedback.textContent = ''; }
    function showError(source) { text(feedback, source); feedback.hidden = false; }
    function update() {
      const previousSources = new Set(cache.keys());
      const current = imageData.usage(getDesigns(), cache);
      // Geometry/text edits do not dismiss an actionable image error.
      if (measured && (previousSources.size !== cache.size || [...cache.keys()].some(src => !previousSources.has(src)))) clearError();
      measured = true;
      const locale = root.WolkenworteI18n?.getLocale() || element.ownerDocument.documentElement.lang || 'de';
      const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
      text(counter, '{{count}}/20 Bilder · {{size}}/10 MB', {
        count: number.format(current.count), size: number.format(current.bytes / 1024 / 1024),
      });
      return current;
    }
    view.addEventListener('wolkenworte:localechange', update);
    return { update, showError, clearError };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.DesignImageUsage = { create };
})(typeof window === 'undefined' ? globalThis : window);
