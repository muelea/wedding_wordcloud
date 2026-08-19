# WeddingCloud

A live word cloud for weddings. Any couple creates their own event, guests
scan a QR code and submit a word from their phone (no account, no app), and
the word cloud grows in real time on a shared display. Free to use — the
commercial product being prepared is an optional order of 1–99 personalized
mugs printed from the finished word cloud after the event.

## How it works

1. Couple visits `/start`, enters their names, gets a unique event at
   `/e/<slug>` plus a 4-6 digit admin PIN.
2. `/e/<slug>/display` goes on the big screen / projector.
3. Guests open `/e/<slug>` on their phone (usually via QR code) and submit
   one word at a time.
4. Words appear live on the display via Socket.io — font size scales with
   how many guests submitted the same word.
5. After the event, the couple opens a product configurator, chooses any
   quantity from 1–99, a color palette and one of four print layouts
   (single, both sides, full wrap or optimized area), and approves an
   immutable mug print file with a transparent background. A locally served Three.js preview
   maps that exact artwork onto a rotatable mug using Printful's physical
   dimensions. The print area itself is a small Fabric.js editor: every word
   and every curated wedding motif can be moved, resized, rotated, recolored,
   duplicated or removed; words can also be edited directly. Hard bounds keep
   the entire design printable.
6. The approved configuration continues to a dedicated, mobile-first
   shipping-address page. Countries and state/province choices come directly
   from Printful; the server uses the immutable variant and quantity to fetch
   a live fulfillment, standard-shipping and provisional tax/VAT estimate in
   EUR. The normalized address and exact cent amounts are stored in an opaque,
   expiring quote; abandoned address quotes are automatically removed.
7. "Weiter zur Testzahlung" re-estimates the same trusted configuration and
   address immediately before creating a dynamic Stripe-hosted Checkout
   Session. A changed price must be confirmed again. Signed Stripe webhooks
   transition the order to `paid_test` exactly once and enqueue the persisted
   fulfillment snapshot. Test payments are then completed by the local `mock`
   worker without making any Printful order request; the confirmation page
   clearly states that no real fulfillment was created. Live payments and real
   Printful orders remain hard-disabled until the tax phase is signed off.

## Quick start

```bash
npm install
cp .env.example .env    # optional locally — see below
npm start                # or: npm run dev (auto-restarts on file change)
```

The server prints a URL on startup (your machine's LAN IP, so phones on the
same WiFi can reach it). Open it — `/` is the landing page, `/start` is
event creation.

Requires Node with built-in `node:sqlite` support (Node 22.5+ / 24+). You'll
see an `ExperimentalWarning: SQLite is an experimental feature` on startup —
expected, harmless.

## Environment variables

Everything in `.env.example` is documented inline. Summary:

| Variable | Required? | Purpose |
|---|---|---|
| `PORT` | no (defaults 3000) | server port |
| `PUBLIC_URL` | only in production | overrides auto-detected base URL used in QR codes / links |
| `ADMIN_TOKEN_SECRET` | **yes, in production** | signs the admin PIN session token — the default is intentionally insecure |
| `DB_PATH` | no | SQLite file location (defaults `./data/weddingcloud.sqlite`) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | only for test checkout | Stripe test secret and local/Dashboard webhook signing secret; unset → checkout/webhook return a clean 501 |
| `STRIPE_ALLOW_LIVE_PAYMENTS` | no (must remain `false`) | rejects live Stripe keys and live webhook events during this test-only phase |
| `CHECKOUT_QUOTE_TTL_MINUTES` | no (defaults 30) | lifetime of a saved address/price quote; accepted range 5–120 minutes |
| `PRINTFUL_API_KEY`, `PRINTFUL_STORE_ID` | for live quotes and later fulfillment | unset → quote returns a clear 501; direct order creation degrades safely to a mock |
| `PRINTFUL_FULFILLMENT_MODE` | no (defaults `mock`) | `mock`, `draft` or `live`; Stripe test payments ignore this and always remain mocked |
| `PRINTFUL_ALLOW_ORDER_WRITES` | no (must remain `false`) | second safety switch required before a live payment may create a Printful draft |
| `PRINTFUL_CONFIRM_LIVE_ORDERS` | no (must remain `false`) | third safety switch required before a draft may be confirmed, charged and submitted |
| `SHOP_TARGET_MARGIN_PERCENT` | no (defaults 45) | provisional catalog-wide target gross margin applied to Printful's current product costs |
| `SHOP_MIN_PROFIT_PER_ORDER_CENTS` | no (defaults 500) | minimum product contribution for the complete order, in cents (500 = 5,00 €) |

**Never commit `.env`** — it's gitignored. Production secrets (Render, or
wherever this is deployed) are set directly in the host's dashboard, not in
the repo.

## Provisional test pricing

