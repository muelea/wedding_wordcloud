# WeddingCloud — multi-tenant word cloud + His & Hers mug-duo

Turns the validated single-event prototype (`/Users/leamueller/Projects/2026_wordcloud`)
into a multi-tenant product: any couple can create their own event at
`/e/<slug>`, guests scan a QR code and submit a word from their phone, the
word cloud grows live on a shared display, and — once the cloud has words —
the couple can order a "His & Hers" mug duo (34,90€, one bundled product,
via Stripe Checkout + Printful fulfillment).

The live word-cloud experience is and stays completely free, no account
required for guests, no paywall. The mug duo is the only monetization.

## What's fully built and tested

- **Multi-tenant data model** (`src/db.js`): `events`, `words`, `orders`,
  `archives` tables. Word counts use an atomic
  `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` upsert — no more
  in-memory `Map`, no lost/raced counts, and state survives a restart.
- **Socket.io room isolation** (`src/socket.js`) — the critical fix over the
  prototype. Every socket must join a room keyed by the event's slug before
  it can do anything; every emit is `io.to(slug).emit(...)` /
  `socket.to(slug).emit(...)`, never the prototype's global `io.emit(...)`.
  An unknown slug gets a `fatal-error` and is disconnected, not silently
  joined to nothing.
  **Verified by `test/isolation.test.js`**: two concurrent events, submit a
  word / change theme on event A, assert event B receives **zero**
  `word-update`/`theme-change` emissions and its word list stays empty.
- **Event creation flow** (`public/create.html` + `POST /api/events`) —
  couple names, optional wedding date, live slug preview (debounced
  `GET /api/slug-availability`), 4-6 digit admin PIN (+confirm). No
  accounts/login — matches the "no paywalled tier" reality. Slugs
  transliterate German umlauts (ä→ae, ö→oe, ü→ue, ß→ss) rather than
  stripping them.
