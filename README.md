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
   the same products, arrangement actions and editing tools as the shared-cloud configurator;
   only the initial canvas content differs.
   A guest can add up to six photos plus personal words and motifs, then use
   the normal address, quote and checkout flow for their own order.
6. After the event, the couple opens a product configurator, chooses a white
   mug, cork-backed coaster, matte or framed poster, tote bag, throw blanket
   spiral notebook or decorative pillow from grouped product families, any
   color palette and product-specific arrangement actions, and approves an
   immutable Printful-sized file with a transparent background. Each approved
   design is added to the local order basket automatically when the customer
   chooses another product or continues to the shipping address, so the
   customer can design a mug, a coaster, another mug size, etc. before moving
   to delivery. Basket designs can be opened again for inspection or edits;
   either onward action, opening another basket design or returning to the
   word cloud saves the current state as a new immutable configuration and
   replaces the previous basket entry.
   Local illustrated thumbnails make the catalog scannable. A locally served
   Three.js preview maps mug artwork onto a rotatable model; flat products use
   the same design in a proportional print preview. Posters can be designed in
   portrait or landscape format; switching orientation preserves the current
   design, swaps the immutable print-file dimensions and keeps the same Printful
   variant and price basis. Products with two printable
   faces expose separate front/back editors plus a copy-to-back shortcut and
   store one immutable print file per side. The print area itself is a small
   Fabric.js editor: every word
   and every curated wedding motif can be moved, resized, rotated, recolored,
   duplicated or removed. A selection rectangle, Shift/Command/Control-click and
   “Select all” support the familiar temporary multi-selection workflow; desktop
   users can also copy and paste selected elements with the standard keyboard
   shortcuts. Text elements can use the classic default or one of four curated,
   locally bundled print fonts; a font change also works across a mixed
   multi-selection and affects only its text elements. Arrangement actions always transform the
   complete current canvas and can be applied repeatedly; they are commands, not a persisted
   selection. The immutable canvas design is the only source for preview and Printful output. Words
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

## Languages

Wolkenworte supports German, English, French, Italian, Spanish and Turkish.
The language chosen when an event is created is stored on the event and is
used by default on its guest, display, configurator, shipping and confirmation
pages. Every page also exposes a language selector; a visitor's explicit
choice is stored locally in that browser and takes precedence over the event
default. A `?lang=de|en|fr|it|es|tr` query parameter provides the same explicit
override for shared or test links.

German source copy is the canonical message id, the English catalog is the
runtime fallback, and each additional locale lives in `public/locales/`.
Fixed interface copy, metadata, accessibility labels, browser dialogs,
product descriptions, editor feedback, quantities, money, country names and
Stripe Checkout all use the active locale. `Wolkenworte`, couple names, guest
word submissions and text or photos deliberately added to a personal design
are never translated. Word normalization is locale-aware, including Turkish
dotted and dotless I.

## Current development status

- The full product now runs on Postgres. Versioned migrations and a dedicated
  least-privileged runtime role are configured in the Supabase project.
- The hosted test environment is active at `https://wolkenworte.fly.dev` on
  one stateless Fly Machine in Frankfurt. It scales to zero while idle and
  reconnects to durable Supabase Postgres on cold start. This is not yet the
  public production launch or custom domain.
- Stripe Checkout and signed Stripe webhooks run in test mode. Printful is
  already used for countries and live cost estimates when configured, but a
  Stripe test payment can only create a local `mocked` fulfillment record.
- The production container, readiness/liveness checks, cache rules, graceful
  shutdown, Fly configuration and manual deployment workflow are in the repository.
- Personal photos are normalized by the server and stored once in a private
  Supabase Storage bucket. Immutable configurations contain only opaque asset
  IDs; editable responses use short-lived signed previews and print SVGs
  materialize verified private bytes on demand.
- The application data layer is fully asynchronous through one bounded `pg`
  pool. Application startup checks the required migration version and never
  creates or alters schema objects.
- Event/configuration expiration, safe paid-data retention, one-use reset PINs
  and the complete initial abuse-control boundary are implemented. Customer
  VAT/Stripe Tax treatment, scheduled maintenance/job leasing,
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

The reduced browser image is uploaded once to the backend. The server verifies
its real JPEG/PNG/WebP signature, fully decodes it with bounded dimensions and
pixels, strips metadata, normalizes it, and writes it to the private
`wolkenworte-private` Supabase Storage bucket. Postgres stores only the opaque
asset id, checksum, byte size, state and configuration references—never the
image bytes or a permanent object URL. Revisions reuse the same object.

