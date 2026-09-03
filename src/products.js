'use strict';

/**
 * Curated products offered by Wolkenworte.
 *
 * Keep this deliberately small. Printful's full catalog is large and changes
 * frequently; the storefront only exposes products whose print geometry and
 * preview have been verified here. The variants below were re-verified
 * against Printful's Catalog + Mockup Generator APIs on 2026-08-21.
 */

const THEMES = Object.freeze([
  // The first palette is the shared default for the live cloud and every product.
  Object.freeze({
    key: 'konfetti',
    label: 'Konfetti',
    description: 'Bunte Kontraste mit Kobaltblau, Sonnengelb und Fuchsia',
    colors: Object.freeze(['#2455f5', '#ed2446', '#18a84b', '#efbf00', '#f77500', '#e600b8']),
    background: Object.freeze(['#fffdfa', '#fff7ef', 'rgba(239,191,0,.10)', 'rgba(230,0,184,.05)']),
  }),
  Object.freeze({
    key: 'dopamin-pop',
    label: 'Dopamin Pop',
    description: 'Leuchtendes Orange, Pink, Türkis, Gelb, Violett und Apfelgrün',
    colors: Object.freeze(['#ff6a00', '#f500a6', '#00bfc4', '#ffd400', '#7b2cff', '#7ccc00']),
    background: Object.freeze(['#fffdfa', '#fff5fa', 'rgba(255,212,0,.10)', 'rgba(0,191,196,.07)']),
    // Keep white button labels readable without darkening the approved word colors.
    uiPrimary: '#b84700',
  }),
  Object.freeze({
    key: 'pastel',
    label: 'Sorbet Pop',
    description: 'Leuchtende Beeren- und Aprikosentöne',
    colors: Object.freeze(['#a40e4c', '#d90368', '#f45b69', '#ff7f3f', '#6a4c93', '#168f83']),
    background: Object.freeze(['#fffdfa', '#fff3f5', 'rgba(247,238,223,.7)', 'rgba(209,96,126,.08)']),
  }),
  Object.freeze({
    key: 'sage-gold',
    label: 'Smaragd & Gold',
    description: 'Edle Juwelen- und Goldtöne',
    colors: Object.freeze(['#063e36', '#006d5b', '#14967f', '#8f6100', '#d0920f', '#654100']),
    background: Object.freeze(['#f7fbf5', '#edf6ef', 'rgba(20,150,127,.13)', 'rgba(208,146,15,.10)']),
  }),
  Object.freeze({
    key: 'ocean',
    label: 'Ocean Electric',
    description: 'Tiefes Blau mit leuchtendem Türkis',
    colors: Object.freeze(['#003049', '#00509d', '#0077b6', '#0096c7', '#00a6a6', '#136f63']),
    background: Object.freeze(['#f4f9fc', '#eaf4fa', 'rgba(0,119,182,.13)', 'rgba(0,166,166,.10)']),
  }),
  Object.freeze({
    key: 'custom',
    label: 'Eigene Farben',
    description: 'Eure ganz persönliche Farbmischung',
    colors: Object.freeze(['#c2185b', '#f05a28', '#f2a900', '#008f83', '#3155c6', '#7027a0']),
  }),
]);

const PRODUCT_FAMILIES = Object.freeze([
  Object.freeze({
    key: 'mugs',
    label: 'Tassen',
    description: 'Weiße Keramiktassen in drei Größen',
    thumbnail: '/assets/product-thumbnails/mug.svg',
  }),
  Object.freeze({
    key: 'posters',
    label: 'Poster',
    description: 'Matt oder schwarz gerahmt',
    thumbnail: '/assets/product-thumbnails/poster.svg',
  }),
  Object.freeze({
    key: 'home',
    label: 'Wohnaccessoires',
    description: 'Untersetzer, Decke und Kissen',
    thumbnail: '/assets/product-thumbnails/blanket.svg',
  }),
  Object.freeze({
    key: 'bags',
    label: 'Taschen',
    description: 'Allover bedruckte Tragetasche',
    thumbnail: '/assets/product-thumbnails/tote.svg',
  }),
  Object.freeze({
    key: 'notebooks',
    label: 'Notizbücher',
    description: 'Spiralbindung und Soft-Touch-Cover',
    thumbnail: '/assets/product-thumbnails/notebook.svg',
  }),
]);

