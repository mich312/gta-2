#!/bin/sh
# V-iter9-history, BEFORE leg: reproduce the BEFORE columns of
# evidence/iter9-instrument/history.txt WITHOUT overwriting
# server/src/tools/mapAudit.ts, which iteration 9's own rescore-history.sh
# does (cp aside, git show over it, cp back). This verifier is not allowed to
# touch production source, so the bb0aaae instrument is staged instead at
# evidence/iter10-verify/oldaudit/mapAudit.ts — which is deliberately at the
# SAME directory depth as server/src/tools, so its relative import
# `../../../shared/dist/world/fields.js` still resolves — with a local
# node_modules/shared symlink for the bare `shared` specifier, and run through
# node 22's type stripping.
#
#   sh evidence/iter10-verify/rescore-before-only.sh
set -e
S=/tmp/claude-0/-home-user-gta-2/297482db-7a0b-5d48-914d-987762c0d996/scratchpad
OLD=evidence/iter10-verify/oldaudit/mapAudit.ts
SHAS="e3306c8~2 7769a2c ffb2e89 b5c7805 ce3189b cda745a bb0aaae"

# Control: the staged instrument must NOT be the current one. If the two agree
# on bb0aaae's country-outside-blocks then the swap did not happen and every
# row below is the AFTER instrument wearing the BEFORE column's label.
node "$OLD" --data="$S/v10-bake-bb0aaae.ts" --summary > "$S/v10-ctl-old.txt" 2>&1
node server/dist/tools/mapAudit.js --data="$S/v10-bake-bb0aaae.ts" --summary > "$S/v10-ctl-new.txt" 2>&1
co=$(grep '^# country-outside-blocks ' "$S/v10-ctl-old.txt" | awk '{print $3}')
cn=$(grep '^# country-outside-blocks ' "$S/v10-ctl-new.txt" | awk '{print $3}')
echo "# CONTROL: country-outside-blocks on bb0aaae — staged(bb0aaae)=$co  current tree=$cn"
if [ "$co" = "$cn" ]; then echo "#   *** the two instruments AGREE: the staged copy is not the old one ***";
else echo "#   they differ, so the staged copy really is the pre-iteration-9 instrument  FIRES"; fi
echo ""

printf '%-34s %8s %10s\n' 'bake' 'TOTAL' 'SCORE'
for s in $SHAS; do
  k=$(echo "$s" | tr -d '~')
  node "$OLD" --data="$S/v10-bake-$k.ts" --summary > "$S/v10-before-$k.txt" 2>&1
  b=$(grep '^# TOTAL ' "$S/v10-before-$k.txt" | head -1)
  printf '%-34s %8s %10s\n' "$s" "$(echo "$b" | awk '{print $3}')" "$(echo "$b" | awk '{print $5}')"
done
