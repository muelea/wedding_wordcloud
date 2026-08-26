'use strict';

const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { slugify, makeUniqueSlug } = require('../slug');
const { getBaseUrl } = require('../baseUrl');
const adminAuth = require('../adminAuth');
const stripe = require('../stripe');
const printful = require('../printful');
const { buildCustomerQuoteForShipments } = require('../pricing');
const { normalizeWord, MAX_WORD_LENGTH } = require('../words');
const {
  DEFAULT_PRODUCT,
  getProduct,
  resolveProductOrientation,
  getPublicProduct,
  getPublicProducts,
  getPublicProductFamilies,
} = require('../products');
const { buildProductPrintSvg, isPrintDesignWithinBounds } = require('../mugPrint');
const DesignFonts = require('../designFonts');
const MugIcons = require('../../public/js/mug-icons.js');

const PIN_RE = /^\d{4,6}$/;
const MAX_NAME_LENGTH = 80;
const MAX_SNAPSHOT_WORDS = 200;
// Two-sided layouts duplicate every approved cloud word, with a little room
// left for words the couple adds manually in the editor.
const MAX_DESIGN_ELEMENTS = 500;
const MAX_DESIGN_IMAGES = 6;
const MAX_DESIGN_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_DESIGN_IMAGE_BYTES * 4 / 3) + 128;
const CONFIGURATION_TYPES = new Set(['event_wordcloud', 'personal_memory']);
const ADDRESS_LIMITS = Object.freeze({
  name: 100,
  address1: 120,
  address2: 120,
  city: 100,
  zip: 20,
});
const MAX_CHECKOUT_SHIPMENTS = 10;
const MAX_CART_CONFIGURATIONS = 20;
const MAX_CART_ITEMS = 99;

function normalizeConfigurationIdList(value) {
  const rawIds = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(rawIds
    .map((id) => String(id || '').trim())
    .filter((id) => /^[A-Za-z0-9_-]{16}$/.test(id)))].slice(0, MAX_CART_CONFIGURATIONS);
}

function cleanAddressValue(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLength).trim();
}

function normalizeAddressLookupValue(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('de');
}

const germanRegionNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['de'], { type: 'region' })
  : null;

function localizedCountryNameForCode(code) {
  try {
    return germanRegionNames?.of(code) || '';
  } catch {
    return '';
  }
}

function findShippingCountry(value, countries) {
  const raw = String(value || '').trim();
  const code = raw.toUpperCase();
  const byCode = countries.find((entry) => entry.code === code);
  if (byCode) return byCode;
  const lookup = normalizeAddressLookupValue(raw);
  if (!lookup) return null;
  return countries.find((entry) => (
    normalizeAddressLookupValue(entry.name) === lookup ||
    normalizeAddressLookupValue(localizedCountryNameForCode(entry.code)) === lookup
  )) || null;
}

function findShippingState(value, country) {
  const raw = String(value || '').trim();
  const code = raw.toUpperCase();
  const byCode = country.states.find((entry) => String(entry.code || '').toUpperCase() === code);
  if (byCode) return byCode;
  const lookup = normalizeAddressLookupValue(raw);
  if (!lookup) return null;
  return country.states.find((entry) => normalizeAddressLookupValue(entry.name) === lookup) || null;
}

function normalizeRecipient(rawRecipient, countries) {
  const raw = rawRecipient && typeof rawRecipient === 'object' && !Array.isArray(rawRecipient)
    ? rawRecipient
    : {};
  const recipient = {
    name: cleanAddressValue(raw.name, ADDRESS_LIMITS.name),
    address1: cleanAddressValue(raw.address1, ADDRESS_LIMITS.address1),
    address2: cleanAddressValue(raw.address2, ADDRESS_LIMITS.address2),
    city: cleanAddressValue(raw.city, ADDRESS_LIMITS.city),
    zip: cleanAddressValue(raw.zip, ADDRESS_LIMITS.zip),
    country_code: String(raw.country_code || '').trim().toUpperCase(),
    state_code: String(raw.state_code || '').trim().toUpperCase(),
  };
  const invalidFields = [];
  for (const field of ['name', 'address1', 'city', 'zip']) {
    if (recipient[field].length < 2) invalidFields.push(field);
  }
  const country = findShippingCountry(raw.country_code, countries);
  if (!country) {
    invalidFields.push('country_code');
  } else if (country.states.length) {
    recipient.country_code = country.code;
    const state = findShippingState(raw.state_code, country);
    if (!state) {
      invalidFields.push('state_code');
    } else {
      recipient.state_code = String(state.code || '').toUpperCase();
    }
  } else {
    recipient.country_code = country.code;
    delete recipient.state_code;
  }
  if (!recipient.address2) delete recipient.address2;
  return { recipient, invalidFields: [...new Set(invalidFields)] };
}

function normalizeCheckoutShipments(rawBody, countries, product, fallbackQuantity) {
  const usesShipmentList = Array.isArray(rawBody?.shipments);
  const rawShipments = usesShipmentList
    ? rawBody.shipments
    : [{ quantity: rawBody?.quantity ?? fallbackQuantity, recipient: rawBody?.recipient }];
  const invalidFields = [];

  if (!Array.isArray(rawShipments) || rawShipments.length < 1 || rawShipments.length > MAX_CHECKOUT_SHIPMENTS) {
    return { shipments: [], invalidFields: ['shipments'], totalQuantity: 0, usesShipmentList };
  }

  const shipments = rawShipments.map((rawShipment, index) => {
    const raw = rawShipment && typeof rawShipment === 'object' && !Array.isArray(rawShipment)
      ? rawShipment
      : {};
    const rawQuantity = Number(raw.quantity);
    const quantity = Number.isFinite(rawQuantity) ? Math.round(rawQuantity) : 0;
    const fieldPrefix = usesShipmentList ? `shipments.${index}.` : '';
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > product.maxQuantity) {
      invalidFields.push(`${fieldPrefix}quantity`);
    }
    const { recipient, invalidFields: recipientInvalidFields } = normalizeRecipient(raw.recipient || raw, countries);
    recipientInvalidFields.forEach((field) => invalidFields.push(`${fieldPrefix}${field}`));
    return { quantity, recipient };
  });

  const totalQuantity = shipments.reduce((sum, shipment) => sum + Math.max(0, Number(shipment.quantity) || 0), 0);
  if (totalQuantity < product.minQuantity || totalQuantity > product.maxQuantity) {
    invalidFields.push(usesShipmentList ? 'shipments.quantity' : 'quantity');
  }

  return {
    shipments,
    invalidFields: [...new Set(invalidFields)],
    totalQuantity,
    usesShipmentList,
  };
}

