'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const storage = require('./privateStorage');
const { inspectRasterDataUrl } = require('./designImages');
const limits = require('../public/js/design-image-data');
let testStorage = null;
const inFlight = new Map();
const fail = () => Object.assign(new Error('Die Bilder konnten nicht sicher gespeichert oder geladen werden.'),
  { code: 'design_image_unavailable', status: 503 });
function store() {
  if (process.env.NODE_ENV === 'test') { if (!testStorage) throw fail(); return testStorage; }
  return storage;
}
function walk(value, visit) {
  if (Array.isArray(value)) return value.map(item => walk(item, visit));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, visit)]));
  return visit(result);
}
function ids(value) {
  const found = new Set();
  walk(value, item => { if (item.type === 'image' && item.assetId) found.add(item.assetId); return item; });
  return [...found];
}
function canonical(value) {
  return walk(value, item => { if (item.type === 'image' && item.assetId) delete item.src; return item; });
}
async function prepare(scope, value, { deferUploads = false } = {}) {
  const sources = new Map();
  walk(value, item => {
    if (item.type === 'image' && (Object.hasOwn(item, 'src') || Object.hasOwn(item, 'assetId'))) {
      // Only validated inline pixels can create a new reference. Client IDs
      // and remote URLs never authorize reading another workspace's assets.
      const info = inspectRasterDataUrl(item.src);
      if (!info || item.assetId) throw Object.assign(new Error('invalid_design'), { code: 'invalid_design', status: 400 });
      sources.set(item.src, info);
    }
    return item;
  });
  const totalBytes = [...sources.values()].reduce((sum, image) => sum + image.byteSize, 0);
  const pixels = [...sources.values()].reduce((sum, image) => sum + image.width * image.height, 0);
  if (sources.size > limits.MAX_IMAGES || totalBytes > limits.MAX_BYTES || pixels > limits.MAX_PIXELS) {
    throw Object.assign(new Error('design_image_limit'), { code: 'design_image_limit', status: 413 });
  }
  const assets = new Map();
  const uploads = [];
  for (const [src, info] of sources) {
    const bytes = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const id = crypto.randomUUID();
    let asset = await db.reserveDesignImageAsset({ id, scope, sha256, ...info,
      objectKey: `design-images/${id}.${info.mimeType === 'image/png' ? 'png' : 'jpg'}` });
    if (!asset || asset.status === 'deleting') throw fail();
    if (asset.status !== 'active') {
      uploads.push(async () => { try {
        const { Image } = require('canvas');
        const decoded = new Image();
        try {
          await new Promise((resolve, reject) => { decoded.onload = resolve; decoded.onerror = reject; decoded.src = bytes; });
        } catch { throw Object.assign(new Error('invalid_design'), { code: 'invalid_design', status: 400 }); }
        finally { decoded.src = Buffer.alloc(0); }
        try { await store().upload(asset.object_key, bytes, asset.mime_type); }
        catch (error) {
          const existing = await store().download(asset.object_key).catch(() => null);
          if (!existing || !existing.equals(bytes)) throw error;
        }
        asset = await db.activateDesignImageAsset(asset.id, sha256, bytes.length);
        if (!asset) throw fail();
      } catch (error) {
        await db.recordDesignImageFailure(asset.id).catch(() => {});
        if (error.code === 'invalid_design') throw error;
        throw fail();
      } });
    }
    assets.set(src, asset);
  }
  const commit = async () => { for (const upload of uploads) await upload(); };
  if (!deferUploads) await commit();
  return { commit, value: walk(value, item => {
    if (item.type === 'image' && typeof item.src === 'string') { item.assetId = assets.get(item.src).id; delete item.src; }
    return item;
  }), assetIds: [...assets.values()].map(asset => asset.id), imageBytes: totalBytes };
}
async function load(asset) {
  if (inFlight.has(asset.id)) return inFlight.get(asset.id);
  const work = (async () => {
    const bytes = await store().download(asset.object_key);
    if (bytes.length !== Number(asset.byte_size) || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw fail();
    return `data:${asset.mime_type};base64,${bytes.toString('base64')}`;
  })();
  // Sharing is in-flight only, and remains bounded even under connection storms.
  if (inFlight.size < 40) inFlight.set(asset.id, work);
  try { return await work; } catch { throw fail(); } finally { if (inFlight.get(asset.id) === work) inFlight.delete(asset.id); }
}
async function hydrate(value) {
  const assetIds = ids(value);
  if (!assetIds.length) return value;
  if (assetIds.length > limits.MAX_IMAGES) throw fail();
  const assets = await db.getDesignImageAssets(assetIds);
  if (assets.length !== assetIds.length) throw fail();
  const sources = new Map();
  // Bound downloads per document rather than fanning out every image at once.
  for (let offset = 0; offset < assets.length; offset += 2) await Promise.all(assets.slice(offset, offset + 2).map(async asset => {
    sources.set(asset.id, await load(asset));
  }));
  return walk(value, item => {
    if (item.type === 'image' && item.assetId) item.src = sources.get(item.assetId);
    return item;
  });
}
async function cleanupOne(id) {
  const asset = await db.claimUnusedDesignImageAsset(id);
  if (!asset) return { protected: 1 };
  try {
    await store().remove(asset.object_key);
    if (!await db.finishDesignImageDeletion(asset.id, asset.lease, true)) throw fail();
    return { deleted: 1 };
  } catch {
    await db.finishDesignImageDeletion(asset.id, asset.lease, false);
    return { reason: 'design_image_delete_failed', failed: 1 };
  }
}
async function cleanup({ deadline = Date.now() + 10_000, maxObjects = 4 } = {}) {
  if (process.env.NODE_ENV === 'test' && !testStorage) return 0;
  let removed = 0;
  while (removed < maxObjects && Date.now() + 3800 < deadline) {
    const asset = await db.claimUnusedDesignImageAsset();
    if (!asset) break;
    try { await store().remove(asset.object_key); if (await db.finishDesignImageDeletion(asset.id, asset.lease, true)) removed++; }
    catch { await db.finishDesignImageDeletion(asset.id, asset.lease, false); }
  }
  return removed;
}
function setStorageForTests(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test-only image Storage adapter');
  testStorage = adapter;
}
module.exports = { prepare, hydrate, canonical, ids, cleanup, cleanupOne, setStorageForTests };
