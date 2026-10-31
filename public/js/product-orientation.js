(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProductOrientation = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const labels = { portrait: 'Hochformat', landscape: 'Querformat' };
  function dimensions(label, orientation) {
    return String(label || '').replace(/(\d+(?:[.,]\d+)?)\s+×\s+(\d+(?:[.,]\d+)?)\s+(cm|mm)/,
      (match, a, b, unit) => {
        const ordered = [a, b].sort((x, y) => Number(x.replace(',', '.')) - Number(y.replace(',', '.')));
        if (orientation === 'landscape') ordered.reverse();
        return `${ordered[0]} × ${ordered[1]} ${unit}`;
      });
  }
  function selected(product, requested) {
    const options = product?.orientations || product?.orientationOptions || [];
    const key = requested || product?.orientation || product?.defaultOrientation || 'default';
    return options.find(option => option.key === (key === 'default' ? product.legacyDefaultOrientation : key)) ||
      options.find(option => option.key === product.defaultOrientation) || options[0] || null;
  }
  function view(product, requested) {
    const option = selected(product, requested);
    if (!option) return product.orientation === 'default' ? product : { ...product, orientation: 'default' };
    return { ...product, ...Object.fromEntries(Object.entries(option).filter(([key]) =>
      !['key', 'label', 'description'].includes(key))), orientation: option.key };
  }
  function summary(product, i18n = { t: text => text }, { detail = true, orientation = true } = {}) {
    if (!product) return '';
    const size = product.size || {};
    let label = i18n.t(product.variantLabel || size.label || '');
    const option = selected(product);
    if (option && size.label) label = label.replace(/^.*?\d+(?:[.,]\d+)?\s+×\s+\d+(?:[.,]\d+)?\s+(?:cm|mm)/, i18n.t(size.label));
    const parts = [label];
    if (orientation && option) parts.push(i18n.t(labels[option.key]));
    if (detail && size.detail) parts.push(i18n.t(size.detail));
    return parts.filter(Boolean).join(' · ');
  }
  const key = (product, orientation) => `${product.key}:${selected(product, orientation)?.key || 'default'}`;
  return { dimensions, selected, view, summary, key, labels };
});
