'use strict';

// Published product restrictions override successful provider estimates. The
// Printful quote APIs returned rates for JP/SG during the 2026-10-24 audit.
const CASE_COUNTRIES = Object.freeze(['HK', 'JP', 'KR', 'SG', 'TW']);
const RESTRICTED_PRODUCTS = new Set([601, 686, 798]);

function shippingRestrictions(productId) {
  return RESTRICTED_PRODUCTS.has(Number(productId)) ? CASE_COUNTRIES : Object.freeze([]);
}

function unavailableProducts(products, countryCode) {
  const country = String(countryCode || '').trim().toUpperCase();
  return [...new Map(products.filter((product) =>
    product?.shippingRestrictions?.includes(country) ||
    shippingRestrictions(product?.printful?.productId).includes(country)
  ).map((product) => [product.key, product])).values()];
}

module.exports = { shippingRestrictions, unavailableProducts };
