'use strict';
const { normalizeShippingRate } = require('../../src/printfulShipping');

function shippingEstimate({ variantId, quantity, items }, overrides = {}) {
  const orderItems = (items?.length ? items : [{ variantId, quantity }]).map((item) => ({
    catalog_variant_id: item.variantId, quantity: item.quantity,
  }));
  return normalizeShippingRate({ shipping: 'STANDARD', shipping_method_name: 'Standard',
    rate: '4.49', currency: 'EUR', min_delivery_days: 4, max_delivery_days: 7,
    min_delivery_date: '2030-01-14', max_delivery_date: '2030-01-17',
    shipments: [{ departure_country: 'LV', customs_fees_possible: false, shipment_items: orderItems }],
    ...overrides,
  }, orderItems);
}

function mockShippingRates(t, printful) {
  const original = printful.getShippingRates;
  printful.getShippingRates = async (options) => shippingEstimate(options);
  t.after(() => { printful.getShippingRates = original; });
}
module.exports = { shippingEstimate, mockShippingRates };
