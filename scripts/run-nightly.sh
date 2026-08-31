#!/bin/bash
# Daily Deck nightly build — safe to run any number of times per day:
# exits immediately if today's deck already exists (idempotent by design).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$DIR/logs"
mkdir -p "$LOGS"

# claude CLI lives in ~/.local/bin; launchd jobs get a minimal PATH
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$DIR"
git pull --rebase --quiet 2>/dev/null || true

node pipeline/build-deck.mjs --push >> "$LOGS/nightly-$(date +%Y-%m-%d).log" 2>&1
