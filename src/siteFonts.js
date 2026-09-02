'use strict';

const SITE_FONT_ASSETS = Object.freeze({
  jostLatin: '/assets/site-fonts/jost/jost-latin.woff2',
  jostLatinExtended: '/assets/site-fonts/jost/jost-latin-ext.woff2',
  playfairLatin: '/assets/site-fonts/playfair-display/playfair-display-latin.woff2',
  playfairLatinExtended: '/assets/site-fonts/playfair-display/playfair-display-latin-ext.woff2',
  playfairItalicLatin: '/assets/site-fonts/playfair-display/playfair-display-italic-latin.woff2',
  playfairItalicLatinExtended: '/assets/site-fonts/playfair-display/playfair-display-italic-latin-ext.woff2',
  cormorantItalicLatin: '/assets/site-fonts/cormorant-garamond/cormorant-garamond-italic-latin.woff2',
  cormorantItalicLatinExtended: '/assets/site-fonts/cormorant-garamond/cormorant-garamond-italic-latin-ext.woff2',
  shadowsLatin: '/assets/site-fonts/shadows-into-light/shadows-into-light-latin.woff2',
  shadowsLatinExtended: '/assets/site-fonts/shadows-into-light/shadows-into-light-latin-ext.woff2',
});

function siteFontPreloads({ locale, playfairItalic = false, cormorantItalic = false } = {}) {
  const extended = locale === 'tr';
  const paths = [SITE_FONT_ASSETS.jostLatin, SITE_FONT_ASSETS.playfairLatin];
  if (extended) {
    paths.push(SITE_FONT_ASSETS.jostLatinExtended, SITE_FONT_ASSETS.playfairLatinExtended);
  }
  if (playfairItalic) {
    paths.push(SITE_FONT_ASSETS.playfairItalicLatin);
    if (extended) paths.push(SITE_FONT_ASSETS.playfairItalicLatinExtended);
  }
  if (cormorantItalic) {
    paths.push(SITE_FONT_ASSETS.cormorantItalicLatin);
    if (extended) paths.push(SITE_FONT_ASSETS.cormorantItalicLatinExtended);
  }
  return paths;
}

module.exports = { SITE_FONT_ASSETS, siteFontPreloads };
