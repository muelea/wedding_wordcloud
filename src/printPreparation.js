'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const storage = require('./privateStorage');

function specification(product, design) {
  return crypto.createHash('sha256').update(JSON.stringify([
    product.key, product.printful.variantId, product.orientation,
    product.printFile.width, product.printFile.height, product.printful.placements,
    product.printful.options, product.printful.technique, require('./designImageAssets').canonical(design),
  ])).digest('hex');
}

async function prepare(configuration, product, design, {
  repository = db, storageClient = storage,
  renderPng = (...args) => require('./printArtifacts').renderPreviewSurface(...args),
} = {}) {
  const files = [];
  for (const surface of product.printSurfaces) {
    const id = crypto.randomBytes(18).toString('base64url');
    const lease = crypto.randomUUID();
    let file = await repository.claimPreparedPrintFile({ id, lease, configurationId: configuration.id,
      surfaceKey: surface.key, specHash: specification(product, design), objectKey: `prepared-prints/${id}.png` });
    if (!file) throw Object.assign(new Error('Print preparation busy'), { code: 'PRINT_RENDER_BUSY' });
    if (file.status !== 'active') {
      try {
        let bytes, alreadyUploaded = false;
        // Recover an upload whose successful response was lost before rendering again.
        if (file.sha256) {
          try { bytes = await storageClient.download(file.object_key); alreadyUploaded = true; } catch { /* retry a missing upload */ }
        }
        if (!bytes) bytes = await renderPng(product, design.surfaces[surface.key]);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (file.sha256 && file.sha256 !== sha256) throw new Error('prepared_print_integrity_failed');
        if (!await repository.savePreparedPrintFile(file.id, lease, sha256, bytes.length)) throw new Error('print_lease_lost');
        try { if (!alreadyUploaded) await storageClient.upload(file.object_key, bytes, 'image/png'); }
        catch (error) {
          const stored = await storageClient.download(file.object_key).catch(() => null);
          if (!stored || !stored.equals(bytes)) throw error;
        }
        file = await repository.savePreparedPrintFile(file.id, lease, sha256, bytes.length, true);
        if (!file) throw new Error('print_lease_lost');
      } finally { await repository.releasePreparedPrintFile(file.id, lease); }
    }
    files.push(file);
  }
  return files;
}

module.exports = { specification, prepare };
