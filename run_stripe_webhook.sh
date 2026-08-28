#!/usr/bin/env bash

set -euo pipefail

if ! command -v stripe >/dev/null 2>&1; then
  echo "Fehler: Die Stripe CLI ist nicht installiert."
  echo "Installation unter macOS: brew install stripe/stripe-cli/stripe"
  echo "Danach einmalig ausführen: stripe login"
  exit 1
fi

APP_PORT="${PORT:-3000}"

echo "Leite Stripe-Testwebhooks an http://localhost:${APP_PORT}/webhook/stripe weiter."
echo "Kopiere das angezeigte whsec_... als STRIPE_TEST_LOCAL_WEBHOOK_SECRET in .env"
echo "und starte WeddingCloud danach neu, falls es bereits läuft."
echo

exec stripe listen --forward-to "localhost:${APP_PORT}/webhook/stripe"
