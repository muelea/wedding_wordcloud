# Instructions for coding agents

This file is for AI coding agents (Claude Code, Codex, Cursor, etc.) working
in this repo. Read `README.md` first for what the project is and how to run
it — this file is about how to work in it safely.

## Before you're done with any change

- Run `npm test` (137 tests, `node --test`). All must pass. Database-backed
  tests use isolated migrated Postgres schemas plus ephemeral ports and clean
  them up afterward, so they are safe to run repeatedly.
- If you touched `src/socket.js`, `test/isolation.test.js` passing is not
  optional — it's the test that proves one couple's event never leaks words
  or theme changes into another couple's display. See "Hard invariants"
  below.
- If you touched `src/wordBroadcasts.js`, `src/socketEventCache.js`,
  `src/socketOwnershipLoader.js`, `src/performanceProbe.js` or the Socket.io
  shutdown path in `server.js`, `test/phase7-socket-performance.test.js` must
  pass as well.
- If you touched guest contribution ownership in `src/socket.js` or
  `src/db.js`, both `test/isolation.test.js` and `test/words.test.js` must
  pass; they cover cross-event isolation and receipt-bound removal.
- If you touched personal photos/configuration types in `src/routes/events.js`,
  `src/mugPrint.js`, `public/configure.html` or `public/js/mug-editor.js`,
  both `test/configurator.test.js` and `test/storage-assets.test.js` must pass;
  they cover empty personal starts, decoded-image validation, private Storage,
  configuration isolation and immutable print output.
- If you touched `public/js/wordcloud-core.js` (the layout/export engine),
  `test/svg-export.test.js` and `test/export-font-metrics.test.js` must
  still pass — they check no dropped/duplicated/overlapping words and real
  font-metric usage.

## Hard invariants — don't undo these without asking

- **Socket.io is multi-tenant.** Every socket joins a room keyed by the
  event's slug before doing anything. Every emit is `io.to(slug).emit(...)`
  or `socket.to(slug).emit(...)`. **Never** `io.emit(...)` or a bare
  broadcast — that leaks one couple's words into every other couple's
  display. This is the single most important thing in the codebase not to
  regress.
- **Word broadcasts are committed, complete and bounded.** Successful submit
  and removal handlers schedule the shared `wordBroadcasts` coalescer only
  after Postgres commits; they do not query/broadcast independently. Each
  event has at most one complete update per 100 ms, reset fencing prevents a
  stale in-flight snapshot, and pending maps/timers stay explicitly bounded.
  Initial snapshot sharing is in-flight only, never a stale state cache.
- **Receipt hydration remains exact despite batching.** Connection storms may
  batch Postgres reads, but every result is keyed to the exact `(event_id,
  owner_id)` pair and is not cached after completion. Never return one
  browser's private removal receipts to another owner or event.
- **A guest can remove only that browser session's own contributions.** Each
  submitted word creates an unguessable receipt in `word_contributions`,
  bound to both the event and the anonymous `guestId`. Removal must continue
  to match all three values (`event_id`, receipt and owner); a missing receipt
  and somebody else's receipt must remain indistinguishable to callers. Never
  replace this with a decrement-by-word endpoint, which would let one guest
  remove another guest's vote.
- **Personal-memory configurations stay isolated from the event word cloud.**
  `configuration_type=personal_memory` starts with no event words and requires
  its own non-empty design. It must never silently fall back to `words` from
  the shared event. Photos live only in the private Supabase Storage bucket;
  immutable `design_json` contains opaque asset ids and never bytes, signed
  URLs or permanent public URLs. Keep the server checks: decoded JPEG/PNG/WebP
  with valid magic bytes, at most 1,600 px/2,560,000 pixels per upload, at most
  6 unique assets and at most 6 MiB stored bytes per complete design. Asset
  joins are transactional; non-active/foreign assets cannot be attached, and
  failed Storage deletion must retain its retryable object key.
- **The admin PIN fields in `public/create.html` (`#pin`, `#pin-confirm`)
  must stay `type="tel"`, not `type="password"`.** Two adjacent
  `type="password"` fields make Safari/Chrome treat the form as an account
  signup and offer to autofill/generate a strong (alphanumeric) password.
  That password then fails the PIN's `pattern="[0-9]*"` validation and the
  browser silently refocuses the field — looks exactly like a broken submit
  button, and cost real debugging time to track down. The dot-masking is
  done with CSS (`-webkit-text-security: disc`) instead, purely visual.
