#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$ROOT"

bash "$ROOT/scripts/check-prerequisites.sh"

echo ""
echo "Starting Postgres..."
docker compose up -d

echo "Waiting for Postgres to accept connections..."
for i in {1..30}; do
  if docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1; then
    echo "✓ Postgres is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Postgres did not become ready in time."
    exit 1
  fi
  sleep 1
done

echo ""
echo "Installing npm dependencies..."
npm install

echo ""
echo "Running database migrations..."
npm run db:migrate

echo ""
echo "=========================================="
echo "  Backend setup complete!"
echo "  Run task: Backend: Start API"
echo "  Or:       npm run dev"
echo "=========================================="
