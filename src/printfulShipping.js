'use strict';
const { PRODUCTS } = require('./products');
const { isDeepStrictEqual } = require('node:util');

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function normalizeShippingRate(rate, orderItems) {
  const expected = new Map();
  for (const item of orderItems) expected.set(item.catalog_variant_id,
    (expected.get(item.catalog_variant_id) || 0) + item.quantity);
  if (rate.shipping !== 'STANDARD' || rate.currency !== 'EUR' ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(rate.rate)) ||
      !Array.isArray(rate.shipments) || !rate.shipments.length || rate.shipments.length > 99) {
    throw new Error('invalid shipping rate');
  }
  const remaining = new Map(expected);
  const shipments = rate.shipments.map((shipment) => {
    if (!Array.isArray(shipment.shipment_items) || !shipment.shipment_items.length) throw new Error('missing shipment items');
    const items = shipment.shipment_items.map((item) => {
      const variantId = Number(item.catalog_variant_id), quantity = Number(item.quantity);
      if (!remaining.has(variantId) || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error('invalid shipment item');
      remaining.set(variantId, remaining.get(variantId) - quantity);
      return { variantId, quantity, productKey: PRODUCTS.find((product) => product.printful.variantId === variantId)?.key || null };
    });
    return {
      departureCountry: /^[A-Z]{2}$/.test(shipment.departure_country) ? shipment.departure_country : null,
      customsFeesPossible: typeof shipment.customs_fees_possible === 'boolean' ? shipment.customs_fees_possible : null,
      items,
    };
  });
  if ([...remaining.values()].some((quantity) => quantity !== 0)) throw new Error('incomplete shipment coverage');
  let minDate = dateOnly(rate.min_delivery_date), maxDate = dateOnly(rate.max_delivery_date);
  if (!minDate || !maxDate || minDate > maxDate) minDate = maxDate = null;
  const days = (value) => Number.isInteger(value) && value >= 0 && value <= 365 ? value : null;
  let minDays = days(rate.min_delivery_days), maxDays = days(rate.max_delivery_days);
  if (minDays === null || maxDays === null || minDays > maxDays) minDays = maxDays = null;
  return {
    method: 'STANDARD', methodName: String(rate.shipping_method_name || '').slice(0, 200),
    rate: String(rate.rate), currency: rate.currency,
    delivery: { minDate, maxDate, minDays, maxDays }, shipments,
    checkedAt: new Date().toISOString(),
  };
}

// Only a change visible to the buyer needs confirmation. Request timestamps,
// provider wording and internal shipping rates don't change the displayed offer.
function shippingTerms(shipping) {
  if (!shipping) return null;
  return { delivery: shipping.delivery, shipments: shipping.shipments };
}

function shippingTermsDiffer(before, after) {
  return !isDeepStrictEqual(before.map((entry) => shippingTerms(entry.printfulShipping)),
    after.map((entry) => shippingTerms(entry.printfulShipping)));
}

module.exports = { normalizeShippingRate, shippingTermsDiffer };
