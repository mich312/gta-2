#!/bin/sh
# V-iter9-history, AFTER leg only: re-derive the AFTER columns of
# evidence/iter9-instrument/history.txt on the CURRENT tree, WITHOUT the
# source swap that evidence/iter9-instrument/rescore-history.sh performs.
#
#   sh evidence/iter10-verify/rescore-after-only.sh
set -e
S=/tmp/claude-0/-home-user-gta-2/297482db-7a0b-5d48-914d-987762c0d996/scratchpad
SHAS="e3306c8~2 7769a2c ffb2e89 b5c7805 ce3189b cda745a bb0aaae"
for s in $SHAS; do
  k=$(echo "$s" | tr -d '~')
  git show "$s":shared/src/world/city.data.ts > "$S/v10-bake-$k.ts"
done
printf '%-34s %8s %10s %10s\n' 'bake' 'TOTAL' 'SCORE' 'DRAWN'
for s in $SHAS; do
  k=$(echo "$s" | tr -d '~')
  node server/dist/tools/mapAudit.js --data="$S/v10-bake-$k.ts" --summary > "$S/v10-after-$k.txt" 2>&1
  a=$(grep '^# TOTAL ' "$S/v10-after-$k.txt" | head -1)
  printf '%-34s %8s %10s %10s\n' "$s" \
    "$(echo "$a" | awk '{print $3}')" "$(echo "$a" | awk '{print $5}')" "$(echo "$a" | awk '{print $6}')"
done
