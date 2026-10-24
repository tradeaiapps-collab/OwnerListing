#!/usr/bin/env bash
# LOCAL TEST KIT: wipes the local database and loads fresh demo data. .env.local is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo "Run bash scripts/local-setup.sh first." >&2; exit 1; }
echo "This deletes ALL local test data (not your code). Stop the sites first."
read -r -p "Type YES to continue: " ans
[ "$ans" = "YES" ] || { echo "Cancelled."; exit 0; }
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d --wait
node --env-file=.env.local scripts/migrate.mjs
node --env-file=.env.local scripts/seed-demo.mjs
echo "Reset done. Start the sites with: bash scripts/local-start.sh"