The current checkout does not use a fixed price per mug. It calculates one
customer price from Printful's live EUR estimate and the two catalog-wide
settings above. All calculations use integer cents.

Let `C` be Printful's product cost for the complete quantity after any
Printful quantity discount, `m` the target margin (default `0.45`) and `D` the
minimum contribution per order (default `500` cents). The customer product
subtotal is:

```text
max(ceil(C / (1 - m)), C + D)
```

Printful's standard shipping and current provisional tax/VAT estimate are
then added separately:

```text
customer total = customer product subtotal + shipping + provisional tax/VAT
```

Example with 10,98 € Printful product costs: the 45% rule produces 19,97 €,
while the minimum-contribution rule produces 15,98 €. The product subtotal is
therefore 19,97 €, before shipping and provisional tax/VAT.

Because `C` is the actual product cost for the requested quantity, Printful
quantity discounts automatically lower the customer unit price; there are no
separate, manually maintained discount tiers. The 5,00 € floor currently
applies once to the complete order, not once per mug. The server repeats the
Printful estimate immediately before Stripe Checkout, and a changed total must
be confirmed again.

This is intentionally a test calculation. Printful's tax estimate is kept as
a separate line so it can be replaced with the business's reviewed customer
VAT/Stripe Tax treatment before live payments are enabled.

## Project layout

```
server.js                  Express + Socket.io bootstrap, route mounting
src/
  db.js                    SQLite schema + queries (events/words/orders/archives)
  slug.js                  German-aware slugify + unique random-suffix generation
  words.js                 Word normalization (trim/case-fold/emoji-strip)
  adminAuth.js             PIN → HMAC session token issue/verify
  baseUrl.js               LAN-IP / PUBLIC_URL resolution
  socket.js                Socket.io connection handling — room isolation lives here
  stripe.js                Stripe Checkout session creation + webhook verification
  printful.js              Printful estimates plus draft/confirm API primitives
  fulfillment.js           idempotent paid-order worker and mock/draft/live safety gates
  pricing.js               integer-cent quote + catalog-wide margin/minimum rule
  exportSvg.js             Server-side SVG render for the print pipeline (real font metrics via node-canvas)
  mugPrint.js              Printful-sized 2700x1050 mug print-file renderer
  products.js              Curated, API-verified Printful product geometry
  routes/
    events.js              Event CRUD, slug availability, QR, admin verify/reset, checkout
    webhook.js             POST /webhook/stripe (raw body, signature-verified)
public/
  landing.html             Marketing landing page, served at '/'
  create.html              Event creation form, served at '/start'
  guest.html               Guest word-submission page, served at '/e/:slug'
  display.html             Live display + SVG export + mug CTA, served at '/e/:slug/display'
  configure.html           Mug configurator + interactive 3D preview, served at '/e/:slug/configure'
  shipping.html            Mobile-first address + live Printful price estimate
  order-confirmation.html  Polling confirmation page for signed test payments
  js/mug-editor.js         Bounded word-by-word print-area editor
  404.html                 Unknown-event page
  js/wordcloud-core.js     Shared layout/export engine (used by both the browser and Node tests)
test/                      node:test suite — see "Testing" below
```

## Testing

```bash
npm test
```

Runs `node --test test/*.test.js` — 47 tests covering multi-tenant
isolation, word submission/live-update, SVG layout/export correctness, the
print-file export endpoint, immutable product configurations, event
creation/slug/admin-PIN flow, expiring quotes, dynamic Stripe Checkout,
price-change confirmation, webhook idempotency, immutable fulfillment
payloads, live safety gates and Stripe/Printful stub behavior. Each test
file uses its own scratch SQLite file and ephemeral port, so it's safe to run
repeatedly / in parallel.

**The most important test is `test/isolation.test.js`** — it proves two
concurrent events never leak words or theme changes into each other's
Socket.io room. Any change to `src/socket.js` should keep this green.

## Deployment notes

- Deployed via GitHub → Render (`muelea/wedding_wordcloud`, `main` branch).
  Push to `main` to ship.
- Set `ADMIN_TOKEN_SECRET` and (once real accounts exist) the Stripe/Printful
  vars directly in Render's environment settings — they are not in the repo.
- `data/*.sqlite*` needs a persistent volume on Render (or a migration to
  managed Postgres) — otherwise the database resets on every redeploy.
- `node-canvas` (used for the print-file export) ships prebuilt binaries for
  glibc Linux; if the host image is Alpine (musl), install will fall back to
  a slow source build requiring `cairo`/`pango`/`libjpeg`/`giflib` headers.