const MUG_LAYOUTS = Object.freeze([
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
    description: 'Aktuellen Inhalt automatisch großflächig anordnen',
  }),
]);

const FLAT_LAYOUTS = Object.freeze([
  Object.freeze({
    key: 'fit-area',
    label: 'Fläche optimal nutzen',
    description: 'Aktuellen Inhalt automatisch großflächig anordnen',
  }),
  Object.freeze({
    key: 'centered',
    label: 'Motiv mittig',
    description: 'Kompakt und mit einem großzügigen Rand',
  }),
]);

const POSTER_ORIENTATIONS = Object.freeze([
  Object.freeze({
    key: 'portrait',
    label: 'Hochformat',
    description: 'Klassisch hochkant aufgehängt',
  }),
  Object.freeze({
    key: 'landscape',
    label: 'Querformat',
    description: 'Breit und horizontal aufgehängt',
  }),
]);

function freezeSlots(slots) {
  return Object.freeze(slots.map((slot) => Object.freeze(slot)));
}

function freezeLayoutGeometry(layoutGeometry) {
  return Object.freeze(Object.fromEntries(
    Object.entries(layoutGeometry).map(([key, slots]) => [key, freezeSlots(slots)])
  ));
}

function makeProduct({
  key,
  name,
  displayName,
  description,
  icon,
  previewType,
  previewShape,
  productId,
  variantId,
  printfileId,
  templateId,
  size,
  printFile,
  template,
  layoutGeometry,
  layouts,
  defaultQuantity,
  unit,
  designSafeMargin,
  fulfillmentPlacements,
  fulfillmentOptions,
  printTechnique = 'digital',
  printSurfaces,
  familyKey,
  thumbnail,
  previewMockup,
  orientationOptions,
  defaultOrientation,
}) {
  const printPlacement = printFile.placement || 'default';
  const resolvedFulfillmentPlacements = fulfillmentPlacements?.length
    ? [...new Set(fulfillmentPlacements)]
    : [printPlacement];
  if (resolvedFulfillmentPlacements.some((placement) => typeof placement !== 'string' || !placement)) {
    throw new TypeError(`Ungültige Printful-Druckposition für ${key}.`);
  }
  const resolvedPrintSurfaces = printSurfaces?.length
    ? printSurfaces.map((surface) => Object.freeze({ ...surface }))
    : resolvedFulfillmentPlacements.map((surfaceKey) => Object.freeze({
        key: surfaceKey,
        label: surfaceKey === 'front'
          ? 'Vorderseite'
          : surfaceKey === 'back' ? 'Rückseite' : 'Druckfläche',
      }));
  const surfaceKeys = resolvedPrintSurfaces.map((surface) => surface.key);
  if (surfaceKeys.length !== resolvedFulfillmentPlacements.length ||
      resolvedFulfillmentPlacements.some((placement) => !surfaceKeys.includes(placement))) {
    throw new TypeError(`Druckseiten und Printful-Druckpositionen stimmen für ${key} nicht überein.`);
  }
  if (!PRODUCT_FAMILIES.some((family) => family.key === familyKey)) {
    throw new TypeError(`Ungültige Produktfamilie für ${key}.`);
  }
  const resolvedOptions = Array.isArray(fulfillmentOptions)
    ? fulfillmentOptions.map((option) => Object.freeze({ ...option }))
    : [];
  const resolvedOrientationOptions = Array.isArray(orientationOptions)
    ? orientationOptions.map((option) => Object.freeze({ ...option }))
    : [];
  const resolvedDefaultOrientation = resolvedOrientationOptions.length
    ? defaultOrientation || resolvedOrientationOptions[0].key
    : 'default';
  if (resolvedOrientationOptions.length &&
      !resolvedOrientationOptions.some((option) => option.key === resolvedDefaultOrientation)) {
    throw new TypeError(`Ungültige Standardausrichtung für ${key}.`);
  }
  return Object.freeze({
    key,
    familyKey,
    thumbnail,
    name,
    displayName,
    description,
    icon,
    previewType,
    previewShape,
    previewMockup: previewMockup
      ? Object.freeze({
          width: previewMockup.width,
          height: previewMockup.height,
          scale: previewMockup.scale || 1,
          blendMode: previewMockup.blendMode || 'normal',
          rotation: previewMockup.rotation || 0,
          canvas: Object.freeze({
            left: previewMockup.canvas?.left ?? 0,
            top: previewMockup.canvas?.top ?? 0,
            width: previewMockup.canvas?.width ?? 100,
            height: previewMockup.canvas?.height ?? 100,
            fit: previewMockup.canvas?.fit || 'contain',
            clipPath: previewMockup.canvas?.clipPath || 'none',
          }),
          assets: Object.freeze({ ...previewMockup.assets }),
        })
      : null,
    defaultQuantity,
    minQuantity: 1,
    maxQuantity: 99,
    currency: 'EUR',
    unit: Object.freeze(unit),
    designSafeMargin,
    printful: Object.freeze({
      productId,
      variantId,
      printfileId,
      templateId,
      placements: Object.freeze(resolvedFulfillmentPlacements),
      options: Object.freeze(resolvedOptions),
      technique: printTechnique,
    }),
    printSurfaces: Object.freeze(resolvedPrintSurfaces),
    orientationOptions: Object.freeze(resolvedOrientationOptions),
    defaultOrientation: resolvedDefaultOrientation,
    size: Object.freeze(size),
    printFile: Object.freeze({ ...printFile, placement: printPlacement }),
    template: Object.freeze(template),
    layoutGeometry: freezeLayoutGeometry(layoutGeometry),
    themes: THEMES,
    layouts,
  });
}

