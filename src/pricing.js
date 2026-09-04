'use strict';

// Internal fee budgeting only; never use this assumption as customer tax.
const PAYMENT_RESERVE_ASSUMED_TAX_RATE = 0.20;

function eurosToCents(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function productMarkupPercent() {
  const value = Number(process.env.SHOP_PRODUCT_MARKUP_PERCENT || 50);
  return Number.isFinite(value) && value >= 0 && value <= 500 ? value : 50;
}

function paymentReservePercent() {
  const value = Number(process.env.SHOP_PAYMENT_RESERVE_PERCENT || 3.65);
  return Number.isFinite(value) && value >= 0 && value <= 20 ? value : 3.65;
}

function paymentReserveFixedCents() {
  const value = Number(process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS || 25);
  return Number.isSafeInteger(value) && value >= 0 && value <= 500 ? value : 25;
}

function printfulSupplierTaxCents(costs) {
  return eurosToCents(costs.tax) + eurosToCents(costs.vat);
}

function printfulItemCostCents(costs) {
  const shippingCents = eurosToCents(costs.shipping);
  return eurosToCents(costs.total) - shippingCents - printfulSupplierTaxCents(costs);
}

function estimatePaymentFeeCents(totalCents) {
  const percent = paymentReservePercent() / 100;
  return Math.ceil(totalCents * percent + paymentReserveFixedCents());
}

function allocateCents(totalCents, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (totalCents === 0 || totalWeight === 0) return weights.map(() => 0);

  const allocations = weights.map((weight, index) => {
    const exact = totalCents * Math.max(0, weight) / totalWeight;
    const cents = Math.floor(exact);
    return { index, cents, remainder: exact - cents };
  });
  let remaining = totalCents - allocations.reduce((sum, entry) => sum + entry.cents, 0);
  allocations
    .slice()
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((entry) => {
      if (remaining > 0) {
        allocations[entry.index].cents += 1;
        remaining -= 1;
      }
    });
  return allocations.map((entry) => entry.cents);
}

function shipmentNetQuotes(preparedShipments, itemsCents) {
  const allocatedItemsCents = allocateCents(
    itemsCents,
    preparedShipments.map((shipment) => shipment.printfulItemsCents)
  );
  return preparedShipments.map((shipment, index) => {
    const shipmentItemsCents = allocatedItemsCents[index];
    return {
      itemsCents: shipmentItemsCents,
      shippingCents: shipment.shippingCents,
      taxCents: 0,
      supplierTaxCents: shipment.supplierTaxCents,
    };
  });
}

function paymentReserveCents({ baseItemsCents, shippingCents }) {
  let reserveCents = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const netCents = baseItemsCents + reserveCents + shippingCents;
    const estimatedTaxCents = Math.round(netCents * PAYMENT_RESERVE_ASSUMED_TAX_RATE);
    const totalCents = netCents + estimatedTaxCents;
    const estimatedFeeCents = estimatePaymentFeeCents(totalCents);
    if (estimatedFeeCents <= reserveCents) return reserveCents;
    reserveCents = estimatedFeeCents;
  }
  // If the iteration limit is reached, use the last estimate rather than
  // failing checkout. Any remaining shortfall comes out of the shop's margin.
  return reserveCents;
}

/**
 * Convert Printful's decimal response into integer cents and apply one
 * catalog-wide retail rule. The actual, quantity-discounted Printful product
 * cost is the basis, so future curated products need no individual pricing.
 *
 * This is a net quote. Zero tax here means not yet calculated, not tax exempt.
 * Only Stripe's confirmed Checkout calculates customer tax. Supplier tax stays
 * in the procurement snapshot and never determines the customer's tax rate.
 */
function buildCustomerQuote(costs, quantity) {
  return buildCustomerQuoteForShipments([{ quantity, costs }]);
}

function buildCustomerQuoteForShipments(shipments) {
  if (!Array.isArray(shipments) || shipments.length === 0) {
    throw new Error('invalid shipments');
  }

  let currency = null;
  let quantity = 0;
  let printfulItemsCents = 0;
  let shippingCents = 0;
  const preparedShipments = [];

  for (const shipment of shipments) {
    const shipmentCurrency = String(shipment?.costs?.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(shipmentCurrency)) throw new Error('invalid Printful currency');
    if (currency && shipmentCurrency !== currency) throw new Error('mixed Printful currencies');
    currency = shipmentCurrency;

    const shipmentQuantity = Number(shipment.quantity);
    if (!Number.isSafeInteger(shipmentQuantity) || shipmentQuantity < 1) {
      throw new Error('invalid shipment quantity');
    }
    const shipmentPrintfulItemsCents = printfulItemCostCents(shipment.costs);
    const shipmentShippingCents = eurosToCents(shipment.costs.shipping);
    const shipmentSupplierTaxCents = printfulSupplierTaxCents(shipment.costs);
    quantity += shipmentQuantity;
    printfulItemsCents += shipmentPrintfulItemsCents;
    shippingCents += shipmentShippingCents;
    preparedShipments.push({
      printfulItemsCents: shipmentPrintfulItemsCents,
      shippingCents: shipmentShippingCents,
      supplierTaxCents: shipmentSupplierTaxCents,
    });
  }

  const markup = productMarkupPercent() / 100;
  const baseItemsCents = Math.ceil(printfulItemsCents * (1 + markup));
  const reserveCents = paymentReserveCents({ baseItemsCents, shippingCents });
  const itemsCents = baseItemsCents + reserveCents;
  const shipmentQuotes = shipmentNetQuotes(preparedShipments, itemsCents);
  const taxCents = 0;
  const totalCents = itemsCents + shippingCents + taxCents;

  if ([printfulItemsCents, baseItemsCents, reserveCents, itemsCents, shippingCents, taxCents, totalCents].some((value) => value < 0)) {
    throw new Error('invalid negative Printful costs');
  }

  return {
    currency,
    quantity,
    itemsCents,
    shippingCents,
    taxCents,
    totalCents,
    paymentReserveCents: reserveCents,
    shipmentQuotes,
  };
}

module.exports = {
  eurosToCents,
  productMarkupPercent,
  paymentReservePercent,
  paymentReserveFixedCents,
  estimatePaymentFeeCents,
  buildCustomerQuote,
  buildCustomerQuoteForShipments,
};
