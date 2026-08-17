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

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Fehler: Gefunden wurde Node.js $(node --version), benötigt wird Node.js 22 oder neuer."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installiere Abhängigkeiten für den ersten Start ..."
  npm install
fi

echo "WeddingCloud startet auf http://localhost:${PORT:-3000}"
exec npm start
