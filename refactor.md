# Wolkenworte hosted-architecture refactor

This document is the implementation specification for moving Wolkenworte from
the current local SQLite application to a simple hosted foundation. It records
the decisions already made, the work that remains, the required order of work,
and the acceptance criteria. An implementation agent should follow it without
reopening the product or architecture decisions below.

## Objective

Keep Wolkenworte as one low-operations Node.js application while making its
state durable outside a single process or Machine. The result must:

- run against the same Postgres and object-storage technologies locally and
  when hosted;
- preserve strict event isolation and receipt-bound word removal;
- support Stripe Checkout and durable, idempotent Printful fulfillment;
- send durable, duplicate-safe transactional order and shipment email;
- avoid storing image bytes repeatedly in Postgres;
- allow the hosted Fly.io Machine to scale to zero before live launch;
- keep scheduled cleanup and due-job recovery working while that Machine is
  stopped;
- provide a straightforward path to more than one application Machine later;
- avoid accounts, a separate management portal, microservices, Kubernetes, and
  other infrastructure that the current product does not need.

No live deployment, database deletion, hosted-project creation, domain change,
secret change, payment-mode change, Printful write, or Git push is authorized
by this document alone. Those external actions still require an explicit
maintainer request. This document does authorize the repository refactor when
the maintainer asks an agent to implement it.

## Locked decisions

Do not ask the maintainer to choose these again unless implementation evidence
shows that a decision is technically impossible.

1. **Architecture:** one modular monolith: Express, Socket.io, API routes,
   Stripe webhooks, and the lightweight fulfillment loop remain in the same
   Node.js codebase.
2. **Hosted application:** Fly.io in Frankfurt (`fra`).
3. **Database:** Supabase Postgres in Frankfurt (`eu-central-1`). SQLite is
   removed from the application runtime after the migration.
4. **File storage:** one private Supabase Storage bucket for reduced personal
   photos and temporary paid print artifacts.
5. **Environments for now:** local and one hosted environment only. The hosted
   environment begins in test/mock mode and later becomes production after a
   one-time cleanup. Do not introduce a separate staging environment yet.
6. **Public event URL:** keep `/e/<slug>` and all existing nested event URLs.
   `/e/` is the event namespace and prevents collisions with `/start`, `/api`,
   `/impressum`, static assets, and future top-level pages.
7. **Administration:** no accounts, `/manage/<token>` route, or reusable admin
   session. The PIN protects only one action: resetting the event word cloud.
   The couple enters the PIN for each reset request. Theme changes do not require
   the PIN and must remain isolated to the relevant event.
8. **Event lifetime:** an event has one user-visible state: valid. It is valid
   until `expires_at`, which defaults to exactly 365 days after creation. There
   is no planned/live/archive/order state machine.
9. **Personal photo draft lifetime:** an unpaid `personal_memory`
   configuration expires 30 days after it is created. A newer immutable save
   gets its own new 30-day expiry.
10. **Paid print assets:** create and store finalized print artifacts only for
    paid fulfillment. Retain them through fulfillment and a 60-day support
    window, then delete them. Do not store optional user exports server-side.
11. **Browser storage:** browser state may remain a convenience for the basket,
    but it is never the only copy of paid-order inputs or fulfillment files.
12. **Fly pre-live behavior:** `auto_stop_machines = "stop"`,
    `auto_start_machines = true`, and `min_machines_running = 0`.
13. **Fly live behavior:** set `min_machines_running = 1` before accepting live
    payments or advertising live events.
14. **Initial Machine count:** one web Machine. Do not add Redis or a Socket.io
    cross-Machine adapter until a second Machine is actually introduced.
15. **Domain:** IONOS may remain the registrar/DNS provider. The application
    itself stays on Fly.io. Ordinary IONOS web hosting is not part of the
    runtime architecture.
16. **Database code style:** continue with CommonJS and handwritten SQL. Add
    `pg`; do not add an ORM or convert the project to TypeScript.
17. **Existing local SQLite contents:** they are development/test data and do
    not need to be imported into the new hosted database. Preserve the local
    file as an ignored backup during development, start Postgres clean, and do
    not commit database files.
18. **Scheduled wake-up:** Supabase Cron calls one authenticated, bounded
    maintenance endpoint for due fulfillment retries and retention cleanup. It
    may wake a stopped Fly Machine. Do not add a separate worker service for
    this initial architecture.
19. **Database connectivity:** the persistent Fly application uses a small
    `pg.Pool` over Supabase's direct IPv6 connection. Use the session pooler
    only as a fallback for an IPv4-only environment; do not use transaction
    pooling for functionality that depends on session state or
    `LISTEN`/`NOTIFY`.
20. **Buyer email:** keep the current single buyer-email field in Stripe-hosted
    Checkout. Do not add email fields for shipment recipients or duplicate the
    buyer-email input on Wolkenworte's shipping page. After payment, take the
    buyer email only from the verified Stripe Checkout event's
    `customer_details.email` and persist it on the order.
21. **Transactional email:** use Resend for Wolkenworte order confirmations,
    shipment notifications and refund/cancellation notices. Stripe's optional
    payment receipt remains a separate payment document and is never treated
    as the Wolkenworte contract/order confirmation.
22. **Email execution:** transactional email uses the same Postgres-backed
    durable-job loop and authenticated maintenance wake-up as fulfillment. Do
    not add a separate email worker service, queue product or customer-account
    system.

## Current application assessment

The existing implementation is a strong application prototype and should be
refactored, not rewritten.

Preserve these strengths:

- every Socket.io connection validates a slug and joins only that event room;
- every room broadcast is scoped with `io.to(slug)` or `socket.to(slug)`;
- every word contribution has an unguessable receipt bound to the event and
  anonymous browser owner;
- word increment plus receipt creation and receipt removal plus decrement are
  transactional;
- personal-memory configurations start empty and remain isolated from shared
  event words;
- immutable configurations freeze the design that the customer approved;
- Stripe Checkout uses server-calculated integer-cent amounts;
- checkout is re-estimated immediately before Stripe Session creation;
- Stripe signatures, event IDs, order state, and idempotency keys already guard
  duplicate payment handling;
- Stripe test payments can never create a real Printful order;
- Printful draft and confirmation writes are protected by independent switches;
- missing external credentials degrade clearly instead of crashing the app.

The current blockers are:

- `node:sqlite` is synchronous and tied to one local file;
- schema creation and ad-hoc migration run during module import;
- personal photo bytes are embedded as base64 inside every immutable
  `design_json`, so every save can duplicate up to approximately 8 MiB of JSON;
- the basket stores configuration references only in browser `localStorage`;
- the existing reusable 12-hour admin token and browser `sessionStorage` state
  add unnecessary complexity when reset is the only PIN-protected action;
- public event creation, reset PIN attempts, word submission,
  photo/configuration creation, Printful estimates, and checkout lack
  sufficient abuse controls;
- the finalized Printful `external_id` can exceed Printful's documented
  32-character maximum;
- fulfillment state is durable, but retry scheduling still relies partly on
  in-process timers;
- Stripe Checkout collects the buyer email, but the verified payment webhook
  does not yet persist it and Wolkenworte sends no durable order, shipment or
  refund confirmation;
- paid orders are linked to events with cascading deletion, which conflicts
  with deleting expired event data while retaining required commerce records;
- all application JavaScript is currently served with `immutable` caching even
  when its URL is not content-versioned;
- tax/VAT, real Printful artifact acceptance, signed Printful status webhooks,
  and the first controlled live draft remain launch gates.

## Target runtime

```text
Browser / wedding display
           |
           v
Fly Proxy (HTTPS, autostart)
           |
           v
One Wolkenworte Node.js Machine
  - Express pages and APIs
  - Socket.io rooms
  - Stripe webhook
  - lightweight durable-job loop
           |
           +----> Supabase Postgres
           |
           +----> private Supabase Storage
           |
           +----> Stripe Checkout API
           |
           +----> Printful API
           |
           +----> Resend API

Supabase Cron
           |
           +----> authenticated bounded maintenance request
                  (wakes Fly for due jobs and cleanup)
```

The web application is stateless except for connected sockets and short-lived
in-memory rate-limit/token-bucket data. Durable business data belongs in
Postgres or Storage. Fly's root filesystem must be treated as ephemeral.

## Work package 1: Postgres foundation

### Dependencies and configuration

Add only the dependencies needed for the selected approach:

- `pg` for Postgres access;
- `@supabase/supabase-js` for private Storage operations;
- `resend` for transactional customer email;
- `sharp` for bounded server-side image decoding, dimension validation and
  metadata-stripping normalization;
- a small established Express rate-limit package if preferred over a local
  middleware implementation.

Add and document these environment variables in `.env.example` and the README:

