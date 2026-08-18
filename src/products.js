'use strict';

/**
 * Curated products offered by WeddingCloud.
 *
 * Keep this deliberately small. Printful's full catalog is large and changes
 * frequently; the storefront only exposes products whose print geometry and
 * preview have been verified here. These values were retrieved from
 * Printful's stable Catalog + Mockup Generator APIs on 2026-08-16.
 */
const MUG_DUO = Object.freeze({
  key: 'white-glossy-mug-duo-11oz',
  name: 'Wortwolken-Tasse',
  description: 'Weiße Keramiktasse mit eurer persönlichen Wortwolke.',
  defaultQuantity: 2,
  minQuantity: 1,
  maxQuantity: 99,
  currency: 'EUR',
  printful: Object.freeze({
    productId: 19,
    variantId: 1320,
    printfileId: 43,
    templateId: 919,
  }),
  size: Object.freeze({
    label: '11 oz',
    volumeMl: 325,
    heightCm: 9.6,
    diameterCm: 8.2,
  }),
  printFile: Object.freeze({
    width: 2700,
    height: 1050,
    dpi: 300,
    placement: 'default',
  }),
  template: Object.freeze({
    width: 728,
    height: 728,
    printAreaWidth: 671,
    printAreaHeight: 261,
    printAreaTop: 163,
    printAreaLeft: 29,
  }),
  layoutGeometry: Object.freeze({
    // The first and second side centres (587 px / 2112 px) sit 90° away
    // from Printful file 43's edges. Those edges meet at the unprinted
    // handle band, so a one-sided motif belongs at the first centre rather
    // than in the file centre opposite the handle.
    single: Object.freeze([{ x: 127, y: 65, side: 920 }]),
    'both-sides': Object.freeze([
      { x: 162, y: 100, side: 850 },
      { x: 1687, y: 100, side: 850 },
    ]),
    'full-wrap': Object.freeze([
      { x: 130, y: 65, width: 2440, height: 920 },
    ]),
    'fit-area': Object.freeze([
      { x: 36, y: 36, width: 2628, height: 978, optimize: true },
    ]),
  }),
  themes: Object.freeze([
    Object.freeze({
      key: 'pastel',
      label: 'Sorbet Pop',
      description: 'Leuchtende Beeren- und Aprikosentöne',
      colors: Object.freeze(['#a40e4c', '#d90368', '#f45b69', '#ff7f3f', '#6a4c93', '#168f83']),
    }),
    Object.freeze({
      key: 'sage-gold',
      label: 'Smaragd & Gold',
      description: 'Edle Juwelen- und Goldtöne',
      colors: Object.freeze(['#063e36', '#006d5b', '#14967f', '#8f6100', '#d0920f', '#654100']),
    }),
    Object.freeze({
      key: 'ocean',
      label: 'Ocean Electric',
      description: 'Tiefes Blau mit leuchtendem Türkis',
      colors: Object.freeze(['#003049', '#00509d', '#0077b6', '#0096c7', '#00a6a6', '#136f63']),
    }),
    Object.freeze({
      key: 'custom',
      label: 'Eigene Farben',
      description: 'Eure ganz persönliche Farbmischung',
      colors: Object.freeze(['#c2185b', '#f05a28', '#f2a900', '#008f83', '#3155c6', '#7027a0']),
    }),
  ]),
  layouts: Object.freeze([
    Object.freeze({
      key: 'single',
      label: 'Ein großes Motiv',
      description: 'Die Wortwolke groß auf einer Seite jeder Tasse',
    }),
    Object.freeze({
      key: 'both-sides',
      label: 'Auf beiden Seiten',
      description: 'Die Wortwolke von links und rechts sichtbar',
    }),
    Object.freeze({
      key: 'full-wrap',
      label: 'Rundum',
      description: 'Eine Wortwolke über die gesamte Tasse verteilt',
    }),
    Object.freeze({
      key: 'fit-area',
      label: 'Fläche optimal nutzen',
      description: 'Automatisch großflächig angeordnet',
    }),
  ]),
});

function getProduct(key) {
  return key === MUG_DUO.key ? MUG_DUO : null;
}

function getPublicProduct(product = MUG_DUO) {
  return {
    key: product.key,
    name: product.name,
    description: product.description,
    defaultQuantity: product.defaultQuantity,
    minQuantity: product.minQuantity,
    maxQuantity: product.maxQuantity,
    currency: product.currency,
    size: product.size,
    printFile: product.printFile,
    layoutGeometry: product.layoutGeometry,
    themes: product.themes,
    layouts: product.layouts,
  };
}

module.exports = { MUG_DUO, getProduct, getPublicProduct };
