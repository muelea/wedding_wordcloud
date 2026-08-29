#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Fehler: Node.js ist nicht installiert. Bitte installiert Node.js 22 oder neuer."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Fehler: npm ist nicht installiert. Bitte installiert Node.js 22 oder neuer."
  exit 1
fi

NPM_MAJOR="$(npm --version | cut -d. -f1)"
if [[ ! "$NPM_MAJOR" =~ ^[0-9]+$ ]] || (( NPM_MAJOR < 10 )); then
  echo "Fehler: Gefunden wurde npm $(npm --version), benötigt wird npm 10 oder neuer."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Fehler: Gefunden wurde Node.js $(node --version), benötigt wird Node.js 22 oder neuer."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Fehler: Die lokale .env fehlt. Bitte bezieht die freigegebene Entwicklungs-.env sicher vom Maintainer."
  exit 1
fi

node scripts/prepare-local.js

exec npm start