function transposeLayoutGeometry(layoutGeometry) {
  return Object.fromEntries(Object.entries(layoutGeometry).map(([key, slots]) => [
    key,
    slots.map((slot) => ({
      ...slot,
      x: slot.y,
      y: slot.x,
      ...(Number.isFinite(slot.width) && Number.isFinite(slot.height)
        ? { width: slot.height, height: slot.width }
        : {}),
    })),
  ]));
}

function landscapeSizeLabel(label) {
  const match = /^(.*?)\s+×\s+(.*?)\s+(cm|mm)$/.exec(String(label || ''));
  return match ? `${match[2]} × ${match[1]} ${match[3]}` : String(label || '');
}

function rotateMockupCanvasClockwise(canvas) {
  if (!canvas) return canvas;
  const roundPercent = (value) => Math.round(value * 10_000) / 10_000;
  return {
    ...canvas,
    left: roundPercent(100 - canvas.top - canvas.height),
    top: canvas.left,
    width: canvas.height,
    height: canvas.width,
  };
}

function resolveProductOrientation(product, rawOrientation) {
  if (!product) return null;
  const options = product.orientationOptions || [];
  const requested = String(rawOrientation || product.defaultOrientation || 'default');
  const orientation = requested === 'default' && options.length
    ? product.defaultOrientation
    : requested;
  if (options.length) {
    if (!options.some((option) => option.key === orientation)) return null;
  } else if (orientation !== 'default') {
    return null;
  }

  if (orientation !== 'landscape') return { ...product, orientation };
  if (!product.printFile?.canRotate) return null;
  return {
    ...product,
    orientation,
    size: {
      ...product.size,
      label: landscapeSizeLabel(product.size.label),
    },
    printFile: {
      ...product.printFile,
      width: product.printFile.height,
      height: product.printFile.width,
    },
    layoutGeometry: transposeLayoutGeometry(product.layoutGeometry),
    previewMockup: product.previewMockup
      ? {
          ...product.previewMockup,
          rotation: ((product.previewMockup.rotation || 0) + 90) % 360,
          canvas: rotateMockupCanvasClockwise(product.previewMockup.canvas),
        }
      : null,
  };
}

function makeMugProduct(options) {
  return makeProduct({
    familyKey: 'mugs',
    thumbnail: '/assets/product-thumbnails/mug.svg',
    name: 'Wortwolken-Tasse',
    displayName: 'Weiße Tasse',
    description: 'Weiße Keramiktasse mit eurer persönlichen Wortwolke.',
    icon: '☕',
    previewType: 'mug',
    previewShape: 'mug',
    productId: 19,
    printTechnique: 'sublimation',
    defaultQuantity: 1,
    unit: { singular: 'Tasse', plural: 'Tassen' },
    designSafeMargin: 24,
    layouts: MUG_LAYOUTS,
    ...options,
  });
}

