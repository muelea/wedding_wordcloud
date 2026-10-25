'use strict';

// Operator-only asset preparation. Normal startup uses the tracked outputs and
// never downloads models or copies files out of another project.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('canvas');
const ROOT = path.resolve(__dirname, '..');
const definitions = [
  ['mug-325', '19-11oz-mug.glb', 19, [43], { rotateY: 135 }],
  ['mug-444', '19-15oz-mug.glb', 19, [44], { rotateY: 135 }],
  ['mug-591', '20oz_mug.glb', 19, [426], { rotateY: -45, front: [26/6000, 60/6000, 5948/6000, 2334/6000] }],
  ['colored-mug-325', '403-11oz-color-mug.glb', 403, [43], { rotateY: 135, accentCell: 2 }],
  ['canvas-12x16', '3-12x16-canvas.glb', 3, [46], { canvas: true, staticCells: { 2: '#c2aa80', 3: '#b2b5b8' } }],
  ['water-bottle', '382-water-bottle-with-material-v4.glb', 382, [192], { printMaterials: ['material_for_print_file_+_bottle.001'] }],
  ['enamel-mug', '407-12oz-enamel-mug.glb', 407, [215], { rotateY: 225, metallicCell: 1, staticCells: { 3: '#ffffff' } }],
  ['steel-tumbler', 'tumbler_withstraw2.glb', 585, [309], { printMaterials: ['print file+white'], heightMaterial: 'print file+white' }],
  ['wine-tumbler', 'wine_tumbler_with_lid.glb', 632, [383], { printMaterials: ['printfile un kruze'] }],
  ['square-pillow', 'square-pillow.glb', 83, [32, 214], { back: [.5, 0, .5, .5], textile: true, heights: { 32: 45.72, 214: 55.88 } }],
  ['rectangular-pillow', 'rectangular-pillow.glb', 83, [72], { back: [.5, 0, .5, .5], textile: true, height: 30.48 }],
  // Calibrated against the independent 13097 flat proof; see the four measured
  // landmarks in test/fixtures/printful-preview-landmarks.json.
  ['mousepad', 'mousepad_3D.glb', 518, [265], { rotateX: 90, height: 18, textile: true,
    frontProjection: { scaleY: 0.9835861110214438, offsetY: 0.010439469930481764 } }],
  ['coaster', 'COASTER_3D.glb', 611, [358], { rotateX: 90, height: 9.5, baseImage: 0 }],
  ['notebook', 'notebook.glb', 474, [242], { back: [.5, 0, .5, .5], height: 21, baseImage: 0 }],
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readGlb(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Invalid GLB');
  const length = bytes.readUInt32LE(12);
  return { json: JSON.parse(bytes.subarray(20, 20 + length)), binary: bytes.subarray(28 + length) };
}

function geometryOnly({ json: original, binary }) {
  const json = structuredClone(original);
  if (json.extensionsRequired?.length || json.animations || json.skins) throw new Error('Model requires an unsupported preparation path');
  const imageViews = new Set((json.images || []).map(image => image.bufferView));
  const indices = new Map(), chunks = [];
  let offset = 0;
  json.bufferViews = json.bufferViews.flatMap((view, index) => {
    if (imageViews.has(index)) return [];
    if (view.buffer !== 0) throw new Error('Expected a self-contained binary buffer');
    indices.set(index, indices.size);
    const data = binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    const padding = Buffer.alloc((4 - data.length % 4) % 4);
    const result = { ...view, byteOffset: offset };
    chunks.push(data, padding); offset += data.length + padding.length;
    return [result];
  });
  for (const accessor of json.accessors) {
    if (!indices.has(accessor.bufferView)) throw new Error('An accessor references an image buffer');
    accessor.bufferView = indices.get(accessor.bufferView);
  }
  for (const material of json.materials || []) {
    for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete material[key];
    delete material.pbrMetallicRoughness?.baseColorTexture;
    delete material.pbrMetallicRoughness?.metallicRoughnessTexture;
  }
  for (const key of ['images', 'textures', 'samplers']) delete json[key];
  json.buffers = [{ byteLength: offset }];
  json.asset.extras = { source: 'Printful public preview; original geometry, normals, indices and UVs retained; sample textures removed' };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const geometry = Buffer.concat(chunks), header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + text.length + geometry.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(geometry.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, geometry]);
}

async function prepare(sourceDirectory) {
  const destination = path.join(ROOT, 'public/assets/product-models');
  fs.mkdirSync(destination, { recursive: true });
  const manifestPath = path.join(ROOT, 'src/productPreviewModels.json');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath)) : { models: [] };
  const models = [];
  for (const [id, sourceFile, productId, printfileIds, settings = {}] of definitions) {
    const bytes = fs.readFileSync(path.join(sourceDirectory, sourceFile));
    const originalSha256 = hash(bytes), known = previous.models.find(model => model.id === id);
    if (known && known.originalSha256 !== originalSha256) throw new Error(`Upstream model changed: ${sourceFile}. Review it before updating the pinned provenance.`);
    const source = readGlb(bytes), output = geometryOnly(source), sha256 = hash(output);
    const filename = `${id}-${sha256.slice(0, 16)}.glb`;
    fs.writeFileSync(path.join(destination, filename), output);
    const { baseImage, heights, ...options } = settings;
    const model = { id, productId, printfileIds, file: `/assets/product-models/${filename}`,
      front: [0, 0, .5, .5], ...options, ...(heights ? { heights } : {}),
      originalFile: sourceFile, originalSha256, sha256, originalBytes: bytes.length, bytes: output.length };
    if (baseImage !== undefined) {
      const image = source.json.images[baseImage], view = source.json.bufferViews[image.bufferView];
      const bitmap = await loadImage(source.binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
      const atlas = createCanvas(1024, 1024), ctx = atlas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, 1024, 1024);
      // Retain cork, paper and binding pixels; remove every sample print.
      ctx.fillStyle = '#ffffff';
      for (const rect of [model.front, model.back].filter(Boolean)) ctx.fillRect(...rect.map(value => value * 1024));
      const texture = atlas.toBuffer('image/jpeg', { quality: .88 });
      const imageName = `${id}-atlas-${hash(texture).slice(0, 16)}.jpg`;
      fs.writeFileSync(path.join(destination, imageName), texture);
      model.baseAtlas = `/assets/product-models/${imageName}`;
      model.baseAtlasSha256 = hash(texture);
    }
    models.push(model);
  }
  const adaptations = previous.adaptations || [];
  for (const adaptation of adaptations) {
    if (!models.some(model => model.id === adaptation.sourceId && model.sha256 === adaptation.sourceSha256)) throw new Error(`Adapted model changed: ${adaptation.id}. Review its surface mask before updating.`);
  }
  const manifest = { retrievedOn: '2026-10-24', sourceBase: 'https://static.cdn.printful.com/static/v880/generator/3d-objects/',
    mappingSource: 'https://static.cdn.printful.com/dist-pf/62351.c6912764bc6932dba2b3.js', models };
  if (adaptations.length) manifest.adaptations = adaptations;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Prepared ${models.length} original meshes; ${(models.reduce((sum, model) => sum + model.bytes, 0) / 1024 / 1024).toFixed(2)} MiB of geometry.`);
}

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node scripts/prepare-product-models.js <directory-with-reviewed-original-GLBs>');
  prepare(path.resolve(directory)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { readGlb, geometryOnly };
