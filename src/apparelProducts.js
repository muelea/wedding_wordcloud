'use strict';

const catalog = require('./apparelCatalog.json');

// Each size keeps its own fulfillment identity and supplier measurements.
// Physical print dimensions stay constant when the garment gets wider/longer.
module.exports = function apparelProducts({ makeProduct, layouts }) {
  return catalog.products.flatMap(record => record.variants.map(variant => {
    const measurements = record.measurements[variant.size];
    const label = `${variant.size} · ${variant.color === 'White' ? 'Weiß' : 'Schwarz'}`;
    const file = record.printfile, margin = 60;
    const safe = { x: margin, y: margin, width: file.width - margin * 2, height: file.height - margin * 2 };
    const template = record.templates.find(t => t.catalog_variant_ids.includes(variant.id));
    return makeProduct({
      key: variant.key, familyKey: 'clothing', catalogGroup: record.garment,
      name: record.name, displayName: record.name, description: record.description,
      icon: '◇', thumbnail: `/assets/product-thumbnails/${record.garment}.svg`,
      productPhoto: variant.photo, productPhotoFit: 'contain', variantLabel: label,
      previewType: 'photo', previewShape: record.garment,
      previewMockup: {
        width: template.template_width, height: template.template_height,
        backgroundColor: template.background_color,
        canvas: {
          left: template.print_area_left / template.template_width * 100,
          top: template.print_area_top / template.template_height * 100,
          width: template.print_area_width / template.template_width * 100,
          height: template.print_area_height / template.template_height * 100,
        },
        assets: { front: record.previewLayer.src },
      },
      previewModel: { kind: 'garment', garment: record.garment, ...measurements,
        fabricWeight: record.fabricWeight, color: variant.color === 'White' ? '#ffffff' : '#0b0b0b',
        printWidth: file.width / file.dpi * 2.54, printHeight: file.height / file.dpi * 2.54,
        printTop: record.printTop },
      productId: record.productId, variantId: variant.id,
      printfileId: file.printfile_id, templateId: null, printTechnique: 'dtg',
      fulfillmentPlacements: ['front'], printSurfaces: [{ key: 'front', label: 'Vorderseite' }],
      defaultQuantity: 1, unit: { singular: record.unit, plural: record.plural },
      designSafeMargin: margin, designSafeAreas: { front: safe },
      size: { label, detail: `${record.fabricWeight} g/m² · Bio-Baumwolle · Vorderseite bedruckt`,
        widthCm: measurements.width, heightCm: measurements.height, sleeveCm: measurements.sleeve },
      printFile: { width: file.width, height: file.height, dpi: file.dpi,
        fillMode: file.fill_mode, canRotate: false, placement: 'front' },
      template: { width: template.template_width, height: template.template_height,
        printAreaWidth: template.print_area_width, printAreaHeight: template.print_area_height,
        printAreaLeft: template.print_area_left, printAreaTop: template.print_area_top },
      layoutGeometry: { 'fit-area': [{ ...safe, optimize: true }], centered: [{
        x: safe.x + safe.width * .1, y: safe.y + safe.height * .1,
        width: safe.width * .8, height: safe.height * .8,
      }] }, layouts,
    });
  }));
};
