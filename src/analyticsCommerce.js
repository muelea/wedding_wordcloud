'use strict';

const { getProduct } = require('./products');
const cents = value => Number.isSafeInteger(value) && value >= 0;

/** Project frozen checkout prices into public catalog-only analytics rows.
 * Older inclusive-tax snapshots have only aggregate tax: allocate their net
 * revenue proportionally, with exact cent reconciliation. New snapshots retain
 * Stripe's per-line net totals. Never read today's mutable catalog prices. */
function analyticsItems(pricedItems, netItemsCents) {
  if (!Array.isArray(pricedItems) || !pricedItems.length || pricedItems.length > 20 || !cents(netItemsCents)) return [];
  if (pricedItems.some(item => !getProduct(item.productKey) || !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 || item.quantity > 99 || !cents(item.unitAmountCents))) return [];
  let totals = pricedItems.map(item => item.netTotalCents);
  if (!totals.every(cents) || totals.reduce((sum, value) => sum + value, 0) !== netItemsCents) {
    const weights = pricedItems.map(item => BigInt(item.unitAmountCents) * BigInt(item.quantity));
    const total = weights.reduce((sum, value) => sum + value, 0n);
    if (!total) return [];
    const allocations = weights.map((weight, index) => ({ index,
      cents: Number(BigInt(netItemsCents) * weight / total), remainder: BigInt(netItemsCents) * weight % total }));
    let remaining = netItemsCents - allocations.reduce((sum, row) => sum + row.cents, 0);
    for (const row of [...allocations].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
      if (remaining-- > 0) row.cents++;
    }
    totals = allocations.map(row => row.cents);
  }
  return pricedItems.flatMap((item, index) => {
    const unitPriceCents = Math.floor(totals[index] / item.quantity);
    const remainder = totals[index] % item.quantity;
    const row = { productKey: item.productKey, category: getProduct(item.productKey).familyKey, unitPriceCents };
    // Split rounding cents across units so sum(price * quantity) equals value.
    return [ ...(item.quantity > remainder ? [{ ...row, quantity: item.quantity - remainder }] : []),
      ...(remainder ? [{ ...row, unitPriceCents: unitPriceCents + 1, quantity: remainder }] : []) ];
  });
}

module.exports = { analyticsItems };