```text
DATABASE_URL=
MIGRATION_DATABASE_URL=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_STORAGE_BUCKET=wolkenworte-private
RATE_LIMIT_HMAC_SECRET=
MAINTENANCE_SECRET=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
RESEND_WEBHOOK_SECRET=
EMAIL_DELIVERY_MODE=mock
ALLOW_TEST_DATA_RESET=false
```

Remove `ADMIN_TOKEN_SECRET` from the application, `.env.example`, and the
environment-variable documentation. It is no longer needed because the target
architecture does not issue admin tokens.

Rules:

- `SUPABASE_SECRET_KEY` is backend-only and must never be emitted to the browser
  or included in public HTML/JavaScript. Use Supabase's current secret key, not
  the legacy JWT-based `service_role` key, for the hosted application.
- `DATABASE_URL` belongs to a least-privileged application role with only the
  runtime privileges Wolkenworte needs. `MIGRATION_DATABASE_URL` is used only
  by local tooling or the deployment workflow and is never required by the web
  process at runtime.
- Both hosted Postgres connections must use TLS with certificate and hostname
  verification (`sslmode=verify-full` or the equivalent `pg` configuration)
  and the Supabase project must enforce SSL for database connections. Install
  and trust Supabase's database CA certificate; never make a hosted connection
  work by setting `rejectUnauthorized: false`. The local Supabase stack may use
  its documented local non-TLS connection.
- `RATE_LIMIT_HMAC_SECRET` and `MAINTENANCE_SECRET` must be independent random
  secrets. Neither is reused as a Stripe, Storage, PIN, or database credential.
- `ALLOW_TEST_DATA_RESET` is absent or `false` everywhere except the temporary
  hosted-test cleanup window; it is never enabled in live operation.
- Hosted runtime secrets belong in Fly secrets. `MIGRATION_DATABASE_URL` is the
  exception: store it only in the CI/deployment system's secret store and never
  configure it as a Fly application secret, because Fly application secrets are
  available to ordinary web Machines. Local secrets remain in `.env`.
- Keep all existing Stripe and Printful safety variables.
- `EMAIL_DELIVERY_MODE` is `mock` or `live` and defaults to `mock`. A Stripe
  test payment always produces a mocked email result even if the hosted
  delivery mode is accidentally `live`. Missing Resend configuration degrades
  clearly to mock locally, but enabling live payments must fail readiness when
  live transactional email is not validly configured.
