# Wolkenworte

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
   Printful orders remain hard-disabled until the tax review is signed off.

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
- The hosted test environment is active at `https://wolkenworte.io` on one
  stateless Fly Machine in Frankfurt. `https://www.wolkenworte.io` redirects to
  that canonical apex origin. The Machine scales to zero while idle and
  reconnects to durable Supabase Postgres on cold start; this is still the
  hosted test environment, not the live-sales launch.
- Stripe Checkout and the registered Fly webhook destination run in Stripe's
  sandbox. A real hosted test Checkout has been verified through signed Stripe
  delivery, durable `paid_test` storage, mock email and mock fulfillment.
  Printful is already used for countries and live cost estimates when
  configured, but a Stripe test payment can only create a local `mocked`
  fulfillment record.
  Paid live-mode work uses frozen private print artifacts and a
  single-concurrency, Postgres-leased worker that reconciles the same
  deterministic external ID before any provider retry write.
- The production container, readiness/liveness checks, cache rules, graceful
  shutdown, Fly configuration and guarded local deployment command are in the repository.
- Socket.io room updates are transaction-after-commit and coalesced per event
  into complete snapshots at most once per 100 milliseconds. Initial room and
  private receipt hydration deduplicate connection storms without caching
  stale or cross-owner state. A guarded hosted capacity runner records
  application, transport, Postgres and Fly metrics against explicit gates.
- Personal photos are normalized by the server and stored once in a private
  Supabase Storage bucket. Immutable configurations contain only opaque asset
  IDs; editable responses use short-lived signed previews and print SVGs
  materialize verified private bytes on demand.
- The application data layer is fully asynchronous through one bounded `pg`
  pool. Application startup checks the required migration version and never
  creates or alters schema objects.
- Event/configuration expiration, safe paid-data retention, one-use reset PINs,
  abuse controls, bounded authenticated maintenance, Supabase Cron wake-ups,
  leased fulfillment and signed replay-safe Printful status webhooks are
  implemented. Verified Stripe buyer contact, immutable multilingual order
  confirmations, leased Resend jobs, shipment/refund/cancellation notices and
  signed replay-safe Resend delivery webhooks are also implemented. Customer
  VAT/Stripe Tax treatment, legal review of the versioned contractual copy,
  enabling Resend live delivery and the first explicitly approved controlled
  Printful draft remain pending before live sales.

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
key instead of silently orphaning Storage bytes. The authenticated 15-second
maintenance runner invokes the race-safe, object-first cleanup primitives in
bounded batches. Supabase Cron calls the public Fly hostname every five minutes,
so due work wakes a stopped Machine; completion is recorded separately from
pg_net merely queueing a request.

## Bundled design fonts

The product editor ships the OFL-licensed Gelasio font as its deterministic
`Wolkenworte Classic` serif plus Lora, Montserrat, Caveat and Baloo 2. Browser
preview, local rendering and the Linux container register the same files, and
used fonts are embedded directly into immutable print SVGs. Rendering therefore
does not depend on Georgia or another host font being installed. The existing
design-font `OFL.txt` files live next to their binaries; Gelasio's license ships
with its pinned `@fontsource/gelasio` package.

The website interface also serves its pinned Jost, Playfair Display and
Cormorant Garamond WOFF2 files locally from `public/assets/site-fonts/`.
Browsers therefore do not contact Google Fonts or another font CDN during page
loads. Each interface-font family keeps its OFL license beside the binaries.

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

`.env.example` is the canonical, fully commented configuration contract. The
ignored `.env` is a **workstation file** for local processes and operator
commands; it is not a dump of the hosted environment. Fly runtime secrets are
stored independently in Fly Secrets. `fly.toml` contains only non-secret hosted
settings. The scope labels in both env files mean:

| Scope | Where the value belongs |
|---|---|
| local process | ignored `.env`, loaded by a process on the developer workstation |
| operator | ignored `.env`, used by a workstation command that configures or verifies a hosted provider |
| Fly runtime | Fly Secrets for secrets, or `fly.toml` for non-secret settings |
| future live | intentionally empty until the reviewed production cutover |

The application context and Stripe mode are independent and explicit:

