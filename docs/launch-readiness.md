# Wolkenworte launch-readiness checklist

Last reviewed: 2026-09-23

The hosted-architecture refactor is complete. Wolkenworte now runs locally and
on the Fly hosted test environment from the same application code, ordered
Postgres migrations, least-privileged runtime role and private Storage model.
The remaining work is launch preparation: external provider activation,
business/legal decisions, recoverability and the controlled production
cutover. It does not require another application-architecture redesign.

This file is the single source of truth for unfinished launch work. Completed
implementation history is intentionally not maintained as a step-by-step diary.

## Verified baseline

- [x] Supabase Postgres is the only application database. Migrations and the
  dedicated `wolkenworte_app` runtime role are active.
- [x] The stateless Fly hosted test app is healthy in Frankfurt and can safely
  stop when idle. Durable state remains in Supabase.
- [x] The Porkbun-managed `wolkenworte.io` domain is attached to Fly with the
  apex as the canonical public origin and `www` redirecting to it. The stable
  Fly hostname remains available for infrastructure callbacks.
- [x] Private Storage holds frozen paid print artifacts; application records
  contain opaque identifiers rather than public object URLs.
- [x] Stripe sandbox Checkout has been verified end to end through the public
  Fly webhook, durable `paid_test` state, durable email queue, mock fulfillment
  and the public confirmation page.
- [x] Payment, fulfillment and transactional-email work is transactional,
  idempotent, lease-owned and restart-safe.
- [x] Event expiration, bounded authenticated maintenance, one-use reset PINs,
  abuse controls, operational status and guarded recovery/cleanup commands are
  implemented.
- [x] The legal notice and privacy page describe the current hosted test stack,
  provider data flows, browser storage and enforced deletion periods. Interface
  fonts are served locally rather than fetched from Google Fonts.
- [x] The retained 100-room/2,000-socket capacity qualification passed on one
  Fly Machine. A second Machine is neither required nor supported with the
  current in-memory Socket.io adapter.

## Required before live sales

### Business, tax and legal decisions

- [x] Record the current sandbox tax model: B2C sales by the German JUSA
  Engineering UG (haftungsbeschränkt), seller VAT ID stored in Stripe and
  Printful, one active German Stripe Tax `small_seller` registration and no
  active OSS registration. Buyer VAT IDs are intentionally not requested.
- [x] Keep Printful tax/VAT as an internal procurement cost. It is included once
  in the customer-facing product amount without the catalog markup; only Stripe
  Tax creates the customer tax line. Draft/live fulfillment compares Printful's
  actual currency and total with the frozen estimate before confirmation and
  blocks changed or missing costs for manual review.
- [x] Show a compact general customs/import-cost notice in the shop, address
  review, Stripe Checkout, confirmation page and transactional messages. Keep
  the more specific Printful customs-risk and unknown-state warnings as
  additional information; the recipient bears external import charges.
- [ ] Confirm the German `small_seller` treatment, invoicing and bookkeeping
  process with qualified professional input. Monitor the EUR 10,000 EU
  cross-border B2C threshold and register/activate OSS before applying that
  regime; do not restore the removed sandbox OSS registration prematurely.
- [ ] Validate the Stripe Tax setup for live worldwide sales, including live
  registrations, product/shipping tax codes and the actual Printful fulfillment
  origins. Sandbox Checkout records Stripe's confirmed destination tax but uses
  the configured German head-office origin; observed Printful origins include
  Germany, Latvia, Spain and the United States and are not passed to Stripe as a
  per-order tax origin.
- [ ] Review product margins and the provisional markup/payment-reserve values.
- [ ] Approve the versioned order-confirmation, contract-formation,
  personalization/withdrawal, refund and cancellation wording.
- [ ] Have qualified German counsel review the legal notice and privacy policy
  together with the final live provider contracts and tax setup.
- [ ] Define exact retention periods for paid orders, addresses, buyer email,
  sent message bodies and provider metadata. Encode approved deletion periods
  in bounded tests and cleanup queries; do not leave them as an operator habit.
- [ ] Confirm whether Stripe's own payment/refund receipts should be enabled in
  addition to Wolkenworte's transactional messages.

### Resend activation

- [x] Register `mail.wolkenworte.io` in Resend with region `eu-west-1`, publish
  its exact SPF, DKIM and Return-Path/MX records in Porkbun, verify the domain,
  and leave transactional open/click tracking disabled.
- [x] Create one long-lived Sending-access key restricted to that domain plus a
  separate temporary Full-access setup key. Never deploy the management key.
- [x] Run `npm run resend:configure-webhook -- --confirm-replace-webhook`, revoke
  and locally clear the temporary management key, activate the staged runtime
  key/From identity/signing secret with `npm run deploy:hosted`, and verify
  signed delivery callbacks.
- [x] Configure local-only `RESEND_SMOKE_RECIPIENTS` and run the guarded real
  inbox, delivered, bounced, complained and suppressed provider smokes from
  `README.md`. Confirm Reply-To is `kontakt@jusa.io`.
