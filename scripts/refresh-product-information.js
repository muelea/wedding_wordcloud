'use strict';

// Explicit catalog refresh only. Startup, browsing and preview dialogs never
// contact Printful for descriptions or create provider mockups/orders.
const fs = require('node:fs/promises');
const path = require('node:path');
const LOCALES = Object.freeze({ de: 'de_DE', en: 'en_US', es: 'es_ES', fr: 'fr_FR', it: 'it_IT' });

async function refreshProductInformation({ products, fetchProduct, now = new Date() }) {
  const ids = [...new Set(products.map(product => product.printful.productId))].sort((a, b) => a - b);
  const entries = {};
  for (const id of ids) {
    const descriptions = {}, names = {};
    for (const [locale, providerLocale] of Object.entries(LOCALES)) {
      const product = await fetchProduct(id, providerLocale);
      if (product?.id !== id || typeof product.description !== 'string' || !product.description.trim()) {
        throw new Error(`Missing catalog description for product ${id} (${locale})`);
      }
      descriptions[locale] = product.description.replace(/\r\n?/g, '\n').trim();
      names[locale] = String(product.name || '');
    }
    entries[id] = { names, descriptions };
  }
  return { version: 1, checkedAt: now.toISOString(),
    source: 'Printful GET /v2/catalog-products/{id}; X-PF-Language', products: entries };
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
  const token = process.env.PRINTFUL_API_KEY;
  if (!token) throw new Error('PRINTFUL_API_KEY is required for a catalog refresh');
  const data = await refreshProductInformation({ products: require('../src/products').PRODUCTS,
    fetchProduct: async (id, locale) => {
      // Stay below the ordinary catalog API request allowance.
      await new Promise(resolve => setTimeout(resolve, 600));
      const response = await fetch(`https://api.printful.com/v2/catalog-products/${id}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-PF-Language': locale },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Printful catalog request failed: ${response.status} (product ${id}, ${locale})`);
      return (await response.json()).data;
    },
  });
  const target = path.join(__dirname, '../src/productInformationSnapshot.json');
  const temporary = `${target}.tmp-${process.pid}`;
  try { await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n'); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  console.log(`Updated descriptions for ${Object.keys(data.products).length} catalog products in ${Object.keys(LOCALES).length} languages. Review the copy before release.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { refreshProductInformation, LOCALES };