Editable configurations receive a fresh 15-minute signed preview URL. The
configuration-specific print route verifies and embeds the private bytes on
demand and uses `private, no-store`; its opaque random configuration id remains
the public handle. Failed upload/deletion transitions retain a retryable object
key instead of silently orphaning Storage bytes. Phase 4 provides race-safe,
object-first cleanup primitives: paid configurations/assets detach from expired
events, while a failed object deletion retains its key for retry. Phase 5 adds
the authenticated scheduled maintenance runner that invokes these primitives.

## Bundled design fonts

The product editor ships the OFL-licensed Gelasio font as its deterministic
`Wolkenworte Classic` serif plus Lora, Montserrat, Caveat and Baloo 2. Browser
preview, local rendering and the Linux container register the same files, and
used fonts are embedded directly into immutable print SVGs. Rendering therefore
does not depend on Georgia or another host font being installed. The existing
design-font `OFL.txt` files live next to their binaries; Gelasio's license ships
with its pinned `@fontsource/gelasio` package.

## Quick start

```bash
npm install
cp .env.example .env
supabase start
supabase db reset
# Put the local admin connection in MIGRATION_DATABASE_URL, then:
npm run db:provision-runtime
npm start                # or: npm run dev (auto-restarts on file change)
```

The server prints a URL on startup (your machine's LAN IP, so phones on the
same WiFi can reach it). Open it — `/` is the landing page, `/start` is
event creation.

Requires Node 22+ and the Supabase CLI/Docker stack for local database work.
`npm test` uses `MIGRATION_DATABASE_URL` (or `TEST_DATABASE_URL`) to create one
isolated Postgres schema per test server and removes it afterward.

For a clean hosted project, run `npm run db:migrate` with only the privileged
`MIGRATION_DATABASE_URL`, then `npm run db:provision-runtime` once. The second
command generates the `wolkenworte_app` password, proves the role cannot create
tables, verifies schema access and writes its `DATABASE_URL` to the ignored
local `.env`. Never put `MIGRATION_DATABASE_URL` in Fly Secrets.

## Environment variables

Everything in `.env.example` is documented inline. Summary:

| Variable | Required? | Purpose |
|---|---|---|
| `PORT` | no (defaults 3000) | server port |
| `PUBLIC_URL` | only in production | overrides auto-detected base URL used in QR codes / links |
| `DATABASE_URL` | yes | least-privileged Postgres runtime connection; the hosted value belongs in Fly Secrets |
| `DATABASE_CA_CERT_PATH` / `DATABASE_CA_CERT` | hosted database | Supabase database CA path or PEM contents used for full TLS and hostname verification |
| `MIGRATION_DATABASE_URL` | deployment only | privileged Postgres migration connection; local/CI secret only and never available to the Fly web Machine |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | hosted runtime | active private Storage API URL and backend-only secret key; the secret key never reaches browser code |
| `SUPABASE_STORAGE_BUCKET` | hosted runtime | private photo/print-artifact bucket name (currently `wolkenworte-private`) |
| `RATE_LIMIT_HMAC_SECRET`, `MAINTENANCE_SECRET` | hosted environment | independent secrets for privacy-preserving rate-limit identities and authenticated maintenance wake-ups |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | before transactional-email smoke test | backend-only sending key and verified Wolkenworte sender |
| `RESEND_WEBHOOK_SECRET` | after the Resend webhook is deployed | verifies signed Resend delivery webhooks |
| `EMAIL_DELIVERY_MODE` | no (defaults `mock`) | `mock` or `live`; Stripe test payments always remain mocked |
| `ALLOW_TEST_DATA_RESET` | no (must remain `false`) | second guard for the approved one-time pre-live hosted-test cleanup |
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

Postgres and Supabase Storage variables are active now. Resend variables remain
prepared for their later work package and are unused by the runtime today.

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
Dockerfile                 Non-root Debian/Node 22 production image
fly.toml                   Frankfurt hosted-test lifecycle and health config
.github/workflows/         Manual test → migrate → deploy → smoke workflow
scripts/hosted-smoke.js    Sanitized HTTPS/Postgres/Socket.io hosted smoke
src/
  db.js                    async Postgres data boundary and transaction logic
  dbConfig.js              verified-TLS and bounded pg pool configuration
  designAssets.js          bounded image normalization + private asset lifecycle
  privateStorage.js        backend-only Supabase Storage boundary
  lifecycle.js             expired-event cleanup + paid-data detachment
  clientIdentity.js        trusted normalized/HMAC source identity
  rateLimits.js            bounded one-Machine HTTP/Socket.io rate windows
  asyncRoute.js            rejected-promise boundary for Express routes
  slug.js                  German-aware slugify + unique random-suffix generation
  words.js                 Word normalization (trim/case-fold/emoji-strip)
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
  js/mug-icons.js          Curated editorial fine-line wedding motif library
  404.html                 Unknown-event page
  js/wordcloud-core.js     Shared layout/export engine (used by both the browser and Node tests)