- `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are backend-only. Never expose
  them, full email bodies or buyer addresses in browser responses or logs.
- Validate hosted-required configuration once during startup and fail with a
  clear message for an invalid production configuration. Continue to degrade
  gracefully when Stripe or Printful is intentionally unconfigured locally.

### Local Supabase

Initialize Supabase CLI configuration in the repository and commit the
`supabase/` configuration and SQL migrations, never its generated local data.

The documented local startup becomes:

1. start the local Supabase stack;
2. apply/reset committed migrations;
3. start Wolkenworte with local `DATABASE_URL`, `SUPABASE_URL`, and local
   secret key;
4. use Stripe CLI/test keys when testing checkout;
5. keep Printful fulfillment in `mock` unless performing an explicitly approved
   controlled draft test.

### Database module

Replace `DatabaseSync` with one shared `pg.Pool`. Keep the data-access boundary
in `src/db.js` or split it into small domain-specific files only if the single
file becomes materially difficult to maintain. Do not expose raw SQL to route
or Socket.io code.

All database functions become asynchronous. Update every caller to `await`
them and propagate errors to the existing sanitized responses. Never perform a
database promise without awaiting or deliberately scheduling it.

For multi-statement transactions:

1. acquire one client from the pool;
2. `BEGIN`;
3. execute every statement through that client;
4. `COMMIT`;
5. `ROLLBACK` on error;
6. release in `finally`.

Do not use pool-level queries for statements inside a transaction.

The hosted pool must use the direct Supabase connection because Fly Machines
are persistent application servers. Configure an explicit small `max`,
`connectionTimeoutMillis`, `idleTimeoutMillis`, an application name, and
bounded query/statement timeouts. Size the total possible connections across
all future Machines below the database plan's connection allowance. Handle an
idle-client error without crashing silently and close the pool during graceful
shutdown.

Postgres `bigint`/`int8` values are returned by `pg` as strings. Treat database
IDs as opaque strings at the data-access boundary and do not coerce them to
JavaScript numbers. Structured snapshots and designs should use `jsonb` unless
exact byte-for-byte JSON serialization is a documented requirement.

Add one centralized async Express error boundary so rejected database promises
cannot become unhandled rejections or leak SQL details. Socket handlers keep
their existing event-scoped sanitized error behavior.

### Versioned migrations

Move all schema creation and evolution to ordered files under
`supabase/migrations/`. Application startup may check connectivity and required
migration version, but must not run `CREATE TABLE` or `ALTER TABLE` statements.

Migrations run with a dedicated privileged migration connection before the
corresponding application version is activated. The web process connects with
a separate least-privileged application role. Hosted deployment must document
and automate this order; do not rely on a developer remembering to run SQL
after a Fly deploy. After the first launch, schema changes use an
expand/backfill/switch/contract sequence so the previous and next application
versions can overlap safely during a rolling deployment. Migration failure
must prevent the incompatible application release from becoming ready.

Port the existing tables and constraints while making these intentional
changes:

- use Postgres identity/bigint columns for current integer primary keys;
- use `timestamptz` for all timestamps;
- give `events.expires_at` a non-null value exactly 365 days after
  `created_at`; set both consistently in the insert or a database trigger
  because a Postgres column default cannot reference another column;
- allow retained paid orders to outlive events; make `orders.event_id`
  nullable and use `ON DELETE SET NULL`, not `ON DELETE CASCADE`;
- allow immutable configurations required by retained paid order items to
  outlive events; make `configurations.event_id` nullable with `ON DELETE
  RESTRICT`, not cascade. Expiration cleanup explicitly deletes unpaid
  configurations and explicitly sets retained paid configurations' `event_id`
  to null before deleting the event;
- store an `event_slug_snapshot` and any customer-facing event label needed by
  a retained order so order support does not require the event row;
- retain unique constraints on event slug, `(event_id, word)`, Stripe Session,
  quote-to-order association, and Stripe webhook event ID;
- retain indexes that support contribution ownership, event/configuration
  lookup, pending job claims, expiration cleanup, and order status lookup;
- remove SQLite-only `rowid`, `datetime('now')`, `PRAGMA`, `AUTOINCREMENT`, and
  `?` placeholder assumptions;
- preserve opaque existing string IDs for receipts, configurations, and quotes.

### Normalized paid commerce references

Do not use `orders.configuration_ids_json` or shipment `items_json` as the only
relationship between retained commerce data and immutable configurations.
Ephemeral checkout quotes may keep validated JSON snapshots, but converting a
quote into an order must create normalized `order_items` rows in the same
transaction as the order.

`order_items` contains at least:

```text
id                    bigint identity primary key
order_id              retained order foreign key with cascade deletion
configuration_id      nullable configuration foreign key with restrict deletion
shipment_index        integer
item_index            integer
product_key           text snapshot
printful_variant_id   integer snapshot
quantity              integer snapshot
configuration_snapshot_json jsonb
created_at            timestamptz
unique (order_id, shipment_index, item_index)
```

The item snapshot must contain every trusted product, placement, geometry and
design reference needed for support and fulfillment after the event row is
gone. Keep the configuration reference while re-rendering or support may still
need it. Once that retention window ends, an explicit cleanup step may set the
reference to null before deleting the configuration; it must never disappear
through an accidental cascade.

`orders` also stores one nullable `buyer_email` obtained from
`session.customer_details.email` in the verified successful Stripe webhook.
It is the purchaser/contact address for the complete order, not an address for
any individual shipment recipient. Validate and length-bound it before storage.
Never accept a browser-supplied email during the post-payment status request,
and do not require a Stripe Customer object for one-time guest checkout.

Postgres word operations must preserve the exact current semantics. The
aggregate upsert remains atomic. Contribution insert plus aggregate increment
and owned receipt removal plus aggregate decrement remain transactions.

### Concurrency requirements

Do not translate the SQLite multi-statement sequences literally and assume
that `BEGIN` alone provides the same behavior under concurrent Postgres
requests.

- Owned contribution removal uses `DELETE ... RETURNING` for the matching
  `(event_id, receipt_id, owner_id)` row and locks the aggregate word row with
  `SELECT ... FOR UPDATE`, or uses an equivalent single atomic statement,
  before decrementing/deleting it.
- Archive plus word-cloud reset is one transaction. A correct PIN request
  cannot leave an archive without a reset or a reset without its archive.
- Event creation inserts the reserved slug and event in one transaction. The
  unique constraint remains the final arbiter and slug generation retries a
  unique-conflict race with a new suffix.
- Order creation claims one quote in the database and keeps the existing Stripe
  idempotency key. A concurrent request must return the one stored Checkout
  Session rather than issuing another external request.
- Stripe Checkout creation must also survive the process or database failing
  after Stripe accepted the request but before the returned Session id was
  attached to the order. Before the first Stripe call, persist the exact frozen
  request inputs, idempotency key, first-attempt time and a deterministic Session
  expiry. A stalled `creating_checkout` state is recoverable: every automatic
  retry reuses the same request parameters and idempotency key while that key is
  safely inside Stripe's retention window. If the result is still ambiguous near
  that boundary, block the attempt rather than issuing a new key; a fresh attempt
  may begin only after the possibly-created Session is known to be expired or an
  operator has reconciled it.
- A signature-verified successful Stripe webhook may reconcile this crash window
  when `stripe_session_id` has not yet been stored. It resolves the candidate
  order from the Session's `orderId` and `quoteId` metadata, then verifies the
  order state, checkout mode, amount, currency and payment status before
  atomically attaching the Session id and recording payment. Metadata never
  bypasses those trusted-order checks.
- Configuration creation, order creation and cleanup lock or mark the affected
  rows so an asset/configuration cannot become paid while it is being deleted.

Add integration tests for concurrent submission, concurrent owned removals,
reset-versus-submission, duplicate quote checkout, duplicate Stripe events,
cleanup-versus-order creation, and a forced interruption after Stripe accepts a
Checkout Session but before the Session id is persisted. The interrupted case
must recover one Session and one paid-order transition without creating a second
Stripe Session.

### Test isolation

The final test suite must exercise Postgres, not silently retain SQLite as a
test-only behavioral substitute.

Each database test file must receive an isolated Postgres schema named from the
process ID plus a random suffix. Apply migrations into that schema, configure
the test pool's `search_path`, and drop the schema in test cleanup. This keeps
parallel `node:test` files isolated. CI and documented local testing must start
the Supabase local stack before `npm test`.

Keep schema-relative application migrations separate from project-global
Supabase setup such as extensions, Cron jobs and Storage bucket declarations,
so per-file schemas can apply the application schema without racing to recreate
global infrastructure. Storage integration tests use unique object-key prefixes
and remove their objects in test cleanup.

## Work package 2: normalize photo storage

### Storage model

Create a private Storage bucket named by `SUPABASE_STORAGE_BUCKET`. Do not make
the bucket public.

Add a `design_assets` table with at least:

```text
id                    opaque random text primary key
event_id              nullable event foreign key with restricted deletion
uploader_owner_id     anonymous guest/event owner identifier
object_key            unique text
mime_type             validated JPEG, PNG, or WebP
byte_size             integer
sha256                text
storage_status        uploading, active, deleting or delete_failed
deletion_attempts     integer
last_delete_error     nullable sanitized text
created_at            timestamptz
expires_at            timestamptz
deleted_at            nullable timestamptz
```

Add a `configuration_assets` join table:

```text
configuration_id      configuration foreign key with cascade deletion
asset_id              design asset foreign key with restrict deletion
primary key (configuration_id, asset_id)
```

`design_assets.event_id` is nullable and must use `ON DELETE RESTRICT`, not
cascade. Event cleanup explicitly removes unreferenced Storage objects and
their metadata before deleting the event. Assets referenced by a configuration
that must survive for a retained paid order are explicitly detached by setting
their `event_id` to null under the same locked cleanup operation. Only then may
the event be deleted. This prevents both database cascades that orphan bytes
and foreign-key references that would otherwise keep expired events forever.

An immutable configuration stores asset IDs in `design_json`, never a data URL
or raw image bytes. Multiple configuration revisions may reference the same
asset, so saving an edited design does not upload or duplicate the photo.

### Upload flow

Add one backend upload endpoint under the existing event namespace. It may
accept one browser-reduced data URL per request to minimize frontend change:

```text
POST /api/events/:slug/assets
```

Required behavior:

1. accept only a bounded JSON body for one reduced image;
2. decode the base64 payload server-side;
3. validate actual JPEG, PNG, or WebP magic bytes;
4. use a bounded server-side image decoder to prove that the file is valid,
   reject a longest side above 1,600 pixels or more than 2,560,000 total pixels,
   and never trust the browser-side reduction as the enforcement boundary;
5. normalize/re-encode the accepted image before Storage, preserving
   transparency where applicable and stripping metadata;
6. enforce the existing browser source and server decoded-file-size rules;
7. calculate SHA-256 and byte size from the normalized stored bytes;
8. create a metadata row with an unguessable event-scoped object key and
   `storage_status=uploading` before making the non-transactional Storage call;
9. upload the object, then atomically mark the row `active` with its 30-day
   expiry;
10. if upload/finalization fails, retain a discoverable cleanup row rather than
   losing the object key; never leave an untracked Storage object;
11. return only the opaque asset ID and a short-lived preview URL after the row
   is active;
12. never return a Supabase secret key or permanent public object URL.

At configuration creation, the server must validate that:

- every referenced asset exists, is `active`, and belongs to the same event;
- at most six unique photos are referenced across the entire configuration;
- referenced decoded bytes total at most 6 MiB;
- personal-memory designs remain non-empty;
- event-wordcloud designs still cannot import personal photos accidentally;
- configuration-to-asset join rows are inserted in the same transaction as the
  configuration.

When editable configuration data is returned, materialize short-lived signed
preview URLs in the response without writing them into stored `design_json`.
Update the Fabric editor serialization so a photo retains its `assetId` across
loads, edits, surface changes, copies, and immutable saves.

An upload that has not yet been attached to a configuration still counts
against the guest/event upload ceilings. Limit the number and total decoded
bytes of active unattached assets per anonymous guest/event so repeated uploads
cannot create unbounded private Storage cost. Unattached assets may use a
shorter cleanup grace period than the 30-day configuration lifetime, but never
delete an asset that a surviving configuration references.

### Cleanup

Supabase Cron calls an authenticated endpoint such as:

```text
POST /internal/maintenance/run
```

The request must be authenticated with `MAINTENANCE_SECRET` using a
constant-time comparison, accept no customer-controlled target IDs, process a
bounded batch synchronously before returning, and expose no cleanup details to
unauthenticated callers. Calling the public Fly hostname intentionally wakes a
scaled-to-zero Machine. Cron run failures and maintenance failures must remain
visible to monitoring.

`pg_net` is asynchronous, so a successful Supabase Cron invocation proves only
that the HTTP request was queued, not that Fly received it or that maintenance
completed. Persist a small `maintenance_runs` record or equivalent heartbeat
with start time, completion time and sanitized outcome. Monitoring must alert
when no successful completion occurs within two expected Cron intervals and
must also surface `pg_net` timeout/non-2xx response results. Do not put target
IDs, object keys, addresses or other customer data in these run records.

Store the Cron caller's copy of `MAINTENANCE_SECRET` in Supabase Vault or an
equivalent hosted secret facility. Migrations may refer to the Vault secret by
name but must never contain the value. Rotating the secret updates both Fly and
the Cron caller in a coordinated hosted-test step.

Do not rely on `pg_net`'s short default HTTP timeout. The committed Cron SQL
must call `net.http_post(..., timeout_milliseconds := 30000)` explicitly, with
the Fly URL and `MAINTENANCE_SECRET` read from their configured secret sources
rather than embedded in the migration. The maintenance handler has a hard
15-second wall-clock work budget per request. This leaves headroom inside the
30-second caller timeout for a stopped Fly Machine to start, routing and the
HTTP response, and also keeps work below Fly's configured shutdown grace
period. Storage and provider calls made by the batch need their own bounded
timeouts within that 15-second budget.

If a job cannot finish within the handler budget, it must checkpoint safely
under its lease and remain due/recoverable rather than leaving an untracked
asynchronous promise after the response ends. Tests must inspect the installed
Cron definition and prove that the explicit 30-second timeout is present; a
hosted smoke test must prove that a Cron request can wake a stopped Machine and
complete a bounded batch within it.

The maintenance operation must:

- find expired, unpaid personal configurations;
- delete configuration rows only when no order that must be retained references
  them;
- delete a Storage photo only when no surviving configuration references its
  asset row;
- delete the Storage object before deleting its final metadata row;
- record and retry failed object deletions instead of losing the object key;
- remain idempotent when run repeatedly.

Storage objects are deleted only through the Supabase Storage API, never by
deleting rows from the `storage` schema. Use this recoverable state transition:

1. claim an eligible row in Postgres and mark it `deleting` only after
   rechecking references under a row lock;
2. reject new references to any non-`active` asset;
3. delete the object through the Storage API;
4. after success, delete or tombstone the application metadata;
5. after failure, mark `delete_failed`, retain the object key and sanitized
   error, and schedule another attempt.

The same maintenance request may drain due fulfillment jobs and retention work,
but each queue has its own batch and time budget so one class cannot starve the
other. Do not use a Fly in-process timer as the only expiration mechanism.

## Work package 3: event expiration

Keep expiration invisible and simple to users.

- Every new event gets `expires_at = created_at + 365 days`.
- All public event lookups treat expired events as unavailable.
- Use the current unknown-event/404 experience for both unknown and expired
  slugs; do not reveal whether an expired private event once existed.
- Do not add wedding-date input, lifecycle controls, extensions, warning email,
  or multiple event states in this refactor.
- The Cron-triggered maintenance operation deletes expired event content:
  words, contributions, archives, unpaid quotes, unpaid configurations, and
  unreferenced photo assets.
- Paid orders and required commerce records survive through nullable
  `orders.event_id`, snapshots, and non-cascading retention. Before deleting an
  event, cleanup explicitly sets `event_id` to null on configurations referenced
  by retained order items and on assets referenced by those surviving
  configurations. This detachment and the deletion eligibility checks occur
  under the same locks used to prevent cleanup-versus-order races.
- Do not reuse an expired slug for another event. Keep a small slug tombstone
  table if deleting the event row would otherwise make reuse possible.

Add a `reserved_event_slugs` table containing the slug and original creation
time. Insert into it in the same transaction as event creation and never delete
these rows during ordinary expiration cleanup. Slug generation checks this
table, not only active events.

## Work package 4: administration and abuse controls

### PIN-protected reset only

Do not add accounts, login pages, email magic links, owner tokens, a separate
management URL, or an admin session. The PIN exists only to authorize resetting
the event word cloud.

Simplify the current flow as follows:

- remove `src/adminAuth.js` and the reusable signed admin-token mechanism;
- remove `POST /api/events/:slug/admin/verify`;
- stop returning an `adminToken` when an event is created;
- remove all `admin-token:<slug>` browser `sessionStorage` handling;
- keep `POST /api/events/:slug/reset`, but make its JSON body `{ "pin": "1234" }`;
- verify the PIN for that reset request only, perform the reset, and immediately
  discard the submitted PIN;
- return the same generic authentication failure for a missing or wrong PIN so
  the response does not reveal useful authentication details.

The PIN itself remains valid for the event's complete lifetime; there is no
12-hour PIN expiration. It must remain stored only as a salted hash in the
database. Never store the clear PIN in browser storage, logs, or persistent
server state.

### Theme changes

Theme changes are intentionally not an admin action. Preserve the existing
validated Socket.io `theme-change` behavior and its strict event-room isolation.
Do not require a PIN or introduce a separate theme API merely for authorization.

### Limits

Add configurable conservative defaults. Exact initial defaults are:

- event creation: 5 per source IP per hour;
- reset PIN verification: 5 failed attempts per source IP and event in 15 minutes,
  followed by a 15-minute block;
- word submission: burst of 3 per second, 30 per minute, and at most 100 active
  contributions per anonymous guest/event, plus 300 submissions per source
  IP/event per minute;
- word removal: 60 per minute per anonymous guest/event;
- theme changes: 10 per anonymous guest/event per minute and 60 per event per
  minute;
- Socket.io connections: at most 500 active sockets per event and 300 per source
  IP/event;
- event content: at most 5,000 active contributions and 500 unique active words
  per event;
- asset upload: 12 per anonymous guest/event per hour and 300 per source
  IP/event per hour;
- active unattached assets: at most 12 and at most 12 MiB decoded bytes per
  anonymous guest/event;
- unpaid personal Storage per event: at most 2,000 active assets and 1 GiB of
  decoded bytes across active assets;
- configuration creation: 30 per anonymous guest/event per hour and 300 per
  source IP/event per hour;
- unpaid configuration revisions: at most 2,000 active revisions per event;
- Printful cost estimates: 20 per anonymous guest/event and 200 per source IP
  per 10 minutes;
- checkout attempts: 10 per anonymous guest/event and 100 per source IP per
  10 minutes.

Word limits are enforced in the socket process using a token bucket and a
database count for the 100-active-contribution ceiling. Failed reset PIN
attempts must be durable enough that restarting or scaling the web process does
not reset brute-force protection; store hashed-IP/event failure buckets in
Postgres. Other HTTP limits may begin as per-process middleware while only one
Machine exists.

Enforce event-wide database ceilings under an event row lock, advisory lock or
equivalent atomic counter so simultaneous sockets cannot all pass a stale
`COUNT(*)` check. At the unique-word ceiling, increments of existing words may
continue while brand-new unique words receive the stable limit response.

The anonymous guest ID is not trusted as the only abuse-control identity
because a caller can rotate it. The higher IP and event ceilings are secondary
backstops. They are intentionally generous because many legitimate wedding
guests share one venue NAT address. Return a stable sanitized error when a
limit is reached and never partially write the operation.

Resolve the source IP explicitly. On Fly without another proxy in front, use
the Fly-provided client-IP header; locally use the socket remote address.
Normalize IPv4 and IPv6 representations. Do not let an arbitrary
`X-Forwarded-For` value control rate limiting, and replace the current blanket
`app.set('trust proxy', true)` with an explicit trusted-proxy policy before
depending on `req.ip`.

For rate-limit identity, use the complete normalized IPv4 address but mask IPv6
addresses to their `/64` network prefix before applying the HMAC. This prevents
ordinary IPv6 privacy-address rotation within one assigned network from
bypassing the source limits. Store only the resulting HMAC, never either raw
address representation.

Hash IP addresses with an environment-secret HMAC before durable storage. Do
not retain raw IP addresses for rate limiting. Clean expired buckets.

Per-process HTTP/token-bucket limits are acceptable only while exactly one web
Machine exists. Moving to a second Machine requires a shared or durable store
for all security-relevant limits in addition to the Socket.io adapter and
session affinity.

Convert PIN hashing/verification to asynchronous `crypto.scrypt` so malformed
or brute-force requests cannot repeatedly block the Node event loop. Preserve
the existing hash format or provide a safe migration path for existing hashes.
Check the durable failure bucket before starting `scrypt`, and cap concurrent
PIN derivations so brute force cannot merely move the denial of service from
the event loop to the libuv worker pool.

## Work package 5: print artifacts and fulfillment

### Before payment

Continue to generate configuration SVG dynamically for preview/edit flows. A
photo-free design does not need a stored print artifact before payment. Do not
save optional event SVG downloads server-side.

### After payment

Add a `print_artifacts` table with at least:

```text
id                    opaque random text primary key
order_id              retained order foreign key
order_item_id         retained order-item foreign key
configuration_id      nullable configuration reference
surface_key           text
object_key            unique text
mime_type             text
byte_size             integer
sha256                text
access_nonce          opaque random text
storage_status        uploading, active, deleting or delete_failed
deletion_attempts     integer
last_delete_error     nullable sanitized text
created_at            timestamptz
expires_at            timestamptz
deleted_at            nullable timestamptz
unique (order_item_id, surface_key)
```

The durable fulfillment job must, before calling Printful:

1. claim the paid order atomically;
2. render each required immutable surface from persisted configuration and
   private photo objects;
3. create or reuse the deterministic metadata/object-key row in `uploading`
   state through the `(order_item_id, surface_key)` uniqueness boundary;
4. upload the exact artifact to the private bucket, then mark the same row
   `active`; a failed upload remains discoverable and retryable;
5. build a stable public HTTPS application URL containing the opaque artifact
   ID and nonce;
6. pass that URL to Printful;
7. reuse the same artifact and Printful external ID on retries.

Draft creation must preserve the existing `update_existing=true` behavior. A
deterministic external ID is a duplicate boundary, but it is not by itself a
complete recovery procedure. If a Printful create or confirm request times out,
the connection drops, or the process stops after Printful may have accepted the
request, the next leased attempt must first retrieve the order by its external
ID and reconcile the provider status. It may retry draft creation with
`update_existing=true` only when no matching order exists, and may retry
confirmation only when the reconciled order is still an unconfirmed draft. If
Printful already accepted or submitted the order, persist that result instead
of issuing another write. Never recover an ambiguous attempt by generating a
new external ID, and only the current lease owner may commit the reconciled
result.

Provide a route such as:

```text
GET /api/print-files/:artifactId/:nonce
```

It validates both opaque values, checks that the artifact is still active, and
streams the private object with the correct content type. Invalid, expired, and
deleted artifacts all return the same 404 response. Do not expose a bucket URL
or Supabase credential. A Printful request to this route must be able to wake a
scaled-to-zero Fly Machine.

The stored high-entropy `access_nonce` is the artifact URL capability. Do not
also add a global artifact-signing secret unless the URL design is deliberately
changed to stateless HMAC signatures; one mechanism is sufficient. Never place
the nonce in ordinary request logs.

### Retention

Set paid artifact expiry when fulfillment reaches the appropriate shipment or
completed state. Keep the artifact for 60 days after that state. If no useful
delivery-complete event is available, use 90 days after Printful submission as
the safe fallback. A support hold prevents deletion.

Cleanup follows the same object-first, metadata-second, idempotent retry rules
as photo cleanup.

### Printful identifiers

Replace the current long IDs with deterministic values no longer than 32
characters. Use this shape:

```text
order/shipment external_id = "ww_" + first 24 base64url characters of
  SHA-256("order:<order id>:quote:<quote id>:shipment:<index>")

