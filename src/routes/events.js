'use strict';

const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { slugify, makeUniqueSlug } = require('../slug');
const { getBaseUrl } = require('../baseUrl');
const adminAuth = require('../adminAuth');
const stripe = require('../stripe');
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
      unitPriceCents: product.unitPriceCents,
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
      unitPriceCents: Number(configuration.unit_price_cents),
      totalPriceCents: Number(configuration.quantity) * Number(configuration.unit_price_cents),
      theme: configuration.theme,
      placement: configuration.placement,
      printFileUrl: `/api/events/${encodeURIComponent(event.slug)}/configurations/${encodeURIComponent(configuration.id)}/print.svg`,
      createdAt: configuration.created_at,
    });
  });

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
