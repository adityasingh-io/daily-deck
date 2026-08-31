#!/bin/bash
# Daily Deck nightly build — safe to run any number of times per day:
# exits immediately if today's deck already exists (idempotent by design).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$DIR/logs"
mkdir -p "$LOGS"

# launchd jobs get a minimal PATH: add claude (~/.local/bin) and node.
# node may live under nvm/volta/homebrew — probe the usual homes, newest nvm first.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for d in $(ls -d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | sort -rV) "$HOME/.volta/bin"; do
    if [ -x "$d/node" ]; then export PATH="$d:$PATH"; break; fi
  done
fi

cd "$DIR"
git pull --rebase --quiet 2>/dev/null || true

node pipeline/build-deck.mjs --push >> "$LOGS/nightly-$(date +%Y-%m-%d).log" 2>&1
