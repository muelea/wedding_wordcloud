'use strict';

const snapshot = require('./productInformationSnapshot.json');
const translations = require('./productInformationTranslations.json');

// Descriptions remain local, reviewed catalog content. These transformations
// affect display copy only; print geometry, fulfillment IDs and prices stay put.
function metricText(text) {
  return text.replace(/\u00a0/g, ' ')
    .replace(/[\d¼½¾][\d.,¼½¾ \t×x/″"]*[″"][ \t]*\(([^)]*(?:cm|mm)[^)]*)\)/g, '$1')
    .replace(/[\d¼½¾][\d.,¼½¾ \t×x/+−-]*(?:oz\.?(?:\/yd\.?[²2])?|lbs?|(?:US[ \t]*)?gal)[ \t]*\(([^)]*(?:g|kg|ml|l)[^)]*)\)/gi, '$1')
    .replace(/[ \t]*\([^)]*(?:\boz\b|\blbs?\b|\bmil\b|\bgal\b|\bpulgada\w*\b|[″"])[^)]*\)/gi, '')
    .replace(/(\d+(?:[.,]\d+)?)\s*mil\b/g, (match, value) =>
      `${(Number(value.replace(',', '.')) * .0254).toFixed(2).replace('.', value.includes(',') ? ',' : '.')} mm`)
    .replace(/[ \t]{2,}/g, ' ').replace(/^ +/gm, '').trim();
}

function selectVariant(text, product, locale) {
  const id = product.printful.productId;
  const capacity = ({ 325: 11, 444: 15, 591: 20 })[product.size?.volumeMl] ||
    (product.printful.variantId === 16440 ? 25 : product.printful.variantId === 19514 ? 40 : null);
  const isOak = product.variantLabel?.includes('Eiche');
  const isA4 = /(?:21\s*×\s*30|30\s*×\s*21)\s*cm/.test(product.size?.label || '');
  const hooksApply = /(?:61\s*×\s*91|91\s*×\s*61)\s*cm/.test(product.size?.label || '') && product.orientation === 'landscape';
  let includeSection = true;
  const lines = text.replace(/\u00a0/g, ' ').split('\n');
  const selected = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    const ounces = line.match(/\b(11|15|20|25|40)\s*oz\b/i);
    if (id === 663 && ounces && !/^\s*•/.test(line)) {
      includeSection = Number(ounces[1]) === capacity;
      if (includeSection) selected.push(line);
      continue;
    }
    if (!includeSection) {
      if (!line.trim() || /^\s*•/.test(line)) continue;
      includeSection = true; // Preserve the final hot-drink warning for both sizes.
    }
    if ([19, 403].includes(id) && ounces) {
      if (Number(ounces[1]) !== capacity) continue;
      line = line.replace(/\b(?:11|15|20)\s*oz\b/i, `${product.size.volumeMl} ml`);
    }
    // Supplier translations disagree about sleeve weights; omit those optional
    // lines rather than publish different weights for the same physical item.
    if (id === 394 && (/(?:13|15)\s*(?:[″"]|'')/.test(line) || /^\s*•.*(?:gewicht|poids|peso).*:?$/i.test(line))) continue;
    if (id === 304 && /^\s*•/.test(line)) {
      if (/eichen|\boak\b|roble|chêne|rovere/i.test(line) && !isOak) continue;
      if (/erlen|alder|aliso|aulne|ontano/i.test(line) && isOak) continue;
    }
    if ([268, 304].includes(id) && /\bA4\b/.test(line) && !isA4) continue;
    if (id === 304 && /61\s*[×x]\s*91/.test(line) && !hooksApply) {
      while (index + 1 < lines.length && lines[index + 1].trim()) index++;
      continue;
    }
    selected.push(line);
  }
  let result = metricText(selected.join('\n'));
  if (id === 382) result = result.replace(/\b17[- ](?:ounce|Unzen|onces?|onzas?|once)\b/gi, '500 ml');
  if (locale === 'tr' && [19, 403].includes(id)) {
    const format = n => new Intl.NumberFormat('tr').format(n);
    result += `\n• Hacim: ${format(product.size.volumeMl)} ml\n• Yükseklik: ${format(product.size.heightCm)} cm\n• Çap: ${format(product.size.diameterCm)} cm`;
  }
  if (locale === 'tr' && id === 663) {
    result = result.replace('\n\nDikkat!', capacity === 25
      ? '\n• Hacim: 739 ml\n• Bastırılarak takılan plastik kapak dahildir\n\nDikkat!'
      : '\n• Hacim: 1.183 ml\n• Plastik pipet ve vidalı kapak dahildir\n\nDikkat!');
  }
  if (product.familyKey === 'clothing') {
    const labels = {
      de: ['Kleidungsmaß, flach gemessen', 'Breite', 'Länge', 'Ärmellänge'],
      en: ['Garment measurements, laid flat', 'Width', 'Length', 'Sleeve length'],
      es: ['Medidas de la prenda en plano', 'Ancho', 'Largo', 'Largo de manga'],
      fr: ['Mesures du vêtement à plat', 'Largeur', 'Longueur', 'Longueur de manche'],
      it: ['Misure del capo steso', 'Larghezza', 'Lunghezza', 'Lunghezza manica'],
      tr: ['Düz serilmiş giysi ölçüleri', 'Genişlik', 'Uzunluk', 'Kol uzunluğu'],
    }[locale];
    const format = n => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
    if (labels) result += `\n\n${labels[0]} (${product.size.label.split(' · ')[0]}):\n` +
      [product.size.widthCm, product.size.heightCm, product.size.sleeveCm]
        .map((value, i) => `• ${labels[i + 1]}: ${format(value)} cm`).join('\n');
  }
  return result.replace(/\n{3,}/g, '\n\n');
}

function getProductInformation(product) {
  const record = snapshot.products[product.printful.productId];
  if (!record) return null;
  const descriptions = { ...record.descriptions, tr: translations.tr[product.printful.productId] };
  return Object.fromEntries(Object.entries(descriptions).map(([locale, text]) => [locale, selectVariant(text, product, locale)]));
}

module.exports = { getProductInformation, selectVariant, metricText };
