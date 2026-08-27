'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const storage = require('./privateStorage');

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_STORED_BYTES = 6 * 1024 * 1024;
const MAX_DIMENSION = 1600;
const MAX_PIXELS = 2_560_000;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
let sharpLibrary = null;

function imageProcessor(...args) {
  if (!sharpLibrary) sharpLibrary = require('sharp');
  return sharpLibrary(...args);
}

class DesignAssetError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DesignAssetError';
    this.code = code;
    this.status = status;
  }
}

function detectMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function decodeDataUrl(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 128) {
    throw new DesignAssetError('image_too_large', 413);
  }
  const match = DATA_URL_RE.exec(value);
  if (!match) throw new DesignAssetError('invalid_image');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) {
    throw new DesignAssetError('image_too_large', 413);
  }
  const mimeType = detectMime(bytes);
  if (!mimeType || mimeType !== `image/${match[1]}`) {
    throw new DesignAssetError('invalid_image');
  }
  return { bytes, mimeType };
}

async function normalizeImage(dataUrl) {
  const source = decodeDataUrl(dataUrl);
  let metadata;
  try {
    const input = imageProcessor(source.bytes, {
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
      pages: 1,
      sequentialRead: true,
    });
    metadata = await input.metadata();
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        Math.max(width, height) > MAX_DIMENSION || width * height > MAX_PIXELS) {
      throw new DesignAssetError('invalid_image_dimensions');
    }

    let pipeline = input.rotate();
    if (source.mimeType === 'image/jpeg') {
      pipeline = pipeline.jpeg({ quality: 84, mozjpeg: true });
    } else if (source.mimeType === 'image/png') {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    } else {
      pipeline = pipeline.webp({ quality: 84, alphaQuality: 100, smartSubsample: true });
    }
    const normalized = await pipeline.toBuffer({ resolveWithObject: true });
    if (normalized.info.width > MAX_DIMENSION || normalized.info.height > MAX_DIMENSION ||
        normalized.info.width * normalized.info.height > MAX_PIXELS) {
      throw new DesignAssetError('invalid_image_dimensions');
    }
    if (!normalized.data.length || normalized.data.length > MAX_STORED_BYTES) {
      throw new DesignAssetError('image_too_large', 413);
    }
    if (detectMime(normalized.data) !== source.mimeType) throw new DesignAssetError('invalid_image');
    return {
      bytes: normalized.data,
      mimeType: source.mimeType,
      width: normalized.info.width,
      height: normalized.info.height,
      byteSize: normalized.data.length,
      sha256: crypto.createHash('sha256').update(normalized.data).digest('hex'),
    };
  } catch (error) {
    if (error instanceof DesignAssetError) throw error;
    throw new DesignAssetError('invalid_image');
  }
}

function extensionFor(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'webp';
}

async function signedAssetResponse(asset) {
  try {
    const previewUrl = await storage.createSignedUrl(asset.object_key);
    return {
      assetId: asset.id,
      previewUrl,
      mimeType: asset.mime_type,
      byteSize: Number(asset.byte_size),
      expiresInSeconds: storage.SIGNED_PREVIEW_TTL_SECONDS,
    };
  } catch {
    throw new DesignAssetError('storage_unavailable', 503);
  }
}