- **Every event slug gets a random suffix appended at creation**
  (`src/slug.js`'s `makeUniqueSlug()`, e.g. `johanna-und-peter-x7k2q`), not
  just the name-derived prefix. Two problems, one fix: (1) common name
  combos used to collide and 409, forcing a manual retry; now creation
  just retries with a fresh suffix server-side and always succeeds. (2)
  Privacy: guest word submissions are viewable by anyone who reaches the
  URL (admin actions are PIN-gated, viewing is not), so a guessable slug
  like `anna-und-max` let a stranger who guessed a common name combo read
  a couple's live guest submissions — closed by making the slug
  effectively unguessable (5 chars from a 32-character unambiguous
  alphabet, ~33.6M combinations per prefix) while keeping the
  human-readable prefix as a memorable spoken/typed fallback if a QR code
  fails to scan. The prefix-only text is still genuinely re-derived and
  re-validated server-side on submit; the live preview in `create.html`
  shows the prefix plus a "code wird beim Erstellen ergänzt" note rather
  than implying the typed text is the final URL. Old slugs created before
  this change (without a suffix) keep resolving normally — lookup was
  never format-constrained. **Verified by `test/slug.test.js`** (suffix
  alphabet/length, non-sequential/non-enumerable across 40 draws,
  collision-retry behavior) and `test/events.test.js` (two events created
  with identical couple names get distinct, both independently working
  slugs).
- **PIN-gated admin actions** (`src/adminAuth.js`) — verifying the PIN once
  mints a short-lived HMAC-signed token (12h TTL, scoped to that event's
  slug) that the browser holds in `sessionStorage` ("once per browser
  session", not a persistent login) and sends as `Authorization: Bearer` on
  `POST /api/events/:slug/reset`. A token minted for one event's slug is
  rejected by another event's reset endpoint (tested).
- **Guest + display pages ported and made slug-aware**
  (`public/guest.html`, `public/display.html`) — same pastel/neon theme
  system, Georgia serif, restrained motion as the prototype; couple
  name/event title/theme are now fetched per-event
  (`GET /api/events/:slug`) instead of hardcoded.
- **The word-cloud layout/export engine, ported not rewritten**
  (`public/js/wordcloud-core.js`) — `layoutWords()`/`buildSVG()` extracted
  verbatim (algorithmically) from the prototype's `display.html` into a
  shared, stateless module loaded both by the browser
  (`window.WordCloudCore`) and by Node tests (`require(...)`). Color
  assignment was made an injected `colorFn` instead of module-level state,
  so it's safe to reuse concurrently across events on the server.
  **Verified by `test/svg-export.test.js`**: every submitted word is placed
  exactly once (no drops, no duplicates) for a realistic 24-word cloud, no
  two placed words' bounding boxes overlap, everything stays within canvas
  bounds, and `buildSVG()` XML-escapes special characters correctly.
- **Server-side print-file export with a real, fetchable URL, using real
  font metrics** (`src/exportSvg.js` + `GET /e/:slug/export.svg` in
  `server.js`) — the same `layoutWords()`/`buildSVG()` engine run in Node
  against the event's live word list from SQLite, generated on demand
  (measured ~10-25ms for a realistic 10-60 word cloud, ~110ms at 100 words
  — fast enough not to bother caching to disk). This closes the gap
  Printful's order API actually has: it needs a URL it can fetch, not
  inline SVG markup. Text measurement uses `node-canvas`'s real
  `CanvasRenderingContext2D.measureText()` — an earlier pass here used a
  fixed average-character-width approximation instead (see "Architectural
  decisions" below for why that was reversed); the server-rendered layout
  now uses the same measurement spec the browser's export uses, not a
  guess. **Verified by `test/export-endpoint.test.js`**: a real event with
  submitted words (including an umlaut and a near-max-length word) served
  as well-formed XML containing every word exactly once; 404s for an event
  with no words yet and for an unknown slug. **Verified by
  `test/export-font-metrics.test.js`**: real glyph metrics are actually in
  effect (a narrow-vs-wide-glyph case that the old length-only
  approximation could never distinguish, exercised through the real
  `src/exportSvg.js` code path) and the no-overlap/no-drop/all-words-placed
  invariants still hold under real metrics for a realistic word list.
- **Webhook → Printful wiring passes that real URL, not a placeholder**
  (`src/routes/webhook.js`, `src/printful.js`) — on
  `checkout.session.completed`, the handler builds
  `${getBaseUrl(req, port)}/e/<slug>/export.svg` and passes it as `svgUrl` to
  `createPrintfulOrder()`, which — still mocked, no real Printful
  store/product exists — logs it in the `[printful:mock]` line instead of
  calling the real API. **Verified end-to-end by
  `test/webhook-flow.test.js`**: a locally-signed `checkout.session.completed`
  payload (via `stripe.webhooks.generateTestHeaderString()` — pure local
  HMAC verification, no live Stripe account needed) drives the real webhook
  route, and the test asserts the URL handed to a spied-on
  `printful.createPrintfulOrder()` is not just correctly-shaped but actually
  fetchable and serves the submitted word.
- **Word submission → live update flow** — verified end-to-end with real
  `socket.io-client` connections in `test/words.test.js`: normalization
  (trim/case-fold), atomic increment on repeat submissions, broadcast to
  *other* connected sockets (not just an echo to the sender), blank
  submissions produce no broadcast, and a newly-connecting socket receives
  current state rather than an empty board.
- **The mug-duo checkout integration shape** (`src/stripe.js`,
  `src/routes/webhook.js`, `src/printful.js`) — see "What's stubbed" below;
  the shape is real, wired, and unit-tested for its no-credentials
  fallback behavior (`test/checkout-stubs.test.js`).
- **Event-creation/slug-availability flow** — `test/events.test.js` covers
  availability before/after creation, duplicate-slug 409, field validation,
  umlaut transliteration, and the admin-PIN gate described above.
- **Public marketing landing page** (`public/landing.html`, served at
  `/`) — hero, 3-step explainer, positioning statement, His & Hers mug-duo
  showcase, FAQ, and CTAs that link into a real, working `/start` →
  `POST /api/events` flow (not a mockup). Includes a real screen-recorded
  demo video of the actual `display.html` growing live and a mug mockup
  built from a real `GET /e/:slug/export.svg` output. See "Public
  marketing landing page" below for the full routing decision, how the
  demo assets were captured, and what testing was done.

Run `npm test` — **30 tests, all passing** (see "Run it" below).

## What's stubbed, and why

- **Stripe Checkout** (`src/stripe.js`) is wired up correctly (official
  `stripe` SDK, `checkout.sessions.create` with `metadata.eventSlug` for
  the webhook to find its way back to the right event, German-market
  shipping-country allowlist) but `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID` are
  **not set** — no real Stripe account exists yet (needs the business
  owner's verified identity, explicitly out of scope for this pass).
  `POST /api/events/:slug/checkout` returns a clear `501` with a German
  message instead of crashing when unconfigured; the mug-duo CTA on the
  display page surfaces that message via `alert()` rather than failing
  silently.
- **Stripe webhook** (`src/routes/webhook.js`) mounted at `POST
  /webhook/stripe` with `express.raw()` (required for signature
  verification — must NOT go through `express.json()`). Verifies the
  signature, looks up the event by `session.metadata.eventSlug`, marks the
  order paid, and calls `createPrintfulOrder()`. Untested against a live
  Stripe webhook (no account), but the code path is exercised indirectly:
  `constructWebhookEvent()`'s "not configured" branch is covered, and the
  `checkout.session.completed` handler logic was manually traced against
  Stripe's documented webhook payload shape.
- **Printful fulfillment** (`src/printful.js`) — gated on
  `PRINTFUL_API_KEY`. When unset (the current state), `createPrintfulOrder()`
  logs a clear `[printful:mock]` line and returns a fake order id instead
  of throwing, so the full payment→fulfillment data flow is exercisable
  end-to-end locally. It's still purely mocked because no real Printful
  store/product exists yet — but the *file URL gap* that used to block it
  is closed: `svgUrl` passed in is now `GET /e/:slug/export.svg`, a real
  URL Printful's order API can actually fetch (see the two new bullets
  above). What's genuinely still unverified is whether Printful's real
  pipeline accepts SVG directly for a mug print or wants a rasterized PNG
  instead — untestable without a live sandbox account (see "Next phase").
- **Production hosting, real domain, public marketing/landing page** — none
  of this exists; explicitly out of scope for this pass per the brief.

## Architectural decisions that deviate from the brief (with reasoning)

- **SQLite (`node:sqlite`) instead of Postgres.** The brief allows this
  explicitly "if Postgres isn't easily available" — and it isn't in this
  sandbox (no `psql`/`pg_ctl` on `PATH`, no way to stand up and daemonize a
  Postgres server here). Specifically chose Node's **built-in**
  `node:sqlite` (`DatabaseSync`) over `better-sqlite3`: zero native-compile
  step, so `npm install` can't break on a Node upgrade with no ops team
  watching — matches the "agent-first, low headcount" operating model
  explicitly called out in the brief. It's marked experimental by Node
  (harmless `ExperimentalWarning` on startup) but is API- and
  behavior-stable enough for this. Schema/queries are written in
  plain/ANSI-ish SQL (no SQLite-only extensions) so a future Postgres
  migration is a driver swap, not a rewrite.
- **Archive table added, not in the original spec's schema list.** The
  prototype archived words to a JSON file before every "Neue Runde" reset
  so a round could never be silently thrown away. Dropped that behavior
  entirely felt like a regression for a low cost, so `archives(event_id,
  words_json, created_at)` mirrors it in SQL instead of a file.
- **Admin auth is a signed token, not a session/cookie system.** The brief
  literally describes session-scoped behavior ("entered once per browser
  session") — implemented as exactly that: verify PIN once →
  short-lived HMAC token → `sessionStorage` (cleared on tab close) →
  `Authorization: Bearer` header. No server-side session store, no cookie
  middleware, no login system — reused Node's built-in `crypto` (scrypt for
  the PIN hash, HMAC-SHA256 for the token) rather than adding `bcrypt` or a
  JWT library for what's fundamentally a 4-6 digit gate on one low-stakes
  action.
- **`socket.io-client` chosen for the multi-tenant isolation test** (per the
  brief's suggestion) over spinning up a headless browser — matches how the
  prototype itself was validated (hitting a running server directly) and
  is dramatically faster/more deterministic than browser automation for
  proving a server-side broadcast-scoping property.
- **`node-canvas` added as a real dependency for the print-file export,
  reversing an earlier pass's decision to avoid it.** `src/exportSvg.js`
  used to approximate glyph widths with a fixed average-character-width
  ratio instead of real font metrics, reasoning that `node-canvas`'s
  native-compile step conflicted with the "agent-first, no ops team"
  operating model — the same reasoning applied to `node:sqlite` above. That
  reasoning didn't actually transfer: "agent-first" in the brief describes
  lean day-to-day *operations* (support, marketing automation, no headcount
  watching a running server) — it says nothing about avoiding a one-time
  build-step dependency for an engineering decision. `export.svg` is what
  is actually sent to Printful and printed on the mug — the one physical
  product this business sells. An approximate width there means the
  printed word positions can visibly differ from what the customer
  previewed and approved in their own browser (which uses the browser's
  real `measureText()`). For that specific, correctness-critical path,
  real font metrics matter more than avoiding a native dependency.
  Concretely verified before committing to this reversal, rather than
  assumed:
  - `npm install canvas` completes in under a second in this environment
    via a **prebuilt binary** (`prebuild-install`) — no `node-gyp`/compiler
    invocation, no system `cairo`/`pkg-config` needed at install time (this
    machine has neither). A `createCanvas(...).getContext('2d')` +
    `measureText()` smoke test works immediately after install.
  - The old approximation (`str.length * fontPx * 0.42`) by construction
    measures any two equal-length strings identically regardless of their
    actual glyphs; real `measureText()` does not — e.g. a 10-character run
    of `"i"` measures ~3x narrower than a 10-char run of `"w"` at the same
    font size (see `test/export-font-metrics.test.js`, which pins this
    down as an assertion that would fail under the old code and passes
    now).
  - Before/after comparison method: the same word list was laid out three
    ways — (1) the retired fixed-ratio approximation, (2) the current
    `src/exportSvg.js` server path (real `node-canvas` `measureText()`),
    (3) a second, independently-constructed real-canvas context calling
    `WordCloudCore.layoutWords()` directly, standing in for "what the
    browser would compute" since this repo has no headless-browser
    (Puppeteer/Playwright) harness — only a real `<canvas>`-shaped context
    can be constructed headlessly here, per the pattern
    `test/svg-export.test.js` already established for exercising
    `wordcloud-core.js` straight from Node. Result: (2) and (3) — two
    independent real-canvas runs of the identical code path — produced
    **identical** placements (0px average delta), as expected. (1) vs (2)
    diverged substantially: **~187px average / up to ~1529px maximum**
    word-position delta across an 11-word test list at a 1600px canvas
    (one long word's shrink-retry took a different spiral path entirely
    once its real width was known), and per-word box widths differed by
    up to ~44% for glyph-heavy words (e.g. an all-"i" word measured
    180.5px under the approximation vs. 125.6px under real metrics). This
    confirms the fix closes a real, not hypothetical, gap. (This
    comparison script was exploratory and not committed — the durable
    proof lives in `test/export-font-metrics.test.js`, described above.)
  - **Font availability, checked rather than assumed:** in this
    environment (macOS, arm64), `node-canvas` resolves `"Georgia"` to the
    real system Georgia font (macOS ships
    `/System/Library/Fonts/Supplemental/Georgia.ttf`) — confirmed by
    measuring a test string under `"Georgia"` (575.0px), a generic
    `"serif"` (541.6px), and a deliberately bogus font name (576.9px, the
    unknown-font fallback): Georgia's measurement is distinct from both,
    proving it isn't silently falling back. **This has not been verified
    on a Linux production host** (Render or similar) — Georgia is a
    Microsoft-licensed font not bundled with mainstream Linux distros or
    `fontconfig` defaults, so `node-canvas` will very likely fall back to
    a generic serif there unless a Georgia-compatible font file is bundled
    with the app and registered via `canvas.registerFont()` at startup
    (e.g. Google's metric-compatible "Gelasio," which is openly licensed).
    See "Next phase" for the deployment follow-up this implies.

## Public marketing landing page

`public/landing.html`, served at `/`. Event creation (previously at `/`)
moved to `/start` — `server.js` now has two page routes ahead of the
`/e/:slug*` ones:

```js
app.get('/', (req, res) => res.sendFile(... 'landing.html'));
app.get('/start', (req, res) => res.sendFile(... 'create.html'));
```

**Why `/start` and not e.g. `/willkommen` or a `/app` prefix:** shortest
possible path for the couple to actually act on once they've read the
pitch, keeps every existing `/e/:slug`/`/e/:slug/display` URL and the
`GET /e/:slug/export.svg` print-file URL completely unchanged (nothing
printed on a QR code or handed to Printful moves), and every landing-page
CTA just links to `/start` — a real, fully working route into the same
`create.html` → `POST /api/events` flow used before, not a new or
duplicated flow.

Uses the **same design system as the rest of the app as-is** — the same
CSS custom properties (`--bg`, `--primary`, `--accent`, `--text`, `--muted`,
etc.), Georgia serif headings, pastel gradient background, card/shadow
language from `create.html`/`display.html` — deliberately not restyled,
since a separate pass is redesigning the app's visual system and hasn't
shipped yet. Once that direction lands, `landing.html`'s `<style>` block
is the thing to revisit first (see "Flagged for the design-restyle pass"
below).

Sections: hero (headline/subhead/CTA + live demo video), positioning
statement, 3-step "how it works", His & Hers mug-duo showcase, FAQ
(`<details>`/`<summary>`, no JS needed), bottom CTA, footer. Copy is
taken directly from the marketing-copy deliverable (hero, positioning,
steps, FAQ, CTAs) with only the placeholder brand name swapped to
"WeddingCloud" to match what the running app actually calls itself.

### The live demo asset — how it was actually produced

Both demo assets are **captured from the real, running app**, not
mocked up:

- **`assets/demo-wordcloud.mp4`** (~1120px wide, ~380KB, silent,
  autoplay/loop/muted `<video>`): a real screen recording of
  `display.html`. Produced by: booting a real server instance on an
  isolated port and an isolated SQLite file (never the port/DB anything
  else might be using — checked `lsof -i :3000` first and left it alone),
  creating a real event via `POST /api/events`, driving **headless
  Chrome** for the screenshots and **real `socket.io-client`
  connections** (one per simulated guest) for the word submissions —
  the same client library `test/isolation.test.js`/`test/words.test.js`
  already use to exercise the server for real. Per the brief's explicit
  warning, `--window-size` was **not** trusted for the actual rendered
  viewport — instead connected over `--remote-debugging-port` with a
  raw `ws` DevTools-Protocol client, called `Emulation.setDeviceMetricsOverride`,
  and confirmed the real rendered size via `Page.getLayoutMetrics` before
  capturing. Every headless Chrome invocation used its own throwaway
  `--user-data-dir` under the scratch dir, so nothing could attach to a
  real/already-open Chrome profile on this machine. ~25 guest sockets
  submitted realistic German wedding words with pacing between
  submissions (not a burst), `Page.captureScreenshot` ran after each,
  and the resulting PNG sequence was encoded to MP4 with `ffmpeg`
  (present on this machine — confirmed via `which ffmpeg` first).
  **This is real recorded output of the actual app** — the same code
  path a guest's phone and the reception's display screen would run.
- **`assets/mug-duo-preview.svg`**: two simple hand-drawn mug
  silhouettes (SVG shapes — body, handle, rim shading) with the **real**
  `GET /e/:slug/export.svg` output from that same demo event clipped
  onto each mug face, plus a visible caption ("Illustrative Vorschau …
  kein Produktfoto"). No fabricated/stock product photo — the word-cloud
  artwork on it is byte-for-byte what `src/exportSvg.js` actually
  produced for a real event with real submitted words, just framed in an
  honestly-labeled illustrative mockup rather than a photograph.

Both were regenerated with disposable scripts (not committed — they're
one-off capture tooling, not part of the app) that boot the real
`server.js`, so re-running the same approach against a fresh demo event
would reproduce them if the demo ever needs updating.

### Testing performed for the landing page

- `npm test` still passes (30/30) — the routing change didn't touch
  anything the test suite exercises (all tests hit the API/socket layer
  directly, not `/` or `/start`).
- Booted a real instance on an isolated port and curled `/` (200,
  `landing.html`), `/start` (200, `create.html`), and all three
  `/assets/*` files (200, correct `Content-Type`).
- Drove the actual CTA path for real: `POST /api/events` (what
  `create.html`'s form calls) against that instance, then confirmed the
  returned `guestUrl`/`displayUrl` both 200 — the landing page's CTAs
  lead into a genuinely working event, not a dead end.
- Screenshotted `landing.html` full-page in headless Chrome at a desktop
  width (1440px) and a phone width (390px) to check the layout actually
  holds up responsively — grid sections collapse to a single column
  under 760px, nav/CTA stay usable at phone width.

### Flagged for the (upcoming) design-restyle pass

- `landing.html`'s `<style>` block currently **duplicates** the CSS
  custom-property theme from `create.html`/`display.html` rather than
  sharing it — there's no shared stylesheet/theme file across
  `public/*.html` today (each page owns its own inline `<style>`), so
  this matches the existing pattern rather than introducing a new one,
  but it does mean the eventual restyle has to touch (at least) four
  files' worth of duplicated tokens instead of one. Worth factoring the
  theme into a shared `public/css/theme.css` once the new visual
  direction is locked, rather than before.
- The mug-duo mockup (`mug-duo-preview.svg`) is intentionally plain
  (white ceramic silhouette, no texture/lighting) so it reads honestly as
  "illustrative, not a photo" — the restyle pass may want a richer
  illustration style, but should keep the same honesty constraint (real
  exported word-cloud art, clearly not a product photo) rather than
  drifting toward something that could be mistaken for a real photograph.
- The demo video has no captions/text overlay — fine for an autoplay
  loop, but if the restyle pass adds motion/animation elswhere on the
  page, consider whether a short text callout over the video (e.g. "echte
  Aufnahme der App") would strengthen the "this is real, not a mockup"
  message further.

## Project layout

```
server.js                 Express + Socket.io bootstrap, route mounting;
                           also serves GET /e/:slug/export.svg (print file)
src/
  db.js                   SQLite schema + all queries (events/words/orders/archives)
  slug.js                 German-aware slugify + auto-suggestion
  words.js                Word normalization (ported from the prototype)
  adminAuth.js             PIN-session HMAC token issue/verify
  baseUrl.js               LAN-IP / PUBLIC_URL resolution (ported)
  socket.js                Socket.io connection handling — ROOM ISOLATION lives here
  stripe.js                 Stripe Checkout session creation + webhook verification
  printful.js               Printful order creation (mocked without PRINTFUL_API_KEY)
  exportSvg.js               Server-side SVG render for the print pipeline (real font metrics via node-canvas)
  routes/
    events.js               Event CRUD, slug availability, QR, admin verify/reset, checkout
    webhook.js               POST /webhook/stripe (raw body, signature-verified) -> builds
                              the export.svg URL and calls createPrintfulOrder()
public/
  landing.html               Public marketing landing page, served at '/'
  create.html               Event creation form, served at '/start'
  guest.html                 Slug-aware guest word-submission page (was index.html)
  display.html                Slug-aware live display + SVG export + mug-duo CTA
  404.html                    Unknown-event page
  js/wordcloud-core.js        Shared layout/export engine (browser + Node)
  assets/
    demo-wordcloud.mp4        Real screen-recorded demo (see "Marketing landing page" below)
    demo-poster.jpg            Poster frame for the demo video
    mug-duo-preview.svg        Illustrative mug-duo mockup built from a real export.svg
test/
  helpers.js                  Test server bootstrap (fresh SQLite file, ephemeral port)
  isolation.test.js            *** the critical multi-tenant test ***
  words.test.js                 Word submission -> live update flow
  svg-export.test.js             Layout/export correctness (no drops/dupes/overlaps)
  export-endpoint.test.js        GET /e/:slug/export.svg over a real event (umlaut, long word)
  export-font-metrics.test.js    Proves real node-canvas font metrics are in effect (not the
                                  retired length-only approximation) + no-overlap regression
  webhook-flow.test.js           Webhook -> real export.svg URL -> printful.createPrintfulOrder()
  events.test.js                 Event creation, slug preview, identical-name-collision slugs, admin PIN gate
  slug.test.js                   Random suffix (alphabet/length/non-sequential), makeUniqueSlug retry-on-collision
  checkout-stubs.test.js         Stripe/Printful graceful-degradation-when-unconfigured
```

## Run it locally

```bash
cd /Users/leamueller/Projects/2026_weddingcloud_business
npm install
cp .env.example .env   # optional — defaults work for local dev without Stripe/Printful
npm start              # or: npm run dev  (auto-restart on file change)
```

Then open the printed URL (your LAN IP, so phones on the same WiFi can
reach it) — `/` is the public marketing landing page; `/start` is the
event-creation form (linked from every CTA on the landing page). Create
an event, open its `/e/<slug>/display` URL on a big screen, and submit
words from `/e/<slug>` on a phone (or another browser tab) to see it
update live.

Two events created in the same run are fully isolated from each other —
try opening two different `/e/<slug>/display` pages side by side and
submitting to only one.

## Run the tests

```bash
npm test
```

Runs `node --test` over `test/*.test.js` — 30 tests: multi-tenant
isolation (2), word submission/live-update (2), SVG layout/export
correctness (4), the server-side export.svg endpoint (3), real-font-metrics
regression + proof (3), the webhook → real-export-URL → Printful flow (1),
event creation/slug preview/identical-name-collision/admin-PIN (5), random
slug-suffix generation + uniqueness-retry unit tests (7), Stripe/Printful
stub behavior (2), plus an unknown-slug rejection test. Each test file gets
its own scratch SQLite file (auto-cleaned on completion) and its own
ephemeral port, so the suite is safe to run repeatedly/in parallel.

## Next phase — what the next engineer/agent should tackle

1. **Real Stripe + Printful accounts.** Once the business owner's identity
   is verified: create the Stripe product/price for the 34,90€ mug duo,
   set `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID`/`STRIPE_WEBHOOK_SECRET`; create
   a Printful store, pick the actual "His"/"Hers" mug variant IDs, set
   `PRINTFUL_API_KEY`/`PRINTFUL_STORE_ID`/the variant-id env vars. No code
   changes should be needed — verify that assumption against a real Stripe
   test-mode account before going further.
2. **Printful now gets a real, fetchable URL rendered with real font
   metrics — the remaining question is whether it's the *right* file
   format.** `GET /e/:slug/export.svg` exists and is what
   `src/routes/webhook.js` passes to `createPrintfulOrder()` (see
   `test/export-endpoint.test.js`/`test/webhook-flow.test.js`), so the
   "inline SVG isn't fetchable" gap is closed, and `src/exportSvg.js` now
   uses `node-canvas`'s real `measureText()` instead of an approximation
   (see "Architectural decisions" above), so the print file's word
   positions match the browser's export far more closely — no longer a
   known/accepted gap. What's still genuinely open, only verifiable
   against a real Printful sandbox account: whether Printful's mug print
   pipeline accepts SVG directly, or needs a print-resolution raster (PNG)
   — if the latter, add a render step (e.g. `resvg`/`sharp`, or
   `node-canvas`'s own `canvas.toBuffer('image/png')` since it's already a
   dependency) either in the export route or as a Printful-side
   conversion.
3. **Production hosting — font availability and `node-canvas`'s native
   binary are now real deployment prerequisites, not just a `node:sqlite`
   concern.** Pick a host (Render/Fly/Railway/etc — the prototype's
   `getBaseUrl()` already special-cased Render, dropped here for
   cleanliness — re-add if that's the target), move `data/*.sqlite` to a
   persistent volume or migrate to managed Postgres, set
   `ADMIN_TOKEN_SECRET` to a real random value (the fallback is
   intentionally insecure), set `PUBLIC_URL` once there's a real domain.
   Specifically for the print-file export, verify on the actual target
   host/image before going live:
   - `npm install` must resolve a `canvas` prebuilt binary for that
     platform (this pass only confirmed macOS arm64). If the host is
     Linux and **Alpine** (musl libc) rather than Debian/Ubuntu (glibc),
     `node-canvas`'s prebuilds are glibc-only — either switch the base
     image or expect a slower `node-gyp` source build requiring
     `cairo`/`pango`/`libjpeg`/`giflib` dev headers to be installed in the
     image.
   - `"Georgia"` is very unlikely to resolve on a bare Linux host (see the
     font-availability finding above) — bundle a metric-compatible open
     font (e.g. "Gelasio") as a font file in the repo and call
     `canvas.registerFont(path, { family: 'Georgia' })` once at server
     startup so the server-side glyph metrics keep matching what
     `wordcloud-core.js`'s `FONT_FAMILY` constant asks for, rather than
     silently falling back to a generic serif. Re-run the same
     narrow-vs-wide `measureText()` check documented above against the
     actual production image to confirm before shipping.
4. **Public marketing/landing page — done, current pass.** `/` is now
   `public/landing.html` (hero, positioning, 3-step explainer, mug-duo
   showcase with a real-export-based mockup, FAQ, CTAs into `/start`); see
   "Public marketing landing page" above for the full routing rationale,
   how the demo video/mockup were actually captured, and what's flagged
   for the upcoming design-restyle pass. Still open from here: the page
   is unstyled by the *new* visual direction (intentionally — see that
   section), has no analytics/conversion tracking wired up, and the demo
   video is a fixed asset rather than something regenerated automatically
   if `wordcloud-core.js`'s layout algorithm changes.
5. **Abuse/rate-limiting.** No rate limits on word submission or event
   creation yet — fine for a single-server local/small-scale launch, worth
   revisiting once this is public (e.g. a simple per-IP submission
   throttle, a cap on events created per hour).
6. **Consider whether `node:sqlite`'s experimental status is acceptable
   for production**, or whether to migrate to Postgres (schema is already
   written to make that easy) once real hosting is chosen.
