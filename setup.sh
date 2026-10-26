#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

INSTALL=false
PROFILE=test
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=true ;;
    develop|test|deploy) PROFILE="$arg" ;;
    --help|-h)
      echo 'Verwendung: ./setup.sh [develop|test|deploy] [--install]'
      echo 'Prüft ohne Installation. --install bietet einzelne Aktionen mit Rückfrage an.'
      exit 0 ;;
    *) echo "Unbekannte Option: $arg"; exit 1 ;;
  esac
done

confirm() {
  local answer
  if [[ ! -t 0 || ! -t 1 ]]; then return 1; fi
  read -r -p "$1 [j/N] " answer
  case "$answer" in j|J|ja|Ja|y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'process.exit(Number.parseInt(process.versions.node,10)>=22?0:1)' &&
    [[ "$(npm --version)" =~ ^([1-9][0-9]|[1-9][0-9][0-9]+)\. ]]
}

# Discover an existing Homebrew without changing shell profiles or global links.
if ! command -v brew >/dev/null 2>&1; then
  for brew_dir in /opt/homebrew/bin /usr/local/bin; do
    if [[ -x "$brew_dir/brew" ]]; then export PATH="$brew_dir:$PATH"; break; fi
  done
fi

NEEDS_BREW=false
if ! node_ready; then NEEDS_BREW=true; fi
if [[ "$PROFILE" != develop ]] && ! command -v docker >/dev/null 2>&1; then NEEDS_BREW=true; fi
if [[ "$PROFILE" == deploy ]] && ! command -v flyctl >/dev/null 2>&1; then NEEDS_BREW=true; fi
if [[ "$INSTALL" == true && "$NEEDS_BREW" == true && "$(uname -s)" == Darwin ]] && ! command -v brew >/dev/null 2>&1; then
  echo 'Homebrew fehlt. Es kann die angebotenen Programme installieren: https://brew.sh'
  if confirm 'Offiziellen Homebrew-Installer von github.com/Homebrew/install herunterladen und ausführen?'; then
    installer_file="$(mktemp -t wolkenworte-homebrew)"
    trap 'rm -f "$installer_file"' EXIT
    /usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer_file"
    /bin/bash "$installer_file"
    rm -f "$installer_file"
    trap - EXIT
    for brew_dir in /opt/homebrew/bin /usr/local/bin; do
      if [[ -x "$brew_dir/brew" ]]; then export PATH="$brew_dir:$PATH"; break; fi
    done
  fi
fi

if ! node_ready; then
  echo 'Node.js 22+ und npm 10+ werden benötigt (Projektstandard: Node 22, .nvmrc).'
  if [[ "$INSTALL" == true && "$(uname -s)" == Darwin ]] && command -v brew >/dev/null 2>&1 &&
      confirm 'Node.js 22 mit npm über „brew install node@22“ installieren/aktivieren?'; then
    brew install node@22
    node_prefix="$(brew --prefix node@22)"
    export PATH="$node_prefix/bin:$PATH"
    echo 'Node 22 ist für diesen Aufruf aktiviert. Für andere Terminals: nvm use oder den Node-Pfad gemäß Anleitung setzen.'
  fi
  if ! node_ready; then
    echo "Abbruch: ./setup.sh $PROFILE --install im Terminal ausführen. Anleitung: docs/development-environment.md"
    exit 1
  fi
fi

node scripts/check-environment.js "$@"
