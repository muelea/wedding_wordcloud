# Wolkenworte launch-readiness checklist

Last reviewed: 2026-09-25

The hosted-architecture refactor is complete. Wolkenworte now runs locally and
on the Fly hosted test environment from the same application code, ordered
Postgres migrations, least-privileged runtime role and private Storage model.
The remaining pre-launch work is the controlled production cutover, including
activation of the implemented commerce retention rules. Qualified German legal
review and provider verification are complete; additional monitoring and
recovery safeguards are explicitly deferred below. No application-architecture
redesign is required.

This file is the single source of truth for unfinished launch work. Completed
implementation history is intentionally not maintained as a step-by-step diary.

On 2026-09-24 the maintainer took invoicing, bookkeeping, seller VAT IDs,
tax registrations/reporting and optional Stripe payment/refund receipts out of
the project's go-live blockers. The maintainer handles these separately;
this records ownership, not completion or professional approval. No additional
project sign-off is required for these topics.

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

- [x] Initial tax configuration accepted by the maintainer on 2026-09-24;
  configuration work is complete for the initial launch. B2C sales by the
  German JUSA Engineering UG (haftungsbeschränkt) continue through native
  Stripe Checkout with `automatic_tax`, the validated delivery address,
  exclusive prices, goods code `txcd_99999999` and shipping code
  `txcd_92010001`. Buyer VAT IDs are not requested.
- [x] Replace the earlier `small_seller` baseline with the tested Stripe Tax
  configuration: Germany `oss_union` plus Great Britain `standard`. The OSS
  setting is the maintainer's chosen calculation workaround, not evidence
  that the underlying Printful chain transactions qualify for legal OSS
  reporting. Orders 32–40 covered DE, FR, LV, ES, GB, CH and three US states;
  order 41 verified GB VAT at 20% after the GB setting was added. Amounts,
  payment persistence and confirmation messages matched. All evidence is
  sandbox-only; see the [test audit](stripe-printful-test-audit-2026-09-24.md).
- [x] Accept the existing head-office-origin calculation for the initial
  launch, primarily targeting Germany with possible isolated US sales.
  Per-order Printful ship-from support, a separate Tax API integration and
  Checkout preview access are not initial-launch blockers. US checkout
  currently collects no tax under the business assumption of no nexus;
  CH and other unconfigured destinations retain the current calculation.
  These test results do not validate worldwide tax treatment or US nexus.
  Stripe's live threshold monitoring is to support ongoing review, not replace
  an assessment of obligations outside its monitoring coverage.
- [x] Record the maintainer's registration preference: no speculative local
  registrations in all 27 EU states; address destination-country obligations
  as actual sales arise. This is not approval of a universal post-sale
  registration grace period. Stripe settings do not establish registrations
  with tax authorities or submit tax returns by themselves. The accepted
  configuration does not certify that any required foreign registration exists.
- [x] Keep Printful tax/VAT as an internal procurement cost. It is included once
  in the customer-facing product amount without the catalog markup; only Stripe
  Tax creates the customer tax line. Draft/live fulfillment compares Printful's
  actual currency and total with the frozen estimate before confirmation and
  blocks changed or missing costs for manual review.
- [x] Show a compact general customs/import-cost notice in the shop, address
  review, Stripe Checkout, confirmation page and order-confirmation email.
  Shipment-specific risk and unknown-state warnings appear beneath affected
  deliveries in transactional emails; a known no-risk delivery has no warning
  beneath its address. The recipient bears external import charges.
- [x] Initial pricing approved by the maintainer on 2026-09-24: 50% markup on
  Printful product costs, Printful tax/VAT and shipping passed through without
  markup, and an embedded payment-cost reserve of 3.65% plus EUR 0.25 per
  purchase. Stripe calculates customer tax separately. The reserve remains an
  estimate; the markup is a contribution toward operating costs and profit,
  not net profit. Review actual costs after the first real orders; no further
  pricing approval or implementation is required before the initial launch.
- [x] Prepare the live-sales legal copy (2026-09-24): public ordering
  information at `/bestellinformationen`, linked from the landing page,
  configurator and legal pages, explains contract formation, corrections,
  payment, delivery, personalised goods, cancellation requests, statutory
  defect rights, contract storage and supported languages. The order is
  accepted after successful payment and confirmed by email. Shorter confirmation
  snapshots retain the key terms in all six languages under
  `contract-2026-09-25-v4`; existing stored messages remain unchanged.
  Privacy copy describes live fulfillment, delivery-address transfer to Stripe
  and the approved commerce retention schedule described below.
- [x] Show the final price before redirecting to payment (2026-09-25): checking
  prices now creates the final short-lived Stripe Checkout Session, validates and
  displays its automatic-tax result, and keeps the customer on the shipping page.
  "Weiter zur Zahlung" opens that exact Session. This uses native Stripe Checkout
  automatic tax only—not the separately billed Tax Calculation API and not a
  disposable preview Session. The signed paid Session must still match the frozen
  net amounts, pinned customer, displayed tax and displayed gross total.
