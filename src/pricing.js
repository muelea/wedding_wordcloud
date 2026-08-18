'use strict';

function eurosToCents(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function surchargePerMugCents() {
  const value = Number(process.env.SHOP_SURCHARGE_PER_MUG_CENTS || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Convert Printful's decimal response into integer cents and add the shop's
 * centrally configured surcharge. The surcharge is folded into the product
 * line so customers see a normal retail breakdown rather than our margin.
 */
function buildCustomerQuote(costs, quantity) {
  const currency = String(costs.currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('invalid Printful currency');

  const surchargeCents = surchargePerMugCents() * quantity;
  const shippingCents = eurosToCents(costs.shipping);
  const taxCents = eurosToCents(costs.tax) + eurosToCents(costs.vat);
  const printfulTotalCents = eurosToCents(costs.total);
  const totalCents = printfulTotalCents + surchargeCents;

  // Include any Printful fulfillment/additional fees in the product line and
  // absorb tiny decimal-rounding differences so the visible rows always add
  // up exactly to the visible total.
  const itemsCents = totalCents - shippingCents - taxCents;

  if ([itemsCents, shippingCents, taxCents, totalCents].some((value) => value < 0)) {
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

module.exports = { eurosToCents, surchargePerMugCents, buildCustomerQuote };
