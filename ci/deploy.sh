#!/usr/bin/env bash
# Deploy the topdown-city game. Runs ON THE SERVER — the GitHub Actions workflow
# (.github/workflows/deploy.yml) pipes this in over SSH:
#
#   ssh root@host 'bash -s -- <commit-sha>' < ci/deploy.sh
#
# The commit is an ARGUMENT on purpose. The workflow's `test` job gates one
# exact sha; if this script resolved its own target (`git reset --hard
# origin/main`) it would ship whatever main happens to be by the time the
# server fetches, minutes later — a different commit from the one the suite
# passed. No sha, no deploy.
#
# Build-on-server: check out that commit, rebuild the image (pnpm build + vite
# build), and health-check. Health-checks the container's own loopback port
# rather than the public URL, so a deploy succeeds even before DNS/cert for
# gta.mich312.com is live (the edge proxy is verified separately). Rolls back on
# failure — and a failed build leaves the old container running.
set -euo pipefail

REPO_DIR="$HOME/gta-2"
URL="http://127.0.0.1:8080/"   # container's loopback publish

TARGET="${1:-}"
if [[ ! "$TARGET" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "usage: bash -s -- <commit-sha>" >&2
  echo "refusing: no valid target commit given (got '${TARGET}') — nothing deployed" >&2
  exit 2
fi

cd "$REPO_DIR"

compose() { docker compose -f docker-compose.yml -f docker-compose.edge.yml "$@"; }

healthy() {
  sleep 3
  for _ in $(seq 1 18); do   # ~90s
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL") || code=000
    echo "  $URL -> $code"
    # 2xx only. The container's loopback port is the game's own Node server
    # (docker-compose.yml publishes 127.0.0.1:8080 straight at it), and its
    # static handler answers `/` with 200 or, if the client bundle is missing,
    # 500 — it never redirects. Anything else means the deploy is broken, and
    # the rollback below lives entirely in this check's fall-through.
    case "$code" in 2[0-9][0-9]) return 0 ;; esac
    sleep 5
  done
  return 1
}

PREV=$(git rev-parse HEAD)

# Resolve the target BEFORE touching the working tree: if the commit never
# arrives, the old checkout and the running container are left untouched.
git fetch origin --quiet
if ! git cat-file -e "${TARGET}^{commit}" 2>/dev/null; then
  # Not covered by origin's default refspec (or pushed after that fetch began).
  git fetch origin --quiet "$TARGET" 2>/dev/null || true
fi
if ! git cat-file -e "${TARGET}^{commit}" 2>/dev/null; then
  echo "❌ commit ${TARGET} not on this server after fetch — nothing deployed, ${PREV:0:8} still running" >&2
  exit 1
fi

git reset --hard "$TARGET"
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
