#!/usr/bin/env bash
# Deploy the topdown-city game. Runs ON THE SERVER — the GitHub Actions workflow
# (.github/workflows/deploy.yml) pipes this in over SSH.
#
# Build-on-server: pull main, rebuild the image (pnpm build + vite build), and
# health-check. Health-checks the container's own loopback port rather than the
# public URL, so a deploy succeeds even before DNS/cert for gta.mich312.dev is
# live (the edge proxy is verified separately). Rolls back on failure — and a
# failed build leaves the old container running.
set -euo pipefail

REPO_DIR="$HOME/gta-2"
URL="http://127.0.0.1:8080/"   # container's loopback publish
cd "$REPO_DIR"

compose() { docker compose -f docker-compose.yml -f docker-compose.edge.yml "$@"; }

healthy() {
  sleep 3
  for _ in $(seq 1 18); do   # ~90s
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL") || code=000
    echo "  $URL -> $code"
    case "$code" in [1-4][0-9][0-9]) return 0 ;; esac
    sleep 5
  done
  return 1
}

PREV=$(git rev-parse HEAD)
git fetch origin --quiet
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
echo "deploying ${PREV:0:8} -> ${NEW:0:8}"

compose up -d --build

echo "health-checking $URL ..."
if healthy; then
  echo "✅ deploy OK: ${NEW:0:8}"
  exit 0
fi

echo "❌ unhealthy — rolling back to ${PREV:0:8}"
git reset --hard "$PREV"
compose up -d --build
if healthy; then echo "rolled back to ${PREV:0:8}"; else echo "rollback ALSO unhealthy — needs a look"; fi
exit 1