- **Reset has no reusable admin credential.** The PIN is submitted only in the
  JSON body of one reset request, verified asynchronously, and discarded. Do
  not restore an admin-token endpoint, browser token storage, accounts or a
  reusable session. Failed-attempt rows contain only an HMAC of the normalized
  source address, never the raw IPv4/IPv6 address.
- **Expired events look unknown and their slugs are never reused.** Public
  lookups filter `expires_at`; `reserved_event_slugs` survives event cleanup.
  Paid configurations and assets must detach before an event is deleted, and
  Storage objects must be removed before their last metadata row. A failed
  object deletion retains a retryable key.
- **Paid Printful files are frozen private artifacts.** Draft/live work uses
  only the opaque artifact-id/nonce application URL, never the editable
  configuration route or a Supabase object URL. Failed object operations keep
  retryable metadata, and support holds prevent deletion.
- **Fulfillment commits are lease-owned.** Claims persist `locked_by`,
  `locked_until` and a lease version. Shipment/order success or failure must
  match the current unexpired lease; provider ambiguity is reconciled by the
  same deterministic external ID before any retry write.
- **Maintenance is a bounded authenticated wake-up.** Never expose target IDs
  on `/internal/maintenance/run`, weaken its constant-time bearer check, or
  replace its completion heartbeat with an in-process-only timer. Printful
  callbacks verify the exact raw body and remain replay-safe.
- **Transactional email is durable and payment-independent.** A verified
  successful Stripe event stores payment, fulfillment work and one immutable
  confirmation job in the same transaction. Never call Resend inside the
  Stripe webhook, copy email into shipment recipients, or let email failure
  roll back payment/block fulfillment. Test payments always use email `mock`.
  Live retries reuse the permanent job dedupe key only inside the 23-hour
  safety window; signed raw-body Resend callbacks dedupe by `svix-id`, and
  stale lease owners cannot commit.
- **`.env` is never committed.** It's gitignored and holds real Stripe/
  Printful keys in some environments. If you need a new env var, add it to
  `.env.example` with an empty/placeholder value and document it in
  `README.md`'s env var table — never put a real secret in a file that gets
  committed.
- **Stripe/Printful must degrade gracefully when unconfigured**, not throw.
  Missing `STRIPE_TEST_SECRET_KEY`/`STRIPE_LIVE_SECRET_KEY` for the selected
  `STRIPE_PAYMENT_MODE` → checkout route returns a clear 501, not a
  crash. Missing `PRINTFUL_API_KEY` → `createPrintfulOrder()` logs
  `[printful:mock]` and returns a fake order id. Keep this behavior — it's
  what lets the rest of the app be tested/demoed without real payment
  accounts.

## Conventions

- Backend logic lives in `src/`, routes in `src/routes/`, static frontend in
  `public/`, tests in `test/` (one `*.test.js` per concern, using
  `node:test` — no external test framework).
- No build step. Plain CommonJS (`require`/`module.exports`), no bundler,
  no TypeScript. Keep it that way unless explicitly asked to change it —
  the project is intentionally low-dependency/low-ops.
- Postgres through one bounded `pg.Pool` is the production and test data layer.
  Keep SQL behind `src/db.js`, keep callers async/await, and evolve schema only
  through ordered files in `supabase/migrations/`; do not add an ORM or a
  SQLite test substitute.
- German is the user-facing language throughout (`public/*.html` copy, form
  labels, error messages). Keep new user-facing strings in German unless
  told otherwise.
- No accounts/login system for guests or couples. The admin PIN authorizes only
  one reset request at a time; it is not a session/cookie/JWT mechanism. Don't
  add a login system as a "nice to have."

## Where things deploy

The repository is GitHub `muelea/wedding_wordcloud`, `main` branch. Pushing
`main` is not a deployment action; the repository deployment workflow is
manual-only.

The Supabase/Postgres foundation and least-privileged runtime role are active.
The hosted test app is active at `https://wolkenworte.fly.dev` on one stateless
Fly Machine in Frankfurt with automatic stop/start; it is not the production
launch or custom domain. Local secrets stay in `.env`; hosted runtime secrets
belong in Fly Secrets, while the privileged `MIGRATION_DATABASE_URL` stays only
in local/CI migration tooling, never Fly. Do not deploy again or push branches
without explicit maintainer approval.