const MUG_11 = makeMugProduct({
  // Keep the original key so existing immutable configurations remain valid.
  key: 'white-glossy-mug-duo-11oz',
  variantId: 1320,
  printfileId: 43,
  templateId: 919,
  size: {
    label: '11 oz',
    volumeMl: 325,
    heightCm: 9.6,
    diameterCm: 8.2,
  },
  printFile: { width: 2700, height: 1050, dpi: 300 },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 671,
    printAreaHeight: 261,
    printAreaTop: 163,
    printAreaLeft: 29,
  },
  layoutGeometry: {
    // The first and second side centres (587 px / 2112 px) sit 90° away
    // from Printful file 43's edges. Those edges meet at the unprinted
    // handle band, so a one-sided motif belongs at the first centre rather
    // than in the file centre opposite the handle.
    single: [{ x: 127, y: 65, side: 920 }],
    'both-sides': [
      { x: 162, y: 100, side: 850 },
      { x: 1687, y: 100, side: 850 },
    ],
    'full-wrap': [{ x: 130, y: 65, width: 2440, height: 920 }],
    'fit-area': [{ x: 36, y: 36, width: 2628, height: 978, optimize: true }],
  },
});

const MUG_15 = makeMugProduct({
  key: 'white-glossy-mug-15oz',
  variantId: 4830,
  printfileId: 44,
  templateId: 920,
  size: {
    label: '15 oz',
    volumeMl: 444,
    heightCm: 11.9,
    diameterCm: 8.5,
  },
  printFile: { width: 2700, height: 1140, dpi: 300 },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 649,
    printAreaHeight: 274,
    printAreaTop: 117,
    printAreaLeft: 40,
  },
  layoutGeometry: {
    single: [{ x: 57, y: 65, side: 1010 }],
    'both-sides': [
      { x: 92, y: 100, side: 940 },
      { x: 1669, y: 100, side: 940 },
    ],
    'full-wrap': [{ x: 130, y: 71, width: 2440, height: 998 }],
    'fit-area': [{ x: 36, y: 39, width: 2628, height: 1062, optimize: true }],
  },
});

const MUG_20 = makeMugProduct({
  key: 'white-glossy-mug-20oz',
  variantId: 16586,
  printfileId: 426,
  templateId: 181779,
  size: {
    label: '20 oz',
    volumeMl: 591,
    heightCm: 10.9,
    diameterCm: 9.3,
  },
  printFile: { width: 3071, height: 1205, dpi: 300 },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 700,
    printAreaHeight: 275,
    printAreaTop: 166,
    printAreaLeft: 14,
  },
  layoutGeometry: {
    single: [{ x: 135, y: 65, side: 1075 }],
    'both-sides': [
      { x: 170, y: 100, side: 1005 },
      { x: 1896, y: 100, side: 1005 },
    ],
    'full-wrap': [{ x: 148, y: 75, width: 2775, height: 1055 }],
    'fit-area': [{ x: 41, y: 41, width: 2989, height: 1123, optimize: true }],
  },
});

const COASTER = makeProduct({
  key: 'cork-back-coaster',
  familyKey: 'home',
  thumbnail: '/assets/product-thumbnails/coaster.svg',
  name: 'Kork-Untersetzer',
  displayName: 'Kork-Untersetzer',
  description: 'Glänzender Untersetzer mit wasserfester Oberfläche und Korkrückseite.',
  icon: '◉',
  previewType: 'flat',
  previewShape: 'coaster',
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.3,
    canvas: { left: 17.5, top: 17.7, width: 65.3, height: 64.9, fit: 'cover' },
    assets: { default: '/assets/product-mockups/coaster-flat.png' },
  },
  productId: 611,
  printTechnique: 'sublimation',
  variantId: 15662,
  printfileId: 358,
  templateId: 133922,
  defaultQuantity: 1,
  unit: { singular: 'Untersetzer', plural: 'Untersetzer' },
  designSafeMargin: 60,
  size: {
    label: '95 × 95 mm',
    widthCm: 9.5,
    heightCm: 9.5,
    detail: '4 mm stark · Korkrückseite',
  },
  printFile: { width: 1181, height: 1181, dpi: 300, fillMode: 'cover' },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 570,
    printAreaHeight: 570,
    printAreaTop: 79,
    printAreaLeft: 79,
  },
  layoutGeometry: {
    'fit-area': [{ x: 60, y: 60, width: 1061, height: 1061, optimize: true }],
    centered: [{ x: 170, y: 170, side: 841 }],
  },
  layouts: FLAT_LAYOUTS,
});

