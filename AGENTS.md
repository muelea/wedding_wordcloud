# Instructions for coding agents

This file is for AI coding agents (Claude Code, Codex, Cursor, etc.) working
in this repo. Read `README.md` first for what the project is and how to run
it — this file is about how to work in it safely.

## Before you're done with any change

- Run `npm test` (48 tests, `node --test`). All must pass. Each test file
  uses its own scratch SQLite file and ephemeral port, so it's safe to run
  repeatedly.
- If you touched `src/socket.js`, `test/isolation.test.js` passing is not
  optional — it's the test that proves one couple's event never leaks words
  or theme changes into another couple's display. See "Hard invariants"
  below.
- If you touched guest contribution ownership in `src/socket.js` or
  `src/db.js`, both `test/isolation.test.js` and `test/words.test.js` must
  pass; they cover cross-event isolation and receipt-bound removal.
- If you touched personal photos/configuration types in `src/routes/events.js`,
  `src/mugPrint.js`, `public/configure.html` or `public/js/mug-editor.js`,
  `test/configurator.test.js` must pass; it covers empty personal starts,
  image validation, configuration isolation and immutable print output.
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
  the shared event. Photos are embedded in the immutable `design_json`, not
  written to a public upload directory. Keep the server checks: JPEG/PNG/WebP
  magic bytes only, at most 6 images and at most 6 MiB decoded image data for
  the complete design. The opaque configuration id is the only public handle
  used by its immutable print-file route.
- **The admin PIN fields in `public/create.html` (`#pin`, `#pin-confirm`)
  must stay `type="tel"`, not `type="password"`.** Two adjacent
  `type="password"` fields make Safari/Chrome treat the form as an account
  signup and offer to autofill/generate a strong (alphanumeric) password.
  That password then fails the PIN's `pattern="[0-9]*"` validation and the
  browser silently refocuses the field — looks exactly like a broken submit
  button, and cost real debugging time to track down. The dot-masking is
  done with CSS (`-webkit-text-security: disc`) instead, purely visual.
- **`.env` is never committed.** It's gitignored and holds real Stripe/
  Printful keys in some environments. If you need a new env var, add it to
  `.env.example` with an empty/placeholder value and document it in
  `README.md`'s env var table — never put a real secret in a file that gets
  committed.
- **Stripe/Printful must degrade gracefully when unconfigured**, not throw.
  Missing `STRIPE_SECRET_KEY` → checkout route returns a clear 501, not a
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
- `node:sqlite` (Node's built-in, not `better-sqlite3`) is a deliberate
  choice — zero native-compile step. It's marked experimental (harmless
  warning on startup) but don't swap it for another DB driver without
  checking with a maintainer first.
- German is the user-facing language throughout (`public/*.html` copy, form
  labels, error messages). Keep new user-facing strings in German unless
  told otherwise.
- No accounts/login system for guests or couples — the admin PIN
  (`src/adminAuth.js`, short-lived signed token in `sessionStorage`) is the
  only auth, and it's intentionally lightweight (not a session/cookie
  system, not JWT/bcrypt). Don't add a login system as a "nice to have."

## Where things deploy

The repository is GitHub `muelea/wedding_wordcloud`, `main` branch. The app is
currently developed and tested locally; there is no active public production
deployment and pushing `main` must not be treated as a deployment action.

The next discussed infrastructure step is a Fly.io staging app using its
temporary `*.fly.dev` HTTPS address and one persistent volume for the current
SQLite database. A later move to Supabase/Postgres is being considered before
live operation, but neither Fly nor Supabase has been configured in this repo.
Do not add deployment infrastructure, migrate the database or push branches
without explicit maintainer approval. Local secrets stay in `.env`; future
hosted secrets belong in the hosting provider's secret store, never in Git.
