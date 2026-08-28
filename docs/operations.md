# Built-in operations runbook

These operations use the existing Node.js, Fly and Supabase/Postgres stack.
External notification and backup providers are deliberately separate launch
readiness items tracked in `docs/launch-readiness.md`.

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
`paid_test` database order, mock fulfillment, mock confirmation email and the
public order-confirmation API. It rejects live keys and every target other than
`https://wolkenworte.fly.dev`.

If the destination must be created or its signing secret rotated, use the
separate mutation command and deploy the staged Fly secret:

```bash
npm run stripe:configure-webhook -- --confirm-replace-webhook
flyctl deploy --app wolkenworte
```

This replaces only the destination for Wolkenworte's hosted-test callback. It
does not modify unrelated Stripe endpoints and never prints the signing secret.

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
cannot target a future custom production domain. It removes every object from
the configured private Storage bucket first and clears hosted-test business
rows only after the bucket is verified empty. Application migrations and the
least-privileged runtime role remain intact.

Do not run it during ordinary development. At the approved pre-live cutover:

1. Deploy the tested application code and migrations.
2. Keep payments, email and fulfillment in their safe modes: live Stripe off,
   email mock, Printful mock, order writes off and confirmations off.
3. Temporarily set `MAINTENANCE_MODE=true` on Fly. Verify `/` returns `503` and
   `X-Wolkenworte-Maintenance: active`; health endpoints remain available.
4. In the local ignored `.env` only, temporarily set
   `ALLOW_TEST_DATA_RESET=true` and retain the hosted runtime credentials.
5. Run:

   ```bash
   npm run ops:prelive-cleanup -- --target-url https://wolkenworte.fly.dev --confirm-prelive-cleanup
   ```

6. Confirm the command reports `verifiedEmpty: true`, restore
   `ALLOW_TEST_DATA_RESET=false`, and set `MAINTENANCE_MODE=false` on Fly.

Before deleting anything, the command also compares a secret-bound hash of the
target app's database project, Supabase project and bucket with the local
credentials. A stale `.env` pointing at a different project is rejected.

If Storage deletion fails, database deletion does not start. Fix access or the
object failure and rerun the same guarded command. Never manually delete the
remaining metadata first.

Deployment and this destructive cleanup each require separate explicit
maintainer approval; implementing the command does not execute either action.