test/                      node:test suite — see "Testing" below
```

## Testing

```bash
npm test
```

Runs `node --test test/*.test.js` — 97 tests covering multi-tenant
isolation, personal photo-design separation, word submission/live-update, SVG layout/export correctness, the
print-file export endpoint, immutable product configurations, event
creation/slug/admin-PIN flow, expiring quotes, multi-product address quotes,
dynamic Stripe Checkout, price-change confirmation, webhook idempotency, immutable fulfillment
payloads, private Storage normalization/deduplication/deletion recovery,
expiration privacy, safe paid-data retention, one-use async PIN reset and
database/process abuse ceilings,
hosting health/cache/shutdown behavior, live safety gates and
Stripe/Printful stub behavior. Each test
server uses its own randomly named migrated Postgres schema and ephemeral port,
then drops the schema in cleanup, so files remain isolated in parallel.

**The most important test is `test/isolation.test.js`** — it proves two
concurrent events never leak words or theme changes into each other's
Socket.io room. Any change to `src/socket.js` should keep this green.

## Deployment notes

- Repository: GitHub `muelea/wedding_wordcloud`, `main`. Deployments remain
  explicit; pushing `main` does not deploy automatically. The committed GitHub
  workflow is manual-only (`workflow_dispatch`).
- The hosted test app is `wolkenworte` in Fly's `fra` region with one
  `shared-cpu-1x`/512 MiB stateless web Machine, no volume, automatic stop/start
  and `https://wolkenworte.fly.dev`. Durable business data is in Supabase.
- Fly receives only the least-privileged `DATABASE_URL`. Migrations run first
  from local/CI tooling with `MIGRATION_DATABASE_URL`, which must never be
  available to an ordinary web Machine.
- `npm run fly:secrets` validates and stages the runtime-secret allowlist from
  the ignored `.env`; it converts the trusted database CA to an inline Fly
  secret and deliberately excludes `MIGRATION_DATABASE_URL`.
- The release order is `npm test`, production image build, strict Fly config
  validation, `npm run db:migrate`, `flyctl deploy --remote-only --ha=false`,
  and `npm run smoke:hosted -- https://wolkenworte.fly.dev`. The manual GitHub
  workflow encodes this same fail-fast order.
- Before that GitHub workflow is first used, its protected `hosted-test`
  environment needs `MIGRATION_DATABASE_URL`, `DATABASE_CA_CERT` and a scoped
  `FLY_API_TOKEN`. These deployment-runner credentials are not Fly app secrets.
- `PUBLIC_URL` currently uses the Fly-provided HTTPS hostname. A later
  custom IONOS domain changes DNS and `PUBLIC_URL`, not the application flow.
- Hosted credentials (Stripe, Printful and the HMAC/maintenance secrets) belong in Fly
  secrets or the eventual host's equivalent. Keep every live-payment and
  Printful order-write switch disabled in staging.
- The Debian/glibc image installs only the runtime libraries needed by
  `node-canvas`, runs as the non-root `node` user under `tini -s`, and bundles
  and registers Gelasio as `Wolkenworte Classic`. Local and AMD64 container
  font-metric probes are part of the Phase 2 verification record.
- `/health/live` is process-only. `/health/ready` performs a bounded Postgres
  and schema/role check and is the Fly service health check. Both are `no-store`.
- The Supabase bucket is private and limited to the three normalized image MIME
  types and 6 MiB objects. Fly holds the backend-only Storage key; browser
  previews are signed for 15 minutes and immutable designs store no signed URL.

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

1. Implement deterministic paid print artifacts, leased durable jobs and the
   authenticated bounded maintenance endpoint/schedule (Phase 5).
2. Register the separate hosted Stripe test webhook in Stripe Dashboard and
   verify the complete test Checkout flow over the Fly HTTPS address.
3. Verify the separate front/back SVG URLs in one controlled Printful draft
   and inspect the resulting notebook and pillow mockups before enabling sales.
4. Decide the business's VAT status, EU/OSS registrations and bookkeeping
   export; then verify or replace the current customer-tax estimate with the
   reviewed Stripe Tax configuration.
5. Confirm whether Printful's product print pipeline accepts the generated SVG
   directly or needs a rasterized PNG (`node-canvas`'s `toBuffer('image/png')`
   is already available if so).
6. Deliberately enable `draft` mode only for one controlled live-payment test,
   verify Printful can download the immutable file and inspect the unconfirmed
   draft in the dashboard.
7. Configure signed Printful v2 webhooks for production/shipment status once
   the public callback URL exists; do not register a callback before its
   signing secret can be stored in the production environment.
8. Complete the scheduled invocation and monitoring for the implemented
   event/configuration cleanup primitives as part of Phase 5 maintenance.
