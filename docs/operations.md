# Built-in operations runbook

These operations use the existing Node.js, Fly and Supabase/Postgres stack.
External notification and backup decisions are deferred until after initial
paid orders, as tracked in `docs/launch-readiness.md`.

## Read aggregate operational status

From a trusted local shell whose ignored `.env` contains the hosted runtime
database connection:

```bash
npm run ops:status
```

The same aggregate view is available to an authenticated operator at
`GET /internal/performance/operations` with `Authorization: Bearer
<MAINTENANCE_SECRET>`. It reports counts and ages only—never slugs, names,
addresses, email addresses, provider payloads or object keys. The existing
`/internal/performance/snapshot` adds process, event-loop, Postgres pool,
Socket.io room and accepted/rejected operation counters.

## Verify hosted Stripe payment delivery

Local signed-webhook fixtures prove the handler but not Stripe's external
delivery configuration. After completing one Fly-hosted sandbox Checkout, copy
the `cs_test_...` query value from the confirmation URL and run:

```bash
npm run stripe:verify-hosted-payment -- --session cs_test_...
```

The read-only command verifies the exact enabled Stripe destination and events,
the paid sandbox Session, completed Stripe delivery, the corresponding
`paid_test` database order, mock fulfillment, delivered Resend confirmation and the
public order-confirmation API. It rejects live keys and every target other than
`https://wolkenworte.fly.dev`.

If the destination must be created or its signing secret rotated, use the
separate mutation command and deploy the staged Fly secret:

```bash
npm run stripe:configure-webhook -- --confirm-replace-webhook
npm run deploy:hosted
```

This replaces only the destination for Wolkenworte's hosted-test callback. It
does not modify unrelated Stripe endpoints and never prints the signing secret.
The deployment is the repository's guarded local hosted-test release command;
there is no remote deployment workflow.

## Retry one blocked fulfillment

First inspect the blocked order in Supabase using only its internal numeric ID
and confirm the provider state. The retry reuses the frozen print artifacts,
lease fencing and deterministic Printful external ID; it never generates a new
provider identity.

```bash
npm run ops:retry-fulfillment -- --order-id 123 --confirm-fulfillment-retry
```

The command refuses missing confirmation, unknown orders and every order not
currently in `blocked`. Its durable `operator_actions` record contains the
order ID and before/after state, not customer details. In `live` mode the
explicit command may reconcile or write the selected Printful order, so use it
only after checking that exact blocked order.

## One-time hosted-test cleanup

This command is deliberately restricted to `https://wolkenworte.fly.dev`. It
cannot target a future custom production domain. For the initial cutover it
preserves the complete database graph and every referenced private artifact for
event `RimGaoN4-RJkaTJfIN26lg`, while deleting all unrelated hosted-test objects
and business rows. Application migrations and the least-privileged runtime role
remain intact.

Do not run it during ordinary development. At the approved pre-live cutover:

1. Run the reviewed maintenance-lock phase for the exact approved commit:

   ```bash
   npm run cutover:production -- \
     --phase=lock \
     --confirm-commit=<40-character-approved-commit> \
     --confirm-maintenance-lock
   ```

   This keeps Stripe in test mode and Printful in mock/no-write mode, deploys
   `fly.cutover-maintenance.toml`, and verifies the public maintenance response
   plus health endpoints. Do not reproduce it with individual Fly commands.
2. In the local ignored `.env` only, temporarily set
   `ALLOW_TEST_DATA_RESET=true` and retain the hosted runtime credentials.
3. Run:

   ```bash
   npm run ops:prelive-cleanup -- \
     --target-url https://wolkenworte.fly.dev \
     --preserve-event-slug=RimGaoN4-RJkaTJfIN26lg \
     --confirm-prelive-cleanup
   ```

4. Confirm the command reports `verifiedClean: true`, `verifiedEmpty: false`
   and the exact preserved slug. Verify that the event still opens after the
   later activation, then restore `ALLOW_TEST_DATA_RESET=false` immediately.
   Leave the Fly app locked in maintenance mode for credential rotation and the
   production arm phase.

Before deleting anything, the command also compares a secret-bound hash of the
target app's database project, Supabase project and bucket with the local
credentials. A stale `.env` pointing at a different project is rejected.

If Storage deletion fails, database deletion does not start. Fix access or the
object failure and rerun the same guarded command. Never manually delete the
remaining metadata first.

Deployment and this destructive cleanup each require separate explicit
maintainer approval; implementing the command does not execute either action.

