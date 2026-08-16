'use strict';

/**
 * Printful order creation for the His & Hers mug-duo.
 *
 * Called from the Stripe webhook handler once a `checkout.session.completed`
 * event confirms payment. Gated on PRINTFUL_API_KEY, which is NOT set in
 * this build pass (no Printful account exists yet). When the key is
 * missing, this function logs a clear mock-order message and returns a
 * fake order id instead of crashing the webhook handler — so the full
 * payment -> fulfillment data flow can be exercised end-to-end locally
 * (see test/checkout.test.js) without a live Printful sandbox.
 *
 * Required env vars once a real account exists (see .env.example):
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

  // Real call — untested against a live Printful sandbox (no account yet).
  // Shape follows Printful's Orders API; adjust field names against their
  // current docs before first real use.
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
    headers: {
      'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
      'Content-Type': 'application/json',
      ...(process.env.PRINTFUL_STORE_ID ? { 'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Printful order creation failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return { printfulOrderId: data?.result?.id ?? null, mocked: false };
}

module.exports = { isConfigured, createPrintfulOrder };
