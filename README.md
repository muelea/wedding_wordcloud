# WeddingCloud

A live word cloud for weddings. Any couple creates their own event, guests
scan a QR code and submit a word from their phone (no account, no app), and
the word cloud grows in real time on a shared display. Free to use — the
commercial product being prepared is an optional order of 1–99 personalized
white mugs, cork-backed coasters, matte or framed posters, tote bags, throw
blankets, spiral notebooks and decorative pillows, printed from the finished
word cloud after the event. Guests can also
start a completely separate personal-memory design during the celebration,
add their own photos, words and motifs, and purchase it independently.

## How it works

1. Couple visits `/start`, enters their names, gets a unique event at
   `/e/<slug>` plus a 4-6 digit admin PIN.
2. `/e/<slug>/display` goes on the big screen / projector.
3. Guests open `/e/<slug>` on their phone (usually via QR code) and submit
   one word at a time. Their anonymous browser session can remove its own
   contributions again; matching words are decremented rather than deleting
   another guest's vote.
4. Words appear live on the display via Socket.io — font size scales with
   how many guests submitted the same word.
5. From the guest page, any attendee can open the personal-memory flow. It
   starts with an empty product design, locally reduces selected photos before upload,
   and keeps that opaque design separate from the shared wedding word cloud. It uses
   the same products, placements and editing tools as the shared-cloud configurator;
   only the initial canvas content differs.
   A guest can add up to six photos plus personal words and motifs, then use
   the normal address, quote and checkout flow for their own order.
6. After the event, the couple opens a product configurator, chooses a white
   mug, cork-backed coaster, matte or framed poster, tote bag, throw blanket
   spiral notebook or decorative pillow from grouped product families, any
   color palette and a product-specific print layout, and approves an
   immutable Printful-sized file with a transparent background. Each approved
   design is added to the local order basket, so the customer can design a mug,
   a coaster, another mug size, etc. before moving to delivery. Basket designs
   can be opened again for inspection or edits; saving an opened design creates
   a new immutable configuration and replaces the previous basket entry.
   Local illustrated thumbnails make the catalog scannable. A locally served
   Three.js preview maps mug artwork onto a rotatable model; flat products use
   the same design in a proportional print preview. Products with two printable
   faces expose separate front/back editors plus a copy-to-back shortcut and
   store one immutable print file per side. The print area itself is a small
   Fabric.js editor: every word
   and every curated wedding motif can be moved, resized, rotated, recolored,
   duplicated or removed. A selection rectangle, Shift/Command/Control-click and
   “Select all” support the familiar temporary multi-selection workflow; desktop
   users can also copy and paste selected elements with the standard keyboard
   shortcuts. Placement changes transform the complete
   current canvas instead of regenerating it from the original event words. Words
   can also be edited directly. Hard bounds keep
   the entire design printable.
7. The saved designs continue to a dedicated, mobile-first shipping-address
   page. There the customer chooses the quantity of each design per delivery
   address. Countries and state/province choices come directly from Printful;
   the server sends one Printful estimate per recipient address containing all
   positive-quantity items for that address, so Printful can apply its mixed
   product shipping rules. Customer tax/VAT is recalculated on the
   customer-facing product subtotal plus shipping, using the destination rate
   implied by Printful's estimate. The normalized address and exact cent
   amounts are stored in an opaque, expiring quote; abandoned address quotes
   are automatically removed.
8. "Weiter zur Testzahlung" re-estimates the same trusted design basket and
   address split immediately before creating a dynamic Stripe-hosted Checkout
   Session. A changed price must be confirmed again. Signed Stripe webhooks
   transition the order to `paid_test` exactly once and enqueue the persisted
   fulfillment snapshot. Test payments are then completed by the local `mock`
   worker without making any Printful order request; the confirmation page
   clearly states that no real fulfillment was created. Live payments and real
   Printful orders remain hard-disabled until the tax phase is signed off.

## Current development status

- The full product currently runs locally with SQLite. There is no active
  public production deployment.
- Stripe Checkout and signed Stripe webhooks run in test mode. Printful is
  already used for countries and live cost estimates when configured, but a
  Stripe test payment can only create a local `mocked` fulfillment record.
- Fly.io staging with a temporary `*.fly.dev` HTTPS address and one persistent
  SQLite volume is the next discussed hosting step, but no Fly configuration
  exists in the repository yet.
- Supabase/Postgres is a possible later database migration before live
  operation. The current data layer remains deliberately synchronous
  `node:sqlite`; adding Supabase credentials alone would not switch it.
- Customer VAT/Stripe Tax treatment, public hosting details, retention rules,
  signed Printful status webhooks and the first controlled Printful draft are
  intentionally still pending before live sales.

