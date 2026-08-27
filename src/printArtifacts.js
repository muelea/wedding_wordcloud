'use strict';

const crypto = require('crypto');
const db = require('./db');
const storage = require('./privateStorage');
const designAssets = require('./designAssets');
const { buildProductPrintSvg } = require('./mugPrint');
const { getProduct, resolveProductOrientation } = require('./products');

const MIME_TYPE = 'image/svg+xml';
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;

function parseSnapshot(orderItem) {
  try {
    const snapshot = JSON.parse(orderItem.configuration_snapshot_json);
    if (!snapshot || snapshot.version !== 1 || !snapshot.design?.surfaces) throw new Error();
    return snapshot;
  } catch {
    throw new Error('Die gespeicherte Druckkonfiguration ist ungültig.');
  }
}

function artifactCapabilityUrl(artifact) {
  let base;
  try {
    base = new URL(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`);
  } catch {
    throw new Error('PUBLIC_URL ist keine gültige URL.');
  }
  return new URL(
    `/api/print-files/${encodeURIComponent(artifact.id)}/${encodeURIComponent(artifact.access_nonce)}`,
    base
  ).toString();
}

function ensureBudget(deadline, minimumMs = 500) {
  if (deadline && Date.now() + minimumMs >= deadline) {
    const error = new Error('Der Wartungslauf hat sein sicheres Zeitbudget erreicht.');
    error.code = 'FULFILLMENT_CHECKPOINT';
    throw error;
  }
}

async function renderItemSurfaces(orderItem) {
  const snapshot = parseSnapshot(orderItem);
  const product = resolveProductOrientation(getProduct(snapshot.productKey), snapshot.orientation);
  if (!product || Number(snapshot.printfulVariantId) !== Number(orderItem.printful_variant_id) ||
      Number(snapshot.printWidth) !== product.printFile.width ||
      Number(snapshot.printHeight) !== product.printFile.height) {
    throw new Error('Die gespeicherte Druckkonfiguration passt nicht zum Produkt.');
  }

  let design = snapshot.design;
  const hasPhotos = Object.values(design.surfaces)
    .some((surface) => Array.isArray(surface) && surface.some((item) => item.type === 'image'));
  if (hasPhotos) {
    if (!orderItem.configuration_id) throw new Error('Die private Fotokonfiguration fehlt.');
    design = await designAssets.materializeDesignForPrint(orderItem.configuration_id, design);
  }

  return product.printSurfaces.map((surface) => {
    const surfaceDesign = design.surfaces[surface.key];
    if (!Array.isArray(surfaceDesign)) throw new Error('Eine Druckfläche fehlt in der Bestellung.');
    const bytes = Buffer.from(buildProductPrintSvg(product, surfaceDesign), 'utf8');
    if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) {
      throw new Error('Die erzeugte Druckdatei hat eine ungültige Größe.');
    }
    return { surfaceKey: surface.key, placement: surface.printfulType || surface.key, bytes };
  });
}

async function persistSurface(order, orderItem, rendered, { deadline } = {}) {
  ensureBudget(deadline, 1_000);
  const sha256 = crypto.createHash('sha256').update(rendered.bytes).digest('hex');
  const candidateId = crypto.randomBytes(18).toString('base64url');
  const candidateNonce = crypto.randomBytes(24).toString('base64url');
  const objectKey = `print-artifacts/${candidateId}/${sha256}.svg`;
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  let artifact = await db.getOrCreatePrintArtifact({
    id: candidateId,
    orderId: order.id,
    orderItemId: orderItem.id,
    configurationId: orderItem.configuration_id,
    surfaceKey: rendered.surfaceKey,
    objectKey,
    mimeType: MIME_TYPE,
    byteSize: rendered.bytes.length,
    sha256,
    accessNonce: candidateNonce,
    expiresAt,
  });

  if (artifact.sha256 !== sha256 || Number(artifact.byte_size) !== rendered.bytes.length ||
      artifact.mime_type !== MIME_TYPE) {
    const error = new Error('Die eingefrorene Druckdatei stimmt nicht mit ihrem bestehenden Artefakt überein.');
    error.code = 'FULFILLMENT_BLOCKED';
    throw error;
  }
  if (artifact.storage_status === 'active') return artifact;
  if (artifact.storage_status !== 'uploading') {
    const error = new Error('Das Druckartefakt befindet sich in einem ungültigen Speicherzustand.');
    error.code = 'FULFILLMENT_BLOCKED';
    throw error;
  }

  ensureBudget(deadline, 4_000);
  try {
    await storage.upload(artifact.object_key, rendered.bytes, MIME_TYPE);
  } catch (uploadError) {
    // An upload response can be lost after Storage accepted the immutable
    // object. Reconcile the exact object bytes before deciding to retry.
    try {
      const stored = await storage.download(artifact.object_key);
      const storedSha = crypto.createHash('sha256').update(stored).digest('hex');
      if (stored.length !== rendered.bytes.length || storedSha !== sha256) throw new Error('artifact_mismatch');
    } catch {
      await db.failPrintArtifactUpload(artifact.id, 'storage_upload_failed');
      throw uploadError;
    }
  }
  artifact = await db.activatePrintArtifact(artifact.id, {
    byteSize: rendered.bytes.length,
    sha256,
  });
  if (!artifact) throw new Error('Das Druckartefakt konnte nicht aktiviert werden.');
  return artifact;
}

async function ensureOrderArtifacts(order, orderItems, options = {}) {
  const artifacts = [];
  for (const orderItem of orderItems) {
    ensureBudget(options.deadline, 1_000);
    const surfaces = await renderItemSurfaces(orderItem);
    for (const rendered of surfaces) {
      artifacts.push(await persistSurface(order, orderItem, rendered, options));
    }
  }
  return artifacts;
}

async function loadActiveArtifactBytes(id, accessNonce) {
  const artifact = await db.getActivePrintArtifact(id, accessNonce);
  if (!artifact) return null;
  const bytes = await storage.download(artifact.object_key);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== Number(artifact.byte_size) || sha256 !== artifact.sha256) {
    throw new Error('stored_artifact_integrity_failed');
  }
  return { artifact, bytes };
}

module.exports = {
  MIME_TYPE,
  artifactCapabilityUrl,
  ensureOrderArtifacts,
  loadActiveArtifactBytes,
  parseSnapshot,
};