async function uploadEventAsset({ event, ownerId, dataUrl }) {
  if (!event) throw new DesignAssetError('event_not_found', 404);
  if (!/^[a-f0-9]{32}$/.test(String(ownerId || ''))) {
    throw new DesignAssetError('invalid_owner');
  }
  const normalized = await normalizeImage(dataUrl);
  let pending;
  try {
    pending = await db.beginDesignAssetUpload({
      eventId: event.id,
      ownerId,
      mimeType: normalized.mimeType,
      byteSize: normalized.byteSize,
      sha256: normalized.sha256,
      extension: extensionFor(normalized.mimeType),
    });
  } catch (error) {
    if (error.code === 'asset_limit') throw new DesignAssetError('asset_limit', 429);
    throw error;
  }
  if (pending.reused) return signedAssetResponse(pending.asset);

  try {
    await storage.upload(
      pending.asset.object_key,
      normalized.bytes,
      normalized.mimeType
    );
  } catch {
    await db.markDesignAssetUploadFailed(pending.asset.id, 'storage_upload_failed');
    throw new DesignAssetError('storage_unavailable', 503);
  }

  let active;
  try {
    active = await db.activateDesignAsset(pending.asset.id);
  } catch {
    await db.markDesignAssetUploadFailed(pending.asset.id, 'storage_finalize_failed');
    throw new DesignAssetError('storage_unavailable', 503);
  }
  return signedAssetResponse(active);
}

function collectAssetIds(design) {
  if (!design?.surfaces || typeof design.surfaces !== 'object') return [];
  return [...new Set(Object.values(design.surfaces)
    .flatMap((surface) => Array.isArray(surface) ? surface : [])
    .filter((item) => item?.type === 'image')
    .map((item) => item.assetId)
    .filter(Boolean))];
}

async function signedSourcesForConfiguration(configurationId) {
  const assets = await db.getConfigurationAssets(configurationId);
  const entries = await Promise.all(assets.map(async (asset) => {
    try {
      return [asset.id, await storage.createSignedUrl(asset.object_key)];
    } catch {
      throw new DesignAssetError('storage_unavailable', 503);
    }
  }));
  return new Map(entries);
}

async function materializeDesignForEditing(configurationId, design) {
  const sources = await signedSourcesForConfiguration(configurationId);
  const expected = new Set(collectAssetIds(design));
  if (expected.size !== sources.size || [...expected].some((id) => !sources.has(id))) {
    throw new Error('configuration_asset_mismatch');
  }
  return {
    ...design,
    surfaces: Object.fromEntries(Object.entries(design.surfaces).map(([key, surface]) => [
      key,
      surface.map((item) => item.type === 'image'
        ? { ...item, src: sources.get(item.assetId) }
        : { ...item }),
    ])),
  };
}

async function materializeDesignForPrint(configurationId, design) {
  const assets = await db.getConfigurationAssets(configurationId);
  const entries = await Promise.all(assets.map(async (asset) => {
    const bytes = await storage.download(asset.object_key);
    if (bytes.length !== Number(asset.byte_size) ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256 ||
        detectMime(bytes) !== asset.mime_type) {
      throw new Error('stored_asset_integrity_failed');
    }
    return [asset.id, `data:${asset.mime_type};base64,${bytes.toString('base64')}`];
  }));
  const sources = new Map(entries);
  const expected = new Set(collectAssetIds(design));
  if (expected.size !== sources.size || [...expected].some((id) => !sources.has(id))) {
    throw new Error('configuration_asset_mismatch');
  }
  return {
    ...design,
    surfaces: Object.fromEntries(Object.entries(design.surfaces).map(([key, surface]) => [
      key,
      surface.map((item) => item.type === 'image'
        ? { ...item, src: sources.get(item.assetId) }
        : { ...item }),
    ])),
  };
}

async function deleteExpiredAsset(assetId) {
  const asset = await db.claimDesignAssetForDeletion(assetId);
  if (!asset) return { deleted: false };
  try {
    await storage.remove(asset.object_key);
    await db.finishDesignAssetDeletion(asset.id);
    return { deleted: true };
  } catch {
    await db.failDesignAssetDeletion(asset.id, 'storage_delete_failed');
    return { deleted: false, retryable: true };
  }
}

module.exports = {
  DesignAssetError,
  MAX_SOURCE_BYTES,
  MAX_STORED_BYTES,
  MAX_DIMENSION,
  MAX_PIXELS,
  collectAssetIds,
  decodeDataUrl,
  normalizeImage,
  uploadEventAsset,
  materializeDesignForEditing,
  materializeDesignForPrint,
  deleteExpiredAsset,
};