## Guest ownership and personal photo designs

Every guest contribution gets an unguessable receipt tied to the event and an
anonymous browser-session id. Removing a contribution requires all three, so a
guest can decrement only a word that this same browser session submitted. The
API deliberately gives the same `not_found` response for an unknown receipt
and another guest's receipt.

The personal-memory configurator is a separate configuration type. It always
starts empty, never imports words from the shared wedding cloud and requires
its own non-empty design. Before transmission, the browser accepts source
files up to 20 MiB, applies image orientation, scales the longest side to at
most 1600 px and encodes the result as JPEG at quality `0.84`. The server then
validates actual JPEG/PNG/WebP signatures and enforces at most six photos and
at most 6 MiB decoded image data across the complete design.

Photos are stored as data URLs inside the immutable configuration's
`design_json`; there is no separate public upload directory. Consequently the
SQLite database contains the personal photos and needs the same persistence,
backup, access-control and future deletion treatment as order data. The
configuration-specific print route is addressed only by its opaque random id.

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
| `SHOP_PRODUCT_MARKUP_PERCENT` | no (defaults 50) | provisional catalog-wide markup added to Printful's current product costs |
| `SHOP_PAYMENT_RESERVE_PERCENT` | no (defaults 3.15) | internal payment-cost reserve percentage folded into the product subtotal |
| `SHOP_PAYMENT_RESERVE_FIXED_CENTS` | no (defaults 25) | internal fixed payment-cost reserve in cents, also folded into the product subtotal |

**Never commit `.env`** — it's gitignored. Local credentials stay in `.env`;
future hosted secrets must be set in the provider's encrypted secret store,
not copied into the repository or a deployment manifest.

## Provisional test pricing

The current checkout does not use a fixed price per product. It calculates one
customer price from Printful's live EUR estimate(s) and the catalog-wide markup
setting above. For multiple delivery addresses, each address is estimated as
one Printful shipment containing all products assigned to that address. All
calculations use integer cents.

Let `C` be Printful's product cost for the complete order after any Printful
quantity or mixed-order discount, `u` the markup (default `0.50`) and `R` the
internal payment-cost reserve. The customer product subtotal is:

```text
ceil(C * (1 + u)) + R
```

Printful's standard shipping is added separately. Customer tax/VAT is then
calculated on the marked-up product subtotal plus shipping, using the
destination rate implied by Printful's product+shipping tax estimate:

```text
customer tax = round((customer product subtotal + shipping) * destination tax rate)
customer total = customer product subtotal + shipping + customer tax
```

The payment reserve is folded into the product subtotal, not displayed as a
separate card/payment surcharge. By default it is grossed up from a
conservative `3.15% + 0,25 €` estimate so the expected Stripe processing cost
does not reduce the intended product-margin profit.

Example with 10,98 € Printful product costs, 6,24 € shipping and 19% German
VAT: the 50% rule produces a 16,47 € marked-up product subtotal, the internal
payment reserve is 1,15 €, customer VAT is 4,53 € and the customer total is
28,39 €.

Because `C` is the actual product cost for the requested quantity, Printful
quantity discounts automatically lower the customer unit price; there are no
separate, manually maintained discount tiers. The server repeats the Printful
estimate immediately before Stripe Checkout, and a changed total must be
confirmed again.

This is intentionally a test calculation. The tax line is customer-facing now,
but the business's VAT status, OSS obligations and Stripe Tax configuration
still need professional review before live payments are enabled.

## Project layout

```
server.js                  Express + Socket.io bootstrap, route mounting
src/
  db.js                    SQLite schema + queries (events/contributions/configurations/quotes/orders)
  slug.js                  German-aware slugify + unique random-suffix generation
  words.js                 Word normalization (trim/case-fold/emoji-strip)
  adminAuth.js             PIN → HMAC session token issue/verify
  baseUrl.js               LAN-IP / PUBLIC_URL resolution
  socket.js                Socket.io connection handling — room isolation lives here
  stripe.js                Stripe Checkout session creation + webhook verification
  printful.js              Printful estimates plus draft/confirm API primitives
  fulfillment.js           idempotent paid-order worker and mock/draft/live safety gates
  pricing.js               integer-cent quote + catalog-wide markup rule
  exportSvg.js             Server-side SVG render for the print pipeline (real font metrics via node-canvas)
  mugPrint.js              Product-sized SVG print-file renderer
  products.js              Curated, API-verified Printful variants and geometry
  routes/
    events.js              Event/configuration CRUD, personal photos, pricing and checkout
    webhook.js             POST /webhook/stripe (raw body, signature-verified)
public/
  landing.html             Marketing landing page, served at '/'
  create.html              Event creation form, served at '/start'
  guest.html               Guest word-submission + personal-memory entry page
  display.html             Live display + SVG export + mug CTA, served at '/e/:slug/display'
  configure.html           Shared/personal product configurator with photo editor + 3D/flat previews
  shipping.html            Mobile-first address + live Printful price estimate
  order-confirmation.html  Polling confirmation page for signed test payments
  impressum.html           Current legal notice
  datenschutz.html         Current local-development privacy disclosure
  js/mug-3d-viewer.js      Shared rotatable Three.js mug preview
  js/mug-editor.js         Bounded, dynamically scaled text/motif/photo print-area editor
  js/mug-icons.js          Curated code-native wedding motif library
  404.html                 Unknown-event page
  js/wordcloud-core.js     Shared layout/export engine (used by both the browser and Node tests)
test/                      node:test suite — see "Testing" below
```

