'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogPrice, componentPrice, buildCustomerQuoteForShipments, paymentReservePercent,
  paymentReserveFixedCents, estimatePaymentFeeCents } = require('../src/pricing');
const { PRODUCTS } = require('../src/products');
test.beforeEach(t => {
  for (const [key,value] of Object.entries({SHOP_PRODUCT_MARKUP_PERCENT:'50',SHOP_PAYMENT_RESERVE_PERCENT:'3.69',SHOP_PAYMENT_RESERVE_FIXED_CENTS:'49'})) {
    const previous=process.env[key]; process.env[key]=value;
    t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  }
});
function quote(country='DE',quantity=2, costs={currency:'EUR',shipping:11.43,total:32.78,tax:0,vat:0}) {
  return buildCustomerQuoteForShipments([{recipient:{country_code:country},costs,items:[
    {configurationId:'mug',productKey:'white-glossy-mug-duo-11oz',variantId:1320,quantity},
    {configurationId:'poster',productKey:'matte-poster-30x40cm',variantId:8948,quantity:1},
  ]}]);
}
test('every catalog variant has one validated, quantity-independent price',()=>{
  for (const product of PRODUCTS) {
    const p=catalogPrice(product.printful.variantId);
    assert.equal(p.currency,'EUR');
    assert.ok(Number.isSafeInteger(p.unitGrossCents)&&p.unitGrossCents>0);
    assert.ok(Number.isSafeInteger(p.unitNetCents)&&p.unitNetCents>0);
  }
  assert.equal(catalogPrice(1320).unitGrossCents,1107);
  assert.equal(catalogPrice(8948).unitGrossCents,1957);
  assert.deepEqual(Object.keys(require('../src/productCostSnapshot.json').variants).map(Number).sort((a,b)=>a-b),
    PRODUCTS.map(product=>product.printful.variantId).sort((a,b)=>a-b));
});
test('Germany charges exact gross unit prices plus separately calculated gross shipping',()=>{
  const q=quote();
  assert.equal(q.itemsCents,4171);
  assert.equal(q.shippingCents,1484);
  assert.equal(q.totalCents,5655);
  assert.equal(q.taxCents,0,'only Stripe confirms included VAT');
  assert.equal(q.pricing.taxBehavior,'inclusive');
  assert.equal(q.pricing.items[0].unitAmountCents,1107);
});
test('international checkout uses stored net prices, never reverse-rounded German labels',()=>{
  const q=quote('FR');
  assert.equal(q.itemsCents,3505);
  assert.equal(q.shippingCents,1247);
  assert.equal(q.pricing.taxBehavior,'exclusive');
  assert.equal(q.pricing.items[1].unitAmountCents,1645);
  assert.notEqual(Math.round(q.pricing.items[1].unitNetCents*1.19),1957,
    'DE gross labels and foreign net prices are independently rounded from the exact formula');
});
test('discounts and changes to supplier procurement taxes do not silently change published unit prices',()=>{
  const normal=quote();
  const reduced=quote('DE',2,{currency:'EUR',shipping:11.43,total:27.43,tax:1,vat:2});
  assert.equal(normal.itemsCents,reduced.itemsCents);
  assert.equal(normal.shippingCents,reduced.shippingCents);
  assert.equal(reduced.shipmentQuotes[0].supplierTaxCents,300);
  assert.equal(quote('DE',10).pricing.items[0].unitAmountCents,normal.pricing.items[0].unitAmountCents);
});
test('shipping changes only the shipping price and contains its own fixed fee',()=>{
  const first=quote();
  const other=quote('DE',2,{currency:'EUR',shipping:20,total:41.35});
  assert.equal(first.itemsCents,other.itemsCents);
  assert.ok(other.shippingCents>first.shippingCents);
  assert.deepEqual(componentPrice(1143),{netCents:1247,grossCents:1484,reserveCents:104});
});
test('closed formula covers tax and fees on its own surcharge',()=>{
  for(const base of [0,1,100,840,1523,1143,10000,1000000]) {
    const price=componentPrice(base);
    const theoreticalGross=(base+49)*1.19/(1-.0369*1.19);
    assert.ok(price.grossCents>=theoreticalGross);
    assert.ok(price.grossCents-theoreticalGross<1.000001);
    assert.ok(price.netCents*1.19>=theoreticalGross);
  }
  assert.equal(estimatePaymentFeeCents(5655),258);
});
test('zero configuration is supported and invalid fee settings fall back',()=>{
  process.env.SHOP_PAYMENT_RESERVE_PERCENT='0';process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS='0';
  assert.deepEqual(componentPrice(100),{netCents:100,grossCents:119,reserveCents:0});
  process.env.SHOP_PAYMENT_RESERVE_PERCENT='invalid';process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS='501';
  assert.equal(paymentReservePercent(),3.69);assert.equal(paymentReserveFixedCents(),49);
});
test('malformed supplier amounts, currencies, variants and quantities fail closed',()=>{
  for(const costs of [{currency:'EUR',shipping:-1,total:1},{currency:'USD',shipping:1,total:2},{currency:'EUR',shipping:3,total:2}])assert.throws(()=>quote('DE',2,costs));
  assert.throws(()=>quote('DE',0));
  assert.throws(()=>catalogPrice(999999));
  assert.throws(()=>componentPrice(Number.MAX_SAFE_INTEGER));
});
