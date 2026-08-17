# Instructions for coding agents

This file is for AI coding agents (Claude Code, Codex, Cursor, etc.) working
in this repo. Read `README.md` first for what the project is and how to run
it — this file is about how to work in it safely.

## Before you're done with any change

- Run `npm test` (33 tests, `node --test`). All must pass. Each test file
  uses its own scratch SQLite file and ephemeral port, so it's safe to run
  repeatedly.
- If you touched `src/socket.js`, `test/isolation.test.js` passing is not
  optional — it's the test that proves one couple's event never leaks words
  or theme changes into another couple's display. See "Hard invariants"
  below.
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

GitHub `muelea/wedding_wordcloud`, `main` branch, deployed via Render.
Pushing to `main` ships to production — check with the maintainer before
pushing unless explicitly asked to. Production env vars (`ADMIN_TOKEN_SECRET`,
Stripe/Printful keys once real accounts exist) live in Render's dashboard,
not in this repo.