item external_id = "wi_" + first 24 base64url characters of
  SHA-256("order:<order id>:quote:<quote id>:shipment:<index>:item:<index>")
```

The same logical retry must produce the same IDs. Add unit tests for length,
allowed characters, uniqueness across shipments/items, and stability.

### Durable job loop

Keep fulfillment in the same application initially. Replace reliance on
startup-only recovery and transient timers with a Postgres-backed claim loop:

- webhook transaction records successful payment and pending fulfillment;
- webhook returns promptly after durable persistence;
- the app immediately schedules an attempt when awake;
- a short polling loop claims due jobs while the app is running;
- Supabase Cron invokes the authenticated maintenance endpoint so a due job can
  wake a stopped Machine; the endpoint holds the request open only for its
  bounded processing budget and does not return before its claimed batch has
  been completed or safely checkpointed;
- claims use a Postgres atomic update or `FOR UPDATE SKIP LOCKED` to select work,
  then persist `locked_by`, `locked_until` and a lease/version token before the
  claim transaction commits;
- a worker renews the lease for a legitimately long attempt and only the lease
  owner may commit its result; an expired lease makes interrupted work
  claimable again;
- jobs store `next_attempt_at`, attempt count, last sanitized error, and a final
  `blocked`/manual-review state;
- process restart or Machine sleep cannot lose a job;
- Stripe idempotency and Printful's deterministic external IDs remain external
  duplicate guards; ambiguous Printful create/confirm outcomes are reconciled
  by external ID before any retry as specified above.

Do not create a separate Fly worker Machine in the initial architecture.
Limit fulfillment concurrency initially (one order or a small measured number
per Machine) so canvas rendering and external calls cannot starve Socket.io.
The polling loop is an optimization for an awake Machine, not the only retry
trigger.

### External launch gates

Do not enable live Printful confirmation until all of these have been completed
with explicit maintainer approval:

- controlled Printful draft using every supported placement type that can
  differ materially, including two-sided products;
- verification that Printful accepts the chosen SVG or a switch to final PNG;
- confirmation that Printful successfully downloads the frozen artifact URL;
- signed Printful v2 webhook implementation and replay-safe status handling;
- VAT/OSS, invoicing, refund, and customer-tax review;
- verified Resend sending domain, durable Wolkenworte order confirmation and
  a successful delivered/bounced email smoke test;
- verification that Stripe's successful-payment and refund receipts are
  configured as the separate payment receipts intended by the maintainer;
- real product-margin review;
- live Stripe webhook and fulfillment alerting.

### Controlled provider smoke path

The hosted test environment needs an explicit operator-only way to complete the
real Resend and Printful launch-gate checks without weakening the rule that
Stripe test payments always use mock fulfillment and mock email delivery.

Implement a guarded CLI command or one-off deployment-runner command, never a
public HTTP route. Each invocation requires an explicit confirmation flag and
refuses to run while Stripe live payments are enabled. It uses synthetic hosted
test data only and records a sanitized smoke outcome for the launch checklist.

The email smoke path:

- renders the same Wolkenworte order-confirmation template from a synthetic,
  immutable order snapshot;
- sends through the same Resend client, idempotency-key, tag and signed-webhook
  reconciliation code used by durable email jobs;
- accepts only an explicitly supplied, allowlisted maintainer/test recipient;
- can exercise delivered and bounced outcomes without creating a Stripe payment;
  and
- cannot be invoked by the web process or turn an ordinary test-payment email
  job into a real send.

The Printful smoke path:

- renders and stores artifacts through the same paid-artifact pipeline used by
  fulfillment;
- creates only an explicitly approved Printful draft from a synthetic order and
  verifies that Printful downloads the capability URL;
- requires draft mode plus the existing order-write safety switch and refuses to
  run if `PRINTFUL_CONFIRM_LIVE_ORDERS=true`; and
- never confirms, charges or submits the draft for production.

These commands are controlled verification tools, not alternate payment or
fulfillment paths. Their synthetic rows and objects are included in the guarded
pre-live cleanup.

## Work package 6: buyer contact and transactional email

Keep one buyer contact address per order. Stripe-hosted Checkout continues to
ask the purchaser for it; Wolkenworte's shipping form continues to collect only
recipient names and postal addresses. Apple Pay, Link and card checkout may
prefill the buyer address, but the authoritative value is always
`session.customer_details.email` from a signature-verified successful Stripe
event.

Extend the successful-payment transaction so it:

1. records the payment and normalized, length-bounded buyer email on the order;
2. creates the pending fulfillment job; and
3. creates exactly one pending `order_confirmation` email job.

Commit all three before acknowledging the Stripe webhook. Do not call Resend or
Printful inside the webhook request. A missing buyer email must not undo an
already verified payment or cause endless Stripe retries: persist the payment,
mark the email task `blocked`, alert for manual review, and continue fulfillment.

Add an `email_jobs` table with at least:

```text
id                    bigint identity primary key
order_id              retained order foreign key with restrict deletion
shipment_id           nullable retained shipment foreign key with restrict deletion
kind                  order_confirmation, shipment_confirmation,
                      refund_confirmation or cancellation_confirmation