| Deployment | `APP_ENVIRONMENT` | `STRIPE_PAYMENT_MODE` | Webhook secret selected by the server |
|---|---|---|---|
| local development | `local` | `test` | `STRIPE_TEST_LOCAL_WEBHOOK_SECRET` from `.env` |
| current Fly sandbox | `hosted-test` | `test` | `STRIPE_TEST_HOSTED_WEBHOOK_SECRET` from Fly Secrets |
| future production | `production` | `live` | `STRIPE_LIVE_WEBHOOK_SECRET` from the production secret store |

Runtime validation rejects contradictory combinations and the retired ambiguous
names `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
`STRIPE_ALLOW_LIVE_PAYMENTS`; they are never guessed or silently mapped.

| Variable | Scope | Purpose / why it exists |
|---|---|---|
| `APP_ENVIRONMENT` | local + hosted setting | Declares `local`, `hosted-test` or `production`, so environment-specific credentials are selected intentionally. |
| `NODE_ENV` | local + hosted setting | Node behavior profile (`development`, `test`, `production`); it does not select payment credentials. |
| `FLY_APP_NAME` | operator | Names the Fly app targeted by repository operator scripts; defaults to `wolkenworte`. |
| `PORT` | local + hosted setting | TCP port for Express and Socket.io; 3000 locally and 8080 on Fly. |
| `PUBLIC_URL` | local + hosted setting | Canonical origin for QR codes, links, redirects and immutable print capability URLs; empty locally allows LAN detection. |
| `DATABASE_URL` | local/Fly runtime secret | Least-privileged Postgres connection used by the running process. The `.env` and Fly values are independently managed. |
| `DATABASE_CA_CERT_PATH` | shared setting | Path to the committed public Supabase CA used by local processes and the Fly container for verified hosted Postgres TLS. |
| `MIGRATION_DATABASE_URL` | local operator only | Privileged connection for migrations and role provisioning; forbidden in the Fly web process. |
| `TEST_DATABASE_URL` | optional test operator | Overrides the admin connection used to create isolated test schemas; otherwise tests fall back to migration/runtime URLs. |
| `SUPABASE_URL` | local/operator/Fly runtime | Supabase API origin used by the backend for private Storage; browsers never call it directly. |
| `SUPABASE_SECRET_KEY` | local/operator/Fly secret | Backend-only `sb_secret_...` key for private Storage operations; never exposed to clients. |
| `SUPABASE_STORAGE_BUCKET` | shared setting | Private bucket containing normalized personal photos and frozen paid print artifacts. |
| `RATE_LIMIT_HMAC_SECRET` | local/Fly secret | HMACs normalized source addresses so durable abuse data never stores raw IP addresses. |
| `MAINTENANCE_SECRET` | local/Fly secret | Independent bearer secret for bounded Supabase Cron maintenance wake-ups. |
| `MAINTENANCE_MODE` | shared setting | Temporarily blocks public HTTP/socket traffic during the guarded pre-live cleanup while health/operator checks remain available. |
| `RESEND_API_KEY` | local operator/Fly runtime secret | Long-lived Sending-access key restricted to `mail.wolkenworte.io`; the dedicated webhook setup command stages it in Fly. |
| `RESEND_MANAGEMENT_API_KEY` | temporary local operator secret | Separate Full-access key used only to register the Resend webhook; never staged to Fly and revoked immediately afterward. |
| `RESEND_FROM_EMAIL` | local operator/Fly runtime setting | Verified `Wolkenworte <bestellung@mail.wolkenworte.io>` sender. Replies explicitly go to the canonical seller contact `kontakt@jusa.io`. |
| `RESEND_WEBHOOK_SECRET` | Fly runtime secret managed by setup | Verifies signed Resend delivery callbacks. The setup command stages it directly; it stays empty in local `.env`. |
| `RESEND_SMOKE_RECIPIENTS` | local operator only | Restricts the provider smoke command to explicit maintainer or Resend test inboxes and is never staged to Fly. |
| `EMAIL_DELIVERY_MODE` | shared setting | `mock` or `live`; test payments are mocked regardless, preventing sandbox purchases from emailing real recipients. |
| `ALLOW_TEST_DATA_RESET` | temporary operator/Fly setting | Second irreversible guard for the one-time hosted-test cleanup. |
| `STRIPE_PAYMENT_MODE` | shared setting | Selects only the explicitly named `test` or `live` Stripe credential set. |
| `STRIPE_TEST_SECRET_KEY` | local/operator/Fly secret | Sandbox server key for test Checkout and hosted-test provider tooling. |
| `STRIPE_TEST_LOCAL_WEBHOOK_SECRET` | local only | Stripe CLI listener secret that verifies callbacks forwarded to localhost. |
| `STRIPE_TEST_HOSTED_WEBHOOK_SECRET` | Fly secret only | Signing secret for the current Stripe Dashboard destination at the Fly sandbox URL. |
| `STRIPE_LIVE_SECRET_KEY` | future-live secret | Production Stripe server key; deliberately empty during sandbox development. |
| `STRIPE_LIVE_WEBHOOK_SECRET` | future-live secret | Signing secret for the future production webhook destination. |
| `STRIPE_LIVE_PAYMENTS_ENABLED` | shared safety setting | Independent gate required in addition to live mode; must remain `false` locally and on hosted-test. |
| `CHECKOUT_QUOTE_TTL_MINUTES` | shared setting | Bounds saved address/price quote lifetime to 5–120 minutes (default 30). |
| `PRINTFUL_API_KEY` | local/operator/Fly secret | Backend token for live quotes and gated fulfillment; needs `orders` and `webhooks`. |
| `PRINTFUL_STORE_ID` | local/operator/Fly secret | Pins requests and callbacks to the intended Printful store. |
| `PRINTFUL_WEBHOOK_SECRET` | Fly secret | Verifies the exact raw Printful v2 callback body. |
| `PRINTFUL_WEBHOOK_PUBLIC_KEY` | Fly secret | Pins the Printful webhook configuration that owns the signing secret. |
| `PRINTFUL_FULFILLMENT_MODE` | shared setting | Selects `mock`, `draft` or `live`; test Stripe payments always resolve to mock. |
| `PRINTFUL_ALLOW_ORDER_WRITES` | shared safety setting | Independent gate required before creating any Printful draft. |
| `PRINTFUL_CONFIRM_LIVE_ORDERS` | shared safety setting | Final gate before confirming/charging/submitting a Printful order. |
| `SHOP_PRODUCT_MARKUP_PERCENT` | shared setting | Product-cost markup used in server-side retail quotes. |
| `SHOP_PAYMENT_RESERVE_PERCENT` | shared setting | Percentage payment-cost reserve folded into product prices. |
| `SHOP_PAYMENT_RESERVE_FIXED_CENTS` | shared setting | Fixed payment-cost reserve in euro cents folded into product prices. |

`DATABASE_APPLICATION_NAME` is set by `fly.toml`/test helpers for Postgres
observability, and `DATABASE_SCHEMA` is generated only by isolated tests.
Developers normally should not add either one to `.env`.

Postgres, Supabase Storage and durable email jobs are active now. The Resend
sending domain, restricted runtime key and signed webhook are configured and
their delivered, bounced, complained and suppressed outcomes have been verified.
The hosted environment remains in `mock` mode, so ordinary jobs and hosted
Stripe test payments cannot contact the live Resend API.

**Never commit `.env`** — it is gitignored and may contain both local runtime
credentials and privileged operator credentials. Hosted runtime secrets must
be set in the provider's encrypted secret store, not copied into the repository
or a deployment manifest.

Built-in status, manual fulfillment retry and guarded hosted-test cleanup
procedures are documented in [docs/operations.md](docs/operations.md). The
current enforced and pending PII-retention decisions are recorded in
[docs/data-retention.md](docs/data-retention.md). The remaining provider,
backup, restoration, alerting and production-cutover work is tracked in the
single [launch-readiness checklist](docs/launch-readiness.md).

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
scripts/deploy-hosted.js   Guarded local test → build → migrate → deploy → smoke command
scripts/hosted-smoke.js    Sanitized HTTPS/Postgres/Socket.io hosted smoke
scripts/socket-capacity.js Guarded 100-room/2,000-socket staging qualification
reports/                   Sanitized retained capacity evidence
src/
  db.js                    async Postgres data boundary and transaction logic
  dbConfig.js              verified-TLS and bounded pg pool configuration
  designAssets.js          bounded image normalization + private asset lifecycle
  privateStorage.js        backend-only Supabase Storage boundary
  lifecycle.js             expired-event cleanup + paid-data detachment
  maintenance.js           bounded fulfillment/retention orchestration + heartbeat
  printArtifacts.js        frozen paid SVG upload, capability URL + integrity checks
  clientIdentity.js        trusted normalized/HMAC source identity
  rateLimits.js            bounded one-Machine HTTP/Socket.io rate windows
  asyncRoute.js            rejected-promise boundary for Express routes
  slug.js                  German-aware slugify + unique random-suffix generation
  words.js                 Word normalization (trim/case-fold/emoji-strip)
  baseUrl.js               LAN-IP / PUBLIC_URL resolution
  socket.js                Socket.io connection handling — room isolation lives here
  socketEventCache.js      bounded active-event lookup deduplication
  socketOwnershipLoader.js exact event/owner receipt batch hydration
  wordBroadcasts.js        bounded 100-ms per-room complete-snapshot coalescing
  performanceProbe.js      aggregate process/loop/pool/socket instrumentation
  stripe.js                Stripe Checkout session creation + webhook verification
  printful.js              Printful estimates plus draft/confirm API primitives
  fulfillment.js           leased single-concurrency worker + mock/draft/live gates
  resend.js                Resend client, idempotent send and signed webhook verification
  emailDelivery.js         leased transactional-email worker + 23-hour ambiguity boundary
  emailTemplates.js        immutable multilingual order/shipment/refund/cancellation messages
  pricing.js               integer-cent quote + catalog-wide markup rule
  exportSvg.js             Server-side SVG render for the print pipeline (real font metrics via node-canvas)
  mugPrint.js              Product-sized SVG print-file renderer
  products.js              Curated, API-verified Printful variants and geometry
  routes/
    events.js              Event/configuration CRUD, personal photos, pricing and checkout
    maintenance.js         secret-authenticated synchronous Cron wake-up
    performance.js         secret-authenticated aggregate capacity snapshot
    webhook.js             raw-body Stripe, signed Printful and signed Resend callbacks
public/
  js/mug-3d-viewer.js      Shared rotatable Three.js mug preview
  js/mug-editor.js         Bounded, dynamically scaled text/motif/photo print-area editor
  js/mug-icons.js          Curated editorial fine-line wedding motif library
  js/wordcloud-core.js     Shared layout/export engine (used by both the browser and Node tests)
views/
  landing.ejs              Marketing landing page, served at '/'
  create.ejs               Event creation form, served at '/start'
  guest.ejs                Guest word-submission + personal-memory entry page
  display.ejs              Live display + SVG export + mug CTA, served at '/e/:slug/display'
  configure.ejs            Shared/personal product configurator with photo editor + 3D/flat previews
  shipping.ejs             Mobile-first address + live Printful price estimate
  order-confirmation.ejs   Polling confirmation page for signed test payments
  impressum.ejs            Current legal notice
  datenschutz.ejs          Current privacy disclosure
  404.ejs                  Unknown-event page
  partials/site-header.ejs Shared server-rendered header and language navigation
test/                      node:test suite — see "Testing" below
```

