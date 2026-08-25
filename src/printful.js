'use strict';

/**
 * Printful catalog, pricing and safely gated order creation.
 *
 * Live country and estimate helpers power the shipping page. The order
 * Stripe test payments never call the order helper. When it is invoked
 * directly without a key, it remains safely mocked for demos/tests.
 *
 * Required env vars (see .env.example):
 *   PRINTFUL_API_KEY        - Bearer token for the stable Printful API
 *   PRINTFUL_STORE_ID       - Printful store id (multi-store accounts)
 *
 * Orders are always created as drafts first (`confirm=false`). Only the
 * separate confirmation endpoint can submit a draft for fulfillment and
 * charge the Printful account. src/fulfillment.js owns the switches that
 * decide whether either external write is allowed.
 *
 * Printful's print-file upload expects a URL it can fetch (or a base64
 * payload for some endpoints) — not raw SVG text. Whether Printful's
 * pipeline accepts SVG directly or needs a print-resolution raster (PNG)
 * instead is still unverified against a real sandbox — see README "Next
 * phase" — but the immutable URL itself is real, not a placeholder.
 */

function isConfigured() {
  return Boolean(process.env.PRINTFUL_API_KEY);
}

class PrintfulApiError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'PrintfulApiError';
    this.code = code;
    this.status = status;
  }
}

function getPrintfulHeaders() {
  return {
    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'Content-Type': 'application/json',
    ...(process.env.PRINTFUL_STORE_ID ? { 'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID } : {}),
  };
}

async function printfulRequest(path, options = {}) {
  if (!isConfigured()) {
    throw new PrintfulApiError(
      'PRINTFUL_NOT_CONFIGURED',
      'Printful ist noch nicht eingerichtet.',
      501
    );
  }

  let response;
  try {
    response = await fetch(`https://api.printful.com${path}`, {
      ...options,
      headers: { ...getPrintfulHeaders(), ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(12000),
    });
  } catch (error) {
    throw new PrintfulApiError(
      'PRINTFUL_UNAVAILABLE',
      `Printful ist momentan nicht erreichbar: ${error.message}`,
      502
    );
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // The status code below still gives callers a useful, sanitized error.
  }

  if (!response.ok || !data || data.code >= 400) {
    const apiStatus = Number(data?.code) >= 400 ? Number(data.code) : response.status;
    const message = typeof data?.error?.message === 'string'
      ? data.error.message
      : `Printful-Anfrage fehlgeschlagen (${response.status}).`;
    const code = apiStatus === 401 || apiStatus === 403
      ? 'PRINTFUL_AUTH_FAILED'
      : apiStatus >= 400 && apiStatus < 500
        ? 'PRINTFUL_ADDRESS_REJECTED'
        : 'PRINTFUL_UNAVAILABLE';
    throw new PrintfulApiError(code, message, apiStatus >= 500 ? 502 : apiStatus);
  }

  return data.result;
}

let countriesCache = null;
let countriesCachedAt = 0;
const COUNTRIES_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Printful is the source of truth for countries and state/province codes it
 * can currently ship to. Keeping this server-side avoids maintaining a
 * second, inevitably stale country list in the browser.
 */
async function getShippingCountries() {
  if (countriesCache && Date.now() - countriesCachedAt < COUNTRIES_CACHE_MS) {
    return countriesCache;
  }
  const result = await printfulRequest('/countries', { method: 'GET' });
  if (!Array.isArray(result)) {
    throw new PrintfulApiError('PRINTFUL_INVALID_RESPONSE', 'Printful hat keine gültige Länderliste geliefert.', 502);
  }
  countriesCache = result.map((country) => ({
    code: String(country.code || '').toUpperCase(),
    name: String(country.name || ''),
    region: String(country.region || ''),
    states: Array.isArray(country.states)
      ? country.states.map((state) => ({ code: String(state.code || ''), name: String(state.name || '') }))
      : [],
  })).filter((country) => /^[A-Z]{2}$/.test(country.code) && country.name);
  countriesCachedAt = Date.now();
  return countriesCache;
}

/**
 * Ask Printful for the current fulfillment cost without creating an order.
 * Artwork is deliberately omitted: the curated product variant(s) and
 * quantities determine the cost estimate, while Printful cannot fetch a local
 * development artwork URL. The immutable configuration still supplies the
 * trusted variant and later supplies the artwork during fulfillment.
 */
async function estimateOrderCosts({ variantId, quantity, recipient, items }) {
  const orderItems = Array.isArray(items) && items.length
    ? items.map((item) => ({
        variant_id: Number(item.variantId || item.variant_id),
        quantity: Number(item.quantity),
      }))
    : [{ variant_id: Number(variantId), quantity: Number(quantity) }];
  if (!orderItems.length ||
      orderItems.some((item) => !Number.isSafeInteger(item.variant_id) ||
        item.variant_id < 1 ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1)) {
    throw new PrintfulApiError('PRINTFUL_INVALID_ORDER', 'Die Printful-Artikel sind ungültig.', 500);
  }
  const result = await printfulRequest('/orders/estimate-costs', {
    method: 'POST',
    body: JSON.stringify({
      shipping: 'STANDARD',
      recipient,
      items: orderItems,
    }),
  });
  if (!result?.costs || typeof result.costs.currency !== 'string') {
    throw new PrintfulApiError('PRINTFUL_INVALID_RESPONSE', 'Printful hat keinen gültigen Preis geliefert.', 502);
  }
  return result.costs;
}

/**
 * Create an idempotently addressable draft and optionally confirm it.
 * `payload` is built exclusively from persisted server-side data by
 * src/fulfillment.js; browser-supplied variants, quantities and URLs never
 * reach this trust boundary.
 */
async function createPrintfulOrder({ payload, confirm = false }) {
  if (!isConfigured()) {
    const externalId = payload?.external_id || `unconfigured-${Date.now()}`;
    const mockId = `MOCK-${externalId}`;
    console.log(`[printful:mock] ${externalId} was not sent; PRINTFUL_API_KEY is not set.`);
    return { printfulOrderId: mockId, status: 'mocked', mocked: true, confirmed: false };
  }

  if (!payload || typeof payload.external_id !== 'string' || !Array.isArray(payload.items)) {
    throw new PrintfulApiError('PRINTFUL_INVALID_ORDER', 'Die Printful-Bestelldaten sind ungültig.', 500);
  }
  const draft = await printfulRequest('/orders?confirm=false&update_existing=true', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!draft?.id) {
    throw new PrintfulApiError('PRINTFUL_INVALID_RESPONSE', 'Printful hat keine Bestell-ID geliefert.', 502);
  }

  if (!confirm) {
    return {
      printfulOrderId: String(draft.id),
      status: String(draft.status || 'draft'),
      mocked: false,
      confirmed: false,
    };
  }

  const confirmed = await printfulRequest(
    `/orders/${encodeURIComponent(String(draft.id))}/confirm`,
    { method: 'POST' }
  );
  return {
    printfulOrderId: String(confirmed?.id || draft.id),
    status: String(confirmed?.status || 'pending'),
    mocked: false,
    confirmed: true,
  };
}

module.exports = {
  PrintfulApiError,
  isConfigured,
  getShippingCountries,
  estimateOrderCosts,
  createPrintfulOrder,
};