## Testing

```bash
npm test
```

Runs `node --test test/*.test.js` — 54 tests covering multi-tenant
isolation, personal photo-design separation, word submission/live-update, SVG layout/export correctness, the
print-file export endpoint, immutable product configurations, event
creation/slug/admin-PIN flow, expiring quotes, multi-product address quotes,
dynamic Stripe Checkout, price-change confirmation, webhook idempotency, immutable fulfillment
payloads, live safety gates and Stripe/Printful stub behavior. Each test
file uses its own scratch SQLite file and ephemeral port, so it's safe to run
repeatedly / in parallel.

**The most important test is `test/isolation.test.js`** — it proves two
concurrent events never leak words or theme changes into each other's
Socket.io room. Any change to `src/socket.js` should keep this green.

## Deployment notes

- Repository: GitHub `muelea/wedding_wordcloud`, `main`. The app is currently
  local-only; pushing `main` does not represent an approved production deploy.
- The next discussed staging target is Fly.io in an EU region, using one
  Machine and a persistent volume mounted at `/data` with
  `DB_PATH=/data/weddingcloud.sqlite`. This has not been scaffolded yet.
- Fly Volumes are local to one Machine, so the SQLite staging setup must not be
  scaled horizontally. A later managed Supabase/Postgres migration is a
  separate code change because the current DB API is synchronous.
- `PUBLIC_URL` will initially use the Fly-provided HTTPS hostname. A later
  custom IONOS domain changes DNS and `PUBLIC_URL`, not the application flow.
- Hosted credentials (`ADMIN_TOKEN_SECRET`, Stripe and Printful) belong in Fly
  secrets or the eventual host's equivalent. Keep every live-payment and
  Printful order-write switch disabled in staging.
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
  estimates are connected for the curated mug variants 1320, 4830 and 16586,
  coaster variant 15662, unframed poster variants 8948 and 8952, framed
  poster variants 9357 and 9358, tote variant 4533, throw blanket variant
  10986, spiral notebook variant 12141 and decorative pillow variant 4532,
  but a
  successful test payment can only produce a local `mocked` fulfillment
  record. Draft/live writes require a live Stripe payment plus the explicit
  safety switches described above.
- **Final retail VAT configuration** — the quote schema separates products,
  internal reserve, shipping and customer tax cents, and the current test
  display recalculates customer tax from the destination rate implied by
  Printful's estimate. Customer VAT/Stripe Tax must still be professionally
  reviewed before live mode is enabled.

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

1. Verify the separate front/back SVG URLs in one controlled Printful draft
   and inspect the resulting notebook and pillow mockups before enabling sales.
2. Create the Fly.io staging app, persistent SQLite volume and hosted test
   secrets; then verify the complete Stripe test flow over public HTTPS.
3. Decide the business's VAT status, EU/OSS registrations and bookkeeping
   export; then verify or replace the current customer-tax estimate with the
   reviewed Stripe Tax configuration.
4. Confirm whether Printful's product print pipeline accepts the generated SVG
   directly or needs a rasterized PNG (`node-canvas`'s `toBuffer('image/png')`
   is already available if so).
5. Once a public HTTPS deployment exists, deliberately enable `draft` mode
   for one controlled live-payment test, verify Printful can download the
   immutable file and inspect the unconfirmed draft in the dashboard.
6. Configure signed Printful v2 webhooks for production/shipment status once
   the public callback URL exists; do not register a callback before its
   signing secret can be stored in the production environment.
7. Before live operation, decide whether to keep a single persistent SQLite
   instance or migrate the synchronous data layer to Supabase/Postgres.
8. Define and implement retention/deletion for events, immutable designs,
   embedded personal photos, addresses and completed orders.
9. Rate-limiting — no per-IP throttle yet on word submission or event
   creation.