function makePosterProduct({
  key, variantId, printfileId, templateId, label, width, height, template, previewMockup,
}) {
  const safeMargin = 96;
  const centeredSide = Math.min(width - 720, height - 1200);
  return makeProduct({
    key,
    familyKey: 'posters',
    thumbnail: '/assets/product-thumbnails/poster.svg',
    name: 'Mattes Poster',
    displayName: 'Mattes Poster',
    description: 'Museumspapier mit matter Oberfläche und eurer persönlichen Gestaltung.',
    icon: '▤',
    previewType: 'flat',
    previewShape: 'poster',
    previewMockup,
    productId: 268,
    variantId,
    printfileId,
    templateId,
    defaultQuantity: 1,
    unit: { singular: 'Poster', plural: 'Poster' },
    designSafeMargin: safeMargin,
    size: {
      label,
      detail: '189 g/m² · matt',
    },
    // Printful exposes these files in landscape orientation with can_rotate;
    // the curated storefront uses the same exact pixels rotated to portrait.
    printFile: { width, height, dpi: 300, fillMode: 'cover', canRotate: true },
    template,
    layoutGeometry: {
      'fit-area': [{
        x: safeMargin,
        y: safeMargin,
        width: width - safeMargin * 2,
        height: height - safeMargin * 2,
        optimize: true,
      }],
      centered: [{
        x: (width - centeredSide) / 2,
        y: (height - centeredSide) / 2,
        side: centeredSide,
      }],
    },
    layouts: FLAT_LAYOUTS,
    orientationOptions: POSTER_ORIENTATIONS,
    defaultOrientation: 'portrait',
  });
}

function makeFramedPosterProduct({
  key, variantId, printfileId, templateId, label, width, height, template, previewMockup,
}) {
  const safeMargin = 96;
  const centeredSide = Math.min(width - 720, height - 1200);
  return makeProduct({
    key,
    familyKey: 'posters',
    thumbnail: '/assets/product-thumbnails/framed-poster.svg',
    name: 'Gerahmtes Poster',
    displayName: 'Gerahmtes Poster',
    description: 'Mattes Museumspapier im klassischen schwarzen Holzrahmen.',
    icon: '▣',
    previewType: 'flat',
    previewShape: 'framed-poster',
    previewMockup,
    productId: 304,
    variantId,
    printfileId,
    templateId,
    defaultQuantity: 1,
    unit: { singular: 'Rahmenposter', plural: 'Rahmenposter' },
    designSafeMargin: safeMargin,
    size: {
      label,
      detail: '189 g/m² · schwarzer Holzrahmen',
    },
    printFile: { width, height, dpi: 300, fillMode: 'cover', canRotate: true },
    template,
    layoutGeometry: {
      'fit-area': [{
        x: safeMargin,
        y: safeMargin,
        width: width - safeMargin * 2,
        height: height - safeMargin * 2,
        optimize: true,
      }],
      centered: [{
        x: (width - centeredSide) / 2,
        y: (height - centeredSide) / 2,
        side: centeredSide,
      }],
    },
    layouts: FLAT_LAYOUTS,
    orientationOptions: POSTER_ORIENTATIONS,
    defaultOrientation: 'portrait',
  });
}

const POSTER_30X40 = makePosterProduct({
  key: 'matte-poster-30x40cm',
  variantId: 8948,
  printfileId: 153,
  templateId: 21395,
  label: '30 × 40 cm',
  width: 3544,
  height: 4724,
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.18,
    canvas: { left: 25, top: 17.7, width: 49.2, height: 65.5, fit: 'cover' },
    assets: { default: '/assets/product-mockups/matte-poster-30x40.png' },
  },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 503,
    printAreaHeight: 670,
    printAreaTop: 29,
    printAreaLeft: 97,
  },
});