- `"Georgia"` (the app's serif font) is unlikely to be installed on a bare
  Linux host — `node-canvas` will silently fall back to a generic serif for
  the printed mug artwork unless a metric-compatible font (e.g. Google's
  "Gelasio") is bundled and registered via `canvas.registerFont()` at
  startup. Worth verifying before the first real mug order ships.

## Test checkout setup

The hosted Checkout page needs only Stripe's secret test key. There is no
static Stripe Product/Price and no browser-side publishable key in this flow.

1. Put `sk_test_...` into `STRIPE_SECRET_KEY` in `.env`.
2. Install/login to the Stripe CLI once (`brew install stripe/stripe-cli/stripe`,
   then `stripe login`).
3. In a second terminal run `./run_stripe_webhook.sh`. Copy the printed
   `whsec_...` into `STRIPE_WEBHOOK_SECRET` in `.env` and restart the app.
4. Start WeddingCloud with `./run_local.sh` and complete Checkout with a
   Stripe test card such as `4242 4242 4242 4242`, any future expiry date and
   any three-digit CVC.

The success page polls the local order record until the signed webhook has
marked it `paid_test`. Replaying the same webhook or double-clicking the
Checkout button is safe. The durable fulfillment worker records a local
`mocked` result and the exact payload it would use later, but no code path in
this test flow calls Printful's order endpoints — even if all Printful live
switches were accidentally enabled.

## Fulfillment safety modes

The payment state and fulfillment state are stored separately. A successful
payment atomically queues one immutable fulfillment snapshot; a conditional
database claim makes retries, duplicate Stripe events and server restarts
idempotent. A stable `external_id` derived from the internal order and opaque
quote ids gives the same purchase one identity at Printful as an additional
duplicate guard.

| Stripe payment | Requested Printful mode | Result |
|---|---|---|
| test | any | local `mock`; zero Printful order requests |
| live | `mock` | local `mock`; zero Printful order requests |
| live | `draft` + order-write switch | unconfirmed Printful draft |
| live | `live` + both write/confirm switches | draft creation followed by explicit confirmation |

Draft and live writes additionally require `STRIPE_ALLOW_LIVE_PAYMENTS=true`,
`PRINTFUL_ALLOW_ORDER_WRITES=true`, a configured token, and a public HTTPS
`PUBLIC_URL`. `live` also requires `PRINTFUL_CONFIRM_LIVE_ORDERS=true`.
Printful charges the account and starts fulfillment only when the separately
created draft is confirmed. Keep every switch false while developing locally.

## What's intentionally disabled

- **Live Stripe payments** — `sk_live_...` keys and live webhook events are
  rejected while `STRIPE_ALLOW_LIVE_PAYMENTS=false`.
- **Real Printful fulfillment after test payments** — live countries and
  estimates are connected for catalog product 19 / variant 1320, but a
  successful test payment can only produce a local `mocked` fulfillment
  record. Draft/live writes require a live Stripe payment plus the explicit
  safety switches described above.
- **Final retail VAT calculation** — the quote schema already separates
  products, shipping and tax cents, but the current test display uses
  Printful's estimate. Customer VAT/Stripe Tax must be finalized before live
  mode is enabled.

## Known gotchas

- **Don't make the admin PIN fields `type="password"`.** Two adjacent
  password-type fields (`#pin`, `#pin-confirm` in `create.html`) make
  Safari/Chrome treat the form as an account signup and offer to
  autofill/generate a strong password — which then fails the PIN's
  `pattern="[0-9]*"` validation and silently refocuses the field, looking
  like the button is broken. They're deliberately `type="tel"` with
  `autocomplete="off"` and CSS-only dot-masking (`-webkit-text-security`)
  instead. Don't "fix" this back to `type="password"`.
- **Never use `io.emit(...)` or a bare `socket.emit(...)` broadcast in
  `src/socket.js`.** Every event must join a room keyed by its slug first;
  every emit must be `io.to(slug).emit(...)` / `socket.to(slug).emit(...)`.
  A bare global emit leaks one couple's words into every other couple's
  display. `test/isolation.test.js` catches this — don't disable it to make
  a change pass.

## Next steps

1. Decide the business's VAT status, customer-price tax behavior, EU/OSS
   registrations and bookkeeping export; then replace the provisional tax
   line with the reviewed Stripe Tax configuration.
2. Confirm whether Printful's mug print pipeline accepts the generated SVG
   directly or needs a rasterized PNG (`node-canvas`'s `toBuffer('image/png')`
   is already available if so).
3. Once a public HTTPS deployment exists, deliberately enable `draft` mode
   for one controlled live-payment test, verify Printful can download the
   immutable file and inspect the unconfirmed draft in the dashboard.
4. Configure signed Printful v2 webhooks for production/shipment status once
   the public callback URL exists; do not register a callback before its
   signing secret can be stored in the production environment.
5. Move `data/*.sqlite` to a persistent volume, or migrate to Postgres
   (schema is plain SQL, written to make that swap easy).
6. Rate-limiting — no per-IP throttle yet on word submission or event
   creation.
