'use strict';

/**
 * Printful order creation for the His & Hers mug-duo.
 *
 * Called from the Stripe webhook handler once a `checkout.session.completed`
 * event confirms payment. Gated on PRINTFUL_API_KEY. When the key is
 * missing, this function logs a clear mock-order message and returns a fake
 * order id instead of crashing the webhook handler. Live country and price
 * helpers in this file fail clearly when unconfigured because a customer
 * quote must never be fabricated.
 *
 * Required env vars (see .env.example):
 *   PRINTFUL_API_KEY        - Bearer token for the Printful v2 API
 *   PRINTFUL_STORE_ID       - Printful store id (multi-store accounts)
 *   PRINTFUL_MUG_VARIANT_ID - the specific "His" / "Hers" mug variant ids.
 *     A duo is two line items in one order, so this is documented as two
 *     env vars below rather than one, since the two mugs are typically
 *     distinct catalog variants (e.g. "His" vs "Hers" mug wrap designs use
 *     the same physical mug but different print files).
 *
 * Real integration shape (per Printful API v2 docs, as of this writing):
 *   POST https://api.printful.com/orders
 *   Authorization: Bearer <PRINTFUL_API_KEY>
 *   Body: {
 *     recipient: { name, address1, city, state_code, country_code, zip, ... },
 *     items: [
 *       { variant_id, quantity: 1, files: [{ url: <print-ready SVG/PNG URL> }] },
 *       { variant_id, quantity: 1, files: [{ url: <print-ready SVG/PNG URL> }] },
 *     ],
 *   }
 *
 * Printful's print-file upload expects a URL it can fetch (or a base64
 * payload for some endpoints) — not raw SVG text. `svgUrl` below is exactly
 * that: `GET /e/:slug/export.svg` (server.js), built from the app's own
 * public base URL (src/baseUrl.js) by the webhook handler
 * (src/routes/webhook.js) that calls this function. Whether Printful's
 * pipeline accepts SVG directly or needs a print-resolution raster (PNG)
 * instead is still unverified against a real sandbox — see README "Next
 * phase" — but the URL itself is now real, not a placeholder.
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
 * Artwork is deliberately omitted: for this curated mug, the chosen print
 * file does not alter fulfillment cost, and Printful cannot fetch a local
 * development URL. The immutable configuration still supplies the trusted
 * variant and quantity used here and later supplies the artwork at checkout.
 */
async function estimateOrderCosts({ variantId, quantity, recipient }) {
  const result = await printfulRequest('/orders/estimate-costs', {
    method: 'POST',
    body: JSON.stringify({
      shipping: 'STANDARD',
      recipient,
      items: [{ variant_id: variantId, quantity }],
    }),
  });
  if (!result?.costs || typeof result.costs.currency !== 'string') {
    throw new PrintfulApiError('PRINTFUL_INVALID_RESPONSE', 'Printful hat keinen gültigen Preis geliefert.', 502);
  }
  return result.costs;
}

/**
 * @param {object} opts
 * @param {object} opts.event - the event row (slug, couple_name, ...)
 * @param {string|null} opts.svgUrl - fetchable URL to the exported word-cloud
 *   SVG (GET /e/:slug/export.svg), or null if the event has no words yet
 * @param {object} opts.shipping - shipping address collected at Stripe Checkout
 * @param {string} opts.stripeSessionId - for idempotency / order tracing
 * @returns {Promise<{ printfulOrderId: string, mocked: boolean }>}
 */
async function createPrintfulOrder({ event, svgUrl, shipping, stripeSessionId }) {
  if (!isConfigured()) {
    const mockId = `MOCK-${stripeSessionId || Date.now()}`;
    console.log(
      `[printful:mock] Would create His & Hers mug-duo order ${mockId} for ` +
      `event "${event.slug}" (${event.couple_name}), shipping to ` +
      `${shipping && shipping.name ? shipping.name : '(no shipping info)'}, ` +
      `print file: ${svgUrl || '(no words submitted yet — no print file)'}. ` +
      `PRINTFUL_API_KEY not set — see README for what real integration needs.`
    );
    return { printfulOrderId: mockId, mocked: true };
  }

  // Legacy order-creation call. Live estimates are verified; this paid-order
  // path still needs to be adapted to the immutable configuration in the
  // Stripe phase before it is linked from the shipping page.
  const variantHis = process.env.PRINTFUL_MUG_VARIANT_ID_HIS;
  const variantHers = process.env.PRINTFUL_MUG_VARIANT_ID_HERS;
  const printFileUrl = svgUrl; // see file-level note above

  const body = {
    recipient: {
      name: shipping?.name,
      address1: shipping?.address?.line1,
      address2: shipping?.address?.line2 || undefined,
      city: shipping?.address?.city,
      zip: shipping?.address?.postal_code,
      country_code: shipping?.address?.country || 'DE',
    },
    items: [
      { variant_id: variantHis, quantity: 1, files: [{ url: printFileUrl }] },
      { variant_id: variantHers, quantity: 1, files: [{ url: printFileUrl }] },
    ],
    external_id: stripeSessionId,
  };

  const res = await fetch('https://api.printful.com/orders', {
    method: 'POST',
    headers: getPrintfulHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Printful order creation failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return { printfulOrderId: data?.result?.id ?? null, mocked: false };
}

module.exports = {
  PrintfulApiError,
  isConfigured,
  getShippingCountries,
  estimateOrderCosts,
  createPrintfulOrder,
};
