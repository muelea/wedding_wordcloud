'use strict';

const crypto = require('crypto');
const snapshot = require('./productCostSnapshot.json');
const GERMAN_TAX_RATE = 0.19;
const PRICING_VERSION = 2;

function eurosToCents(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(Math.round(number * 100))) {
    throw new Error('invalid Printful money');
  }
  return Math.round(number * 100);
}
function setting(name, fallback, maximum, integer = false) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= maximum && (!integer || Number.isInteger(value))
    ? value : fallback;
}
const productMarkupPercent = () => setting('SHOP_PRODUCT_MARKUP_PERCENT', 50, 500);
const paymentReservePercent = () => setting('SHOP_PAYMENT_RESERVE_PERCENT', 3.69, 20);
const paymentReserveFixedCents = () => setting('SHOP_PAYMENT_RESERVE_FIXED_CENTS', 49, 500, true);
const estimatePaymentFeeCents = total => Math.ceil(total * paymentReservePercent() / 100 + paymentReserveFixedCents());

// Retail price planning, never a replacement for Stripe Tax. Keep both prices:
// a published DE gross cent cannot always be reversed to an exact net cent.
function componentPrice(baseCents) {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) throw new Error('invalid price basis');
  const denominator = 1 - paymentReservePercent() / 100 * (1 + GERMAN_TAX_RATE);
  const exactNet = (baseCents + paymentReserveFixedCents()) / denominator;
  const netCents = Math.ceil(exactNet - 1e-9);
  const grossCents = Math.ceil(exactNet * (1 + GERMAN_TAX_RATE) - 1e-9);
  if (![netCents, grossCents].every(Number.isSafeInteger)) throw new Error('price exceeds safe cents');
  return { netCents, grossCents, reserveCents: netCents - baseCents };
}
function catalogVersion() {
  return crypto.createHash('sha256').update(JSON.stringify([
    snapshot, productMarkupPercent(), paymentReservePercent(), paymentReserveFixedCents(),
  ])).digest('hex').slice(0, 16);
}
function catalogPrice(variantId) {
  const cost = snapshot.variants[String(variantId)];
  if (!cost) throw new Error('missing catalog price for variant ' + variantId);
  const baseCents = Math.ceil(cost.productCents * (1 + productMarkupPercent() / 100)) + cost.supplierTaxCents;
  const price = componentPrice(baseCents);
  return {
    version: PRICING_VERSION, catalogVersion: catalogVersion(), currency: 'EUR', referenceCountry: 'DE',
    unitNetCents: price.netCents, unitGrossCents: price.grossCents,
    reserveCents: price.reserveCents, germanDeliveryAvailable: cost.referenceCountry !== 'AU',
  };
}

function buildCustomerQuoteForShipments(shipments) {
  if (!Array.isArray(shipments) || shipments.length !== 1) throw new Error('one delivery address required');
  const shipment = shipments[0];
  const costs = shipment.costs;
  if (String(costs?.currency).toUpperCase() !== 'EUR') throw new Error('invalid Printful currency');
  const supplierTaxCents = eurosToCents(costs.tax) + eurosToCents(costs.vat);
  if (eurosToCents(costs.total) <= eurosToCents(costs.shipping) + supplierTaxCents) {
    throw new Error('invalid Printful product costs');
  }
  const country = String(shipment.recipient?.country_code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('invalid pricing country');
  if (!Array.isArray(shipment.items) || !shipment.items.length) throw new Error('missing priced items');
  const taxBehavior = country === 'DE' ? 'inclusive' : 'exclusive';
  const items = shipment.items.map(item => {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('invalid quantity');
    const price = catalogPrice(item.variantId);
    return { configurationId: String(item.configurationId), productKey: item.productKey,
      variantId: Number(item.variantId), quantity, unitNetCents: price.unitNetCents,
      unitGrossCents: price.unitGrossCents,
      unitAmountCents: taxBehavior === 'inclusive' ? price.unitGrossCents : price.unitNetCents,
      reserveCents: price.reserveCents };
  });
  const shipping = componentPrice(eurosToCents(costs.shipping));
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const itemsCents = items.reduce((sum, item) => sum + item.quantity * item.unitAmountCents, 0);
  const shippingCents = taxBehavior === 'inclusive' ? shipping.grossCents : shipping.netCents;
  const paymentReserveCents = items.reduce((sum, item) => sum + item.quantity * item.reserveCents, shipping.reserveCents);
  const totalCents = itemsCents + shippingCents;
  if (![itemsCents, shippingCents, totalCents, paymentReserveCents].every(Number.isSafeInteger)) {
    throw new Error('price exceeds safe cents');
  }
  const pricing = { version: PRICING_VERSION, catalogVersion: catalogVersion(), country,
    taxBehavior, currency: 'EUR', items, itemsCents, shippingCents,
    shippingNetCents: shipping.netCents, shippingGrossCents: shipping.grossCents };
  return { currency: 'EUR', quantity, itemsCents, shippingCents, taxCents: 0,
    totalCents, paymentReserveCents, pricing,
    shipmentQuotes: [{ itemsCents, shippingCents, taxCents: 0,
      supplierTaxCents, pricing }] };
}

module.exports = { GERMAN_TAX_RATE, PRICING_VERSION, eurosToCents, productMarkupPercent,
  paymentReservePercent, paymentReserveFixedCents, estimatePaymentFeeCents,
  componentPrice, catalogPrice, buildCustomerQuoteForShipments };