dedupe_key            unique stable text
recipient_email       text
locale                supported locale snapshot
subject               text snapshot
html_body             text snapshot
text_body             text snapshot
status                pending, processing, sent, delivered, bounced,
                      complained, failed or blocked
provider_message_id   nullable unique text
attempt_count         integer
next_attempt_at       timestamptz
first_send_attempt_at timestamptz
locked_by             nullable text
locked_until          nullable timestamptz
lease_version         integer
last_error            nullable sanitized text
sent_at               nullable timestamptz
delivered_at          nullable timestamptz
bounced_at            nullable timestamptz
complained_at         nullable timestamptz
created_at            timestamptz
updated_at            timestamptz
```

The permanent database `dedupe_key` is the primary duplicate-job guard. Pass
that same stable value as the Resend idempotency key for every attempt and add
the non-PII email-job id as a Resend tag so a signed webhook can reconcile a
send whose API response was lost. Provider-side idempotency is an additional
safeguard, not a replacement for the unique database constraint.

Resend retains idempotency keys for 24 hours, so the application must not claim
an unlimited exactly-once guarantee. Persist `first_send_attempt_at`
immediately before the first provider request. Automatic retries after a
timeout or other ambiguous response may reuse the same key only until 23 hours
after that timestamp, leaving a one-hour safety margin inside Resend's window.
A signed webhook carrying the email-job tag may reconcile the job, persist its
`provider_message_id` and finish the appropriate state transition even when
the original API response never arrived. If the delivery outcome is still
unknown at the 23-hour boundary, set the job to `blocked`, record a sanitized
`delivery_outcome_unknown` reason and alert for manual provider review. Never
automatically issue a new idempotency key or blindly resend such a job after
the boundary. A confirmed provider rejection before acceptance may follow the
ordinary bounded retry policy.

Claims, leases, retries, bounded batches and Cron wake-up otherwise follow the
same rules as fulfillment jobs. Email failure never rolls back payment and
never blocks Printful fulfillment, but exhausted or delivery-ambiguous order
confirmation attempts become `blocked` and alert support.

The order confirmation is sent after the verified payment is durably recorded;
it does not wait for Printful to manufacture, accept or ship the product. The
German canonical version and every translation must include at least:

- Wolkenworte order number, order/payment date and buyer contact address;
- immutable products, variants, quantities and a clear design/order reference;
- item subtotal, shipping, tax/VAT, currency and total;
- every delivery address represented by the order;
- Wolkenworte seller identity and support contact;
- the reviewed contract-formation wording and personalization/withdrawal
  information; and
- the exact applicable contractual information in the message or an attached
  immutable document, not only links to web pages whose content can change.

Whether a tax invoice is attached to the same message or sent separately is
decided by the invoicing/tax review. A Stripe payment receipt may also be sent,
but it proves payment and does not replace this Wolkenworte confirmation.

The signed, replay-safe Printful webhook creates one
`shipment_confirmation` job per actual shipment when tracking is available.
The message contains the Wolkenworte order number, shipped items, carrier and
tracking link. Split shipments may therefore create more than one shipping
email, each with a shipment-specific dedupe key. A recorded refund or
cancellation creates the corresponding transactional notice exactly once.
These messages use the buyer email; shipment recipients never receive email.

Add one signature-verified Resend webhook endpoint. Deduplicate its
at-least-once deliveries by the Resend `svix-id` header. Resolve the email job
by the stored `provider_message_id` or the non-PII email-job tag, then use sent,
delivered, bounced, failed and complained events to reconcile the job and raise
appropriate alerts. Webhook transitions must tolerate retries and out-of-order
delivery without moving a terminal failure state backward. `complained` is a
terminal status, records `complained_at` and alerts support; it never transitions
back to sent or delivered. Do not track opens or clicks for these required
transactional messages. Do not add newsletters, marketing consent or
contact-list functionality.

Tests must prove that duplicate Stripe, Printful and Resend events cannot create
duplicate jobs or provider requests; an accepted send with a lost API response
is reconciled by its job tag or safely retried with the same key inside the
23-hour window; an unresolved ambiguous send becomes `blocked` before that key
can expire and is not automatically resent; a restart after claiming a job is
recoverable; a stale lease owner cannot overwrite a successful retry; test
payments never contact Resend; multiple shipment recipients do not create
recipient-email fields; and email failure does not block fulfillment.

## Work package 7: Socket.io performance and future scale

Keep one Machine initially. Preserve HTTP long-polling fallback because wedding
venue networks may be restrictive.

Optimize current room broadcasts without changing visible behavior:

- the first connection still receives a complete state snapshot bounded by the
  configured per-event content ceilings;
- coalesce submissions/removals for the same event into at most one complete
  room update per 100 milliseconds;
- fetch and broadcast only after the transaction commits;
- never combine or leak state across slugs;
- bound per-event pending timers/maps and clear them when no longer needed.

Before adding a second web Machine, implement both:

1. an official Socket.io cross-Machine adapter (the Postgres adapter may use the
   existing Postgres service; Redis is not required initially). Its
   `LISTEN`/`NOTIFY` connection must use a direct or session-mode Postgres
   connection, never a transaction pooler. If the official Postgres adapter is
   selected, add its attachment table through a versioned migration and grant
   the runtime role only the required access; this table carries broadcasts
   above Postgres's notification payload limit and needs the adapter's bounded
   cleanup behavior; and
2. a tested Fly replay/cookie affinity design for Socket.io's HTTP long-polling
   requests.

Do not run two Machines with the default in-memory Socket.io adapter.
Session affinity is not satisfied merely by increasing the Fly Machine count;
prove repeated polling requests for one Socket.io session reach the same
Machine before scaling out.

Load-test before live launch with at least:

- 100 concurrent event rooms;
- 2,000 concurrent sockets distributed across those rooms;
- a hot-room scenario with 300 concurrent sockets in one event, seeded close to
  the configured maximum of 500 unique words and 5,000 active contributions;
- bursts of at least 50 accepted word submissions per second;
- simultaneous configuration saves and estimates;
- a reconnect storm after a cold start or application restart;
- a forced application restart during pending fulfillment;
- assertions that no word, theme, reset, or receipt crosses event boundaries.

The capacity run must measure application throughput rather than rate-limit
throughput. Use representative independent guest identities and enough source
networks that the configured shared-venue IP ceilings do not reject the offered
50-per-second load. Do not count deliberate rate-limit rejections as accepted
submissions or as evidence that the capacity target passed. Separately run the
same abuse tests with production rate-limit settings and prove that the limits
hold. Do not add a production HTTP or Socket.io bypass for load testing.

Record p50/p95/p99 API latency, room-update delay, CPU, memory, database pool
usage, outbound bandwidth, event-loop delay, errors, reconnect success and the
serialized size of hot-room snapshots.
Initial pass/fail targets at the stated 2,000-socket/50-submission load are:

- submitted-word acknowledgement p95 at most 300 ms and p99 at most 1 second;
- visible room-update delay p95 at most 700 ms and p99 at most 1.5 seconds;
- unexpected application/socket error rate below 0.5%, excluding deliberate
  validation and rate-limit rejections;
- at least 99% of clients reconnect and receive a correct snapshot within 15
  seconds after the tested restart;
- sustained CPU below 70%, memory below 75% of the Machine limit, and no
  database pool-acquisition timeout during the steady-state window.

Measure external Printful/Stripe latency separately from Wolkenworte's own
processing latency. Size the chosen Machine with headroom above the expected
peak; do not claim a supported concurrency number until the measured test
passes. If complete coalesced snapshots are still the bottleneck at the bounded
event maximum, introduce delta updates plus reconnect snapshots before adding
another Machine. Any later change to these targets must be justified by an
explicit product/SLO decision, not merely adjusted to make a failing test pass.

## Work package 8: Fly packaging and hosted test mode

This package is brought forward immediately after the Postgres/async foundation
is green. Do not wait for every Storage, fulfillment and lifecycle package
before proving that the actual container can boot, connect and pass a hosted
smoke test. Later packages extend the same hosted test app with every payment
and Printful write switch still disabled.

### Container

Add one production Dockerfile using an official Debian/glibc Node LTS base, not
Alpine. Install only the runtime libraries needed by `canvas`. Use a
non-root runtime user and a multi-stage build if that materially reduces the
image. Pin the Node major version.

Bundle and explicitly register the app's default serif font so hosted
`node-canvas` metrics match local/browser print output. Do not depend on Georgia
being installed in the image. Preserve the existing bundled design fonts and
licenses.

Handle `SIGTERM`/`SIGINT` gracefully:

- stop accepting new HTTP connections;
- close Socket.io and the HTTP server within Fly's grace period;
- stop job polling;
- wait a bounded period for in-flight database work;
- release the Postgres pool;
- leave claimed but unfinished jobs recoverable after their lease expires.

### Health endpoints

Add:

```text
GET /health/live
GET /health/ready
```

`live` proves the process/event loop is responsive and does not call external
services. `ready` performs a fast bounded Postgres check and reports not-ready
if required startup/migration conditions are missing. Neither endpoint exposes
configuration or secrets.

### Hosted migration and deployment

The deployment workflow must:

1. build and test the candidate image;
2. apply pending migrations with `MIGRATION_DATABASE_URL` through a dedicated
   CI/deployment-runner step outside the web process;
3. abort if migration application or migration-version verification fails;
4. deploy the application image;
5. require `/health/ready` and a sanitized smoke test to pass.

Do not implement step 2 as a Fly `release_command` backed by a Fly application
secret: Fly application secrets are also available to ordinary web Machines.
The deployment runner receives `MIGRATION_DATABASE_URL`; the Fly application
receives only the least-privileged runtime `DATABASE_URL`.

Do not bake database or Supabase credentials into the image. Validate Fly
configuration strictly so misspelled lifecycle or health-check settings cannot
silently pass. Database rollback is normally a new forward migration; do not
depend on destructive down migrations after customer data exists.

### Fly configuration

The initial hosted test configuration uses:

```toml
primary_region = "fra"
kill_signal = "SIGTERM"
kill_timeout = "30s"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
```

Use service health checks against `/health/ready`. Configure connection-based
concurrency deliberately because Socket.io maintains long-lived connections;
final soft/hard limits come from load testing, not copied defaults.

Keep the explicit 30-second `kill_timeout`: it gives the 15-second bounded
maintenance handler and ordinary graceful shutdown enough time to checkpoint
claimed work before Fly terminates the process.

Before live launch, change only the availability baseline to at least:

```toml
min_machines_running = 1
```

One connected wedding display or guest socket is active traffic and should
keep the Machine running. Scheduled database cleanup must not depend on the
Machine remaining awake.

The in-process poller also does not keep a Machine awake. Supabase Cron must
exercise the authenticated maintenance endpoint successfully in hosted test
mode, including a due retry created while the Fly Machine is stopped.

### Static assets

Serve frontend files from the same Fly app initially. Do not split the
marketing site onto IONOS or another host.

Fix caching rules:

- vendor libraries, fonts, images, and application assets with a content hash
  or explicit version in the URL may use long `immutable` caching;
- unversioned application JavaScript must use revalidation or short caching;
- HTML and locale manifests must not be cached in a way that pins an old app
  version after deployment;
- retain compression.

Do not add a CDN until measurements show that it is needed.

## Work package 9: hosted test-to-live cutover

There is no separate staging environment for this phase. The one hosted Fly app
and Supabase project are first used as a hosted test environment and then
cleaned once before live launch.

### Hosted test phase

- use the Fly-provided `*.fly.dev` HTTPS hostname;
- use a separate local Supabase stack for local development;
- hosted Stripe remains in test mode;
- `STRIPE_ALLOW_LIVE_PAYMENTS=false`;
- Printful fulfillment remains `mock` except for an explicitly approved
  controlled draft;
- all real Printful confirmation switches remain false;
- use synthetic names, addresses, words, and photos only;
- verify scale-to-zero cold start, Socket.io reconnect, Stripe test webhook,
  quote expiry, Cron-triggered job recovery, Cron-triggered object cleanup,
  private photo access, and artifact download.

### One-time pre-live cleanup

Implement a purpose-built administrative cleanup command that requires an
explicit confirmation flag and refuses to run when live payments are enabled.
It must target only Wolkenworte business tables and the configured private
bucket. It must not drop Supabase system schemas, migration history, extensions,
or auth/storage system tables.

The cleanup sequence is:

1. disable public traffic or place the app in maintenance mode;
2. confirm Stripe live mode and Printful writes are still disabled;
3. delete test Storage objects through the Storage API;
4. delete test business data in foreign-key-safe order;
5. retain schema and applied migration history;
6. verify all Wolkenworte event/configuration/quote/order/artifact counts and
   bucket object counts are zero;
7. rotate the database application credential, Supabase secret key,
   rate-limit HMAC secret and maintenance secret;
8. configure Stripe live key and a new live webhook secret;
9. configure approved Printful credentials and safety mode;
10. attach the custom domain through IONOS DNS and Fly certificates;
11. set `min_machines_running = 1`;
12. run production smoke tests that create no real charge/order;
13. remove maintenance mode only after every launch gate is signed off.

Do not attempt to delete Stripe test-mode history; Stripe test and live modes
are separate. Clean or cancel controlled Printful drafts in the Printful
dashboard as part of the manual cutover checklist.

After launch, never use the pre-live cleanup command against live customer
data. Add a second irreversible guard such as requiring
`ALLOW_TEST_DATA_RESET=true`, which is never set in live operation.

### Post-launch staging trigger

A separate staging environment is not required for this initial refactor or
first launch. After launch, create a separate Fly app and Supabase project
before the first high-risk payment/fulfillment integration change, destructive
data migration, or sustained release cadence that can no longer be exercised
safely against local Supabase alone. Never switch the live application back to
Stripe test credentials or use customer production data as staging fixtures.

## Work package 10: observability and recovery

Before live launch add:

- structured JSON logs with request/order/event correlation IDs and no secrets,
  photo data, PINs, full addresses, full email addresses, message bodies, or
  Stripe/Resend signatures;
- error tracking for unhandled exceptions, webhook failures, Storage failures,
  blocked fulfillment and blocked transactional email;
- alerts for paid orders pending fulfillment beyond five minutes, repeated
  Printful failure, failed/bounced order confirmation, health-check failure,
  and database/storage quota pressure;
- metrics for active sockets, rooms, word submissions, rate-limit rejections,
  quote/checkout failures, job depth, job age, lease expiry, maintenance/Cron
  runs, transactional email state, event-loop delay and external API latency;
- a documented manual retry operation for blocked fulfillment;
- Supabase database backups appropriate for production;
- a separate Storage object backup/export strategy, because database backups
  contain Storage metadata but not the object bytes;
- a tested restoration exercise before live payments.

Document retention separately for event content, personal photos, print
artifacts, abandoned quotes, full shipping addresses, buyer email, exact sent
message bodies, Resend delivery metadata, payment identifiers and
commerce/accounting records. The 60/90-day asset policy does not by itself
define how long address, email or order PII may be kept. Complete the
applicable German/EU tax and privacy review before live sales and encode the
approved retention deadlines in cleanup queries rather than leaving them as
operational tribal knowledge.

## Required API and behavior compatibility

Unless explicitly changed above, preserve all existing public routes, response
shapes, German canonical copy, locale behavior, product catalog, pricing
behavior, editor functions, and query parameters.

The intentional compatibility exceptions are:

- remove `POST /api/events/:slug/admin/verify`;
- remove `adminToken` from the event-creation response;
- change the reset request from a bearer token to a JSON body containing the
  PIN; and
- remove browser storage of reusable admin tokens.

Specifically preserve:

- `/`, `/start`, `/e/:slug`, `/e/:slug/display`,
  `/e/:slug/configure`, `/e/:slug/shipping`, and order confirmation;
- event slug generation with a readable prefix plus cryptographic suffix;
- all six supported locales and locale-aware word normalization;
- guest receipt ownership and indistinguishable `not_found` removal failures;
- personal-memory empty starts and no event-word fallback;
- maximum six photos and maximum 6 MiB decoded photo bytes per complete design;
- immutable configuration behavior and product geometry checks;
- multi-address quote behavior;
- Stripe-hosted Checkout and integer-cent trusted totals;
- duplicate-safe Stripe webhook processing;
- test-payment-to-mock-fulfillment guarantee;
- Printful draft-first and separately confirmed live behavior;
- graceful 501 behavior for intentionally unconfigured Stripe/Printful paths.

## Hard invariants

These are release-blocking. Do not weaken them to make the refactor easier.

1. Never use `io.emit(...)` or an unscoped broadcast for event data.
2. Every event socket validates the slug before joining exactly one event room.
3. Word removal matches event, receipt, and anonymous owner.
4. Unknown and foreign receipts remain indistinguishable.
5. Personal-memory designs never inherit event words.
6. Personal image validation uses decoded bytes and magic signatures, not MIME
   claims or filename extensions. The server also proves the image decodes,
   enforces the 1,600-pixel/2,560,000-pixel bounds and stores normalized bytes;
   browser-side resizing is never the security boundary.
7. An immutable paid design cannot change when later edits or submissions occur.
8. The browser never controls price, Printful variant, fulfillment URL, order
   status, or trusted quantity.
9. Stripe webhooks use the raw body and verified signature.
10. Payment and fulfillment transitions are idempotent and transactional.
11. Stripe test payments never perform a Printful order write.
12. Live Printful confirmation requires every existing independent safety gate.
13. Secrets never enter Git, logs, browser responses, or stored design JSON.
14. Expiring an event never deletes a paid order that must be retained.
15. Deleting database metadata never silently orphan-leaks a private object;
    failed object cleanup remains discoverable and retryable.
16. The PIN inputs in `public/create.html` remain `type="tel"` with CSS masking.
17. The PIN authorizes only word-cloud reset and is submitted fresh for every
    reset request. The application never issues or stores a reusable admin
    credential.
18. Paid-order/configuration relationships are normalized and enforced by
    foreign keys; JSON ID arrays are never the only retention relationship.
19. An object selected for deletion is marked non-referenceable before the
    Storage API call, and a failed deletion retains a retryable object key.
20. No public event can create unbounded word, contribution, socket, upload or
    configuration state.
21. A claimed fulfillment attempt has a persisted lease, and only the current
    lease owner may commit its result.
22. The buyer email comes from the verified Stripe event, is never taken from
    a shipment recipient, and is never returned by the public order-status API.
23. A successful payment durably creates one Wolkenworte order-confirmation
    job. Automated retries reuse one stable Resend idempotency key only inside
    its safe provider window; an unresolved ambiguous outcome becomes visibly
    blocked and is never blindly resent with a new key.
24. Transactional email failure never loses or rolls back payment and never
    blocks fulfillment; it remains retryable or becomes visibly blocked.
25. The privileged migration credential is never available to an ordinary Fly
    web Machine; the runtime role cannot create or alter schema objects.
26. Retained paid configurations and their required photo assets are explicitly
    detached before event deletion and never disappear through a cascade.
27. A queued Cron HTTP request is not treated as completed maintenance; a
    persisted successful-run heartbeat must remain fresh and monitorable.

## Verification and acceptance criteria

Each work package must include tests proportional to its risk. Before any
change is considered finished:

```text
npm test
```

must pass completely against the new local Postgres setup.

The final refactor is accepted only when all of the following are true:

- no production application path imports `node:sqlite`;
- a clean local Supabase start plus migrations can boot the application;
- a clean hosted Supabase project plus the same migrations can boot it;
- all existing behavioral tests pass after conversion to Postgres;
- the runtime database role cannot create/alter schema objects and hosted
  deployment applies migrations before the incompatible application version;
  `MIGRATION_DATABASE_URL` is absent from the ordinary Fly web Machine;
- isolation tests still prove no cross-event word or theme traffic;
- theme changes remain strictly event-scoped and require no PIN or admin
  session;
- contribution ownership tests still prevent cross-browser/event removal;
- concurrent identical word submissions produce exact counts;
- concurrent removals of different owned receipts produce an exact aggregate
  count with no zero-count row, lost decrement or foreign removal;
- archive plus reset is atomic under a concurrent submission;
- concurrent checkout attempts produce one Stripe Session/order;
- an interruption after Stripe accepts Checkout but before local Session
  persistence is recovered with the frozen request and original idempotency key;
  a verified successful webhook can reconcile the missing Session link through
  trusted metadata and creates one payment transition, while an unresolved
  ambiguous attempt never rolls to a new key before the old Session is known to
  be expired;
- duplicate Stripe events produce one payment transition and one fulfillment;
- the verified Stripe buyer email is stored on the order and a duplicate
  successful-payment event creates only one order-confirmation job;
- the Wolkenworte order confirmation contains the immutable order totals,
  items, delivery addresses and versioned contractual information;
- a Resend timeout after provider acceptance is reconciled by the signed
  webhook job tag or retried with the same idempotency key inside the 23-hour
  automatic window without a second provider send;
- an ambiguous Resend outcome that remains unresolved at the retry boundary
  becomes `blocked`, alerts support and causes no automatic request with a new
  idempotency key;
- test payments and automated tests never contact the live Resend API;
- the guarded operator email smoke sends only to its explicit allowlist and
  exercises signed delivery/bounce reconciliation without enabling real email
  for Stripe test payments;
- the guarded Printful smoke creates a draft that downloads the frozen artifact
  URL but cannot confirm or submit it;
- a signed Printful shipment event updates the retained shipment and creates
  one buyer-addressed tracking email, including for replayed and split-shipment
  events;
- signed Resend delivered/bounced events are replay-safe and update the matching
  email job without exposing its recipient or body publicly;
- exhausted email retries alert support while the paid fulfillment job remains
  independently processable;
- personal configuration JSON contains asset IDs and no `data:image/...` bytes;
- malformed images and images above the server-side dimension or pixel limits
  are rejected before Storage, even when submitted outside the browser UI;
- saving five revisions with the same photos stores one copy of each photo;
- foreign-event asset IDs are rejected;
- assets marked `uploading`, `deleting` or `delete_failed` cannot be attached
  to a new configuration;
- expired signed preview URLs do not make stored configurations invalid;
- expired events behave like unknown events;
- expiring an event leaves its paid order/support data intact, detaches retained
  paid configurations/assets and does not leave the expired event blocked by a
  foreign-key reference;
- every retained paid item has a normalized order-item snapshot and no paid
  retention rule depends only on an ID stored inside JSON;
- unpaid personal assets are removed after their TTL when unreferenced;
- cleanup racing with configuration/order creation either preserves a valid
  reference and object or completes a discoverable retryable deletion; it
  never creates a dangling reference or orphaned object;
- paid print artifacts remain downloadable during their support window and are
  deleted afterward;
- Printful external and item IDs are deterministic and at most 32 characters;
- reset fails for a missing or wrong PIN, each correct-PIN request performs one
  reset, and the application never returns or stores a reusable admin token;
- configured rate limits return stable, localized-safe errors without leaking
  whether a PIN or private resource exists;
- source-IP limiting ignores spoofed forwarded headers and shared-venue NAT
  traffic remains within the documented generous secondary ceilings; IPv6
  addresses that differ only in host bits within one `/64` use the same bucket;
- event-wide contribution, unique-word and socket ceilings are enforced
  atomically enough that concurrent requests cannot materially exceed them;
- event-wide unpaid asset byte/count and configuration-revision ceilings reject
  excess work without leaving an untracked Storage object;
- Fly test configuration can stop at zero and wake successfully on HTTP access;
- a Stripe test webhook after a cold start is persisted and fulfilled as mock;
- a due retry created while Fly is stopped is claimed through the authenticated
  Cron maintenance request without a separate worker Machine;
- the installed Supabase Cron request explicitly uses a 30-second `pg_net`
  timeout and the maintenance handler stops or checkpoints work within its
  15-second budget, including after a hosted cold start;
- maintenance records a successful completion heartbeat, a simulated queued
  request with no successful HTTP completion does not refresh it, and stale
  heartbeats plus `pg_net` timeout/non-2xx results reach monitoring;
- an unauthenticated maintenance request performs no work, and the Cron secret
  is absent from migrations, application logs and ordinary HTTP logs;
- forced restart during fulfillment resumes without duplicate external work;
- a lost Printful create or confirmation response is reconciled through the
  deterministic external ID before retry, completes from the provider's actual
  status, and never creates or confirms a second order;
- an expired fulfillment lease is recoverable and a stale lease owner cannot
  overwrite the successful retry result;
- unversioned application JavaScript no longer receives immutable caching;
- Fly configuration retains `SIGTERM` with a 30-second `kill_timeout`, and a
  shutdown test proves claimed work is completed or safely checkpointed;
- a signed Resend complaint event produces one terminal `complained` transition
  and cannot be moved backward by an out-of-order delivery event;
- print font metrics and generated artifacts match local expected output;
- the documented 2,000-socket load test meets the agreed latency/error target
  established before the test, including a near-maximum-size hot room, at least
  50 accepted submissions per second, measured snapshot size/outbound bandwidth
  and the reconnect-storm scenario; production rate limits are verified in a
  separate run and their rejections are not counted as accepted load;
- the cleanup command refuses to run without both safety guards and empties
  only test business data and the configured bucket.

## Implementation order and commit boundaries

Implement in this order so the application stays reviewable and failures can
be localized:

1. Supabase CLI scaffold, application/global migration split, least-privileged
   database role, normalized order items, `pg` data layer, async route/socket
   conversion, concurrency tests, and restoration of the full green suite.
2. Docker/Fly configuration, hosted migration workflow, health checks, graceful
   shutdown, cache rules, and the first hosted mock-mode smoke test.
3. Private Storage asset model, upload flow, editor asset references, photo
   deduplication, deletion-state protocol and Storage integration tests.
4. Event/configuration expiration, safe commerce retention, reset PIN
   simplification, async PIN verification, trusted client-IP resolution and
   abuse controls.
5. Deterministic Printful IDs, normalized frozen paid artifacts, artifact
   streaming, leased Postgres job scheduling, authenticated Cron maintenance
   endpoint, cleanup and signed Printful status webhooks.
6. Verified Stripe buyer-email capture, Resend configuration, durable
   transactional-email jobs, Wolkenworte order confirmation, shipment/refund
   notices, signed Resend delivery webhooks and duplicate/retry tests.
7. Socket broadcast coalescing, event ceilings, load/reconnect tooling and the
   measured single-Machine capacity test.
8. Structured privacy-safe logs and request correlation, built-in aggregate
   metrics/status, documented manual blocked-fulfillment retry, PII retention
   decision record, and guarded pre-live cleanup command. Use only the current
   Node/Fly/Supabase stack in this phase.
9. One external error/uptime notification path, database backup, separate
   Storage-object export, tested restoration, README and `.env.example` final
   synchronization, and the complete hosted test-to-live checklist.

Prefer one coherent commit per numbered boundary. Every boundary must leave the
application bootable and `npm test` green; do not split the async database layer
from its required callers into intentionally broken commits. Do not mix
visual/product changes into the infrastructure refactor. Preserve unrelated
user changes in the worktree.

## Explicitly out of scope

Do not add any of these during this refactor:

- customer or couple accounts;
- social login, email login, magic links, or password reset;
- `/manage/<token>` or a separate admin dashboard;
- wedding lifecycle/status states beyond a single `expires_at`;
- a separate staging project before the initial launch; follow the explicit
  post-launch staging trigger when its conditions are met;
- microservices or a separate worker deployment;
- Kubernetes;
- Redis before a second Socket.io Machine is required;
- Supabase client-side direct database access or public RLS-based app logic;
- Supabase Auth;
- newsletters, marketing campaigns, contact lists or marketing-consent flows;
- a frontend framework, bundler, TypeScript, or ORM;
- a new login/session cookie system;
- admin bearer tokens, PIN session tokens, or remembered PINs;
- a move of marketing pages to IONOS;
- optional server-side storage of user-exported word clouds;
- automatic live-payment or Printful safety-switch activation;
- production deployment, domain changes, hosted data deletion, or Git pushes
  without explicit maintainer approval.

## Definition of done

The refactor is done when Wolkenworte runs locally and on the hosted test app
from the same code, migrations, Postgres behavior, and private Storage model;
all tests and load/isolation checks pass; paid orders are durable and
idempotently fulfillable; every verified paid order has one durable
Wolkenworte confirmation outcome and Printful shipments can produce replay-safe
tracking notices through Resend; image, print and email data follow the defined
retention rules; events use the single 365-day expiry; the hosted Machine can
scale to zero in test mode while authenticated Cron requests still recover due
work and cleanup; and the project has a reviewed, guarded path for the one-time
cleanup and later live launch.
