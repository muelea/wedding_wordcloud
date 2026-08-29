'use strict';

const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { slugify, makeUniqueSlug } = require('../slug');
const { getBaseUrl } = require('../baseUrl');
const { sourceHashForRequest } = require('../clientIdentity');
const rateLimits = require('../rateLimits');
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
const designAssets = require('../designAssets');
const MugIcons = require('../../public/js/mug-icons.js');
const I18n = require('../i18n');
const { asyncRoute } = require('../asyncRoute');
const log = require('../structuredLog');
const performanceProbe = require('../performanceProbe');

const PIN_RE = /^\d{4,6}$/;
const MAX_NAME_LENGTH = 80;
const MAX_SNAPSHOT_WORDS = 200;
// Two-sided layouts duplicate every approved cloud word, with a little room
// left for words the couple adds manually in the editor.
const MAX_DESIGN_ELEMENTS = 500;
const MAX_DESIGN_IMAGES = 6;
const DESIGN_ASSET_ID_RE = /^[A-Za-z0-9_-]{24}$/;
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
  return String(value || '')
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/\p{M}/gu, '');
}

const regionNameFormatters = typeof Intl.DisplayNames === 'function'
  ? I18n.SUPPORTED_LOCALES.map((locale) => new Intl.DisplayNames([locale], { type: 'region' }))
  : [];

function localizedCountryNamesForCode(code) {
  return regionNameFormatters.map((formatter) => {
    try { return formatter.of(code) || ''; } catch { return ''; }
  }).filter(Boolean);
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
    localizedCountryNamesForCode(entry.code)
      .some((name) => normalizeAddressLookupValue(name) === lookup)
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
      message: 'Der Gesamtpreis konnte gerade nicht berechnet werden. Bitte versucht es gleich noch einmal.',
    });
  }
  if (error?.code === 'PRINTFUL_ADDRESS_REJECTED') {
    return res.status(422).json({
      error: 'address_not_accepted',
      message: 'Für diese Lieferadresse konnten keine Versandkosten berechnet werden. Bitte prüft eure Angaben.',
    });
  }
  if (error?.code === 'PRINTFUL_AUTH_FAILED') {
    log.error('printful_quote_failed', { errorCode: 'printful_auth_failed', provider: 'printful' });
  } else {
    log.error('printful_quote_failed', {
      errorCode: log.errorCode(error, 'printful_quote_failed'), provider: 'printful',
    });
  }
  performanceProbe.recordOperation('quoteFailed');
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

