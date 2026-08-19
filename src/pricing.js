'use strict';

function eurosToCents(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function targetMarginPercent() {
  const value = Number(process.env.SHOP_TARGET_MARGIN_PERCENT || 45);
  return Number.isFinite(value) && value >= 0 && value <= 80 ? value : 45;
}

function minimumProfitCents() {
  const value = Number(process.env.SHOP_MIN_PROFIT_PER_ORDER_CENTS || 500);
  return Number.isSafeInteger(value) && value >= 0 ? value : 500;
}

/**
 * Convert Printful's decimal response into integer cents and apply one
 * catalog-wide retail rule. The actual, quantity-discounted Printful product
 * cost is the basis, so future curated products need no individual markup.
 *
 * Taxes in the current test checkout are Printful's estimate and remain a
 * deliberately isolated line. Before live payments, this line will be
 * replaced with the shop's finalized VAT/Stripe Tax treatment without
 * changing the quote/order data model.
 */
function buildCustomerQuote(costs, quantity) {
  const currency = String(costs.currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('invalid Printful currency');

  const shippingCents = eurosToCents(costs.shipping);
  const taxCents = eurosToCents(costs.tax) + eurosToCents(costs.vat);
  const printfulTotalCents = eurosToCents(costs.total);
  const printfulItemsCents = printfulTotalCents - shippingCents - taxCents;

  const margin = targetMarginPercent() / 100;
  const marginPriceCents = Math.ceil(printfulItemsCents / (1 - margin));
  const minimumPriceCents = printfulItemsCents + minimumProfitCents();
  const itemsCents = Math.max(marginPriceCents, minimumPriceCents);
  const totalCents = itemsCents + shippingCents + taxCents;

  if ([printfulItemsCents, itemsCents, shippingCents, taxCents, totalCents].some((value) => value < 0)) {
    throw new Error('invalid negative Printful costs');
  }

  return {
    currency,
    quantity,
    itemsCents,
    shippingCents,
    taxCents,
    totalCents,
  };
}

module.exports = { eurosToCents, targetMarginPercent, minimumProfitCents, buildCustomerQuote };
