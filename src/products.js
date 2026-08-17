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
  unitPriceCents: 1745,
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
    single: Object.freeze([{ x: 890, y: 65, side: 920 }]),
    'both-sides': Object.freeze([
      { x: 162, y: 100, side: 850 },
      { x: 1687, y: 100, side: 850 },
    ]),
    'full-wrap': Object.freeze([
      { x: 130, y: 65, width: 2440, height: 920 },
    ]),
  }),
  themes: Object.freeze([
    Object.freeze({
      key: 'pastel',
      label: 'Pastell',
      description: 'Warm, weich und elegant',
      colors: Object.freeze(['#8f3a58', '#c97084', '#b78a46', '#5e2c3a', '#d8a3ae', '#7e6b65']),
    }),
    Object.freeze({
      key: 'rose-garden',
      label: 'Rosengarten',
      description: 'Romantische Beerentöne',
      colors: Object.freeze(['#6f1d3f', '#9f315b', '#c65c7c', '#d98a9d', '#8b4a5c', '#b88973']),
    }),
    Object.freeze({
      key: 'sage-gold',
      label: 'Salbei & Gold',
      description: 'Natürlich und festlich',
      colors: Object.freeze(['#425b4a', '#6f8066', '#94a184', '#b08d57', '#c5a86c', '#32453a']),
    }),
    Object.freeze({
      key: 'terracotta',
      label: 'Terrakotta',
      description: 'Warm und mediterran',
      colors: Object.freeze(['#713a2d', '#a4513b', '#c27052', '#d79770', '#8b5a45', '#5a4037']),
    }),
    Object.freeze({
      key: 'ocean',
      label: 'Ozean',
      description: 'Ruhige Blau- und Petroltöne',
      colors: Object.freeze(['#173a4a', '#24576a', '#367a87', '#4d9a9a', '#647f8c', '#1c4f61']),
    }),
    Object.freeze({
      key: 'classic',
      label: 'Klassisch',
      description: 'Zeitlos in Schwarz und Grau',
      colors: Object.freeze(['#1f1a1c', '#3c3437', '#5b5054', '#75686c', '#292326', '#8d7f83']),
    }),
    Object.freeze({
      key: 'neon',
      label: 'Neon Pop',
      description: 'Kräftig, modern und lebendig',
      colors: Object.freeze(['#c000a6', '#007b78', '#7222aa', '#188b00', '#d35400', '#cc1238']),
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
    unitPriceCents: product.unitPriceCents,
    currency: product.currency,
    size: product.size,
    printFile: product.printFile,
    layoutGeometry: product.layoutGeometry,
    themes: product.themes,
    layouts: product.layouts,
  };
}

module.exports = { MUG_DUO, getProduct, getPublicProduct };
