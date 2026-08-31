# Wolkenworte data-retention record

Last reviewed: 2026-08-31

This document records what the application enforces today and which commerce
retention periods still require a German/EU legal and tax decision before live
sales. It does not invent deletion periods for records that may be required for
customer support, bookkeeping or statutory evidence.

## Enforced automatically

| Data | Current lifetime | Enforcement |
|---|---:|---|
| Wedding event, shared words, contribution receipts and event archives | 365 days from event creation | Postgres expiry plus the bounded maintenance cleanup |
| Unpaid product configurations | 365 days from event creation | Removed with their expired event unless retained by a paid order |
| Checkout quote containing address and current provider price | 5–120 minutes, 30 minutes by default | It cannot start Checkout after expiry; abandoned expired quotes are removed after a one-day cleanup grace period |
| Frozen paid print artifact | at least 90 days from submission, or 60 days after delivery | Expiry is extended by fulfillment/webhook state; Storage object is deleted before metadata |
| Reserved event slug | Indefinite | Deliberately retained so an expired wedding URL is never assigned to another couple |
| Hashed reset-attempt source identity | No independent customer profile | Contains only an HMAC, never a raw IP; its event relationship is removed with the expired event |

Support holds override print-artifact deletion. Failed Storage deletion remains
retryable and prevents removal of the last metadata row.

## Decision required before live sales

The following records are intentionally retained until the applicable German/EU
tax, bookkeeping, consumer-law and privacy review defines exact deadlines:

- paid orders and payment/refund identifiers;
- full recipient/shipping addresses frozen into quotes, orders and shipments;
- buyer email addresses;
- immutable sent email subject, HTML and text bodies;
- Stripe, Printful and Resend webhook/delivery metadata;
- fulfillment, maintenance and operator-audit records.

Once those periods are approved, they must be encoded in bounded, tested cleanup
queries. They must not exist only as an informal operator convention.

## Related launch-readiness work

Database backups, private Storage-object exports, restoration testing and one
external error/uptime notification path remain required before live sales.
They are tracked in `docs/launch-readiness.md` rather than duplicated here.