const POSTER_50X70 = makePosterProduct({
  key: 'matte-poster-50x70cm',
  variantId: 8952,
  printfileId: 113,
  templateId: 21396,
  label: '50 × 70 cm',
  width: 5906,
  height: 8268,
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.1,
    canvas: { left: 21.4, top: 10, width: 57.2, height: 80, fit: 'cover' },
    assets: { default: '/assets/product-mockups/matte-poster-50x70.png' },
  },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 478,
    printAreaHeight: 670,
    printAreaTop: 30,
    printAreaLeft: 110,
  },
});

const FRAMED_POSTER_30X40 = makeFramedPosterProduct({
  key: 'framed-matte-poster-black-30x40cm',
  variantId: 9357,
  printfileId: 15,
  templateId: 273627,
  label: '30 × 40 cm',
  width: 3600,
  height: 4800,
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.12,
    canvas: { left: 24.1, top: 15.1, width: 51.9, height: 69.7, fit: 'cover' },
    assets: { default: '/assets/product-mockups/framed-poster-black-30x40.png' },
  },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 502,
    printAreaHeight: 670,
    printAreaTop: 29,
    printAreaLeft: 97,
  },
});

const FRAMED_POSTER_50X70 = makeFramedPosterProduct({
  key: 'framed-matte-poster-black-50x70cm',
  variantId: 9358,
  printfileId: 113,
  templateId: 273908,
  label: '50 × 70 cm',
  width: 5906,
  height: 8268,
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.1,
    canvas: { left: 22.8, top: 11.3, width: 54.5, height: 77.4, fit: 'cover' },
    assets: { default: '/assets/product-mockups/framed-poster-black-50x70.png' },
  },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 477,
    printAreaHeight: 668,
    printAreaTop: 31,
    printAreaLeft: 110,
  },
});

const TOTE_BAG = makeProduct({
  key: 'all-over-tote-black-handles',
  familyKey: 'bags',
  thumbnail: '/assets/product-thumbnails/tote.svg',
  name: 'Allover-Tragetasche',
  displayName: 'Tragetasche',
  description: 'Geräumige Tragetasche mit vollflächigem Druck und schwarzen Baumwollträgern.',
  icon: '▱',
  previewType: 'flat',
  previewShape: 'tote',
  previewMockup: {
    width: 700,
    height: 1000,
    scale: 1,
    blendMode: 'multiply',
    canvas: {
      left: 5,
      top: 35.5,
      width: 90,
      height: 58.5,
      fit: 'cover',
      clipPath: 'polygon(0 0, 100% 0, 96% 100%, 3% 100%)',
    },
    assets: { default: '/assets/product-mockups/tote-front.jpg' },
  },
  productId: 84,
  printTechnique: 'cut-sew',
  fulfillmentOptions: [{ id: 'stitch_color', value: 'black' }],
  variantId: 4533,
  printfileId: 6,
  templateId: 1204,
  defaultQuantity: 1,
  unit: { singular: 'Tragetasche', plural: 'Tragetaschen' },
  designSafeMargin: 100,
  size: {
    label: '39 × 39 cm',
    detail: '10 l · schwarze Träger',
  },
  printFile: { width: 2550, height: 2475, dpi: 150, fillMode: 'cover' },
  template: {
    width: 3000,
    height: 3000,
    printAreaWidth: 2942,
    printAreaHeight: 2851,
    printAreaTop: 8,
    printAreaLeft: 28,
  },
  layoutGeometry: {
    'fit-area': [{ x: 100, y: 100, width: 2350, height: 2275, optimize: true }],
    centered: [{ x: 275, y: 237.5, side: 2000 }],
  },
  layouts: FLAT_LAYOUTS,
});

