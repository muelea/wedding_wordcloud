'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const preparation = require('./printPreparation');
const { getProduct, resolveProductOrientation } = require('./products');

const VERSION = 1;

async function approve(order, quote, req) {
  const input = req.body?.mockupApproval;
  if (input?.version !== VERSION || input.accepted !== true || !Array.isArray(input.jobIds) ||
      input.jobIds.length < 1 || input.jobIds.length > 20 || input.jobIds.some(id => !/^[A-Za-z0-9_-]{24}$/.test(id))) return false;
  const scope = crypto.createHash('sha256').update(JSON.stringify([
    process.env.PRINTFUL_API_KEY || '', process.env.PRINTFUL_STORE_ID || '',
  ])).digest('hex');
  const needed = new Set(db.getCheckoutQuoteShipments(quote).flatMap(shipment =>
    shipment.items ? shipment.items.filter(item => Number(item.quantity)>0).map(item => item.configurationId || item.configuration_id)
      : [quote.configuration_id]));
  const filesByConfiguration = new Map();
  for (const id of new Set(input.jobIds)) {
    const job = await db.getMockupJob(id);
    if (!job || job.scope !== scope || job.mode !== 'customer' || String(job.eventId)!==String(order.event_id) ||
        !['completed','failed'].includes(job.status) || job.expiresAt<=Date.now()) return false;
    for (const item of job.items || []) {
      if (needed.has(item.configurationId) && item.mockups?.length) filesByConfiguration.set(item.configurationId, item.fileIds);
    }
  }
  if ([...needed].some(id => !filesByConfiguration.has(id))) return false;
  const fileIds = [...new Set([...filesByConfiguration.values()].flat())];
  const files = await db.getPreparedPrintFiles(fileIds);
  const items = await db.getOrderItems(order.id);
  for (const configurationId of needed) {
    const item = items.find(value => value.configuration_id === configurationId);
    if (!item) return false;
    const snapshot = JSON.parse(item.configuration_snapshot_json);
    const product = resolveProductOrientation(getProduct(snapshot.productKey), snapshot.orientation);
    if (!product || JSON.stringify(snapshot.printfulPlacements)!==JSON.stringify(product.printful.placements) ||
        JSON.stringify(snapshot.printfulOptions)!==JSON.stringify(product.printful.options)) return false;
    const exact = files.filter(file => filesByConfiguration.get(configurationId).includes(file.id));
    if (exact.length!==product.printSurfaces.length || product.printSurfaces.some(surface =>
      !exact.some(file => file.configuration_id===configurationId && file.surface_key===surface.key && file.status==='active' &&
        Date.parse(file.expires_at)>Date.now() && file.spec_hash===preparation.specification(product,snapshot.design)))) return false;
  }
  return db.recordMockupApproval(order.id, { version: VERSION, acceptedAt: new Date().toISOString(),
    owner: crypto.createHash('sha256').update(String(req.get('X-Wolkenworte-Guest-Id') || '')).digest('hex'),
    configurationIds: [...needed].sort(), fileIds, jobIds: [...new Set(input.jobIds)] });
}

module.exports = { VERSION, approve };