function normalizeCartShipments(rawBody, countries, configurations) {
  const configurationById = new Map(configurations.map((configuration) => [configuration.id, configuration]));
  const rawShipments = Array.isArray(rawBody?.shipments) ? rawBody.shipments : [];
  const invalidFields = [];

  if (!rawShipments.length || rawShipments.length > MAX_CHECKOUT_SHIPMENTS) {
    return { shipments: [], invalidFields: ['shipments'], totalQuantity: 0 };
  }

  const shipments = rawShipments.map((rawShipment, index) => {
    const raw = rawShipment && typeof rawShipment === 'object' && !Array.isArray(rawShipment)
      ? rawShipment
      : {};
    const fieldPrefix = `shipments.${index}.`;
    const { recipient, invalidFields: recipientInvalidFields } = normalizeRecipient(raw.recipient || raw, countries);
    recipientInvalidFields.forEach((field) => invalidFields.push(`${fieldPrefix}${field}`));

    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    const items = [];
    for (const rawItem of rawItems) {
      const configurationId = String(rawItem?.configurationId || rawItem?.configuration_id || '').trim();
      const configuration = configurationById.get(configurationId);
      const product = configuration ? getProduct(configuration.product_key) : null;
      const rawQuantity = Number(rawItem?.quantity);
      const quantity = Number.isFinite(rawQuantity) ? Math.round(rawQuantity) : 0;
      if (!configuration || !product) {
        invalidFields.push(`${fieldPrefix}items`);
        continue;
      }
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > product.maxQuantity) {
        invalidFields.push(`${fieldPrefix}items.${configurationId}`);
        continue;
      }
      if (quantity > 0) items.push({ configurationId, quantity });
    }
    if (!items.length) invalidFields.push(`${fieldPrefix}items`);
    return {
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      recipient,
      items,
    };
  });

  const totalQuantity = shipments.reduce((sum, shipment) => sum + shipment.quantity, 0);
  if (totalQuantity < 1 || totalQuantity > MAX_CART_ITEMS) {
    invalidFields.push('shipments.quantity');
  }

  return {
    shipments,
    invalidFields: [...new Set(invalidFields)],
    totalQuantity,
  };
}

function sendPrintfulError(res, error) {
  if (error?.code === 'PRINTFUL_NOT_CONFIGURED') {
    return res.status(501).json({
      error: 'pricing_not_configured',
      message: 'Die Preisberechnung ist noch nicht eingerichtet.',
    });
  }
  if (error?.code === 'PRINTFUL_ADDRESS_REJECTED') {
    return res.status(422).json({
      error: 'address_not_accepted',
      message: 'Printful konnte für diese Adresse keinen Preis berechnen. Bitte prüft eure Angaben.',
    });
  }
  if (error?.code === 'PRINTFUL_AUTH_FAILED') {
    console.error('Printful authentication failed while estimating costs.');
  } else {
    console.error('Printful cost estimate failed:', error?.message || error);
  }
  return res.status(502).json({
    error: 'pricing_unavailable',
    message: 'Die Preisberechnung ist gerade nicht erreichbar. Bitte versucht es gleich noch einmal.',
  });
}

function checkoutQuoteResponse(quote) {
  const shipments = db.getCheckoutQuoteShipments(quote);
  const configurationIds = db.getCheckoutQuoteConfigurationIds(quote);
  return {
    id: quote.id,
    currency: quote.currency,
    quantity: Number(quote.quantity),
    configurationCount: configurationIds.length || 1,
    shipmentCount: shipments.length || 1,
    itemsCents: Number(quote.items_cents),
    paymentReserveCents: Number(quote.payment_reserve_cents || 0),
    shippingCents: Number(quote.shipping_cents),
    taxCents: Number(quote.tax_cents),
    totalCents: Number(quote.total_cents),
    expiresAt: quote.expires_at,
  };
}

function quoteAmountsDiffer(stored, fresh) {
  return stored.currency !== fresh.currency ||
    Number(stored.quantity) !== fresh.quantity ||
    Number(stored.items_cents) !== fresh.itemsCents ||
    Number(stored.payment_reserve_cents || 0) !== (fresh.paymentReserveCents || 0) ||
    Number(stored.shipping_cents) !== fresh.shippingCents ||
    Number(stored.tax_cents) !== fresh.taxCents ||
    Number(stored.total_cents) !== fresh.totalCents;
}

function normalizeSnapshotWords(rawWords) {
  if (!Array.isArray(rawWords) || rawWords.length === 0 || rawWords.length > MAX_SNAPSHOT_WORDS) {
    return null;
  }
  const merged = new Map();
  for (const entry of rawWords) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const word = normalizeWord(entry[0]);
    const count = Number(entry[1]);
    if (!word || !Number.isSafeInteger(count) || count < 1 || count > 1000000) return null;
    merged.set(word, (merged.get(word) || 0) + count);
  }
  return Array.from(merged.entries());
}

function normalizeDesignText(rawText) {
  if (typeof rawText !== 'string') return '';
  const text = rawText.normalize('NFC').trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/ {2,}/g, ' ')
    .slice(0, MAX_WORD_LENGTH)
    .trim();
  // Reuse the guest-word sanitizer as the source of truth for unsupported
  // characters, but preserve intentional capitalization in the editor.
  return normalizeWord(text) === text.toLowerCase() ? text : '';
}

function normalizeDesignImage(rawSource) {
  if (typeof rawSource !== 'string' || rawSource.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(rawSource);
  if (!match) return null;
  let bytes;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > MAX_DESIGN_IMAGE_BYTES) return null;
  const mime = match[1];
  const isJpeg = mime === 'jpeg' && bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = mime === 'png' && bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = mime === 'webp' && bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return null;
  return { source: `data:image/${mime};base64,${match[2]}`, byteLength: bytes.length };
}

