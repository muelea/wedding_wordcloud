'use strict';

// Explicit, read-only provider refresh. Never part of startup or a page request.
const fs = require('node:fs/promises');
const path = require('node:path');
async function refreshProductCosts({ products, estimate, now = new Date() }) {
  const variants = {};
  for (const product of products) {
    const variantId = product.printful.variantId;
    const recipient = { name:'Wolkenworte Preispruefung',address1:'Musterstrasse 1',city:'Berlin',zip:'10115',country_code:'DE' };
    const costs = await estimate({variantId,quantity:1,recipient});
    const moneyCents = require('../src/pricing').eurosToCents;
    const cents = value => {
      const n = moneyCents(value ?? 0);
      if (n == null) throw new Error('invalid supplier money for variant ' + variantId);
      return n;
    };
    if (costs.currency !== 'EUR') throw new Error('non-EUR quote for variant ' + variantId);
    const supplierTaxCents = cents(costs.tax) + cents(costs.vat);
    const productCents = cents(costs.total) - cents(costs.shipping) - supplierTaxCents;
    if (productCents <= 0) throw new Error('invalid product cost for variant ' + variantId);
    variants[variantId] = {productCents,supplierTaxCents};
  }
  return {version:1,checkedAt:now.toISOString(),currency:'EUR',referenceCountry:'DE',
    source:'Printful /orders/estimate-costs; one item; synthetic reference addresses',variants};
}
async function main() {
  require('dotenv').config({path:path.join(__dirname,'../.env')});
  const data = await refreshProductCosts({products:require('../src/products').PRODUCTS,
    estimate:require('../src/printful').estimateOrderCosts});
  const target = path.join(__dirname,'../src/productCostSnapshot.json');
  const temporary = target + '.tmp-' + process.pid;
  try {await fs.writeFile(temporary,JSON.stringify(data,null,2)+'\n');await fs.rename(temporary,target);}
  finally {await fs.rm(temporary,{force:true});}
  console.log('Updated ' + Object.keys(data.variants).length + ' single-item supplier costs. Review the diff before release.');
}
if (require.main === module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = {refreshProductCosts};