- [x] Qualified German counsel reviewed the legal notice and privacy policy
  together with the ordering information, price presentation and final live
  provider contracts/data-processing agreements. The maintainer confirmed this
  formal review and provider-agreement qualification complete on 2026-09-25.
- [x] Approve and implement commerce retention (2026-09-24): eight-year order
  evidence, six/eight-year correspondence, three-year operational copies,
  thirty-day confirmed unpaid checkouts and ninety-day technical details.
  Calendar-year deadlines, reviewed holds, longer per-order statutory periods,
  payment uncertainty and object-first deletion are enforced by bounded
  maintenance queries. Policy, classifications and operator commands live in
  `docs/data-retention.md`; the privacy page is updated in all six languages.
  Schema version 5 and the new Stripe expiry subscription are prepared locally;
  activation is part of the controlled cutover, not an already executed release.

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
- [x] Retain the test-mode safety hold: `PRINTFUL_FULFILLMENT_MODE=mock`,
  `PRINTFUL_ALLOW_ORDER_WRITES=false` and
  `PRINTFUL_CONFIRM_LIVE_ORDERS=false` until the cutover is explicitly
  approved. This is a cutover gate, not unfinished provider integration.

## Controlled production cutover

Execute this only after every item above has an owner and all launch blockers
are signed off. Deployment, destructive cleanup, credential rotation and live
provider activation each require explicit maintainer approval at action time.

Execution status on 2026-09-25: the approved commit is deployed in the armed
production posture and the guarded cleanup completed successfully. It deleted
31,077 unrelated hosted-test rows and independently verified that only the 126
rows belonging to event `RimGaoN4-RJkaTJfIN26lg` remain; the private bucket is
empty and the event has no referenced Storage artifacts. The live Stripe,
Printful and Resend values are deployed, the Stripe test secrets are removed,
the exact live webhook and DE `oss_union` + GB `standard` Tax registrations are
verified, and one Frankfurt Machine is pinned healthy. Public traffic remains
locked, Stripe charging is disabled and Printful remains mock/no-write/no-confirm.
Continue only with the separate activation approval at step 9.

1. Include `checkout.session.expired` in the sandbox webhook subscription via
   the guarded configuration command, then run `npm run deploy:hosted` for the
   tested candidate (including schema version 5) while Stripe remains in
   test mode, transactional test email remains enabled and Printful writes
   remain disabled.
2. Run the `lock` phase of `npm run cutover:production` for the exact approved
   commit. It deploys the reviewed hosted-test maintenance configuration and
   verifies public traffic is locked while health endpoints remain available.
3. Set `ALLOW_TEST_DATA_RESET=true` only in the local operator environment and
   run the guarded cleanup from `docs/operations.md`, explicitly preserving
   event `RimGaoN4-RJkaTJfIN26lg`. Verify that only its complete relational graph
   and referenced private artifacts remain while the clean baseline schema is
   unchanged.
4. Restore `ALLOW_TEST_DATA_RESET=false` immediately.
5. Rotate the database runtime credential, Supabase backend key, rate-limit
   HMAC secret and maintenance secret. Update only the stores that consume each
   value. Maintainer decision on 2026-09-25: do not rotate these credentials;
   the shared Fly/Supabase projects are intentionally becoming production,
   repository history contains no production secret, the runtime database role
   is least-privileged and there is no evidence of compromise. This is an
   explicit risk acceptance rather than a completed rotation.
6. Configure the Stripe live key and a new live webhook destination/signing
   secret. Subscribe to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.expired` and
   `charge.refunded`. Never reuse the sandbox or local Stripe CLI webhook secret.
   Completion status on 2026-09-25: the guarded arm phase deployed both live
   secrets without printing them and removed both hosted Stripe test secrets.
   The one live destination at the stable Fly callback URL is enabled for the
   exact four events above. Stripe Tax is active with a German head office,
   default tangible-goods tax code `txcd_99999999`, Germany `oss_union` and
   Great Britain `standard`; live charging remains disabled.
7. Configure the approved Resend and Printful production values while their
   independent live/write/confirmation gates remain disabled.
8. Run the `arm` phase of `npm run cutover:production` with the same explicit
   preserved-event slug. It verifies the preservation boundary, stages the
   reviewed production values and test-secret removals, keeps
   all payment/fulfillment gates off behind maintenance, verifies certificates
   and the canonical redirect, and pins one Machine running.
   Completed on 2026-09-25 for commit
   `6576af1f3fca67696d633f99ee0bc638b52539b3`; all 473 release tests passed.
9. Reconfirm live email and provider/tax settings, then run the separately
   approved `activate` phase. It enables payment and fulfillment gates and
   removes maintenance atomically, performs production health/read-only smoke
   checks, and automatically re-arms maintenance if those checks fail.
10. Complete the explicitly approved minimal live acceptance transaction. If
    it exposes any blocking issue, immediately run the guarded `rearm` phase to
    return the app to the reviewed armed maintenance posture before investigating.

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