const THROW_BLANKET_50X60 = makeProduct({
  key: 'throw-blanket-50x60in',
  familyKey: 'home',
  thumbnail: '/assets/product-thumbnails/blanket.svg',
  name: 'Kuscheldecke',
  displayName: 'Kuscheldecke',
  description: 'Weiche Decke mit vollflächigem Druck und weißer Rückseite.',
  icon: '▰',
  previewType: 'flat',
  previewShape: 'blanket',
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.1,
    canvas: { left: 6.3, top: 13.7, width: 86.8, height: 71.9, fit: 'cover' },
    assets: { default: '/assets/product-mockups/throw-blanket-flat-horizontal.png' },
  },
  productId: 395,
  printTechnique: 'sublimation',
  variantId: 10986,
  printfileId: 208,
  templateId: 19414,
  defaultQuantity: 1,
  unit: { singular: 'Decke', plural: 'Decken' },
  designSafeMargin: 180,
  size: {
    label: '127 × 153 cm',
    detail: 'weich · weiße Rückseite',
  },
  printFile: {
    width: 9450,
    height: 7950,
    dpi: 150,
    fillMode: 'cover',
    canRotate: true,
  },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 725,
    printAreaHeight: 609,
    printAreaTop: 60,
    printAreaLeft: 2,
  },
  layoutGeometry: {
    'fit-area': [{ x: 180, y: 180, width: 9090, height: 7590, optimize: true }],
    centered: [{ x: 1475, y: 725, side: 6500 }],
  },
  layouts: FLAT_LAYOUTS,
});

const SPIRAL_NOTEBOOK = makeProduct({
  key: 'spiral-notebook-dotted',
  familyKey: 'notebooks',
  thumbnail: '/assets/product-thumbnails/notebook.svg',
  name: 'Spiral-Notizbuch',
  displayName: 'Spiral-Notizbuch',
  description: 'Notizbuch mit Soft-Touch-Umschlag und 140 punktierten Seiten.',
  icon: '▥',
  previewType: 'flat',
  previewShape: 'notebook',
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1,
    canvas: { left: 19.9, top: 4.7, width: 57.6, height: 90.4, fit: 'cover' },
    assets: {
      front: '/assets/product-mockups/spiral-notebook-front.png',
      back: '/assets/product-mockups/spiral-notebook-back.png',
    },
  },
  productId: 474,
  variantId: 12141,
  printfileId: 242,
  templateId: 63186,
  fulfillmentPlacements: ['front', 'back'],
  printSurfaces: [
    { key: 'front', label: 'Vorderseite' },
    { key: 'back', label: 'Rückseite' },
  ],
  defaultQuantity: 1,
  unit: { singular: 'Notizbuch', plural: 'Notizbücher' },
  designSafeMargin: 90,
  size: {
    label: '14,5 × 21 cm',
    detail: '140 punktierte Seiten · Soft-Touch',
  },
  printFile: {
    width: 1725,
    height: 2625,
    dpi: 300,
    fillMode: 'cover',
    placement: 'front',
  },
  template: {
    width: 728,
    height: 728,
    printAreaWidth: 439,
    printAreaHeight: 669,
    printAreaTop: 29,
    printAreaLeft: 138,
  },
  layoutGeometry: {
    'fit-area': [{ x: 90, y: 90, width: 1545, height: 2445, optimize: true }],
    centered: [{ x: 180, y: 630, side: 1365 }],
  },
  layouts: FLAT_LAYOUTS,
});