- [x] Approve and enable `EMAIL_DELIVERY_MODE=live` in the hosted test
  environment for real `[TEST]` confirmations while Stripe stays in sandbox
  mode and Printful fulfillment stays mocked. Automated tests remain mocked.
- [x] Complete one new hosted sandbox purchase and verify that its confirmation
  reaches the intended inbox and receives a signed Resend delivery callback.
  Order `WW-00000031` passed the hosted Stripe verifier; its real `[TEST]`
  confirmation arrived in the intended inbox and recorded `email.sent` and
  `email.delivered` callbacks (2026-09-23).

### Printful verification

- [x] Run the guarded unconfirmed-draft smoke for all 12 catalog variants,
  including separate front/back output and an embedded sample image
  (2026-09-23).
- [x] Confirm that Printful downloads the frozen capability URLs. The first
  real SVG was rejected; full-resolution transparent PNG files reached `ok`
  on all 12 subsequent product drafts (2026-09-23).
- [x] Inspect representative Printful previews for the mug, blanket and
  two-sided pillow, then cancel all 13 synthetic drafts, including the failed
  SVG draft (2026-09-23).
- [x] Configure the signed Printful v2 webhook with an `orders` + `webhooks`
  scoped token, activate its signing values with `npm run deploy:hosted`, and
  verify provider-origin `order_created` and `order_updated` callbacks from one
  unconfirmed synthetic draft (2026-09-23). The draft was archived after the
  test; invalid signatures receive HTTP 400 and replay-safe persistence is
  covered by the signed callback test. Shipment and return delivery remain to
  be observed on the first real fulfilled order.
- [ ] Keep `PRINTFUL_FULFILLMENT_MODE=mock`,
  `PRINTFUL_ALLOW_ORDER_WRITES=false` and
  `PRINTFUL_CONFIRM_LIVE_ORDERS=false` until the cutover is explicitly
  approved.

## Controlled production cutover

Execute this only after every item above has an owner and all launch blockers
are signed off. Deployment, destructive cleanup, credential rotation and live
provider activation each require explicit maintainer approval at action time.

1. Run `npm run deploy:hosted` for the tested candidate while Stripe remains in
   test mode, transactional test email remains enabled and Printful writes
   remain disabled.
2. Set `MAINTENANCE_MODE=true` on Fly and verify public traffic receives the
   maintenance response while health endpoints remain available.
3. Set `ALLOW_TEST_DATA_RESET=true` only in the local operator environment and
   run the guarded cleanup from `docs/operations.md`. Verify that application
   tables and the configured private bucket are empty while the clean baseline
   schema remains.
4. Restore `ALLOW_TEST_DATA_RESET=false` immediately.
5. Rotate the database runtime credential, Supabase backend key, rate-limit
   HMAC secret and maintenance secret. Update only the stores that consume each
   value.
6. Configure the Stripe live key and a new live webhook destination/signing
   secret. Never reuse the sandbox or local Stripe CLI webhook secret.
7. Configure the approved Resend and Printful production values while their
   independent live/write/confirmation gates remain disabled.
8. Reconfirm the custom-domain certificates and canonical redirect, then set at
   least one Machine to remain running.
9. Run production health and read-only smoke checks that create no real charge,
   email or Printful order.
10. Reconfirm live email, enable payment and fulfillment gates in the reviewed
    order, perform the explicitly approved minimal live acceptance transaction,
    then remove maintenance mode.

Stripe sandbox history does not need to be deleted. Stripe test and live data
are separate. The pre-live cleanup command must never be used after customer
production data exists.

## After launch

### Monitoring and recovery after initial paid orders

The maintainer decided on 2026-09-23 to begin live sales with the existing Fly
readiness check and built-in aggregate operational status, without adding an
external alerting provider, verifying or upgrading the Supabase backup policy,
exporting private Storage objects, or running a restore exercise beforehand.
Revisit these safeguards after the first real paid orders bring in revenue.
Until then, the current backup availability is unverified: a database or
Storage loss could make early paid order data or frozen print files
unrecoverable, and operational failures could be noticed late. This is an
explicitly accepted initial-launch risk, not a verified recovery capability.

- [ ] Reassess external alerts for health-check failures, stale maintenance
  heartbeats, failed Cron requests, blocked or overdue fulfillment, and
  failed/bounced order confirmations.
- [ ] Confirm the Supabase database backup policy and configure it if needed.
- [ ] Decide whether to export private Storage objects to separate encrypted
  storage. Database backups contain Storage metadata, not the print bytes.
- [ ] If backups are adopted, restore matching database and Storage data in an
  isolated exercise and document the result.

A separate staging Fly app and Supabase project are not needed for the initial
launch. Create them before the first destructive data migration, high-risk
payment/fulfillment integration change or release cadence that can no longer be
tested safely with local Supabase. Never use production customer data as test
fixtures or switch the production app back to sandbox credentials.

Do not add Redis, microservices, Kubernetes, a CDN, an ORM, a frontend framework
or additional Fly Machines without measurements and a concrete requirement.
The current single-service architecture is the intentional baseline.
