'use strict';

const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { slugify, makeUniqueSlug } = require('../slug');
const { getBaseUrl } = require('../baseUrl');
const adminAuth = require('../adminAuth');
const stripe = require('../stripe');
const printful = require('../printful');
const { buildCustomerQuote } = require('../pricing');
const { normalizeWord, MAX_WORD_LENGTH } = require('../words');
const { MUG_DUO, getProduct, getPublicProduct } = require('../products');
const { buildMugPrintSvg, isMugDesignWithinBounds } = require('../mugPrint');
const MugIcons = require('../../public/js/mug-icons.js');

const PIN_RE = /^\d{4,6}$/;
const MAX_NAME_LENGTH = 80;
const MAX_SNAPSHOT_WORDS = 200;
// Two-sided layouts duplicate every approved cloud word, with a little room
// left for words the couple adds manually in the editor.
const MAX_DESIGN_ELEMENTS = 500;
const ADDRESS_LIMITS = Object.freeze({
  name: 100,
  address1: 120,
  address2: 120,
  city: 100,
  zip: 20,
});

function cleanAddressValue(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLength).trim();
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
  const country = countries.find((entry) => entry.code === recipient.country_code);
  if (!country) {
    invalidFields.push('country_code');
  } else if (country.states.length) {
    const state = country.states.find((entry) => entry.code.toUpperCase() === recipient.state_code);
    if (!state) invalidFields.push('state_code');
  } else {
    delete recipient.state_code;
  }
  if (!recipient.address2) delete recipient.address2;
  return { recipient, invalidFields: [...new Set(invalidFields)] };
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