## Controlled production cutover command

`npm run cutover:production` is the only supported path from the existing
hosted-test app to live sales. It uses the same Fly and Supabase projects. A
read-only preflight validates the clean `main` commit, `origin/main`, all three
reviewed Fly configs, local production credential shapes, Fly authentication,
Docker, certificates, the single-Machine topology, and the current secret
boundary:

```bash
npm run cutover:production -- --phase=preflight
```

After the cleanup and credential rotations are complete, `arm` first verifies
that the rotated database/Supabase identity still matches the locked Fly target
and that only the explicitly preserved event graph and its private artifacts
remain. If the
maintenance secret was rotated locally, temporarily retain the still-active
old value as `CUTOVER_CURRENT_MAINTENANCE_SECRET`; it is used only for this
identity proof, never uploaded, and must be cleared after `arm` succeeds. The
phase then stages the reviewed runtime values from the ignored local `.env`,
stages removal of the two hosted Stripe test secrets, and only then deploys
`fly.production-armed.toml`. That release selects the live Stripe credentials
but keeps the site in maintenance, live payments disabled, and all Printful
order writes disabled:

```bash
npm run cutover:production -- \
  --phase=arm \
  --confirm-commit=<40-character-approved-commit> \
  --preserve-event-slug=RimGaoN4-RJkaTJfIN26lg \
  --confirm-production-arm
```

The final `activate` phase is a separate approval. It re-runs the full release
gate and preservation-boundary verification, then applies `fly.production.toml` in one
single-Machine release: maintenance is removed while Stripe payments and all
three Printful live gates are enabled together. It performs only health and
read-only HTTP checks. If deployment or those checks fail, the command
automatically redeploys the armed maintenance configuration and verifies that
safe posture before returning failure.

The first armed release temporarily kept one Machine running. Before activation,
convert that exact transitional posture to the reviewed automatic stop/start
lifecycle. This phase keeps maintenance active and every payment/fulfillment
gate disabled, runs the full release checks, and changes the Fly release to
`min_machines_running=0`:

```bash
npm run cutover:production -- \
  --phase=autosleep \
  --confirm-commit=<40-character-approved-commit> \
  --confirm-production-autosleep
```

The phase is deliberately idempotent from the resulting armed posture so a
reviewed safety fix can be deployed and rechecked before activation without
falling back to ad-hoc Fly commands.

The Supabase `wolkenworte-maintenance` pg_cron job remains active every five
minutes. Its authenticated request can wake the Machine, runs bounded provider
queue and retention work, and then allows Fly to stop the Machine again when it
is idle. Maintenance mode blocks browser and API traffic but deliberately lets
that exact bearer-authenticated wake-up and the signature-verified Stripe,
Printful and Resend callback paths reach their own authentication boundaries.
The production smoke sends only invalid-signature probes and requires all three
callbacks to reject them with HTTP 400; it creates no provider or business data.

```bash
npm run cutover:production -- \
  --phase=activate \
  --confirm-commit=<40-character-approved-commit> \
  --preserve-event-slug=RimGaoN4-RJkaTJfIN26lg \
  --confirm-live-activation
```

If the later real acceptance transaction exposes a blocking problem, use the
fast guarded rollback posture rather than an improvised Fly deployment. It is
accepted only from the exact active posture and atomically restores maintenance
with payments and Printful writes disabled while keeping the production secrets
in place:

```bash
npm run cutover:production -- \
  --phase=rearm \
  --confirm-commit=<40-character-approved-commit> \
  --confirm-emergency-rearm
```

Each mutating phase, including `autosleep` and emergency re-arm, requires the exact full
approved commit, its own phase-specific confirmation, and a clean local `main`
that exactly matches `origin/main`. The normal `lock`, `arm`, `autosleep` and `activate`
phases re-run the complete test suite and migrations. Emergency `rearm`
deliberately skips those slow release steps so it can restore the already-tested
armed posture quickly. All phases reject multiple Fly Machines, mixed test/live
Stripe secrets, staged or partially deployed secrets, an unexpected prior
posture, or unsafe local gates. Never run `activate` until the live provider/tax
review and explicit acceptance transaction approval are complete.


## Updates after production activation

Once real customer data exists, deploy approved updates with the guarded
`release` phase. It requires the exact active production posture, the production
secret boundary and a clean `main` matching `origin/main`:

```bash
npm run cutover:production -- \
  --phase=release \
  --confirm-commit=<40-character-approved-commit> \
  --confirm-production-release
```