function normalizeDesign(rawDesign, width, height, safeMargin, imageBudget = { count: 0, bytes: 0 }) {
  if (!Array.isArray(rawDesign) || rawDesign.length === 0 || rawDesign.length > MAX_DESIGN_ELEMENTS) {
    return null;
  }
  const ids = new Set();
  const normalized = [];
  for (const [index, rawItem] of rawDesign.entries()) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return null;
    const type = rawItem.type == null || rawItem.type === 'text' ? 'text' : rawItem.type;
    if (type !== 'text' && type !== 'icon' && type !== 'image') return null;
    const x = Number(rawItem.x);
    const y = Number(rawItem.y);
    const rawAngle = Number(rawItem.angle ?? 0);
    const idPrefix = type === 'image' ? 'foto' : type === 'icon' ? 'motiv' : 'wort';
    const id = String(rawItem.id || `${idPrefix}-${index + 1}`).slice(0, 64);
    if (!id || ids.has(id) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rawAngle)) {
      return null;
    }
    ids.add(id);
    const angle = ((rawAngle + 180) % 360 + 360) % 360 - 180;
    const common = {
      id,
      type,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      angle: Math.round(angle * 10) / 10,
    };
    if (type === 'image') {
      const image = normalizeDesignImage(rawItem.src);
      const imageWidth = Number(rawItem.width);
      const imageHeight = Number(rawItem.height);
      imageBudget.count += 1;
      imageBudget.bytes += image?.byteLength || 0;
      if (!image || imageBudget.count > MAX_DESIGN_IMAGES || imageBudget.bytes > MAX_DESIGN_IMAGE_BYTES ||
          !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) ||
          imageWidth < 48 || imageHeight < 48 || imageWidth > width || imageHeight > height) {
        return null;
      }
      normalized.push({
        ...common,
        src: image.source,
        width: Math.round(imageWidth * 10) / 10,
        height: Math.round(imageHeight * 10) / 10,
      });
      continue;
    }
    const color = String(rawItem.color || '').toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) return null;
    if (type === 'icon') {
      const icon = String(rawItem.icon || '');
      const size = Number(rawItem.size);
      if (!MugIcons.has(icon) || !Number.isFinite(size) || size < 48 || size > height) return null;
      normalized.push({ ...common, color, icon, size: Math.round(size * 10) / 10 });
      continue;
    }

    const text = normalizeDesignText(rawItem.text);
    const fontSize = Number(rawItem.fontSize);
    const rawFontFamily = rawItem.fontFamily;
    if ((rawFontFamily != null && !DesignFonts.has(rawFontFamily)) ||
        !text || !Number.isFinite(fontSize) || fontSize < 12 || fontSize > height) return null;
    normalized.push({
      ...common,
      color,
      text,
      fontSize: Math.round(fontSize * 10) / 10,
      fontFamily: DesignFonts.normalizeKey(rawFontFamily),
    });
  }
  return isPrintDesignWithinBounds(normalized, width, height, safeMargin) ? normalized : null;
}

function normalizeProductDesigns(rawBody, product) {
  if (!rawBody || typeof rawBody !== 'object') return null;
  const imageBudget = { count: 0, bytes: 0 };
  const normalizeOne = (rawDesign) => normalizeDesign(
    rawDesign,
    product.printFile.width,
    product.printFile.height,
    product.designSafeMargin,
    imageBudget
  );

  if (Object.hasOwn(rawBody, 'designs')) {
    const rawDesigns = rawBody.designs;
    if (!rawDesigns || typeof rawDesigns !== 'object' || Array.isArray(rawDesigns)) return null;
    const allowedSurfaces = new Set(product.printSurfaces.map((surface) => surface.key));
    if (Object.keys(rawDesigns).some((surfaceKey) => !allowedSurfaces.has(surfaceKey))) return null;
    const surfaces = {};
    for (const surface of product.printSurfaces) {
      const design = normalizeOne(rawDesigns[surface.key]);
      if (!design) return null;
      surfaces[surface.key] = design;
    }
    return { version: 2, surfaces };
  }

  if (!Object.hasOwn(rawBody, 'design')) return null;
  const design = normalizeOne(rawBody.design);
  if (!design) return null;
  if (product.printSurfaces.length === 1) return design;
  return {
    version: 2,
    surfaces: Object.fromEntries(product.printSurfaces.map((surface) => [
      surface.key,
      design.map((item) => ({ ...item })),
    ])),
  };
}

function configurationPrintFileUrls(slug, configurationId, product) {
  const base = `/api/events/${encodeURIComponent(slug)}/configurations/` +
    `${encodeURIComponent(configurationId)}/print.svg`;
  const multipleSurfaces = product.printSurfaces.length > 1;
  const printFileUrls = Object.fromEntries(product.printSurfaces.map((surface) => [
    surface.key,
    multipleSurfaces ? `${base}?surface=${encodeURIComponent(surface.key)}` : base,
  ]));
  return {
    printFileUrl: printFileUrls[product.printSurfaces[0].key],
    printFileUrls,
  };
}

function configurationResponse(slug, configuration) {
  const baseProduct = getProduct(configuration.product_key);
  const product = resolveProductOrientation(baseProduct, configuration.orientation);
  if (!product) return null;
  const placement = product.layouts.find((option) => option.key === configuration.placement);
  const printFiles = configurationPrintFileUrls(slug, configuration.id, product);
  return {
    id: configuration.id,
    quantity: Number(configuration.quantity),
    product: getPublicProduct(baseProduct, product.orientation),
    placement: placement ? { key: placement.key, label: placement.label } : null,
    orientation: product.orientation,
    configurationType: configuration.configuration_type,
    ...printFiles,
    createdAt: configuration.created_at,
  };
}

function configurationDesignSurfaces(product, design) {
  if (!design) return null;
  if (Array.isArray(design)) {
    return Object.fromEntries(product.printSurfaces.map((surface) => [
      surface.key,
      design.map((item) => ({ ...item })),
    ]));
  }
  if (design.version === 2 && design.surfaces && typeof design.surfaces === 'object') {
    return Object.fromEntries(product.printSurfaces.map((surface) => [
      surface.key,
      Array.isArray(design.surfaces[surface.key])
        ? design.surfaces[surface.key].map((item) => ({ ...item }))
        : [],
    ]));
  }
  return null;
}

function editableConfigurationResponse(slug, configuration) {
  const summary = configurationResponse(slug, configuration);
  if (!summary) return null;
  const product = resolveProductOrientation(
    getProduct(configuration.product_key),
    configuration.orientation
  );
  if (!product) return null;
  let words;
  let design = null;
  try {
    words = JSON.parse(configuration.words_json);
    if (configuration.design_json) design = JSON.parse(configuration.design_json);
  } catch {
    return null;
  }
  if (!Array.isArray(words)) return null;
  return {
    ...summary,
    productKey: configuration.product_key,
    theme: configuration.theme,
    placementKey: configuration.placement,
    words,
    designs: configurationDesignSurfaces(product, design),
  };
}