function normalizeDesign(rawDesign, width, height) {
  if (!Array.isArray(rawDesign) || rawDesign.length === 0 || rawDesign.length > MAX_DESIGN_ELEMENTS) {
    return null;
  }
  const ids = new Set();
  const normalized = [];
  for (const [index, rawItem] of rawDesign.entries()) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return null;
    const type = rawItem.type == null || rawItem.type === 'text' ? 'text' : rawItem.type;
    if (type !== 'text' && type !== 'icon') return null;
    const x = Number(rawItem.x);
    const y = Number(rawItem.y);
    const rawAngle = Number(rawItem.angle ?? 0);
    const color = String(rawItem.color || '').toLowerCase();
    const id = String(rawItem.id || `${type === 'icon' ? 'motiv' : 'wort'}-${index + 1}`).slice(0, 64);
    if (!id || ids.has(id) || !Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(rawAngle) || !/^#[0-9a-f]{6}$/.test(color)) {
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
      color,
    };
    if (type === 'icon') {
      const icon = String(rawItem.icon || '');
      const size = Number(rawItem.size);
      if (!MugIcons.has(icon) || !Number.isFinite(size) || size < 48 || size > height) return null;
      normalized.push({ ...common, icon, size: Math.round(size * 10) / 10 });
      continue;
    }

    const text = normalizeDesignText(rawItem.text);
    const fontSize = Number(rawItem.fontSize);
    if (!text || !Number.isFinite(fontSize) || fontSize < 12 || fontSize > height) return null;
    normalized.push({ ...common, text, fontSize: Math.round(fontSize * 10) / 10 });
  }
  if (!normalized.some((item) => item.type === 'text')) return null;
  return isMugDesignWithinBounds(normalized, width, height) ? normalized : null;
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
    const { coupleName, eventTitle, weddingDate, pin } = req.body || {};
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
      eventTitle: (eventTitle && String(eventTitle).trim()) || 'Hochzeit',
      weddingDate: weddingDate ? String(weddingDate).slice(0, 10) : null,
      pin,
    });

    res.status(201).json({
      slug: event.slug,
      guestUrl: `/e/${event.slug}`,
      displayUrl: `/e/${event.slug}/display`,
    });
  });

  // ── Public event info (guest + display pages fetch this) ────────────────
  router.get('/events/:slug', (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    res.json({
      slug: event.slug,
      coupleName: event.couple_name,
      eventTitle: event.event_title,
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
    res.json({ ok: true });
  });

  // ── Product configurator ────────────────────────────────────────────────
  router.get('/events/:slug/configurator', (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const words = db.getWords(event.id);
    if (!words.length) return res.status(409).json({ error: 'no_words' });
    res.json({
      event: {
        slug: event.slug,
        coupleName: event.couple_name,
        eventTitle: event.event_title,
        theme: event.theme,
      },
      words,
      product: getPublicProduct(),
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

  router.post('/events/:slug/configurations', express.json({ limit: '64kb' }), (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });

    const product = getProduct(req.body?.productKey || MUG_DUO.key);
    if (!product) return res.status(400).json({ error: 'invalid_product' });

    const theme = req.body?.theme;
    const placement = req.body?.placement;
    const quantity = Number(req.body?.quantity ?? product.defaultQuantity);
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
    const words = req.body && Object.hasOwn(req.body, 'words')
      ? normalizeSnapshotWords(req.body.words)
      : db.getWords(event.id);
    if (!words || !words.length) {
      return res.status(400).json({ error: 'invalid_words' });
    }

    const design = Object.hasOwn(req.body || {}, 'design')
      ? normalizeDesign(req.body.design, product.printFile.width, product.printFile.height)
      : null;
    if (Object.hasOwn(req.body || {}, 'design') && !design) {
      return res.status(400).json({ error: 'invalid_design' });
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
      printWidth: product.printFile.width,
      printHeight: product.printFile.height,
    });

    res.status(201).json({
      id: configuration.id,
      productKey: configuration.product_key,
      quantity: Number(configuration.quantity),
      theme: configuration.theme,
      placement: configuration.placement,
      printFileUrl: `/api/events/${encodeURIComponent(event.slug)}/configurations/${encodeURIComponent(configuration.id)}/print.svg`,
      createdAt: configuration.created_at,
    });
  });

  router.get('/events/:slug/configurations/:configurationId', (req, res) => {
    const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
    const product = getProduct(configuration.product_key);
    if (!product) return res.status(500).json({ error: 'configuration_invalid' });
    const placement = product.layouts.find((option) => option.key === configuration.placement);
    res.json({
      id: configuration.id,
      quantity: Number(configuration.quantity),
      product: {
        key: product.key,
        name: product.name,
        description: product.description,
        size: product.size,
      },
      placement: placement ? { key: placement.key, label: placement.label } : null,
      printFileUrl: `/api/events/${encodeURIComponent(req.params.slug)}/configurations/${encodeURIComponent(configuration.id)}/print.svg`,
      createdAt: configuration.created_at,
    });
  });

  router.post(
    '/events/:slug/configurations/:configurationId/estimate-costs',
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
      if (!configuration) return res.status(404).json({ error: 'configuration_not_found' });
      try {
        const countries = await printful.getShippingCountries();
        const { recipient, invalidFields } = normalizeRecipient(req.body?.recipient, countries);
        if (invalidFields.length) {
          return res.status(400).json({
            error: 'invalid_address',
            fields: invalidFields,
            message: 'Bitte füllt alle benötigten Adressfelder vollständig aus.',
          });
        }
        const costs = await printful.estimateOrderCosts({
          variantId: Number(configuration.printful_variant_id),
          quantity: Number(configuration.quantity),
          recipient,
        });
        const quote = buildCustomerQuote(costs, Number(configuration.quantity));
        res.json({ quote });
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

  router.get('/events/:slug/configurations/:configurationId/print.svg', (req, res) => {
    const configuration = db.getEventConfiguration(req.params.slug, req.params.configurationId);
    if (!configuration) return res.status(404).send('configuration not found');
    let words;
    let design = null;
    try {
      words = JSON.parse(configuration.words_json);
      if (configuration.design_json) design = JSON.parse(configuration.design_json);
    } catch {
      return res.status(500).send('configuration is invalid');
    }
    const svg = buildMugPrintSvg(words, configuration.theme, configuration.placement, design);
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(svg);
  });

  // ── Mug-duo checkout ─────────────────────────────────────────────────────
  router.post('/events/:slug/checkout', express.json(), async (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).json({ error: 'event not found' });
    try {
      const baseUrl = getBaseUrl(req, port);
      const session = await stripe.createCheckoutSession({ slug: event.slug, baseUrl });
      db.createOrder({ eventId: event.id, stripeSessionId: session.id });
      res.json({ url: session.url });
    } catch (err) {
      if (err.code === 'STRIPE_NOT_CONFIGURED') {
        return res.status(501).json({
          error: 'checkout_not_configured',
          message: 'Stripe ist noch nicht eingerichtet (fehlende API-Keys). Diese Funktion folgt in einer späteren Phase.',
        });
      }
      console.error('Checkout session creation failed:', err);
      res.status(500).json({ error: 'checkout_failed' });
    }
  });

  return router;
}

module.exports = { makeRouter };
