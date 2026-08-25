'use strict';

function eurosToCents(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function productMarkupPercent() {
  const value = Number(process.env.SHOP_PRODUCT_MARKUP_PERCENT || 50);
  return Number.isFinite(value) && value >= 0 && value <= 500 ? value : 50;
}

function paymentReservePercent() {
  const value = Number(process.env.SHOP_PAYMENT_RESERVE_PERCENT || 3.15);
  return Number.isFinite(value) && value >= 0 && value <= 20 ? value : 3.15;
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

function inferCustomerTaxRate(printfulTaxCents, printfulTaxableCents) {
  if (printfulTaxCents <= 0) return 0;
  if (printfulTaxableCents <= 0) throw new Error('invalid Printful tax base');
  return Math.round((printfulTaxCents / printfulTaxableCents) * 1000) / 1000;
}

function customerTaxCents({ printfulItemsCents, customerItemsCents, shippingCents, supplierTaxCents }) {
  const rate = inferCustomerTaxRate(supplierTaxCents, printfulItemsCents + shippingCents);
  return Math.round((customerItemsCents + shippingCents) * rate);
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

function shipmentTaxQuotes(preparedShipments, itemsCents) {
  const allocatedItemsCents = allocateCents(
    itemsCents,
    preparedShipments.map((shipment) => shipment.printfulItemsCents)
  );
  return preparedShipments.map((shipment, index) => {
    const shipmentItemsCents = allocatedItemsCents[index];
    const shipmentTaxCents = customerTaxCents({
      printfulItemsCents: shipment.printfulItemsCents,
      customerItemsCents: shipmentItemsCents,
      shippingCents: shipment.shippingCents,
      supplierTaxCents: shipment.supplierTaxCents,
    });
    return {
      itemsCents: shipmentItemsCents,
      shippingCents: shipment.shippingCents,
      taxCents: shipmentTaxCents,
      supplierTaxCents: shipment.supplierTaxCents,
    };
  });
}

function paymentReserveCents({ baseItemsCents, shippingCents, preparedShipments }) {
  let reserveCents = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const shipmentQuotes = shipmentTaxQuotes(preparedShipments, baseItemsCents + reserveCents);
    const taxCents = shipmentQuotes.reduce((sum, shipment) => sum + shipment.taxCents, 0);
    const totalCents = baseItemsCents + reserveCents + shippingCents + taxCents;
    const estimatedFeeCents = estimatePaymentFeeCents(totalCents);
    if (estimatedFeeCents <= reserveCents) return reserveCents;
    reserveCents = estimatedFeeCents;
  }
  // In a pathological rounding/tax edge case, do not fail checkout over the
  // reserve. Use the last estimate; at worst the shop absorbs a few cents.
  return reserveCents;
}

/**
 * Convert Printful's decimal response into integer cents and apply one
 * catalog-wide retail rule. The actual, quantity-discounted Printful product
 * cost is the basis, so future curated products need no individual pricing.
 *
 * Customer tax/VAT is recalculated on the customer-facing taxable amount
 * (marked-up product subtotal + shipping), using the destination rate implied
 * by Printful's product+shipping estimate. Before live payments, this should
 * be replaced or verified with the shop's finalized VAT/Stripe Tax treatment.
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
  const reserveCents = paymentReserveCents({ baseItemsCents, shippingCents, preparedShipments });
  const itemsCents = baseItemsCents + reserveCents;
  const shipmentQuotes = shipmentTaxQuotes(preparedShipments, itemsCents);
  const taxCents = shipmentQuotes.reduce((sum, shipment) => sum + shipment.taxCents, 0);
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
  customerTaxCents,
  buildCustomerQuote,
  buildCustomerQuoteForShipments,
};
