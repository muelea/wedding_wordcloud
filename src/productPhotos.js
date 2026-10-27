'use strict';

const catalog = require('./productPhotoCatalog.json');

// This reviewed, local catalog is deliberately independent of editable designs
// and fulfillment. A supplier photo is offered only for its audited variant IDs.
function getProductPhotos(product) {
  const matching = catalog.photos.filter(photo => photo.productId === product.printful.productId &&
    photo.variantIds.includes(product.printful.variantId));
  const fallback = product.productPhoto || product.previewMockup?.assets?.default ||
    product.previewMockup?.assets?.front || Object.values(product.previewMockup?.assets || {})[0] || product.thumbnail;
  // The original catalog and gallery can store the same photograph at different
  // sizes/URLs. Prefer the reviewed gallery copy, only when it matches this variant.
  const reference = matching.find(photo => photo.duplicates?.some(copy => copy.src === fallback));
  const candidates = [
    ...matching.filter(photo => photo.primary),
    ...(reference ? [{ ...reference, label: 'Produktfoto' }] :
      fallback ? [{ src: fallback, label: 'Produktfoto', frame: catalog.frames[fallback] }] : []),
    ...matching.filter(photo => !photo.primary),
  ];
  const seen = new Set();
  return candidates.filter(photo => !seen.has(photo.src) && seen.add(photo.src))
    .map(({ src, label, frame }) => ({ src, label, ...(frame ? { frame } : {}) }));
}

module.exports = { getProductPhotos };