## Testing

```bash
npm test
```

Runs `node --test test/*.test.js`. The suite covers multi-tenant
isolation, personal photo-design separation, word submission/live-update, SVG layout/export correctness, the
print-file export endpoint, immutable product configurations, event
creation/slug/admin-PIN flow, expiring quotes, multi-product address quotes,
dynamic Stripe Checkout, price-change confirmation, webhook idempotency,
immutable artifacts, lease recovery/stale-owner rejection, provider ambiguity
reconciliation, signed callbacks, atomic buyer-email jobs, Resend idempotency,
lost-response recovery, lease fencing, shipment/refund/cancellation notices,
authenticated maintenance, private Storage normalization/deduplication/deletion recovery,
expiration privacy, safe paid-data retention, one-use async PIN reset and
database/process abuse ceilings,
hosting health/cache/shutdown behavior, live safety gates and
Stripe/Printful stub behavior, per-room broadcast coalescing, bounded
connection-storm hydration, polling fallback and restart-safe reconnects. Each test
server uses its own randomly named migrated Postgres schema and ephemeral port,
then drops the schema in cleanup, so files remain isolated in parallel.

**The most important test is `test/isolation.test.js`** — it proves two
concurrent events never leak words or theme changes into each other's
Socket.io room. Any change to `src/socket.js` should keep this green.

