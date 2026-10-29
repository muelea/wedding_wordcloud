# Wolkenworte data-retention record

Approved by the maintainer: 2026-09-24. Implemented in schema version 5 and the
existing authenticated maintenance worker. Activation requires the approved
hosted release; editing this policy does not deploy it or delete hosted data.
Activity expiry and worker scheduling were approved on 2026-10-26 and are
prepared locally through the additional schema-8 migration and application
changes below.

## Commerce policy

| Data | Retention | Application behavior |
|---|---|---|
| Essential paid order/payment/refund evidence | Eight complete calendar years; extend where a longer obligation applies | Keep product/quantity/amount/tax/currency, transaction references and one necessary recipient name/address record; delete the order and dependent records after expiry |
| Order and refund confirmations | Eight complete calendar years | Classified as booking evidence; keep the original recipient, subject and bodies until expiry |
| Shipment and cancellation correspondence | Six complete calendar years | Replace expired recipient/subject/bodies with an explicit erased-content tombstone; retain dedupe/provider IDs and terminal outcome while the order exists |
| Additional operational contacts, delivery copies and artwork | Three complete calendar years after completed handling | Remove buyer contact, phone, shipment recipient/tracking copies, checkout request address, linked quote, item artwork and unreferenced expired/detached configurations; retain one name/address record and correspondence as evidence under their longer periods |
| Safely unpaid Checkout attempts | 30 days after confirmed expiry | Delete the order, shipment/item copies and linked quote; ambiguous or potentially paid attempts are excluded |
| Unneeded technical error/provider payload details | 90 days after completed handling | Remove error detail, Checkout URL and provider payloads; retain external order IDs, payment matching references and terminal email reason codes |
| Completed maintenance logs and unmatched webhook metadata | 90 days | Delete bounded batches; webhook identities linked to retained order/email evidence survive until that evidence expires |

These are application retention rules, not a declaration that this database is
complete statutory bookkeeping. Separate invoices, ledgers, business email and
provider documents remain the maintainer's bookkeeping responsibility. Books
and financial statements generally require ten years; this application does not
create them. Ordinary correspondence kept elsewhere needs its own six-year
policy. If shipment/cancellation correspondence is used as a booking voucher,
retain that voucher in the separate eight-year bookkeeping archive before the
application's six-year cleanup.

