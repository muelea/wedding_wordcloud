# WeddingCloud

A live word cloud for weddings. Any couple creates their own event, guests
scan a QR code and submit a word from their phone (no account, no app), and
the word cloud grows in real time on a shared display. Free to use — the
only paid product is an optional set of personalized mugs printed from the
finished word cloud after the event.

## How it works

1. Couple visits `/start`, enters their names, gets a unique event at
   `/e/<slug>` plus a 4-6 digit admin PIN.
2. `/e/<slug>/display` goes on the big screen / projector.
3. Guests open `/e/<slug>` on their phone (usually via QR code) and submit
   one word at a time.
4. Words appear live on the display via Socket.io — font size scales with
   how many guests submitted the same word.
5. After the event, the couple opens a product configurator, chooses any
   quantity from 1–99, a color palette and one of three print layouts
   (single, both sides or full wrap), and approves an immutable mug print
   file with a transparent background. A locally served Three.js preview
   maps that exact artwork onto a rotatable mug using Printful's physical
   dimensions. The print area itself is a small Fabric.js editor: every word
   can be moved, resized, rotated, recolored, edited, duplicated or removed,
   while hard bounds keep the design printable.
6. The approved configuration can then be purchased through Stripe Checkout
   and sent to Printful for fulfillment.

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
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | only for mug checkout | unset → checkout returns a clean 501, rest of the app works fine |
| `PRINTFUL_API_KEY`, `PRINTFUL_STORE_ID`, `PRINTFUL_MUG_VARIANT_ID_HIS/HERS` | only for the current fulfillment stub | unset → order creation is mocked (logs `[printful:mock]`, doesn't call the real API) |

**Never commit `.env`** — it's gitignored. Production secrets (Render, or
wherever this is deployed) are set directly in the host's dashboard, not in
the repo.

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
  printful.js              Printful order creation (mocked without PRINTFUL_API_KEY)
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
  js/mug-editor.js         Bounded word-by-word print-area editor
  404.html                 Unknown-event page
  js/wordcloud-core.js     Shared layout/export engine (used by both the browser and Node tests)
test/                      node:test suite — see "Testing" below
```

## Testing

```bash
npm test
```

Runs `node --test test/*.test.js` — 34 tests covering multi-tenant
isolation, word submission/live-update, SVG layout/export correctness, the
print-file export endpoint, immutable product configurations, event
creation/slug/admin-PIN flow, and Stripe/Printful stub behavior. Each test
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

## What's stubbed (by design, not by accident)

- **Stripe Checkout / webhook** — code is fully wired (official SDK,
  signature verification, `metadata.eventSlug` round-trip) but no live
  Stripe account exists yet. Missing keys → checkout returns a 501 with a
  clear message instead of crashing.
- **Printful fulfillment** — the 11 oz white glossy mug (catalog product 19,
  variant 1320) and its 2700x1050 / 300 DPI print geometry have been verified
  against the live API. Missing `PRINTFUL_API_KEY` →
  `createPrintfulOrder()` logs `[printful:mock]` and returns a fake order id
  so the full payment→fulfillment flow is still exercisable end-to-end
  locally.

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

1. Connect the saved configuration id, quantity and unit price to Stripe
   Checkout metadata and make the webhook fulfill that immutable
   configuration rather than the live event export.
2. Confirm whether Printful's mug print pipeline accepts the generated SVG
   directly or needs a rasterized PNG (`node-canvas`'s `toBuffer('image/png')`
   is already available if so).
3. Move `data/*.sqlite` to a persistent volume, or migrate to Postgres
   (schema is plain SQL, written to make that swap easy).
4. Rate-limiting — no per-IP throttle yet on word submission or event
   creation.
