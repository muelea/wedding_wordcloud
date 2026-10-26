#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

usage() {
  echo "Verwendung: ./run_local.sh [--seed-cloud DATEI.json] [--printful-mockups]"
}

SEED_CLOUD_FILE=""
PRINTFUL_MOCKUP_TOOLS_ENABLED="false"
while (( $# > 0 )); do
  case "$1" in
    --seed-cloud)
      if (( $# < 2 )) || [[ "$2" == -* ]]; then
        echo "Fehler: --seed-cloud benötigt eine JSON-Datei."
        usage
        exit 1
      fi
      if [[ -n "$SEED_CLOUD_FILE" ]]; then
        echo "Fehler: --seed-cloud darf nur einmal angegeben werden."
        exit 1
      fi
      SEED_CLOUD_FILE="$2"
      shift 2
      ;;
    --printful-mockups)
      if [[ "$PRINTFUL_MOCKUP_TOOLS_ENABLED" == "true" ]]; then
        echo "Fehler: --printful-mockups darf nur einmal angegeben werden."
        exit 1
      fi
      PRINTFUL_MOCKUP_TOOLS_ENABLED="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Fehler: Unbekannte Option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -t 0 && -t 1 ]]; then
  source ./setup.sh develop --install
else
  source ./setup.sh develop
fi

env PRINTFUL_MOCKUP_TOOLS_ENABLED="$PRINTFUL_MOCKUP_TOOLS_ENABLED" node scripts/prepare-local.js

if [[ -n "$SEED_CLOUD_FILE" ]]; then
  env PRINTFUL_MOCKUP_TOOLS_ENABLED="$PRINTFUL_MOCKUP_TOOLS_ENABLED" \
    node scripts/seed-local-cloud.js "$SEED_CLOUD_FILE"
fi

if [[ "$PRINTFUL_MOCKUP_TOOLS_ENABLED" == "true" ]]; then
  echo "[local] Printful-Mockup-Werkzeuge sind für diese Sitzung aktiviert."
fi

exec env PRINTFUL_MOCKUP_TOOLS_ENABLED="$PRINTFUL_MOCKUP_TOOLS_ENABLED" npm start
