# Wolkenworte launch-readiness checklist

Last reviewed: 2026-08-28

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
- [x] Private Storage holds normalized personal photos and frozen paid print
  artifacts; application records contain opaque identifiers rather than public
  object URLs.
- [x] Stripe sandbox Checkout has been verified end to end through the public
  Fly webhook, durable `paid_test` state, mock email, mock fulfillment and the
  public confirmation page.
- [x] Payment, fulfillment and transactional-email work is transactional,
  idempotent, lease-owned and restart-safe.
- [x] Event expiration, bounded authenticated maintenance, one-use reset PINs,
  abuse controls, operational status and guarded recovery/cleanup commands are
  implemented.
- [x] The retained 100-room/2,000-socket capacity qualification passed on one
  Fly Machine. A second Machine is neither required nor supported with the
  current in-memory Socket.io adapter.

## Required before live sales

### Business, tax and legal decisions

- [ ] Decide the business's VAT status, EU/OSS obligations, invoicing and
  bookkeeping/export process with qualified professional input.
- [ ] Review the customer-facing tax calculation and decide whether the current
  destination-rate calculation is sufficient or must use Stripe Tax.
- [ ] Review product margins and the provisional markup/payment-reserve values.
- [ ] Approve the versioned order-confirmation, contract-formation,
  personalization/withdrawal, refund and cancellation wording.
- [ ] Define exact retention periods for paid orders, addresses, buyer email,
  sent message bodies and provider metadata. Encode approved deletion periods
  in bounded tests and cleanup queries; do not leave them as an operator habit.
- [ ] Confirm whether Stripe's own payment/refund receipts should be enabled in
  addition to Wolkenworte's transactional messages.

### Resend activation

- [ ] Register the Wolkenworte sending domain or subdomain and publish the DNS
  records supplied by Resend.
- [ ] Create a domain-scoped sending key and configure `RESEND_API_KEY` plus the
  verified `RESEND_FROM_EMAIL` in the appropriate secret stores.
- [ ] Run `npm run resend:configure-webhook -- --confirm-replace-webhook`, deploy
  the staged signing secret, and verify signed delivery callbacks.
- [ ] Configure `RESEND_SMOKE_RECIPIENTS` and run the guarded delivered and
  bounced provider smokes described in `README.md`.
- [ ] Return `EMAIL_DELIVERY_MODE` to `mock` after testing. Enable live delivery
  only as part of the approved production cutover.

### Printful verification

- [ ] Run the guarded unconfirmed-draft smoke for every materially different
  placement type, including separate front/back output.
- [ ] Confirm that Printful downloads the frozen capability URLs and accepts
  the generated SVG files. Switch the final artifact format to PNG only if the
  provider test proves it necessary.
- [ ] Inspect the resulting mockups and cancel or remove synthetic drafts in
  Printful after verification.
- [ ] Run `npm run printful:configure-webhook -- --confirm-replace-webhook`,
  deploy the returned signing values and verify replay-safe status callbacks.
- [ ] Keep `PRINTFUL_FULFILLMENT_MODE=mock`,
  `PRINTFUL_ALLOW_ORDER_WRITES=false` and
  `PRINTFUL_CONFIRM_LIVE_ORDERS=false` until the cutover is explicitly
  approved.

### Monitoring and recovery

- [ ] Configure one external error/uptime notification path for health-check
  failures, stale maintenance heartbeats, failed Cron requests, blocked or
  overdue fulfillment, and failed/bounced order confirmations. The built-in
  aggregate status remains the diagnostic source; one notification provider is
  enough.
- [ ] Confirm and configure the Supabase database backup policy appropriate for
  live commerce data.
- [ ] Configure a separate encrypted export of the private Storage objects.
  Database backups contain Storage metadata, not the photo/print object bytes.
- [ ] Perform and document one restoration exercise that restores both the
  database and matching Storage objects before live payments are enabled.

## Controlled production cutover

Execute this only after every item above has an owner and all launch blockers
are signed off. Deployment, destructive cleanup, credential rotation and live
provider activation each require explicit maintainer approval at action time.

1. Deploy the tested candidate while Stripe remains in test mode, email remains
   in mock mode and Printful writes remain disabled.
2. Set `MAINTENANCE_MODE=true` on Fly and verify public traffic receives the
   maintenance response while health endpoints remain available.
3. Set `ALLOW_TEST_DATA_RESET=true` only in the local operator environment and
   run the guarded cleanup from `docs/operations.md`. Verify that application
   tables and the configured private bucket are empty while migrations remain.
4. Restore `ALLOW_TEST_DATA_RESET=false` immediately.
5. Rotate the database runtime credential, Supabase backend key, rate-limit
   HMAC secret and maintenance secret. Update only the stores that consume each
   value.
6. Configure the Stripe live key and a new live webhook destination/signing
   secret. Never reuse the sandbox or local Stripe CLI webhook secret.
7. Configure the approved Resend and Printful production values while their
   independent live/write/confirmation gates remain disabled.
8. Attach the custom domain through DNS and Fly certificates, update
   `PUBLIC_URL`, and set at least one Machine to remain running.
9. Run production health and read-only smoke checks that create no real charge,
   email or Printful order.
10. Enable live email, payment and fulfillment gates in the reviewed order,
    perform the explicitly approved minimal live acceptance transaction, then
    remove maintenance mode.

Stripe sandbox history does not need to be deleted. Stripe test and live data
are separate. The pre-live cleanup command must never be used after customer
production data exists.

## After launch

A separate staging Fly app and Supabase project are not needed for the initial
launch. Create them before the first destructive data migration, high-risk
payment/fulfillment integration change or release cadence that can no longer be
tested safely with local Supabase. Never use production customer data as test
fixtures or switch the production app back to sandbox credentials.

Do not add Redis, microservices, Kubernetes, a CDN, an ORM, a frontend framework
or additional Fly Machines without measurements and a concrete requirement.
The current single-service architecture is the intentional baseline.