## Deployment notes

- Repository: GitHub `muelea/wedding_wordcloud`, `main`. GitHub is the source
  control remote, not a deployment runner. Pushing `main` does not deploy, no
  repository deployment workflow exists, and no deployment credentials belong
  in GitHub.
- The only supported hosted-test release path is this command from an explicitly
  approved maintainer workstation:

  ```bash
  npm run deploy:hosted
  ```

  It requires Node 22+, a running Docker daemon, an authenticated local Fly CLI,
  and the ignored local `.env` values `MIGRATION_DATABASE_URL` and
  `MAINTENANCE_SECRET`. It refuses CI, arguments, a dirty worktree, any branch
  other than `main`, a commit that does not exactly match `origin/main`, a
  different Fly app, or unsafe hosted-test settings in `fly.toml`. It never
  prints or uploads the migration credential. Before release it also reads only
  Fly Secret names—not values—and rejects missing runtime secrets, any migration
  credential, or any secret that could override the committed safety modes.
  This command is intentionally restricted to the current hosted-test
  environment; a future live release path must be reviewed separately before
  any safety mode changes.
- The hosted test app is `wolkenworte` in Fly's `fra` region with one
  `shared-cpu-2x`/512 MiB stateless web Machine, no volume, automatic stop/start
  and the public origin `https://wolkenworte.io`. Durable business data is in
  Supabase. The Fly-provided `https://wolkenworte.fly.dev` hostname remains a
  stable infrastructure endpoint for the existing Stripe sandbox webhook,
  Supabase maintenance Cron and explicitly guarded hosted-test tools.