German basis: [§ 257 HGB](https://www.gesetze-im-internet.de/hgb/__257.html),
[§ 147 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html),
[§ 14b UStG](https://www.gesetze-im-internet.de/ustg_1980/__14b.html).
Actual OSS records require ten years under
[§ 22 UStG](https://www.gesetze-im-internet.de/ustg_1980/__22.html).
The accepted Stripe `oss_union` calculation setting does not by itself classify
a transaction as an actual OSS filing. Set a longer per-order period or a hold
where actual tax treatment, foreign law, an audit or a dispute requires it.
The three-year operational period is a chosen support/claims policy, not a
universal statutory requirement to retain every address for three years.

## Start dates and safety boundaries

- Calendar deadlines use **Europe/Berlin**, not the server's time zone. A
  document from 2026 with eight-year retention expires on 1 January 2035.
- Completion is the latest delivery date across all shipments. If delivery is
  not reported, it is shipment dispatch plus 90 days, provided fulfillment has
  succeeded and no failed/returned shipment or support hold exists. A canceled
  order is complete only once fully refunded and every shipment is canceled or
  delivered. Missing shipment state remains unresolved.
- For order/operational/technical retention, use the latest completion, payment,
  refund or correspondence creation time. This deliberately prevents an old
  purchase date from deleting a later refund or ongoing handling. Email content
  uses each message's own creation year.
- Pending, processing, blocked, retryable or ambiguous email work and active
  fulfillment leases prevent order cleanup. Resolve those cases through the
  existing operational workflow. They are not silently treated as completed.
- Once Stripe Session creation was attempted, a **verified
  `checkout.session.expired` event with unpaid status** is required. The
  local Session expiry alone is insufficient. A checkout never submitted to
  Stripe can expire locally. `retention.unresolvedCheckouts` in `ops:status`
  identifies old attempts needing reconciliation; do not delete them merely
  because their local date passed.
- Event expiry detaches all surviving order configurations; it cannot bypass
  ambiguous payments or holds. Shared designs still referenced by another order
  or an active event are not deleted by another order's cleanup.
- Storage objects are removed before artifact metadata. Uploads, failed
  deletion, active deletion and support holds protect their dependencies.
  A paid order cannot be deleted while any print artifact remains.
- Expired correspondence cannot be resent. Minimal replay/dedupe records
  survive content erasure, and late provider callbacks cannot restore erased
  delivery contacts or message content.

## Holds and longer periods

Use the existing runtime-scoped database environment. These commands change
only the selected order's retention metadata and write an audit entry without
customer details. No HTTP endpoint accepts retention targets.

```bash
node scripts/order-retention.js --order-id 123 --hold support --review-at 2026-12-01 --confirm-retention-change
node scripts/order-retention.js --order-id 123 --release --confirm-retention-change
node scripts/order-retention.js --order-id 123 --release --years 10 --confirm-retention-change
```

Allowed reasons: `support`, `refund`, `dispute`, `audit`, `legal`. Set a hold as
soon as a complaint, unresolved refund, dispute, audit or other preservation
requirement becomes known. A hold protects order, message and file cleanup; the
review date is a reminder, **never automatic permission to delete**. Review due
holds through `npm run ops:status` (`retention.reviewsDue`). Releasing a hold
preserves the configured year count unless explicitly changed. Do not shorten
it without checking the underlying retention obligation. A file deletion
already in progress cannot be retroactively stopped; the command reports that
condition instead of falsely promising preservation.

## Existing event, quote and artifact rules

| Data | Lifetime |
|---|---|
| Event, shared words, contribution receipts and event archives | Three calendar months from the last committed edit (`events.updated_at`); daily cleanup after expiry |
| Unpaid configurations with no unresolved order dependency | Removed with their expired event |
| Unused checkout quote containing address/provider price | Usable for 5–120 minutes (default 30); eligible for deletion one day after expiry |
| Frozen paid print artifact | At least 90 days from submission, extended to 60 days after delivery where later; holds override deletion |
| Prepared preview/print file | Initially 24 hours; paid artifacts, unfinished paid fulfillment, holds and unresolved attempted Checkouts protect the shared source until it can safely be deleted |
| Reserved opaque event slug | Indefinite, to prevent reuse of expired public URLs |
| Hashed PIN-attempt source identity | Older than one day: removed on PIN checks; also removed with the event; never contains raw IP addresses |

Schema 8 changes event expiry through a new ordered migration; it does not
rewrite the customer baseline. Already active events receive three calendar
months from migration time because their historical edit times are incomplete.
Already expired events remain expired. New clouds and direct-design workspaces
use the same activity policy. Committed word insertion, count changes, removal,
nonempty reset, title/PIN changes and explicit configuration creation renew the
parent event. Viewing, connecting, failed writes and no-op edits do not. Word
changes touch the parent in the same transaction, once per affected event per
SQL statement. Expired events cannot be revived by those touches. Account saves
remain manual and keep their independent existing three-month rules.

## Daily activity cleanup and worker scheduling

The existing authenticated five-minute Supabase Cron wake-up remains. It now
starts or resumes one durable daily scan, instead of applying a two-event daily
quota. Its scheduled day changes at **03:00 Europe/Berlin**, including DST;
startup after an outage catches up the latest due day. An unfinished day is
finished before a new day starts. Every run has a fixed eligibility cutoff.

- `retention_runs` stores category cursors, counters and a 60-second lease.
  Candidate pages contain at most 50 entries. Successful per-record commits and
  checkpoints allow safe replay after interruption; no transaction spans a page
  or a Storage/Auth request. Stale lease owners cannot save progress or release
  a successor's lease.
- A wake-up spends at most approximately ten seconds on the daily scan, then
  preserves the remaining maintenance budget for recovery. Application workers
  also start paid work immediately on startup and provider callbacks. Daily
  continuation happens on subsequent five-minute wake-ups, without waiting for
  another night. Budgets are cooperative; individual SQL/provider timeouts
  bound operations, rather than aborting an in-flight remote deletion.
- Categories advance independently and rotate between pages: Auth discovery,
  expired clouds, saved designs, dormant accounts, paid artifacts, commerce,
  old metadata, queued design-object/Auth deletions, prepared print files,
  expired mockup-cache records and unreferenced design source images. Account
  expiry waits for discovery and design expiry; external deletion waits for their producers.
  Every candidate is rechecked before deletion. Commerce policies/holds and
  payment ambiguity are unchanged; expired cloud cleanup detaches retained
  configurations and preserves slug reservations. Prepared sources still
  referenced by paid artifacts are excluded from discovery, rather than
  creating routine hourly deletion retries throughout their 90-day retention.
- Blocked/busy/failed targets enter `retention_deferrals`; they do not prevent
  scanning later IDs. Independently leased retries back off from five minutes
  to at most one hour. Storage failure preserves retryable metadata. Completed
  scans with deferred targets say `completed_with_deferrals`, not unconditional
  success. `npm run ops:status` exposes the latest daily progress and remaining
  deferral count. Maintenance HTTP responses contain counts/status, never
  target IDs. Daily run history expires after 90 days. Run-level errors retain
  their sanitized code and timestamp for diagnosis; a completed scan clears
  that transient error. File-deletion counters require the current lease owner
  to commit successfully.
- Source photos have their own private immutable objects and metadata. Database
  references from configurations, order items, saved designs and pending manual
  saves pin them independently. Account/design deletion releases only its own
  references. Commerce artwork redaction releases order references; retained
  configurations and orders continue to protect sources. Cleanup locks the asset,
  rechecks every reference and fences new references before deleting the object.
  A one-hour reservation grace and upload deadline protect interrupted uploads;
  failed deletions retain metadata and retry after five minutes. Legacy inline
  snapshots follow their existing parent retention policy.
- Short-lived quote/upload/session housekeeping, interrupted mockups and
  explicit account/file deletion retries stay on the five-minute wake-up.
  These do not rescan all long-lived business records.
- Fulfillment and transactional-email work is event-triggered immediately.
  Their safety polls run at five seconds after work, then back off to 60
  seconds after an empty poll. A persisted retry due sooner wakes the worker
  at that deadline instead of waiting the whole idle interval. Existing leases, retry deadlines, attempt limits
  and provider idempotency fences are unchanged.
- Mockup generation starts only for an explicit request. Startup and the
  maintenance wake-up recover persisted unfinished work. The worker schedules
  the next due job (respecting provider backoff/leases), and stops its timer
  when no job or journaled file cleanup remains. Reading a completed cached
  preview does not restart polling. The five-minute recovery check is the only
  periodic check when the queue is empty.
- Process metrics are summarized every ten seconds, in RAM. Fly readiness
  checks remain at 15 seconds; they are independent of retention scheduling.

This scheduling and activity policy is prepared locally. It takes effect on
the hosted project only through a separately approved migration and release.

## Maintenance and activation

The daily scanner considers all old orders in keyset pages; each order is
normally revisited once per daily scan, with separate retries for deferred
work. Each order's changes are transactional. Row locks, `SKIP LOCKED`,
nonblocking child locks, statement timeouts and the existing maintenance budget
keep cleanup bounded. A failed/busy transaction rolls back and retries later.
Completed-log/unmatched-webhook cleanup uses batches of 100 rows per category
and repeats until the daily scan drains them, resuming on later wake-ups when
its time budget is exhausted. Counts enter the existing maintenance heartbeat; logs contain no
addresses, email recipients or message bodies. Deadlines make rows eligible;
actual removal occurs on a subsequent successful maintenance pass.

Migration `20260924000000_commerce_retention.sql` only adds policy metadata;
it does not immediately erase existing data. Before activation, review existing
holds/longer statutory periods and include `checkout.session.expired` in both
sandbox and live webhook subscriptions. The guarded sandbox configuration
script includes it; this implementation has not run that script or changed any
provider configuration. Release/cutover remains in `docs/launch-readiness.md`.

Local cleanup does not delete copies at Stripe, Printful, Resend, in mailboxes,
in bookkeeping exports or in database/provider backups. Apply the relevant
provider/backup retention policies separately; restored data must pass through
retention before being returned to use. Deferred backup/restore verification
and monitoring remain recorded in the launch checklist.