function parseStoredCheckoutRequest(order) {
  try {
    const parsed = JSON.parse(order?.checkout_request_json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function attemptPersistedCheckout(order) {
  const claimed = await db.claimCheckoutAttempt(order.id);
  if (!claimed) return null;
  try {
    const request = parseStoredCheckoutRequest(claimed);
    const session = await stripe.createCheckoutSession({ order: claimed, ...request });
    await db.attachStripeSession(claimed.id, session);
    return session;
  } catch (error) {
    // A timeout or process interruption can occur after Stripe accepted the
    // request. Keep the attempt recoverable and reuse the exact same frozen
    // parameters and idempotency key on the next claim.
    await db.markCheckoutCreationFailed(claimed.id, error);
    throw error;
  }
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

function normalizeSnapshotWords(rawWords, locale = I18n.DEFAULT_LOCALE) {
  if (!Array.isArray(rawWords) || rawWords.length === 0 || rawWords.length > MAX_SNAPSHOT_WORDS) {
    return null;
  }
  const merged = new Map();
  for (const entry of rawWords) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const word = normalizeWord(entry[0], locale);
    const count = Number(entry[1]);
    if (!word || !Number.isSafeInteger(count) || count < 1 || count > 1000000) return null;
    merged.set(word, (merged.get(word) || 0) + count);
  }
  return Array.from(merged.entries());
}

function normalizeDesignText(rawText, locale = I18n.DEFAULT_LOCALE) {
  if (typeof rawText !== 'string') return '';
  const text = rawText.normalize('NFC').trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/ {2,}/g, ' ')
    .slice(0, MAX_WORD_LENGTH)
    .trim();
  // Reuse the guest-word sanitizer as the source of truth for unsupported
  // characters, but preserve intentional capitalization in the editor.
  return normalizeWord(text, locale) === text.toLocaleLowerCase(locale) ? text : '';
}

function normalizeDesign(
  rawDesign,
  width,
  height,
  safeMargin,
  imageBudget = { assetIds: new Set() },
  locale = I18n.DEFAULT_LOCALE,
  allowImages = false
) {
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
      const assetId = String(rawItem.assetId || '');
      const imageWidth = Number(rawItem.width);
      const imageHeight = Number(rawItem.height);
      if (!allowImages || !DESIGN_ASSET_ID_RE.test(assetId) ||
          !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) ||
          imageWidth < 48 || imageHeight < 48 || imageWidth > width || imageHeight > height) {
        return null;
      }
      imageBudget.assetIds.add(assetId);
      if (imageBudget.assetIds.size > MAX_DESIGN_IMAGES) return null;
      normalized.push({
        ...common,
        assetId,
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

    const text = normalizeDesignText(rawItem.text, locale);
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

function normalizeProductDesigns(
  rawBody,
  product,
  configurationType,
  locale = I18n.DEFAULT_LOCALE
) {
  if (!rawBody || typeof rawBody !== 'object') return null;
  const rawDesigns = rawBody.designs;
  if (!rawDesigns || typeof rawDesigns !== 'object' || Array.isArray(rawDesigns)) return null;
  const imageBudget = { assetIds: new Set() };
  const normalizeOne = (rawDesign) => normalizeDesign(
    rawDesign,
    product.printFile.width,
    product.printFile.height,
    product.designSafeMargin,
    imageBudget,
    locale,
    configurationType === 'personal_memory'
  );

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
  const printFiles = configurationPrintFileUrls(slug, configuration.id, product);
  return {
    id: configuration.id,
    quantity: Number(configuration.quantity),
    product: getPublicProduct(baseProduct, product.orientation),
    orientation: product.orientation,
    configurationType: configuration.configuration_type,
    ...printFiles,
    createdAt: configuration.created_at,
  };
}

function configurationDesignSurfaces(product, design) {
  if (!design) return null;
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

async function editableConfigurationResponse(slug, configuration) {
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
  if (designAssets.collectAssetIds(design).length) {
    design = await designAssets.materializeDesignForEditing(configuration.id, design);
  }
  return {
    ...summary,
    productKey: configuration.product_key,
    theme: configuration.theme,
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

function makeRouter({ io, port, wordBroadcasts = null }) {
  const router = express.Router();

  function requestIdentities(req) {
    const sourceHash = sourceHashForRequest(req);
    const guestId = rateLimits.guestIdentity(req.get('X-Wolkenworte-Guest-Id'), sourceHash);
    return { sourceHash, guestId };
  }

  function consumeEventRequest(req, event, action, guestLimit, sourceLimit) {
    const { sourceHash, guestId } = requestIdentities(req);
    return rateLimits.consume([
      {
        name: `${action}:guest`,
        key: `${event.id}:${guestId}`,
        ...guestLimit,
      },
      {
        name: `${action}:source`,
        key: `${event.id}:${sourceHash}`,
        ...sourceLimit,
      },
    ]);
  }

  function rateLimited(res) {
    performanceProbe.recordOperation('httpRateLimited');
    return res.status(429).json({ error: 'rate_limited' });
  }

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
  router.post('/events', express.json(), asyncRoute(async (req, res) => {
    const sourceHash = sourceHashForRequest(req);
    if (!rateLimits.consume([{
      name: 'event:create',
      key: sourceHash,
      ...rateLimits.LIMITS.eventCreate,
    }])) return rateLimited(res);
    const { coupleName, pin } = req.body || {};
    if (req.body?.locale != null && !I18n.isSupportedLocale(req.body.locale)) {
      return res.status(400).json({ error: 'invalid_locale' });
    }
    const locale = I18n.normalizeLocale(req.body?.locale);
    let { slug } = req.body || {};

    if (!coupleName || typeof coupleName !== 'string' || !coupleName.trim()) {
      return res.status(400).json({ error: 'invalid_couple_name' });
    }
    if (coupleName.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: 'couple_name_too_long' });
    }
    if (!pin || !PIN_RE.test(String(pin))) {
      return res.status(400).json({ error: 'invalid_pin' });
    }

    slug = slugify(slug || coupleName);
    if (!slug) return res.status(400).json({ error: 'invalid_slug' });

    // Always append a random suffix -- no more 409/manual-retry dance for
    // the common "same names as an earlier couple" case, and it closes the
    // privacy gap where a guessable slug lets a stranger view a couple's
    // (unauthenticated-read) live guest submissions. See src/slug.js for
    // the full reasoning. Retries with a fresh suffix on the astronomically
    // unlikely case of a real collision rather than assuming one can't
    // happen.
    let event = null;
    for (let attempt = 0; attempt < 20 && !event; attempt += 1) {
      const finalSlug = makeUniqueSlug(slug, () => false);
      try {
        // The unique index is the final arbiter. A race retries with a fresh
        // suffix instead of relying on a stale availability pre-check.
        event = await db.createEvent({
          slug: finalSlug,
          coupleName: coupleName.trim(),
          pin,
          locale,
        });
      } catch (error) {
        if (error?.code !== '23505') throw error;
      }
    }
    if (!event) return res.status(500).json({ error: 'slug_generation_failed' });

    res.status(201).json({
      slug: event.slug,
      locale: event.locale,
      guestUrl: `/e/${event.slug}`,
      displayUrl: `/e/${event.slug}/display`,
    });
  }));

  // ── Public event info (guest + display pages fetch this) ────────────────
  router.get('/events/:slug', asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    res.json({
      slug: event.slug,
      coupleName: event.couple_name,
      theme: event.theme,
      locale: event.locale,
    });
  }));

  router.get('/events/:slug/qr', asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
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
  }));

  // ── Reset ("Neue Runde") — one request, one PIN verification ───────────
  router.post('/events/:slug/reset', express.json({ limit: '1kb' }), asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const sourceHash = sourceHashForRequest(req);
    let authorization;
    try {
      authorization = await db.authorizeResetPin(event, req.body?.pin, sourceHash);
    } catch (error) {
      if (error?.code === 'pin_busy') return res.status(503).json({ error: 'temporarily_unavailable' });
      throw error;
    }
    if (authorization.blocked) return rateLimited(res);
    if (!authorization.ok) return res.status(401).json({ error: 'invalid_pin' });
    await db.archiveAndClearWords(event.id);
    if (wordBroadcasts) wordBroadcasts.resetRoom(event, []);
    else io.to(event.slug).emit('word-update', []);
    io.to(event.slug).emit('round-reset');
    res.json({ ok: true });
  }));

  // ── Product configurator ────────────────────────────────────────────────
  router.get('/events/:slug/configurator', asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const personalMemory = req.query.mode === 'personal';
    const words = personalMemory ? [] : await db.getWords(event.id);
    if (!personalMemory && !words.length) return res.status(409).json({ error: 'no_words' });
    res.json({
      event: {
        slug: event.slug,
        coupleName: event.couple_name,
        theme: event.theme,
        locale: event.locale,
      },
      words,
      configurationType: personalMemory ? 'personal_memory' : 'event_wordcloud',
      // Keep `product` for older/open browser tabs while the current UI uses
      // the complete curated list to render the size selector.
      product: getPublicProduct(DEFAULT_PRODUCT),
      products: getPublicProducts(),
      productFamilies: getPublicProductFamilies(),
    });
  }));

  // Printful's current shipping destinations are proxied through our server
  // so the private API token never reaches the browser. The Printful module
  // caches this slow-changing list for 24 hours.
  router.get('/shipping/countries', asyncRoute(async (req, res) => {
    try {
      const countries = await printful.getShippingCountries();
      res.json({ countries });
    } catch (error) {
      sendPrintfulError(res, error);
    }
  }));

  router.post('/events/:slug/assets', express.json({ limit: '27mb' }), asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    if (!consumeEventRequest(
      req, event, 'asset', rateLimits.LIMITS.assetGuest, rateLimits.LIMITS.assetSource
    )) return rateLimited(res);
    try {
      const result = await designAssets.uploadEventAsset({
        event,
        ownerId: req.get('X-Wolkenworte-Guest-Id'),
        dataUrl: req.body?.dataUrl,
      });
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof designAssets.DesignAssetError) {
        return res.status(error.status).json({ error: error.code });
      }
      throw error;
    }
  }));

  router.post('/events/:slug/configurations', express.json({ limit: '256kb' }), asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    if (!consumeEventRequest(
      req,
      event,
      'configuration',
      rateLimits.LIMITS.configurationGuest,
      rateLimits.LIMITS.configurationSource
    )) return rateLimited(res);

    const baseProduct = getProduct(req.body?.productKey || DEFAULT_PRODUCT.key);
    if (!baseProduct) return res.status(400).json({ error: 'invalid_product' });
    const product = resolveProductOrientation(baseProduct, req.body?.orientation);
    if (!product) return res.status(400).json({ error: 'invalid_orientation' });

    const theme = req.body?.theme;
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
    // The browser sends the exact snapshot it previewed. Re-normalize it at
    // this trust boundary, then store it independently from the live event.
    const words = configurationType === 'personal_memory'
      ? []
      : req.body && Object.hasOwn(req.body, 'words')
        ? normalizeSnapshotWords(req.body.words, event.locale)
        : await db.getWords(event.id);
    if (configurationType === 'event_wordcloud' && (!words || !words.length)) {
      return res.status(400).json({ error: 'invalid_words' });
    }

    const design = normalizeProductDesigns(req.body, product, configurationType, event.locale);
    if (!design) {
      return res.status(400).json({ error: 'invalid_design' });
    }

    let configuration;
    try {
      configuration = await db.createConfiguration({
        eventId: event.id,
        productKey: product.key,
        printfulVariantId: product.printful.variantId,
        quantity,
        // Compatibility snapshot only. Retail pricing is calculated after the
        // address is entered and never taken from the browser/configuration.
        unitPriceCents: 0,
        theme,
        words,
        design,
        configurationType,
        orientation: product.orientation,
        printWidth: product.printFile.width,
        printHeight: product.printFile.height,
      });
    } catch (error) {
      if (error.code === 'invalid_design_assets') {
        return res.status(400).json({ error: 'invalid_design' });
      }
      if (error.code === 'configuration_limit') return rateLimited(res);
      throw error;
    }

    const printFiles = configurationPrintFileUrls(event.slug, configuration.id, product);
    res.status(201).json({
      id: configuration.id,
      productKey: configuration.product_key,
      quantity: Number(configuration.quantity),
      theme: configuration.theme,
      orientation: configuration.orientation === 'default'
        ? product.orientation
        : configuration.orientation,
      configurationType: configuration.configuration_type,
      ...printFiles,
      createdAt: configuration.created_at,
    });
  }));

  router.get('/events/:slug/configurations', asyncRoute(async (req, res) => {
    const ids = normalizeConfigurationIdList(req.query.ids);
    if (!ids.length) return res.status(400).json({ error: 'invalid_configurations' });
    const configurations = await db.getEventConfigurations(req.params.slug, ids);
    if (configurations.length !== ids.length) {
      return res.status(404).json({ error: 'configuration_not_found' });
    }
    const response = configurations.map((configuration) => configurationResponse(req.params.slug, configuration));
    if (response.some((configuration) => !configuration)) {
      return res.status(500).json({ error: 'configuration_invalid' });
    }
    res.json({ configurations: response });
  }));

  router.get('/events/:slug/configurations/:configurationId', asyncRoute(async (req, res) => {
    const configuration = await db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
    const response = configurationResponse(req.params.slug, configuration);
    if (!response) return res.status(500).json({ error: 'configuration_invalid' });
    res.json(response);
  }));

  router.get('/events/:slug/configurations/:configurationId/edit', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const configuration = await db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
    const response = await editableConfigurationResponse(req.params.slug, configuration);
    if (!response) return res.status(500).json({ error: 'configuration_invalid' });
    res.json(response);
  }));

  router.post(
    '/events/:slug/configurations/:configurationId/estimate-costs',
    express.json({ limit: '16kb' }),
    asyncRoute(async (req, res) => {
      const configuration = await db.getEventConfiguration(req.params.slug, req.params.configurationId);
      if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
      if (!consumeEventRequest(
        req,
        { id: configuration.event_id },
        'estimate',
        rateLimits.LIMITS.estimateGuest,
        rateLimits.LIMITS.estimateSource
      )) return rateLimited(res);
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
          performanceProbe.recordOperation('quoteFailed');
          log.error('printful_quote_currency_mismatch', { errorCode: 'pricing_currency_mismatch' });
          return res.status(502).json({
            error: 'pricing_currency_mismatch',
            message: 'Der Gesamtpreis konnte gerade nicht berechnet werden. Bitte versucht es später erneut.',
          });
        }
        const savedQuote = await db.createCheckoutQuote({
          eventId: configuration.event_id,
          configurationId: configuration.id,
          shipments: quotedShipments,
          quote: calculatedQuote,
        });
        performanceProbe.recordOperation('quoteSucceeded');
        res.json({ quote: checkoutQuoteResponse(savedQuote) });
      } catch (error) {
        if (error?.message?.startsWith('invalid Printful') || error?.message?.startsWith('invalid negative')) {
          performanceProbe.recordOperation('quoteFailed');
          log.error('printful_quote_invalid', { errorCode: 'invalid_pricing_response' });
          return res.status(502).json({
            error: 'pricing_unavailable',
            message: 'Der Gesamtpreis konnte gerade nicht berechnet werden. Bitte versucht es erneut.',
          });
        }
        return sendPrintfulError(res, error);
      }
    })
  );

  router.post('/events/:slug/cart/estimate-costs', express.json({ limit: '32kb' }), asyncRoute(async (req, res) => {
    const ids = normalizeConfigurationIdList(req.body?.configurationIds || req.body?.configuration_ids);
    const configurations = await db.getEventConfigurations(req.params.slug, ids);
    if (!ids.length || configurations.length !== ids.length) {
      return res.status(404).json({ error: 'configuration_not_found' });
    }
    if (!consumeEventRequest(
      req,
      { id: configurations[0].event_id },
      'estimate',
      rateLimits.LIMITS.estimateGuest,
      rateLimits.LIMITS.estimateSource
    )) return rateLimited(res);
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
        performanceProbe.recordOperation('quoteFailed');
        log.error('printful_quote_currency_mismatch', { errorCode: 'pricing_currency_mismatch' });
        return res.status(502).json({
          error: 'pricing_currency_mismatch',
          message: 'Der Gesamtpreis konnte gerade nicht berechnet werden. Bitte versucht es später erneut.',
        });
      }
      const savedQuote = await db.createCheckoutQuote({
        eventId: configurations[0].event_id,
        configurationId: configurations[0].id,
        configurationIds: configurations.map((configuration) => configuration.id),
        shipments: pricedShipments,
        quote: calculatedQuote,
      });
      performanceProbe.recordOperation('quoteSucceeded');
      res.json({ quote: { ...checkoutQuoteResponse(savedQuote), ...cartSummary(configurations) } });
    } catch (error) {
      if (error?.message?.startsWith('invalid Printful') || error?.message?.startsWith('invalid negative')) {
        performanceProbe.recordOperation('quoteFailed');
        log.error('printful_quote_invalid', { errorCode: 'invalid_pricing_response' });
        return res.status(502).json({
          error: 'pricing_unavailable',
          message: 'Der Gesamtpreis konnte gerade nicht berechnet werden. Bitte versucht es erneut.',
        });
      }
      return sendPrintfulError(res, error);
    }
  }));

  // Restore an opaque saved quote after returning from Stripe's cancel URL.
  // The response is no-store because it contains the normalized address.
  router.get('/events/:slug/configurations/:configurationId/quotes/:quoteId', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const quote = await db.getEventCheckoutQuote(
      req.params.slug,
      req.params.configurationId,
      req.params.quoteId
    );
    if (!quote) return res.status(404).json({ error: 'quote_not_found' });
    const order = await db.getOrderByQuoteId(quote.id);
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
  }));

  router.get('/events/:slug/cart/quotes/:quoteId', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ids = normalizeConfigurationIdList(req.query.ids);
    const quote = await db.getEventCartCheckoutQuote(req.params.slug, ids, req.params.quoteId);
    if (!quote) return res.status(404).json({ error: 'quote_not_found' });
    const order = await db.getOrderByQuoteId(quote.id);
    if (db.isCheckoutQuoteExpired(quote) && !order) {
      return res.status(410).json({ error: 'quote_expired' });
    }
    const configurations = await db.getEventConfigurations(req.params.slug, ids);
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
  }));

  router.get('/events/:slug/configurations/:configurationId/print.svg', asyncRoute(async (req, res) => {
    const configuration = await db.getEventConfiguration(req.params.slug, req.params.configurationId);
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
    let design = null;
    try {
      if (configuration.design_json) {
        const storedDesign = JSON.parse(configuration.design_json);
        if (storedDesign?.version === 2 &&
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
    if (!design) return res.status(500).send('configuration is invalid');
    if (configuration.configuration_type === 'personal_memory' && design.some((item) => item.type === 'image')) {
      try {
        const storedDesign = JSON.parse(configuration.design_json);
        const materialized = await designAssets.materializeDesignForPrint(configuration.id, storedDesign);
        design = materialized.surfaces[surfaceKey];
      } catch {
        return res.status(503).send('configuration asset is unavailable');
      }
    }
    const svg = buildProductPrintSvg(product, design);
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', configuration.configuration_type === 'personal_memory'
      ? 'private, no-store'
      : 'public, max-age=31536000, immutable');
    res.send(svg);
  }));

  router.post('/events/:slug/cart/checkout', express.json({ limit: '32kb' }), asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    if (!consumeEventRequest(
      req, event, 'checkout', rateLimits.LIMITS.checkoutGuest, rateLimits.LIMITS.checkoutSource
    )) return rateLimited(res);
    const ids = normalizeConfigurationIdList(req.body?.configurationIds || req.body?.configuration_ids);
    const configurations = await db.getEventConfigurations(event.slug, ids);
    if (!ids.length || configurations.length !== ids.length) {
      return res.status(404).json({ error: 'configuration_not_found' });
    }
    const quoteId = typeof req.body?.quoteId === 'string' ? req.body.quoteId : '';
    const storedQuote = await db.getEventCartCheckoutQuote(event.slug, ids, quoteId);
    if (!storedQuote) {
      return res.status(404).json({
        error: 'quote_not_found',
        message: 'Die Preisberechnung wurde nicht gefunden. Bitte berechnet den Preis erneut.',
      });
    }

    let order = await db.getOrderByQuoteId(storedQuote.id);
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
      try {
        const recoveredSession = await attemptPersistedCheckout(order);
        if (recoveredSession) return res.json({ url: recoveredSession.url, recovered: true });
      } catch (error) {
        if (error?.code === 'STRIPE_NOT_CONFIGURED') {
          return res.status(501).json({ error: 'checkout_not_configured' });
        }
        performanceProbe.recordOperation('checkoutFailed');
        log.error('stripe_checkout_recovery_failed', {
          orderId: order.id, errorCode: log.errorCode(error, 'checkout_recovery_failed'),
        });
      }
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
          message: 'Der Gesamtpreis konnte gerade nicht berechnet werden.',
        });
      }

      const changed = quoteAmountsDiffer(storedQuote, freshQuote);
      const refreshedQuote = await db.updateCheckoutQuote(storedQuote.id, {
        shipments: pricedShipments,
        quote: freshQuote,
      });
      if (changed) {
        return res.status(409).json({
          error: 'quote_changed',
          message: 'Der Gesamtpreis hat sich geändert. Bitte bestätigt den neuen Betrag.',
          quote: { ...checkoutQuoteResponse(refreshedQuote), ...cartSummary(configurations) },
        });
      }

      const products = configurations.map((configuration) => resolveProductOrientation(
        getProduct(configuration.product_key),
        configuration.orientation
      )).filter(Boolean);
      const checkoutRequest = stripe.freezeCheckoutRequest({
        products,
        slug: event.slug,
        configurationIds: configurations.map((configuration) => configuration.id),
        quoteId: refreshedQuote.id,
        quantity: freshQuote.quantity,
        shipmentCount: pricedShipments.length,
        baseUrl: getBaseUrl(req, port),
        locale: I18n.normalizeLocale(req.body?.locale || event.locale),
      });
      const orderResult = await db.createCheckoutOrder({
        eventId: event.id,
        configurationId: configurations[0].id,
        quote: refreshedQuote,
        mode: stripe.getCheckoutMode(),
        checkoutRequest,
      });
      order = orderResult.order;
      if (!orderResult.created && order.status !== 'creating_checkout') {
        if (order.status === 'checkout_pending' && order.stripe_checkout_url) {
          return res.json({ url: order.stripe_checkout_url, reused: true });
        }
        return res.status(409).json({
          error: 'checkout_in_progress',
          message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
        });
      }

      const session = await attemptPersistedCheckout(order);
      if (!session) {
        return res.status(409).json({
          error: 'checkout_in_progress',
          message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
        });
      }
      performanceProbe.recordOperation('checkoutSucceeded');
      return res.json({ url: session.url });
    } catch (error) {
      if (error?.code === 'STRIPE_NOT_CONFIGURED') {
        return res.status(501).json({
          error: 'checkout_not_configured',
          message: 'Die Zahlung ist momentan nicht verfügbar. Bitte versucht es später erneut.',
        });
      }
      if (error?.code === 'STRIPE_LIVE_MODE_BLOCKED') {
        return res.status(503).json({
          error: 'stripe_live_mode_blocked',
          message: 'Die Zahlung ist momentan nicht verfügbar. Bitte versucht es später erneut.',
        });
      }
      if (error instanceof printful.PrintfulApiError) return sendPrintfulError(res, error);
      performanceProbe.recordOperation('checkoutFailed');
      log.error('stripe_checkout_creation_failed', {
        orderId: order?.id, errorCode: log.errorCode(error, 'checkout_creation_failed'),
      });
      return res.status(500).json({
        error: 'checkout_failed',
        message: 'Die Zahlungsseite konnte gerade nicht vorbereitet werden. Bitte versucht es erneut.',
      });
    }
  }));

  // Re-estimate from the saved address immediately before Stripe. The client
  // supplies only the opaque quote id; product, quantity, address and cents
  // all come from the database.
  router.post(
    '/events/:slug/configurations/:configurationId/checkout',
    express.json({ limit: '4kb' }),
    asyncRoute(async (req, res) => {
      const event = await db.getEventBySlug(req.params.slug);
      if (!event) return res.status(404).json({ error: 'event_not_found' });
      if (!consumeEventRequest(
        req, event, 'checkout', rateLimits.LIMITS.checkoutGuest, rateLimits.LIMITS.checkoutSource
      )) return rateLimited(res);
      const configuration = await db.getEventConfiguration(req.params.slug, req.params.configurationId);
      if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
      const product = resolveProductOrientation(
        getProduct(configuration.product_key),
        configuration.orientation
      );
      if (!product) return res.status(500).json({ error: 'configuration_invalid' });
      const quoteId = typeof req.body?.quoteId === 'string' ? req.body.quoteId : '';
      const storedQuote = await db.getEventCheckoutQuote(event.slug, configuration.id, quoteId);
      if (!storedQuote) {
        return res.status(404).json({
          error: 'quote_not_found',
          message: 'Die Preisberechnung wurde nicht gefunden. Bitte berechnet den Preis erneut.',
        });
      }

      // A repeated click returns the same Stripe Session. No re-estimate is
      // necessary because this exact quote was already revalidated before
      // that Session was created.
      let order = await db.getOrderByQuoteId(storedQuote.id);
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
        try {
          const recoveredSession = await attemptPersistedCheckout(order);
          if (recoveredSession) return res.json({ url: recoveredSession.url, recovered: true });
        } catch (error) {
          if (error?.code === 'STRIPE_NOT_CONFIGURED') {
            return res.status(501).json({ error: 'checkout_not_configured' });
          }
          performanceProbe.recordOperation('checkoutFailed');
          log.error('stripe_checkout_recovery_failed', {
            orderId: order.id, errorCode: log.errorCode(error, 'checkout_recovery_failed'),
          });
        }
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
            message: 'Der Gesamtpreis konnte gerade nicht berechnet werden.',
          });
        }

        const changed = quoteAmountsDiffer(storedQuote, freshQuote);
        const refreshedQuote = await db.updateCheckoutQuote(storedQuote.id, {
          shipments: quotedShipments,
          quote: freshQuote,
        });
        if (changed) {
          return res.status(409).json({
            error: 'quote_changed',
            message: 'Der Gesamtpreis hat sich geändert. Bitte bestätigt den neuen Betrag.',
            quote: checkoutQuoteResponse(refreshedQuote),
          });
        }

        const checkoutRequest = stripe.freezeCheckoutRequest({
          product,
          slug: event.slug,
          configurationId: configuration.id,
          quoteId: refreshedQuote.id,
          quantity: freshQuote.quantity,
          shipmentCount: refreshedShipments.length,
          baseUrl: getBaseUrl(req, port),
          locale: I18n.normalizeLocale(req.body?.locale || event.locale),
        });
        const orderResult = await db.createCheckoutOrder({
          eventId: event.id,
          configurationId: configuration.id,
          quote: refreshedQuote,
          mode: stripe.getCheckoutMode(),
          checkoutRequest,
        });
        order = orderResult.order;
        if (!orderResult.created && order.status !== 'creating_checkout') {
          if (order.status === 'checkout_pending' && order.stripe_checkout_url) {
            return res.json({ url: order.stripe_checkout_url, reused: true });
          }
          return res.status(409).json({
            error: 'checkout_in_progress',
            message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
          });
        }

        const session = await attemptPersistedCheckout(order);
        if (!session) {
          return res.status(409).json({
            error: 'checkout_in_progress',
            message: 'Die Zahlungsseite wird bereits vorbereitet. Bitte versucht es gleich noch einmal.',
          });
        }
        performanceProbe.recordOperation('checkoutSucceeded');
        return res.json({ url: session.url });
      } catch (error) {
        if (error?.code === 'STRIPE_NOT_CONFIGURED') {
          return res.status(501).json({
            error: 'checkout_not_configured',
            message: 'Die Zahlung ist momentan nicht verfügbar. Bitte versucht es später erneut.',
          });
        }
        if (error?.code === 'STRIPE_LIVE_MODE_BLOCKED') {
          return res.status(503).json({
            error: 'stripe_live_mode_blocked',
            message: 'Die Zahlung ist momentan nicht verfügbar. Bitte versucht es später erneut.',
          });
        }
        if (error instanceof printful.PrintfulApiError) return sendPrintfulError(res, error);
        performanceProbe.recordOperation('checkoutFailed');
        log.error('stripe_checkout_creation_failed', {
          orderId: order?.id, errorCode: log.errorCode(error, 'checkout_creation_failed'),
        });
        return res.status(500).json({
          error: 'checkout_failed',
          message: 'Die Zahlungsseite konnte gerade nicht vorbereitet werden. Bitte versucht es erneut.',
        });
      }
    })
  );

  router.get('/events/:slug/orders/status', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'invalid_session' });
    }
    const order = await db.getEventOrderBySessionId(req.params.slug, sessionId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    const configurationIds = db.getOrderConfigurationIds(order);
    const configurations = (await Promise.all(configurationIds.map((id) => db.getConfiguration(id)))).filter(Boolean);
    const configuration = configurations[0] || await db.getConfiguration(order.configuration_id);
    const products = configurations.map((entry) => getProduct(entry.product_key)).filter(Boolean);
    const product = products.length === 1 ? products[0] : null;
    const paymentConfirmed = ['paid_test', 'paid'].includes(order.status);
    const fulfillmentCreated = ['draft', 'submitted'].includes(order.fulfillment_status);
    const orderShipments = await db.getOrderShipments(order.id);
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
  }));

  // Retain a clear response for clients of the former fixed-Price endpoint.
  router.post('/events/:slug/checkout', express.json(), asyncRoute(async (req, res) => {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event_not_found' });
    return res.status(410).json({
      error: 'quote_required',
      message: 'Bitte berechnet zuerst den aktuellen Preis auf der Lieferadressseite.',
    });
  }));

  return router;
}

module.exports = { makeRouter };