- Fly receives only the least-privileged `DATABASE_URL`. Migrations run first
  from local operator tooling with `MIGRATION_DATABASE_URL`, which must never be
  available to an ordinary web Machine.
- `npm run fly:secrets` validates and stages the runtime-secret allowlist from
  the ignored `.env` and deliberately excludes `MIGRATION_DATABASE_URL`. The
  public Supabase CA is committed at `certs/supabase-prod-ca-2021.crt`, copied
  into the image and referenced by the one `DATABASE_CA_CERT_PATH` setting.
- `npm run maintenance:configure-cron` stores the Fly maintenance URL and
  independent bearer secret in Supabase Vault, then installs the committed
  five-minute request with an explicit 30-second pg_net timeout. The migration
  contains neither hosted value.
  When local `.env` deliberately leaves `PUBLIC_URL` blank, pass
  `-- --url https://wolkenworte.fly.dev` explicitly.
- `npm run maintenance:verify-cron -- --confirm-maintenance-run` queues the
  exact Vault-backed pg_net request and succeeds only after a new Fly-completed
  maintenance heartbeat appears. The explicit flag is required because this
  invokes real retention work.
- The release order is a clean `npm ci`, `npm test`, an AMD64 production image
  build, strict Fly config validation, `npm run db:migrate`, the fixed Fly
  deployment, `npm run maintenance:configure-cron`, and
  `npm run smoke:hosted -- https://wolkenworte.io`, followed by a final Fly
  status check. `npm run deploy:hosted` owns and tests this fail-fast order; do
  not reproduce it as an ad-hoc command list or remote workflow.
- `PUBLIC_URL` is `https://wolkenworte.io`. Porkbun hosts the authoritative DNS;
  Fly terminates HTTPS for the apex and `www`, and the application redirects
  only the `www` alias to the apex. Existing infrastructure callbacks keep
  their explicit Fly hostname instead of depending on the public alias.
- Hosted credentials (Stripe, Printful and the HMAC/maintenance secrets) belong in Fly
  secrets or the eventual host's equivalent. Resend API/webhook credentials are
  handled the same way. Keep every live-payment, live-email and Printful
  order-write switch disabled in staging except during an explicitly approved
  provider smoke.
- The Debian/glibc image installs only the runtime libraries needed by
  `node-canvas`, runs as the non-root `node` user under `tini -s`, and bundles
  and registers Gelasio as `Wolkenworte Classic`. Local and AMD64 container
  font-metric probes are part of the container verification suite.
