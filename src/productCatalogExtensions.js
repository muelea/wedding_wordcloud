'use strict';

const manifest = require('./productCatalogManifest.json');

module.exports = function extendCatalog({ makeProduct, products, flatLayouts, mugLayouts, orientations }) {
  const byKey = new Map(products.map(product => [product.key, product]));
  return manifest.products.map(record => {
    const base = byKey.get(record.base);
    if (record.base && !base) throw new Error(`Unknown catalog base: ${record.base}`);
    const file = { ...record.printfile };
    if (['poster', 'frame', 'canvas'].includes(record.kind) && file.width > file.height) [file.width, file.height] = [file.height, file.width];
    const placement = Object.keys(record.placements)[0];
    const margin = record.margin ?? base?.designSafeMargin ?? 50;
    const safe = record.safeArea || { x: margin, y: margin, width: file.width - margin * 2, height: file.height - margin * 2 };
    const clone = base ? { ...base, ...base.printful, productId: base.printful.productId,
      fulfillmentPlacements: base.printful.placements, fulfillmentOptions: base.printful.options,
      printTechnique: base.printful.technique, orientationOptions: base.orientationOptions } : {};
    const template = record.templates.find(t => t.role === 'template') || record.templates[0];
    let model = record.model || null;
    let previewType = '3d', previewMockup = null;
    if (record.kind === 'case') {
      model = { ...record.model, magSafe: record.productId === 798, device: record.label, displayPhone: true };
    } else if (record.kind === 'colored-mug') {
      model = { kind: 'colored-mug', accent: record.accent };
    } else if (['bottle', 'steel-tumbler', 'wine', 'travel', 'enamel'].includes(record.kind)) {
      model = { kind: record.kind, color: record.color, profile: record.profile,
        printCenterY: record.printCenterY || 0, straw: record.straw, finish: 'glossy' };
    } else if (['poster', 'frame'].includes(record.kind)) {
      const width = file.width / file.dpi * 2.54, height = file.height / file.dpi * 2.54;
      model = { kind: 'panel', width, height, depth: record.kind === 'frame' ? 1.9 : .03,
        frameColor: record.frameColor };
    } else if (record.kind === 'canvas') {
      const inset = record.frontInset ?? 900;
      model = { kind: 'canvas', width: Math.min(record.width, record.height), height: Math.max(record.width, record.height), depth: record.depth,
        ...(record.canvasStyle ? { style: record.canvasStyle, frameColor: record.frameColor } : {}),
        face: { x: inset / file.width, y: inset / file.height,
          width: (file.width - inset * 2) / file.width, height: (file.height - inset * 2) / file.height } };
    } else if (['mousepad', 'sleeve'].includes(record.kind)) {
      // Sleeves use the provider mockup's visible face crop. Inferring that
      // crop from nominal finished dimensions enlarged the design.
      // Other surfaces retain their physical bleed conversion.
      model = { kind: record.kind, width: record.width, height: record.height, depth: record.depth,
        radius: record.kind === 'sleeve' ? 1.8 : .5,
        face: record.previewFace || { x: (1 - record.width / 2.54 * file.dpi / file.width) / 2,
          y: (1 - record.height / 2.54 * file.dpi / file.height) / 2,
          width: record.width / 2.54 * file.dpi / file.width, height: record.height / 2.54 * file.dpi / file.height } };
    } else if (record.kind === 'tote') {
      model = { kind: 'tote', width: 39, height: 39, depth: 7, handleColor: record.handleColor };
    } else if (record.kind === 'eco-tote') {
      const color = record.previewMockup.backgroundColor;
      model = { kind: 'tote', style: 'organic', width: 40.6, height: 35.6, depth: 12.7,
        color, handleColor: color, printWidth: 25.4, printHeight: 25.4, printFaceCenterY: -1.3 };
      // Retain the provider composition as calibration evidence. Rendering uses
      // the single front print on a gusseted cotton body with an unprinted back.
      previewMockup = record.previewMockup;
    } else if (record.kind === 'blanket') {
      model = { kind: 'blanket', width: 101.6, height: 76.2, depth: .6, color: '#ffffff', face: { x: 225/file.width, y: 225/file.height, width: 1-450/file.width, height: 1-450/file.height } };
    } else if (record.kind === 'pillow') {
      model = record.model;
    } else {
      previewType = 'flat';
      previewMockup = record.previewMockup;
      if (!previewMockup) throw new Error(`Missing verified preview: ${record.key}`);
    }
    const name = record.name || base.displayName;
    const isColoredMug = record.kind === 'colored-mug';
    const frameCopy = record.frameColor === '#c79d67'
      ? { displayName: 'Poster im Eichenrahmen', description: 'Mattes Museumspapier im Rahmen aus Massiveiche.', detail: '189 g/m² · Rahmen aus Massiveiche' }
      : record.frameColor === '#202124'
        ? { displayName: base?.displayName, description: base?.description, detail: base?.size.detail }
        : { displayName: 'Poster im weißen Rahmen', description: 'Mattes Museumspapier im weißen Holzrahmen.', detail: '189 g/m² · weißer Holzrahmen' };
    const layoutGeometry = isColoredMug ? base.layoutGeometry : {
      'fit-area': [{ ...safe, optimize: true }],
      centered: [{ x: safe.x + safe.width * .12, y: safe.y + safe.height * .12,
        width: safe.width * .76, height: safe.height * .76 }],
    };
    const surfaces = record.kind === 'pillow' ? ['front', 'back'] : [placement];
    const product = makeProduct({ ...clone,
      key: record.key, familyKey: record.family || base.familyKey,
      catalogGroup: record.catalogGroup || (record.kind === 'colored-mug' ? 'colored-mug' : record.kind === 'case' ? record.shape : ['poster','frame','pillow','blanket','tote'].includes(record.kind) ? base.previewShape : record.kind),
      variantLabel: record.canvasStyle === 'framed' || ['colored-mug', 'case', 'frame'].includes(record.kind) ? record.variantLabel : record.label, name,
      displayName: isColoredMug ? 'Tasse mit farbiger Innenseite' : record.kind === 'frame' ? frameCopy.displayName : name,
      description: record.kind === 'case'
        ? 'Zweischichtige Schutzhülle. Das Motiv bleibt unterhalb der Kamera und innerhalb des sicheren Druckbereichs.'
        : record.kind === 'frame' ? frameCopy.description
        : record.kind === 'tote' ? 'Tragetasche mit farbigen Baumwollträgern und eurer persönlichen Wortwolke.'
        : record.kind === 'eco-tote' ? 'Bio-Baumwolltasche mit bedruckter Vorderseite.' : record.description || base?.description || `${name} mit eurer persönlichen Wortwolke.`,
      icon: base?.icon || '◇', thumbnail: base?.thumbnail || `/assets/product-thumbnails/${({ case: 'phone-case', bottle: 'water-bottle', sleeve: 'laptop-sleeve', mousepad: 'mouse-pad', canvas: 'canvas', 'eco-tote': 'tote' })[record.kind] || 'drinkware'}.svg`,
      productPhoto: record.productPhoto, productPhotoFit: 'contain', productPhotoPosition: 'center',
      previewType, previewShape: record.shape || base.previewShape, previewModel: model, previewMockup,
      productId: record.productId, variantId: record.variantId, printfileId: file.printfile_id, templateId: null,
      printTechnique: template?.technique || base?.printful.technique || 'sublimation',
      printFile: { width: file.width, height: file.height, dpi: file.dpi, fillMode: file.fill_mode, canRotate: file.can_rotate, placement },
      template: template ? { width: template.template_width, height: template.template_height,
        printAreaWidth: template.print_area_width, printAreaHeight: template.print_area_height,
        printAreaLeft: template.print_area_left, printAreaTop: template.print_area_top } : {},
      defaultQuantity: 1, unit: base?.unit || { singular: name, plural: ({ Mauspad: 'Mauspads', Laptophülle: 'Laptophüllen', Leinwand: 'Leinwände', 'Edelstahl-Trinkflasche': 'Edelstahl-Trinkflaschen', 'Emaille-Tasse': 'Emaille-Tassen', 'Bio-Baumwolltasche': 'Bio-Baumwolltaschen', 'iPhone-Schutzhülle': 'iPhone-Schutzhüllen', 'MagSafe-Schutzhülle': 'MagSafe-Schutzhüllen', 'Samsung-Schutzhülle': 'Samsung-Schutzhüllen' })[name] || name },
      designSafeMargin: margin, designSafeAreas: ['colored-mug', 'tote'].includes(record.kind) ? base.designSafeAreas : { default: safe },
      fulfillmentPlacements: surfaces,
      fulfillmentOptions: base?.printful.options || [],
      printSurfaces: surfaces.map(key => ({ key, label: key === 'front' ? 'Vorderseite' : key === 'back' ? 'Rückseite' : 'Druckfläche' })),
      size: { ...(base?.size || {}), label: record.kind === 'colored-mug' ? record.variantLabel : record.kind === 'case' ? record.variantLabel : record.label || base?.size.label,
        ...(record.heightCm ? { heightCm: record.heightCm, diameterCm: record.diameterCm } : {}),
        detail: record.kind === 'case' ? '' : record.kind === 'frame' ? frameCopy.detail
          : record.kind === 'tote' ? record.handleColor === '#ce252b' ? '10 l · rote Träger' : '10 l · gelbe Träger'
          : record.kind === 'eco-tote' ? 'Nur Vorderseite bedruckt' : record.detail || base?.size.detail },
      layoutGeometry, layouts: isColoredMug ? mugLayouts : flatLayouts,
      orientationOptions: record.kind === 'blanket' ? base.orientationOptions :
        ['poster', 'frame', 'canvas'].includes(record.kind) && file.can_rotate ? orientations : [],
      defaultOrientation: record.kind === 'blanket' ? 'portrait' :
        ['poster', 'frame', 'canvas'].includes(record.kind) && file.can_rotate ? 'portrait' : 'default',
      nativeOrientation: record.kind === 'blanket' ? 'landscape' : 'portrait',
      legacyDefaultOrientation: record.kind === 'blanket' ? 'landscape' : null,
    });
    byKey.set(product.key, product);
    return product;
  });
};