The command runs `npm ci`, the complete test suite, an AMD64 production image
build, uploaded-image pixel and font-contract/geometry tests inside that Linux
candidate, strict configuration validation, read-only target schema/runtime
permission checks, ordered migrations and a second schema/access check. A failed
check stops before deployment. It rechecks the exact commit and active
production boundary immediately before deploying `fly.production.toml`, then
verifies public health, representative read-only routes, callback authentication
and the healthy Machine.
Deployment or post-release verification failure invokes the existing automatic
maintenance re-arm.

This phase keeps the existing production credentials, maintenance Cron and
customer data. It does not run pre-live cleanup or empty-database verification,
stage secrets or send provider orders. Never repeat the initial `arm`/`activate`
sequence or use `deploy:hosted` for a post-launch update. Each release requires
explicit maintainer deployment approval for its exact reviewed commit.

### Explicitly approved light releases

The full `release` phase remains the default. For a small reviewed update, the
maintainer may separately approve a **lighter deployment of the exact commit**:

```bash
npm run cutover:production -- \
  --phase=release-light \
  --confirm-commit=<40-character-approved-commit> \
  --confirm-production-light-release
```

The phase and confirmation flag must match; the normal production-release
confirmation does not approve a light release. Approval to prepare this mode,
ordinary deployment approval, the size of a diff, and a previous light release
never authorize its use. Coding agents must obtain that explicit human approval
for each light deployment. There is no persistent skip setting, generic
`--skip-tests` option or automatic fallback after a failed full release check.

| Check or action | Full `release` | Approved `release-light` |
| --- | --- | --- |
| Reproducible `npm ci` and clean `main` matching `origin/main` | Required | Required |
| Exact commit, production posture, certificates, secret boundary and strict Fly config | Required | Required |
| Complete local functional suite | Required | Skipped |
| Local AMD64 image build and Linux pixel/font/geometry/emoji tests | Required | Skipped |
| Read-only target schema and least-privileged runtime access | Before and after migrations | Current schema must already match |
| Ordered database migrations | Applied | Never applied; pending migrations block release |
| Remote image build and production deployment | Required | Required |
| Post-deployment smoke/health checks and automatic maintenance re-arm on failure | Required | Required |

Light mode uses the same guarded production deployment and failure recovery;
it does not stage secrets, change Cron, clean up customer data or enable
accounts. `--enable-design-accounts` requires the full release phase. Docker
and the existing local operator credentials remain necessary: the read-only
database verifier still builds its reference only in disposable local Postgres.
All meaningful focused checks for the approved change should pass before
deployment. A light release does not establish that the full suite or Linux
image tests passed.

### Recovering an automatically re-armed release

If a release's post-deployment smoke fails, production stays in maintenance.
Fix and test the operator check before restoring sales. Never repeat initial
cutover cleanup or improvise Fly secret/config commands. The guarded `recover`
phase requires a separate maintainer recovery approval, the exact current
operator commit, the previously fully verified application commit and the exact
already-deployed image digest.

`recover-check` is read-only: it requires the armed production posture and secret
boundary, checks maintenance health and database compatibility, rejects any
application/dependency/migration/Fly-config change since the verified commit,
and compares the deployed application file tree byte for byte with Git (ignoring
only Finder's `.DS_Store` metadata). Only
operator scripts, tests and documentation may differ. Review this output first:

```bash
npm run cutover:production -- --phase=recover-check \
  --verified-commit=<fully-tested-application-sha> --confirm-image=sha256:<image-digest>
```

After the separate approval, run the same arguments with `--phase=recover`,
`--confirm-commit=<current-operator-sha>` and `--confirm-production-recovery`.
Recovery deploys that immutable existing image with the reviewed active config;
it does not rebuild, migrate, clean business data or stage secrets. The full
suite and Linux image checks are reused only because the application image and
application source are unchanged from the verified release. The corrected
operator smoke must have its focused and real-router regression checks pass.
Public health, read-only application routes, webhook authentication, production
posture and Machine health are verified again. Any failure re-arms maintenance
with the same pinned image.

## Retention holds

The approved retention policy, data categories and guarded per-order hold /
release / longer-period commands are in [data-retention.md](data-retention.md).
`ops:status` exposes `retention.reviewsDue` and
`retention.unresolvedCheckouts`. Review holds and uncertain payments before
allowing their deletion; a review date never releases a hold automatically.