- `/health/live` is process-only. `/health/ready` performs a bounded Postgres
  and schema/role check and is the Fly service health check. Both are `no-store`.
- Keep one web Machine until both an official Socket.io cross-Machine adapter
  and tested Fly affinity/replay for long-polling exist. Increasing the Machine
  count with the current in-memory adapter would split rooms and is unsupported.
- The Supabase bucket is private. Personal-photo validation remains limited to
  JPEG/PNG/WebP and 6 MiB per complete design; the bucket also accepts frozen
  SVG print artifacts up to 24 MiB. Fly holds the backend-only Storage key; browser
  previews are signed for 15 minutes and immutable designs store no signed URL.

## Socket capacity qualification

Socket capacity has a guarded hosted-test-only runner:

```bash
npm run load:socket:capacity -- --confirm-capacity-test
```

The explicit flag authorizes a synthetic hosted load and real restart of the
`wolkenworte` staging Machine. The runner accepts only
`https://wolkenworte.fly.dev`, creates run-scoped events directly in Postgres,
and removes those fixtures in a `finally` cleanup. It never enables live
Stripe payments, Resend delivery or Printful order writes.

A qualifying run uses 100 rooms and 2,000 Socket.io clients, including 300 in
one near-maximum hot room and 20 permanently polling-only clients. The other
clients use the same WebSocket-first connection with real polling fallback and
randomized reconnect backoff as the shipped guest/display pages. During 30 seconds it offers and
requires 1,500 accepted submissions at 50 per second alongside configuration
saves and Printful estimates, then verifies word/theme/reset/receipt isolation,
production abuse ceilings, recovery after a real Machine restart and takeover
of one synthetic mock fulfillment whose old lease expires across that restart.
The fulfillment probe never creates a Printful order.

The result is written to `reports/socket-capacity-latest.json`. It includes
p50/p95/p99 acknowledgement, room-update and API latency; steady and reconnect
CPU, memory, event-loop and Postgres-pool measurements; outbound bytes; hot
snapshot size; and transport-versus-snapshot reconnect timing. Supported
capacity must not be claimed unless the report's top-level `passed` value and
every individual gate are `true`.

The retained qualifying run from 28 August 2026 passed every gate on one
`shared-cpu-2x`/512 MiB Machine: acknowledgement p95 was 203 ms, visible
room-update p95 was 303 ms, unexpected error rate was 0%, and 99.65% of all
2,000 clients reconnected with the correct snapshot within 15 seconds of their
disconnect. Reconnect p99 was 14.6 seconds and post-connect snapshot p99 was
345 ms. Steady Fly CPU peaked at 16.1%, memory peaked at 34.3%, the Postgres
pool had no waiter, tenant/receipt isolation had no violation, and the
interrupted mock fulfillment recovered after the restart. The complete
sanitized measurements are retained in
`reports/socket-capacity-latest.json`.

## Test checkout setup

There is no static Stripe Product/Price and no browser-side publishable key in
this flow.

### Local Checkout

1. Keep `APP_ENVIRONMENT=local` and `STRIPE_PAYMENT_MODE=test`, then put the
   sandbox `sk_test_...` key into `STRIPE_TEST_SECRET_KEY` in `.env`.
2. Install/login to the Stripe CLI once (`brew install stripe/stripe-cli/stripe`,
   then `stripe login`).
3. In a second terminal run `./run_stripe_webhook.sh`. Copy the printed
   `whsec_...` into `STRIPE_TEST_LOCAL_WEBHOOK_SECRET` in `.env` and restart
   the app. This secret belongs only to that local CLI listener.
4. Start Wolkenworte with `./run_local.sh` and complete Checkout with a
   Stripe test card such as `4242 4242 4242 4242`, any future expiry date and
   any three-digit CVC.

The success page polls the local order record until the signed webhook has
marked it `paid_test`. Replaying the same webhook or double-clicking the
Checkout button is safe. The durable fulfillment worker records a local
`mocked` result and the exact payload it would use later, but no code path in
this test flow calls Printful's order endpoints — even if all Printful live
switches were accidentally enabled.

### Hosted sandbox Checkout

The public Fly callback must be registered separately from the local Stripe CLI
listener. With the Stripe test key and Fly authentication available locally,
run (the hosted-only command safely defaults to the fixed Fly test origin):