function cartSummary(configurations) {
  return {
    configurationCount: configurations.length,
    productCount: configurations.length,
  };
}

function printfulEstimateItemsForShipment(shipment, configurationById) {
  return shipment.items.map((item) => {
    const configuration = configurationById.get(item.configurationId);
    const product = configuration ? getProduct(configuration.product_key) : null;
    if (!configuration || !product) throw new Error('configuration_invalid');
    return {
      configurationId: configuration.id,
      variantId: Number(configuration.printful_variant_id),
      quantity: item.quantity,
    };
  });
}

async function estimateCartShipments({ body, countries, configurations }) {
  const { shipments, invalidFields } = normalizeCartShipments(body, countries, configurations);
  if (invalidFields.length) return { invalidFields };
  const configurationById = new Map(configurations.map((configuration) => [configuration.id, configuration]));
  const pricedShipments = await Promise.all(shipments.map(async (shipment) => {
    const items = printfulEstimateItemsForShipment(shipment, configurationById);
    const printfulCosts = await printful.estimateOrderCosts({
      recipient: shipment.recipient,
      items,
    });
    return {
      ...shipment,
      items: shipment.items,
      printfulCosts,
    };
  }));
  const calculatedQuote = buildCustomerQuoteForShipments(
    pricedShipments.map((shipment) => ({ quantity: shipment.quantity, costs: shipment.printfulCosts }))
  );
  return {
    pricedShipments: pricedShipments.map((shipment, index) => ({
      ...shipment,
      customerCosts: calculatedQuote.shipmentQuotes[index],
    })),
    calculatedQuote,
  };
}

