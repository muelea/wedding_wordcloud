'use strict';

function checkoutRequest(order) {
  const value = order?.checkout_request_json;
  try { return typeof value === 'string' ? JSON.parse(value) : value || {}; }
  catch { return {}; }
}

const cents = (value) => Number.isSafeInteger(value) && value >= 0;

/** Validate Stripe's signed result against the frozen net order, never a
 * browser total. Used again under the payment transaction's row lock. */
function paymentAmounts(order, session) {
  if (!session || String(session.currency || '').toUpperCase() !== order.currency) return null;
  const alreadyPaid = ['paid', 'paid_test'].includes(order.status);
  if (!alreadyPaid && (Number(order.tax_cents) !== 0 ||
      Number(order.total_cents) !== Number(order.items_cents) + Number(order.shipping_cents))) return null;
  const request = checkoutRequest(order);
  const tax = session.total_details?.amount_tax;
  const shipping = session.shipping_cost;
  const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!request.customerId || customer !== request.customerId ||
      session.automatic_tax?.enabled !== true || session.automatic_tax?.status !== 'complete' ||
      session.total_details?.amount_discount !== 0 || !cents(tax) ||
      !cents(session.amount_subtotal) || session.amount_subtotal !== Number(order.items_cents) ||
      !shipping || !cents(shipping.amount_subtotal) || !cents(shipping.amount_tax) ||
      !cents(shipping.amount_total) || shipping.amount_tax > tax ||
      shipping.amount_subtotal !== Number(order.shipping_cents) ||
      shipping.amount_total !== shipping.amount_subtotal + shipping.amount_tax ||
      !cents(session.amount_total) ||
      session.amount_total !== Number(order.items_cents) + Number(order.shipping_cents) + tax) return null;
  const expectedTax = request.expectedTaxCents;
  const expectedTotal = request.expectedTotalCents;
  const hasExpectedAmounts = expectedTax !== undefined || expectedTotal !== undefined;
  if (!alreadyPaid && hasExpectedAmounts &&
      (!cents(expectedTax) || !cents(expectedTotal) ||
       tax !== expectedTax || session.amount_total !== expectedTotal)) return null;
  if (alreadyPaid &&
      (tax !== Number(order.tax_cents) || session.amount_total !== Number(order.total_cents))) return null;
  return { taxCents: tax, totalCents: session.amount_total };
}

module.exports = { checkoutRequest, paymentAmounts };
