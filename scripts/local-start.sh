#!/usr/bin/env bash
# LOCAL TEST KIT: starts the public site (http://localhost:3005) and the admin site (http://localhost:3006). Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo "Run bash scripts/local-setup.sh first." >&2; exit 1; }
docker compose -f docker-compose.local.yml up -d --wait
trap 'kill 0' EXIT INT TERM
APP_MODE=public NEXT_DIST_DIR=.next npx next dev -p 3005 &
APP_MODE=admin NEXT_DIST_DIR=.next-admin npx next dev -p 3006 &
echo "Open http://localhost:3005/dev-login (public) and http://localhost:3006/dev-login (admin) in about 30 seconds."
wait