function makeRouter({ io, port }) {
  const router = express.Router();

  // ── Slug preview (live-checked while typing in the create form) ─────────
  // NOTE: this only validates/previews the name-derived *prefix*. The final
  // slug always gets a random suffix appended at creation time (see
  // makeUniqueSlug in ../slug.js), so there is no meaningful "is this exact
  // text taken" question to answer here anymore — the suffix is what
  // guarantees uniqueness, not this prefix. That's also why the response
  // shape is `{ slug, valid }`, not `{ slug, available }`: "available"
  // implied the typed text could itself be taken, which is no longer true
  // and would mislead the couple about what the final URL looks like.
  router.get('/slug-availability', (req, res) => {
    const raw = String(req.query.slug || '');
    const slug = slugify(raw);
    if (!slug) return res.json({ slug, valid: false, reason: 'empty' });
    res.json({ slug, valid: true });
  });

  // ── Create event ──────────────────────────────────────────────────────
  router.post('/events', express.json(), (req, res) => {
    const { coupleName, pin } = req.body || {};
    let { slug } = req.body || {};

    if (!coupleName || typeof coupleName !== 'string' || !coupleName.trim()) {
      return res.status(400).json({ error: 'coupleName is required' });
    }
    if (coupleName.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: 'coupleName is too long' });
    }
    if (!pin || !PIN_RE.test(String(pin))) {
      return res.status(400).json({ error: 'pin must be 4-6 digits' });
    }

    slug = slugify(slug || coupleName);
    if (!slug) return res.status(400).json({ error: 'could not derive a valid slug' });

    // Always append a random suffix -- no more 409/manual-retry dance for
    // the common "same names as an earlier couple" case, and it closes the
    // privacy gap where a guessable slug lets a stranger view a couple's
    // (unauthenticated-read) live guest submissions. See src/slug.js for
    // the full reasoning. Retries with a fresh suffix on the astronomically
    // unlikely case of a real collision rather than assuming one can't
    // happen.
    let finalSlug;
    try {
      finalSlug = makeUniqueSlug(slug, (candidate) => db.slugExists(candidate));
    } catch (err) {
      console.error('Slug generation failed:', err);
      return res.status(500).json({ error: 'could not generate a unique slug, please try again' });
    }

    const event = db.createEvent({
      slug: finalSlug,
      coupleName: coupleName.trim(),
      pin,
    });

    res.status(201).json({
      slug: event.slug,
      guestUrl: `/e/${event.slug}`,
      displayUrl: `/e/${event.slug}/display`,
      adminToken: adminAuth.issueToken(event.slug),
    });
  });

  // ── Public event info (guest + display pages fetch this) ────────────────
  router.get('/events/:slug', (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    res.json({
      slug: event.slug,
      coupleName: event.couple_name,
      theme: event.theme,
    });
  });

  router.get('/events/:slug/qr', async (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const url = `${getBaseUrl(req, port)}/e/${event.slug}`;
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 220,
        margin: 1,
        color: { dark: '#5a3e36', light: '#fdf8f4' },
      });
      res.json({ dataUrl, url });
    } catch (err) {
      res.status(500).json({ error: 'QR generation failed' });
    }
  });

  // ── Admin PIN verification -> short-lived session token ─────────────────
  router.post('/events/:slug/admin/verify', express.json(), (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const { pin } = req.body || {};
    if (!pin || !db.verifyPin(pin, event.admin_pin_hash, event.admin_pin_salt)) {
      return res.status(401).json({ error: 'invalid pin' });
    }
    const token = adminAuth.issueToken(event.slug);
    res.json({ token });
  });

  function requireAdmin(req, res, next) {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!adminAuth.verifyToken(token, req.params.slug)) {
      return res.status(401).json({ error: 'admin authorization required' });
    }
    next();
  }

  // ── Reset ("Neue Runde") — archives then clears, PIN-gated ─────────────
  router.post('/events/:slug/reset', requireAdmin, (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    db.archiveWords(event.id);
    db.clearWords(event.id);
    io.to(event.slug).emit('word-update', []);
    io.to(event.slug).emit('round-reset');
    res.json({ ok: true });
  });

  // ── Product configurator ────────────────────────────────────────────────
  router.get('/events/:slug/configurator', (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const personalMemory = req.query.mode === 'personal';
    const words = personalMemory ? [] : db.getWords(event.id);
    if (!personalMemory && !words.length) return res.status(409).json({ error: 'no_words' });
    res.json({
      event: {
        slug: event.slug,
        coupleName: event.couple_name,
        theme: event.theme,
      },
      words,
      configurationType: personalMemory ? 'personal_memory' : 'event_wordcloud',
      // Keep `product` for older/open browser tabs while the current UI uses
      // the complete curated list to render the size selector.
      product: getPublicProduct(DEFAULT_PRODUCT),
      products: getPublicProducts(),
      productFamilies: getPublicProductFamilies(),
    });
  });

  // Printful's current shipping destinations are proxied through our server
  // so the private API token never reaches the browser. The Printful module
  // caches this slow-changing list for 24 hours.
  router.get('/shipping/countries', async (req, res) => {
    try {
      const countries = await printful.getShippingCountries();
      res.json({ countries });
    } catch (error) {
      sendPrintfulError(res, error);
    }
  });

  router.post('/events/:slug/configurations', express.json({ limit: '9mb' }), (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });

    const baseProduct = getProduct(req.body?.productKey || DEFAULT_PRODUCT.key);
    if (!baseProduct) return res.status(400).json({ error: 'invalid_product' });
    const product = resolveProductOrientation(baseProduct, req.body?.orientation);
    if (!product) return res.status(400).json({ error: 'invalid_orientation' });

    const theme = req.body?.theme;
    const placement = req.body?.placement;
    const configurationType = String(req.body?.configurationType || 'event_wordcloud');
    if (!CONFIGURATION_TYPES.has(configurationType)) {
      return res.status(400).json({ error: 'invalid_configuration_type' });
    }
    const defaultQuantity = product.minQuantity;
    const quantity = Number(req.body?.quantity ?? defaultQuantity);
    if (!Number.isSafeInteger(quantity) || quantity < product.minQuantity || quantity > product.maxQuantity) {
      return res.status(400).json({ error: 'invalid_quantity' });
    }
    if (!product.themes.some((option) => option.key === theme)) {
      return res.status(400).json({ error: 'invalid_theme' });
    }
    if (!product.layouts.some((option) => option.key === placement)) {
      return res.status(400).json({ error: 'invalid_placement' });
    }

    // The browser sends the exact snapshot it previewed. Re-normalize it at
    // this trust boundary, then store it independently from the live event.
    const words = configurationType === 'personal_memory'
      ? []
      : req.body && Object.hasOwn(req.body, 'words')
        ? normalizeSnapshotWords(req.body.words)
        : db.getWords(event.id);
    if (configurationType === 'event_wordcloud' && (!words || !words.length)) {
      return res.status(400).json({ error: 'invalid_words' });
    }

    const hasDesignPayload = Object.hasOwn(req.body || {}, 'design') ||
      Object.hasOwn(req.body || {}, 'designs');
    const design = hasDesignPayload ? normalizeProductDesigns(req.body, product) : null;
    if (hasDesignPayload && !design) {
      return res.status(400).json({ error: 'invalid_design' });
    }
    if (configurationType === 'personal_memory' && !design) {
      return res.status(400).json({ error: 'personal_design_required' });
    }

    const configuration = db.createConfiguration({
      eventId: event.id,
      productKey: product.key,
      printfulVariantId: product.printful.variantId,
      quantity,
      // Legacy SQLite column only. Retail pricing is calculated after the
      // address is entered and never taken from the browser/configuration.
      unitPriceCents: 0,
      theme,
      placement,
      words,
      design,
      configurationType,
      orientation: product.orientation,
      printWidth: product.printFile.width,
      printHeight: product.printFile.height,
    });

    const printFiles = configurationPrintFileUrls(event.slug, configuration.id, product);
    res.status(201).json({
      id: configuration.id,
      productKey: configuration.product_key,
      quantity: Number(configuration.quantity),
      theme: configuration.theme,
      placement: configuration.placement,
      orientation: configuration.orientation === 'default'
        ? product.orientation
        : configuration.orientation,
      configurationType: configuration.configuration_type,
      ...printFiles,
      createdAt: configuration.created_at,
    });
  });

  router.get('/events/:slug/configurations', (req, res) => {
    const ids = normalizeConfigurationIdList(req.query.ids);
    if (!ids.length) return res.status(400).json({ error: 'invalid_configurations' });
    const configurations = db.getEventConfigurations(req.params.slug, ids);
    if (configurations.length !== ids.length) {
      return res.status(404).json({ error: 'configuration_not_found' });
    }
    const response = configurations.map((configuration) => configurationResponse(req.params.slug, configuration));
    if (response.some((configuration) => !configuration)) {
      return res.status(500).json({ error: 'configuration_invalid' });
    }
    res.json({ configurations: response });
  });

  router.get('/events/:slug/configurations/:configurationId', (req, res) => {
    const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
    const response = configurationResponse(req.params.slug, configuration);
    if (!response) return res.status(500).json({ error: 'configuration_invalid' });
    res.json(response);
  });

  router.get('/events/:slug/configurations/:configurationId/edit', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
    const response = editableConfigurationResponse(req.params.slug, configuration);
    if (!response) return res.status(500).json({ error: 'configuration_invalid' });
    res.json(response);
  });

  router.post(
    '/events/:slug/configurations/:configurationId/estimate-costs',
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
      if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
      try {
        const product = getProduct(configuration.product_key);
        if (!product) return res.status(500).json({ error: 'configuration_invalid' });
        const countries = await printful.getShippingCountries();
        const { shipments, invalidFields } = normalizeCheckoutShipments(
          req.body,
          countries,
          product,
          Number(configuration.quantity)
        );
        if (invalidFields.length) {
          return res.status(400).json({
            error: 'invalid_address',
            fields: invalidFields,
            message: 'Bitte fülle alle benötigten Adressfelder vollständig aus.',
          });
        }
        const pricedShipments = await Promise.all(shipments.map(async (shipment) => {
          const printfulCosts = await printful.estimateOrderCosts({
            variantId: Number(configuration.printful_variant_id),
            quantity: shipment.quantity,
            recipient: shipment.recipient,
          });
          return { ...shipment, printfulCosts };
        }));
        const calculatedQuote = buildCustomerQuoteForShipments(
          pricedShipments.map((shipment) => ({ quantity: shipment.quantity, costs: shipment.printfulCosts }))
        );
        const quotedShipments = pricedShipments.map((shipment, index) => ({
          ...shipment,
          customerCosts: calculatedQuote.shipmentQuotes[index],
        }));
        if (calculatedQuote.currency !== 'EUR') {
          console.error(`Printful returned ${calculatedQuote.currency}; dynamic checkout requires EUR.`);
          return res.status(502).json({
            error: 'pricing_currency_mismatch',
            message: 'Der Shoppreis konnte nicht in Euro berechnet werden. Bitte versucht es später erneut.',
          });
        }
        const savedQuote = db.createCheckoutQuote({
          eventId: configuration.event_id,
          configurationId: configuration.id,
          shipments: quotedShipments,
          quote: calculatedQuote,
        });
        res.json({ quote: checkoutQuoteResponse(savedQuote) });
      } catch (error) {
        if (error?.message?.startsWith('invalid Printful') || error?.message?.startsWith('invalid negative')) {
          console.error('Invalid Printful pricing response:', error.message);
          return res.status(502).json({
            error: 'pricing_unavailable',
            message: 'Printful hat gerade keinen gültigen Preis geliefert. Bitte versucht es erneut.',
          });
        }
        return sendPrintfulError(res, error);
      }
    }
  );

  router.post('/events/:slug/cart/estimate-costs', express.json({ limit: '32kb' }), async (req, res) => {
    const ids = normalizeConfigurationIdList(req.body?.configurationIds || req.body?.configuration_ids);
    const configurations = db.getEventConfigurations(req.params.slug, ids);
    if (!ids.length || configurations.length !== ids.length) {
      return res.status(404).json({ error: 'configuration_not_found' });
    }
    try {
      const countries = await printful.getShippingCountries();
      const { invalidFields, pricedShipments, calculatedQuote } = await estimateCartShipments({
        body: req.body,
        countries,
        configurations,
      });
      if (invalidFields?.length) {
        return res.status(400).json({
          error: 'invalid_address',
          fields: invalidFields,
          message: 'Bitte fülle alle benötigten Adressfelder vollständig aus.',
        });
      }
      if (calculatedQuote.currency !== 'EUR') {
        console.error(`Printful returned ${calculatedQuote.currency}; dynamic checkout requires EUR.`);
        return res.status(502).json({
          error: 'pricing_currency_mismatch',
          message: 'Der Shoppreis konnte nicht in Euro berechnet werden. Bitte versucht es später erneut.',
        });
      }
      const savedQuote = db.createCheckoutQuote({
        eventId: configurations[0].event_id,
        configurationId: configurations[0].id,
        configurationIds: configurations.map((configuration) => configuration.id),
        shipments: pricedShipments,
        quote: calculatedQuote,
      });
      res.json({ quote: { ...checkoutQuoteResponse(savedQuote), ...cartSummary(configurations) } });
    } catch (error) {
      if (error?.message?.startsWith('invalid Printful') || error?.message?.startsWith('invalid negative')) {
        console.error('Invalid Printful pricing response:', error.message);
        return res.status(502).json({
          error: 'pricing_unavailable',
          message: 'Printful hat gerade keinen gültigen Preis geliefert. Bitte versucht es erneut.',
        });
      }
      return sendPrintfulError(res, error);
    }
  });

  // Restore an opaque saved quote after returning from Stripe's cancel URL.
  // The response is no-store because it contains the normalized address.
  router.get('/events/:slug/configurations/:configurationId/quotes/:quoteId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const quote = db.getEventCheckoutQuote(
      req.params.slug,
      req.params.configurationId,
      req.params.quoteId
    );
    if (!quote) return res.status(404).json({ error: 'quote_not_found' });
    const order = db.getOrderByQuoteId(quote.id);
    if (db.isCheckoutQuoteExpired(quote) && !order) {
      return res.status(410).json({ error: 'quote_expired' });
    }
    let recipient;
    try {
      recipient = JSON.parse(quote.recipient_json);
    } catch {
      return res.status(500).json({ error: 'quote_invalid' });
    }
    const shipments = db.getCheckoutQuoteShipments(quote)
      .map((shipment) => ({ quantity: Number(shipment.quantity), recipient: shipment.recipient }));
    return res.json({ quote: checkoutQuoteResponse(quote), recipient, shipments });
  });

  router.get('/events/:slug/cart/quotes/:quoteId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ids = normalizeConfigurationIdList(req.query.ids);
    const quote = db.getEventCartCheckoutQuote(req.params.slug, ids, req.params.quoteId);
    if (!quote) return res.status(404).json({ error: 'quote_not_found' });
    const order = db.getOrderByQuoteId(quote.id);
    if (db.isCheckoutQuoteExpired(quote) && !order) {
      return res.status(410).json({ error: 'quote_expired' });
    }
    const configurations = db.getEventConfigurations(req.params.slug, ids);
    const shipments = db.getCheckoutQuoteShipments(quote)
      .map((shipment) => ({
        quantity: Number(shipment.quantity),
        recipient: shipment.recipient,
        items: Array.isArray(shipment.items) ? shipment.items : [],
      }));
    return res.json({
      quote: { ...checkoutQuoteResponse(quote), ...cartSummary(configurations) },
      shipments,
    });
  });

  router.get('/events/:slug/configurations/:configurationId/print.svg', (req, res) => {
    const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).send('configuration not found');
    const product = resolveProductOrientation(
      getProduct(configuration.product_key),
      configuration.orientation
    );
    if (!product) return res.status(500).send('configuration is invalid');
    if (Number(configuration.print_width) !== product.printFile.width ||
        Number(configuration.print_height) !== product.printFile.height) {
      return res.status(500).send('configuration is invalid');
    }
    const surfaceKey = String(req.query.surface || product.printSurfaces[0].key);
    if (!product.printSurfaces.some((surface) => surface.key === surfaceKey)) {
      return res.status(400).send('print surface is invalid');
    }
    let words;
    let design = null;
    try {
      words = JSON.parse(configuration.words_json);
      if (configuration.design_json) {
        const storedDesign = JSON.parse(configuration.design_json);
        if (Array.isArray(storedDesign)) {
          // Configurations created before independent print surfaces used one
          // immutable design for every Printful placement.
          design = storedDesign;
        } else if (storedDesign?.version === 2 &&
                   storedDesign.surfaces &&
                   Array.isArray(storedDesign.surfaces[surfaceKey])) {
          design = storedDesign.surfaces[surfaceKey];
        } else {
          return res.status(500).send('configuration is invalid');
        }
      }
    } catch {
      return res.status(500).send('configuration is invalid');
    }
    const svg = buildProductPrintSvg(product, words, configuration.theme, configuration.placement, design);
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(svg);
  });

  router.post('/events/:slug/cart/checkout', express.json({ limit: '32kb' }), async (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    const ids = normalizeConfigurationIdList(req.body?.configurationIds || req.body?.configuration_ids);
    const configurations = db.getEventConfigurations(event.slug, ids);
    if (!ids.length || configurations.length !== ids.length) {
      return res.status(404).json({ error: 'configuration_not_found' });
    }
    const quoteId = typeof req.body?.quoteId === 'string' ? req.body.quoteId : '';
    const storedQuote = db.getEventCartCheckoutQuote(event.slug, ids, quoteId);
    if (!storedQuote) {
      return res.status(404).json({
        error: 'quote_not_found',
        message: 'Die Preisberechnung wurde nicht gefunden. Bitte berechnet den Preis erneut.',
      });
    }

    let order = db.getOrderByQuoteId(storedQuote.id);
    if (order?.status === 'checkout_pending' && order.stripe_checkout_url) {
      return res.json({ url: order.stripe_checkout_url, reused: true });
    }
    if (order && ['paid_test', 'paid'].includes(order.status)) {
      return res.json({
        confirmationUrl: `/e/${encodeURIComponent(event.slug)}/order-confirmation?session_id=${encodeURIComponent(order.stripe_session_id)}`,
        alreadyPaid: true,
      });
    }
    if (order?.status === 'creating_checkout') {
      return res.status(409).json({
        error: 'checkout_in_progress',
        message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
      });
    }
    if (db.isCheckoutQuoteExpired(storedQuote)) {
      return res.status(409).json({
        error: 'quote_expired',
        message: 'Der Preis ist abgelaufen. Bitte berechnet den Gesamtpreis erneut.',
      });
    }

    const storedShipments = db.getCheckoutQuoteShipments(storedQuote);
    if (!storedShipments.length) {
      return res.status(500).json({ error: 'quote_invalid' });
    }

    try {
      const countries = await printful.getShippingCountries();
      const { invalidFields, pricedShipments, calculatedQuote: freshQuote } = await estimateCartShipments({
        body: { shipments: storedShipments },
        countries,
        configurations,
      });
      if (invalidFields?.length) {
        return res.status(400).json({
          error: 'invalid_address',
          fields: invalidFields,
          message: 'Bitte fülle alle benötigten Adressfelder vollständig aus.',
        });
      }
      if (freshQuote.currency !== 'EUR') {
        return res.status(502).json({
          error: 'pricing_currency_mismatch',
          message: 'Der Shoppreis konnte nicht in Euro berechnet werden.',
        });
      }

      const changed = quoteAmountsDiffer(storedQuote, freshQuote);
      const refreshedQuote = db.updateCheckoutQuote(storedQuote.id, {
        shipments: pricedShipments,
        quote: freshQuote,
      });
      if (changed) {
        return res.status(409).json({
          error: 'quote_changed',
          message: 'Printful hat den Preis aktualisiert. Bitte bestätigt den neuen Gesamtpreis.',
          quote: { ...checkoutQuoteResponse(refreshedQuote), ...cartSummary(configurations) },
        });
      }

      const orderResult = db.createCheckoutOrder({
        eventId: event.id,
        configurationId: configurations[0].id,
        quote: refreshedQuote,
        mode: stripe.getCheckoutMode(),
      });
      order = orderResult.order;
      if (!orderResult.created && order.status === 'checkout_failed') {
        order = db.retryCheckoutOrder(order.id);
      }
      if (!orderResult.created && order.status !== 'creating_checkout') {
        if (order.status === 'checkout_pending' && order.stripe_checkout_url) {
          return res.json({ url: order.stripe_checkout_url, reused: true });
        }
        return res.status(409).json({
          error: 'checkout_in_progress',
          message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
        });
      }

      const session = await stripe.createCheckoutSession({
        order,
        products: configurations.map((configuration) => resolveProductOrientation(
          getProduct(configuration.product_key),
          configuration.orientation
        )).filter(Boolean),
        slug: event.slug,
        configurationIds: configurations.map((configuration) => configuration.id),
        quoteId: refreshedQuote.id,
        quantity: freshQuote.quantity,
        shipmentCount: pricedShipments.length,
        baseUrl: getBaseUrl(req, port),
      });
      db.attachStripeSession(order.id, session);
      return res.json({ url: session.url });
    } catch (error) {
      if (order?.id) db.markCheckoutCreationFailed(order.id);
      if (error?.code === 'STRIPE_NOT_CONFIGURED') {
        return res.status(501).json({
          error: 'checkout_not_configured',
          message: 'Stripe ist noch nicht eingerichtet. Bitte ergänzt den Test-Key in der .env-Datei.',
        });
      }
      if (error?.code === 'STRIPE_LIVE_MODE_BLOCKED') {
        return res.status(503).json({ error: 'stripe_live_mode_blocked', message: error.message });
      }
      if (error instanceof printful.PrintfulApiError) return sendPrintfulError(res, error);
      console.error('Cart checkout creation failed:', error);
      return res.status(500).json({
        error: 'checkout_failed',
        message: 'Die Zahlungsseite konnte gerade nicht vorbereitet werden. Bitte versucht es erneut.',
      });
    }
  });

  // Re-estimate from the saved address immediately before Stripe. The client
  // supplies only the opaque quote id; product, quantity, address and cents
  // all come from the database.
  router.post(
    '/events/:slug/configurations/:configurationId/checkout',
    express.json({ limit: '4kb' }),
    async (req, res) => {
      const event = db.getEventBySlug(req.params.slug);
      if (!event) return res.status(404).json({ error: 'event_not_found' });
      const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
      if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
      const product = resolveProductOrientation(
        getProduct(configuration.product_key),
        configuration.orientation
      );
      if (!product) return res.status(500).json({ error: 'configuration_invalid' });
      const quoteId = typeof req.body?.quoteId === 'string' ? req.body.quoteId : '';
      const storedQuote = db.getEventCheckoutQuote(event.slug, configuration.id, quoteId);
      if (!storedQuote) {
        return res.status(404).json({
          error: 'quote_not_found',
          message: 'Die Preisberechnung wurde nicht gefunden. Bitte berechnet den Preis erneut.',
        });
      }

      // A repeated click returns the same Stripe Session. No re-estimate is
      // necessary because this exact quote was already revalidated before
      // that Session was created.
      let order = db.getOrderByQuoteId(storedQuote.id);
      if (order?.status === 'checkout_pending' && order.stripe_checkout_url) {
        return res.json({ url: order.stripe_checkout_url, reused: true });
      }
      if (order && ['paid_test', 'paid'].includes(order.status)) {
        return res.json({
          confirmationUrl: `/e/${encodeURIComponent(event.slug)}/order-confirmation?session_id=${encodeURIComponent(order.stripe_session_id)}`,
          alreadyPaid: true,
        });
      }
      if (order?.status === 'creating_checkout') {
        return res.status(409).json({
          error: 'checkout_in_progress',
          message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
        });
      }
      if (db.isCheckoutQuoteExpired(storedQuote)) {
        return res.status(409).json({
          error: 'quote_expired',
          message: 'Der Preis ist abgelaufen. Bitte berechnet den Gesamtpreis erneut.',
        });
      }

      const storedShipments = db.getCheckoutQuoteShipments(storedQuote);
      if (!storedShipments.length) {
        return res.status(500).json({ error: 'quote_invalid' });
      }

      try {
        const refreshedShipments = await Promise.all(storedShipments.map(async (shipment) => {
          const costs = await printful.estimateOrderCosts({
            variantId: Number(configuration.printful_variant_id),
            quantity: Number(shipment.quantity),
            recipient: shipment.recipient,
          });
          return {
            quantity: Number(shipment.quantity),
            recipient: shipment.recipient,
            printfulCosts: costs,
          };
        }));
        const freshQuote = buildCustomerQuoteForShipments(
          refreshedShipments.map((shipment) => ({ quantity: shipment.quantity, costs: shipment.printfulCosts }))
        );
        const quotedShipments = refreshedShipments.map((shipment, index) => ({
          ...shipment,
          customerCosts: freshQuote.shipmentQuotes[index],
        }));
        if (freshQuote.currency !== 'EUR') {
          return res.status(502).json({
            error: 'pricing_currency_mismatch',
            message: 'Der Shoppreis konnte nicht in Euro berechnet werden.',
          });
        }

        const changed = quoteAmountsDiffer(storedQuote, freshQuote);
        const refreshedQuote = db.updateCheckoutQuote(storedQuote.id, {
          shipments: quotedShipments,
          quote: freshQuote,
        });
        if (changed) {
          return res.status(409).json({
            error: 'quote_changed',
            message: 'Printful hat den Preis aktualisiert. Bitte bestätigt den neuen Gesamtpreis.',
            quote: checkoutQuoteResponse(refreshedQuote),
          });
        }

        const orderResult = db.createCheckoutOrder({
          eventId: event.id,
          configurationId: configuration.id,
          quote: refreshedQuote,
          mode: stripe.getCheckoutMode(),
        });
        order = orderResult.order;
        if (!orderResult.created && order.status === 'checkout_failed') {
          order = db.retryCheckoutOrder(order.id);
        }
        if (!orderResult.created && order.status !== 'creating_checkout') {
          if (order.status === 'checkout_pending' && order.stripe_checkout_url) {
            return res.json({ url: order.stripe_checkout_url, reused: true });
          }
          return res.status(409).json({
            error: 'checkout_in_progress',
            message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
          });
        }

        const session = await stripe.createCheckoutSession({
          order,
          product,
          slug: event.slug,
          configurationId: configuration.id,
          quoteId: refreshedQuote.id,
          quantity: freshQuote.quantity,
          shipmentCount: refreshedShipments.length,
          baseUrl: getBaseUrl(req, port),
        });
        db.attachStripeSession(order.id, session);
        return res.json({ url: session.url });
      } catch (error) {
        if (order?.id) db.markCheckoutCreationFailed(order.id);
        if (error?.code === 'STRIPE_NOT_CONFIGURED') {
          return res.status(501).json({
            error: 'checkout_not_configured',
            message: 'Stripe ist noch nicht eingerichtet. Bitte ergänzt den Test-Key in der .env-Datei.',
          });
        }
        if (error?.code === 'STRIPE_LIVE_MODE_BLOCKED') {
          return res.status(503).json({ error: 'stripe_live_mode_blocked', message: error.message });
        }
        if (error instanceof printful.PrintfulApiError) return sendPrintfulError(res, error);
        console.error('Dynamic checkout creation failed:', error);
        return res.status(500).json({
          error: 'checkout_failed',
          message: 'Die Zahlungsseite konnte gerade nicht vorbereitet werden. Bitte versucht es erneut.',
        });
      }
    }
  );

  router.get('/events/:slug/orders/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'invalid_session' });
    }
    const order = db.getEventOrderBySessionId(req.params.slug, sessionId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    const configurationIds = db.getOrderConfigurationIds(order);
    const configurations = configurationIds.map((id) => db.getConfiguration(id)).filter(Boolean);
    const configuration = configurations[0] || db.getConfiguration(order.configuration_id);
    const products = configurations.map((entry) => getProduct(entry.product_key)).filter(Boolean);
    const product = products.length === 1 ? products[0] : null;
    const paymentConfirmed = ['paid_test', 'paid'].includes(order.status);
    const fulfillmentCreated = ['draft', 'submitted'].includes(order.fulfillment_status);
    const orderShipments = db.getOrderShipments(order.id);
    res.json({
      status: order.status,
      paymentConfirmed,
      fulfillmentCreated,
      fulfillmentStatus: order.fulfillment_status || 'not_started',
      mode: order.mode || 'test',
      currency: order.currency,
      totalCents: Number(order.total_cents),
      quantity: orderShipments.length
        ? orderShipments.reduce((sum, shipment) => sum + Number(shipment.quantity || 0), 0)
        : configuration ? Number(configuration.quantity) : null,
      shipmentCount: orderShipments.length || 1,
      configurationCount: configurations.length || 1,
      product: product ? {
        name: product.name,
        unit: product.unit,
      } : { name: 'Wolkenworte Bestellung', unit: { singular: 'Produkt', plural: 'Produkte' } },
      configurationType: configuration?.configuration_type || 'event_wordcloud',
      paidAt: order.paid_at,
    });
  });

  // Retain a clear response for clients of the former fixed-Price endpoint.
  router.post('/events/:slug/checkout', express.json(), (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    return res.status(410).json({
      error: 'quote_required',
      message: 'Bitte berechnet zuerst den aktuellen Preis auf der Lieferadressseite.',
    });
  });

  return router;
}

module.exports = { makeRouter };