```bash
npm run stripe:configure-webhook -- --confirm-replace-webhook
npm run deploy:hosted
```

The guarded command creates exactly one sandbox destination for
`https://wolkenworte.fly.dev/webhook/stripe`, subscribes only to
`checkout.session.completed`, `checkout.session.async_payment_succeeded` and
`charge.refunded`, and stages it as `STRIPE_TEST_HOSTED_WEBHOOK_SECRET`
directly in Fly. It never writes or prints that secret, and the generic `npm run
fly:secrets` command deliberately cannot overwrite it from the local `.env`.
The hosted app selects it because `fly.toml` explicitly declares
`APP_ENVIRONMENT=hosted-test` and `STRIPE_PAYMENT_MODE=test`. The deploy
activates it.

The signing secret remains inspectable in Stripe Sandbox → Workbench →
Webhooks: select the `https://wolkenworte.fly.dev/webhook/stripe` destination
and choose **Click to reveal**. It is an endpoint-specific hosted runtime
secret and must not be added to local `.env`; local webhook forwarding uses the
separate `STRIPE_TEST_LOCAL_WEBHOOK_SECRET` printed by `stripe listen`.

Complete one real hosted Checkout with Stripe test card data. Copy the
`cs_test_...` value from the resulting confirmation-page URL and run:

```bash
npm run stripe:verify-hosted-payment -- --session cs_test_...
```

This is the external end-to-end acceptance check. It requires one enabled exact
Stripe destination, a paid sandbox Session whose delivery is complete, the
matching durable `paid_test` order, mock fulfillment, mock transactional email
and a successful public confirmation response. Unit tests still use signed
fixtures and deliberately do not pretend to exercise Stripe's network.

## Transactional email safety and activation

A signature-verified successful Stripe event is the only authority for the
buyer email. In the same database transaction, Wolkenworte records the payment,
queues fulfillment and inserts one immutable `order_confirmation` email job.
The message snapshot contains the order number/date, buyer address, products,
variants, quantities, design references, every delivery address, all exact
cent totals, seller identity and versioned contractual/personalization wording.
No recipient address is copied into a shipment, and no provider call happens in
the Stripe webhook request.

Email jobs use database claims, expiring leases and lease versions. Their
permanent dedupe key is also the Resend `Idempotency-Key`; a non-PII job id is
sent as a tag. An ambiguous provider response can reuse only that exact key for
23 hours. If a signed webhook has not resolved the outcome by then, the job is
blocked for manual review instead of risking a duplicate send. Signed Resend
events are deduplicated by `svix-id` and terminal
bounce/failure/complaint/suppression states cannot be moved backward by a late
delivery event. Routine workers cannot claim provider-smoke jobs; only the
explicit local operator command can claim an exact allowlisted smoke job. Each
increase in Stripe's cumulative refunded amount creates
one notice for exactly the newly refunded amount; duplicate or stale events do
not create mail. Every provider request sets Reply-To to the canonical seller
contact `kontakt@jusa.io`. Email failure never rolls back payment or blocks
Printful fulfillment.

`EMAIL_DELIVERY_MODE=mock` is the safe default. Stripe test payments are always
mocked even if another value is accidentally configured. Real provider
activation can therefore wait until the sending domain is available:

1. Add `mail.wolkenworte.io` in Resend with region `eu-west-1`, publish the exact
   SPF, DKIM and Return-Path/MX records supplied by Resend in Porkbun DNS, and
   wait until the domain is verified. Keep open/click tracking disabled.
2. Create a long-lived Sending-access key restricted to that domain and a
   separate temporary Full-access setup key. Put them in the ignored local
   `.env` as `RESEND_API_KEY` and `RESEND_MANAGEMENT_API_KEY`; use the committed
   `RESEND_FROM_EMAIL` value and keep `EMAIL_DELIVERY_MODE=mock`.
3. Run `npm run resend:configure-webhook -- --confirm-replace-webhook`. It
   registers the fixed `https://wolkenworte.io/webhook/resend` endpoint for
   sent/delivered/bounced/failed/complained/suppressed events and stages only the
   runtime sending key, From identity and returned signing secret in Fly. Revoke
   the temporary Full-access key and clear `RESEND_MANAGEMENT_API_KEY` immediately.
