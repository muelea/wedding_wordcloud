# Wolkenworte data-retention record

Approved by the maintainer: 2026-09-24. Implemented in schema version 5 and the
existing authenticated maintenance worker. Activation requires the approved
hosted release; editing this policy does not deploy it or delete hosted data.

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
| Event, shared words, contribution receipts and event archives | 365 days from event creation |
| Unpaid configurations with no unresolved order dependency | Removed with their expired event |
| Unused checkout quote containing address/provider price | Usable for 5–120 minutes (default 30); eligible for deletion one day after expiry |
| Frozen paid print artifact | At least 90 days from submission, extended to 60 days after delivery where later; holds override deletion |
| Reserved opaque event slug | Indefinite, to prevent reuse of expired public URLs |
| Hashed PIN-attempt source identity | Removed with the event; never contains raw IP addresses |

## Maintenance and activation

Commerce cleanup considers at most one old order per authenticated wake-up;
checks rotate oldest-first and each order is normally revisited no more than
once daily. Each order's changes are transactional. Row locks, `SKIP LOCKED`,
nonblocking child locks, statement timeouts and the existing maintenance budget
keep cleanup bounded. A failed/busy transaction rolls back and retries later.
Completed-log/unmatched-webhook cleanup is capped at 100 rows per category per
wake-up. Counts enter the existing maintenance heartbeat; logs contain no
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