const BASIC_PILLOW_18 = makeProduct({
  key: 'all-over-basic-pillow-18in',
  familyKey: 'home',
  thumbnail: '/assets/product-thumbnails/pillow.svg',
  name: 'Allover-Dekokissen',
  displayName: 'Dekokissen',
  description: 'Weiches Dekokissen mit formstabiler Füllung und beidseitigem Druck.',
  icon: '◇',
  previewType: 'flat',
  previewShape: 'pillow',
  previewMockup: {
    width: 1000,
    height: 1000,
    scale: 1.3,
    canvas: { left: 17.1, top: 18.7, width: 64.8, height: 63.1, fit: 'cover' },
    assets: {
      front: '/assets/product-mockups/basic-pillow-flat.png',
      back: '/assets/product-mockups/basic-pillow-flat.png',
    },
  },
  productId: 83,
  printTechnique: 'cut-sew',
  variantId: 4532,
  printfileId: 32,
  templateId: 22667,
  fulfillmentPlacements: ['front', 'back'],
  fulfillmentOptions: [{ id: 'stitch_color', value: 'white' }],
  printSurfaces: [
    { key: 'front', label: 'Vorderseite' },
    { key: 'back', label: 'Rückseite' },
  ],
  defaultQuantity: 1,
  unit: { singular: 'Kissen', plural: 'Kissen' },
  designSafeMargin: 120,
  size: {
    label: '46 × 46 cm',
    detail: 'inklusive Füllung · weißer Reißverschluss',
  },
  printFile: {
    width: 2850,
    height: 2850,
    dpi: 150,
    fillMode: 'cover',
    placement: 'front',
  },
  template: {
    width: 3000,
    height: 3000,
    printAreaWidth: 2717,
    printAreaHeight: 2717,
    printAreaTop: 14,
    printAreaLeft: 146,
  },
  layoutGeometry: {
    'fit-area': [{ x: 120, y: 120, width: 2610, height: 2610, optimize: true }],
    centered: [{ x: 375, y: 375, side: 2100 }],
  },
  layouts: FLAT_LAYOUTS,
});

const PRODUCTS = Object.freeze([
  MUG_11,
  MUG_15,
  MUG_20,
  COASTER,
  POSTER_30X40,
  POSTER_50X70,
  FRAMED_POSTER_30X40,
  FRAMED_POSTER_50X70,
  TOTE_BAG,
  THROW_BLANKET_50X60,
  BASIC_PILLOW_18,
  SPIRAL_NOTEBOOK,
]);
const DEFAULT_PRODUCT = MUG_11;

function getProduct(key) {
  return PRODUCTS.find((product) => product.key === key) || null;
}

function getPublicProduct(product = DEFAULT_PRODUCT, orientation = product.defaultOrientation) {
  const resolvedProduct = resolveProductOrientation(product, orientation);
  if (!resolvedProduct) return null;
  return {
    key: resolvedProduct.key,
    familyKey: resolvedProduct.familyKey,
    thumbnail: resolvedProduct.thumbnail,
    name: resolvedProduct.name,
    displayName: resolvedProduct.displayName,
    description: resolvedProduct.description,
    icon: resolvedProduct.icon,
    previewType: resolvedProduct.previewType,
    previewShape: resolvedProduct.previewShape,
    previewMockup: resolvedProduct.previewMockup,
    defaultQuantity: resolvedProduct.defaultQuantity,
    minQuantity: resolvedProduct.minQuantity,
    maxQuantity: resolvedProduct.maxQuantity,
    currency: resolvedProduct.currency,
    unit: resolvedProduct.unit,
    designSafeMargin: resolvedProduct.designSafeMargin,
    printSurfaces: resolvedProduct.printSurfaces,
    size: resolvedProduct.size,
    printFile: resolvedProduct.printFile,
    layoutGeometry: resolvedProduct.layoutGeometry,
    themes: resolvedProduct.themes,
    layouts: resolvedProduct.layouts,
    orientation: resolvedProduct.orientation,
    defaultOrientation: product.defaultOrientation,
    orientations: product.orientationOptions.map((option) => {
      const oriented = resolveProductOrientation(product, option.key);
      return {
        ...option,
        size: oriented.size,
        printFile: oriented.printFile,
        layoutGeometry: oriented.layoutGeometry,
        previewMockup: oriented.previewMockup,
      };
    }),
  };
}

function getPublicProducts() {
  return PRODUCTS.map((product) => getPublicProduct(product));
}

function getPublicProductFamilies() {
  return PRODUCT_FAMILIES.map((family) => ({ ...family }));
}

module.exports = {
  MUG_11,
  MUG_15,
  MUG_20,
  COASTER,
  POSTER_30X40,
  POSTER_50X70,
  FRAMED_POSTER_30X40,
  FRAMED_POSTER_50X70,
  TOTE_BAG,
  THROW_BLANKET_50X60,
  BASIC_PILLOW_18,
  SPIRAL_NOTEBOOK,
  PRODUCT_FAMILIES,
  PRODUCTS,
  DEFAULT_PRODUCT,
  getProduct,
  resolveProductOrientation,
  getPublicProduct,
  getPublicProducts,
  getPublicProductFamilies,
};
