#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

missing=0

check() {
  local cmd="$1"
  local hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "✓ $cmd — $(command -v "$cmd")"
  else
    echo "✗ $cmd — not found"
    echo "  → $hint"
    missing=1
  fi
}

echo "Checking backend prerequisites..."
echo ""

check docker "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
check npm "Install Node.js: brew install node  OR  https://nodejs.org"

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "Install the missing tools above, then run the task:"
  echo "  Backend: Full Setup"
  exit 1
fi

echo ""
echo "All prerequisites found. You can run Backend: Full Setup."