4. Run `npm run deploy:hosted` to activate the staged secrets while Fly remains
   in email `mock` mode. Put only a
   maintainer inbox or Resend's `delivered@resend.dev`, `bounced@resend.dev`,
   `complained@resend.dev` and `suppressed@resend.dev` addresses in the local
   `RESEND_SMOKE_RECIPIENTS`. For each controlled smoke, override only the local
   CLI process to `EMAIL_DELIVERY_MODE=live` and run:

   ```sh
   EMAIL_DELIVERY_MODE=live npm run smoke:resend-email -- \
     --confirm-email-smoke --recipient <allowlisted> --expect <delivered|bounced|complained|suppressed>
   ```

   The synthetic message uses the production template, Reply-To, client,
   idempotency key, tag and signed webhook reconciliation path. It cannot be
   invoked through HTTP and refuses to run while Stripe live payments are enabled.
5. Fly remains at `EMAIL_DELIVERY_MODE=mock` after testing. Do not enable live
   sales until the contractual copy, VAT/invoicing treatment and all provider
   smokes have been approved.

## Fulfillment safety modes

The payment state and fulfillment state are stored separately. A successful
payment atomically queues one immutable fulfillment snapshot. Claims persist a
worker owner, expiry and monotonically increasing lease version; only that
owner/version can commit a shipment or order result. An expired lease is safely
claimable after restart. Before a real provider call, every surface is frozen
in private Storage and exposed through a high-entropy
`/api/print-files/<artifact>/<nonce>` capability. Invalid, expired and deleted
capabilities all return 404.

Printful order/shipment and item IDs are deterministic 27-character SHA-256
references. Every attempt first retrieves the provider order by that external
ID. A lost create/confirm response is reconciled before another write; draft
creation retains `update_existing=true` as a second guard.

| Stripe payment | Requested Printful mode | Result |
|---|---|---|
| test | any | local `mock`; zero Printful order requests |
| live | `mock` | local `mock`; zero Printful order requests |
| live | `draft` + order-write switch | unconfirmed Printful draft |
| live | `live` + both write/confirm switches | draft creation followed by explicit confirmation |

Draft and live writes additionally require `STRIPE_PAYMENT_MODE=live`,
`STRIPE_LIVE_PAYMENTS_ENABLED=true`,
`PRINTFUL_ALLOW_ORDER_WRITES=true`, a configured token, and a public HTTPS
`PUBLIC_URL`. `live` also requires `PRINTFUL_CONFIRM_LIVE_ORDERS=true`.
Printful charges the account and starts fulfillment only when the separately
created draft is confirmed. Keep every switch false while developing locally.

`npm run smoke:printful-draft -- --confirm-draft-smoke --recipient-file <json>
--product <key>` is the only non-payment provider smoke path. It refuses live
Stripe mode, requires draft-only writes, creates marked synthetic data, never
confirms the draft and verifies Printful processed the frozen capability URL.
`npm run printful:configure-webhook -- --confirm-replace-webhook` deliberately
replaces the store's signed v2 webhook configuration and stages its returned
keys in Fly for activation by `npm run deploy:hosted`.

## What's intentionally disabled

- **Live Stripe payments** — `STRIPE_LIVE_SECRET_KEY` and live webhook events
  remain unreachable while `STRIPE_PAYMENT_MODE=test` and
  `STRIPE_LIVE_PAYMENTS_ENABLED=false`.
- **Live transactional delivery** — email snapshots and mock outcomes are
  durable, but `EMAIL_DELIVERY_MODE=mock` prevents ordinary jobs from contacting
  Resend. Stripe test payments remain mocked in every mode. The sending domain,
  signed webhook and controlled real-inbox/delivered/bounced/complained/
  suppressed outcomes are verified; only the deliberate live-delivery cutover
  remains gated.
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
  password-type fields (`#pin`, `#pin-confirm` in `views/create.ejs`) make
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

## Remaining launch work

The architecture refactor is complete. Live sales are still intentionally
disabled until the external provider checks, legal/tax decisions, alerting,
backup/restoration exercise and controlled cutover are complete. The ordered,
up-to-date list lives only in
[docs/launch-readiness.md](docs/launch-readiness.md); do not maintain a second
historical implementation checklist here.
