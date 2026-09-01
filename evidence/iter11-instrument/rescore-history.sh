#!/bin/sh
# Re-score every bake this loop has produced, with the instrument BEFORE
# iteration 11's two new signatures and with it AFTER, so the series stays
# continuous across a detector that has just grown.
#
#   sh evidence/iter11-instrument/rescore-history.sh
#
# This is iteration 9's `rescore-history.sh` pointed at iteration 11's break.
# Adding a signature changes TOTAL and SCORE exactly as correcting one did, so
# it owes the same restatement, and the BEFORE column has to reproduce every
# number this loop has published or the AFTER column means nothing.
#
# `--data` decodes any committed `city.data.ts`, so no worktree per commit is
# needed. The "before" leg checks out `d7b4256`'s copy of `mapAudit.ts`,
# measures, and puts the working copy straight back — by `cp`, never by
# `git stash`, because refs/stash is shared between worktrees in this project
# and two agents have already popped each other's work out of it.
#
# THE PLAN IS HELD CONSTANT AND DOES NOT NEED TO BE STAGED. `--data` swaps the
# BAKE only; the plan comes from the working tree. That is fine here and it is
# checkable: `shared/data/city-plan.json` is blob 8ef130c on every commit in
# this table, so `course-unbuilt` asks all eight bakes about the same authored
# roads, which is what makes its column a series rather than eight readings.
#
# It writes `history.txt` beside this script.
set -e
SRC=server/src/tools/mapAudit.ts
OUT=evidence/iter11-instrument/history.txt
KEEP=/tmp/iter11-history-keep.ts
BASE=d7b4256   # the branch head: the instrument iterations 9 and 10 published with

# e3306c8~2 is older than the series and is carried as the CALIBRATION bake:
# `country-outside-blocks` is known present on it, so a detector that reports
# it clean has gone blind rather than got better.
SHAS="e3306c8~2 7769a2c ffb2e89 b5c7805 ce3189b cda745a bb0aaae d7b4256"

for s in $SHAS; do
  git show "$s":shared/src/world/city.data.ts > "/tmp/iter11-bake-$(echo "$s" | tr -d '~').ts"
done

measure() {  # $1 = before|after
  pnpm build >/dev/null 2>&1
  for s in $SHAS; do
    f="/tmp/iter11-bake-$(echo "$s" | tr -d '~').ts"
    node server/dist/tools/mapAudit.js --data="$f" --summary \
      > "/tmp/iter11-$1-$(echo "$s" | tr -d '~').txt" 2>&1
  done
}

cp "$SRC" "$KEEP"
git show "$BASE":"$SRC" > "$SRC"
measure before
cp "$KEEP" "$SRC"
measure after

label_of() {
  case "$1" in
    "e3306c8~2") echo "e3306c8~2  pre-iteration-3 (calib)";;
    7769a2c) echo "7769a2c    pre-iteration-5";;
    ffb2e89) echo "ffb2e89    post-iteration-5";;
    b5c7805) echo "b5c7805    post-iteration-5 (instr)";;
    ce3189b) echo "ce3189b    post-iteration-6";;
    cda745a) echo "cda745a    post-iteration-7 (no map)";;
    bb0aaae) echo "bb0aaae    post-iteration-8";;
    d7b4256) echo "d7b4256    post-iteration-10 (head)";;
    *) echo "$1";;
  esac
}

{
  echo "# mapaudit re-scored: the same eight bakes, the instrument before and after iteration 11"
  echo "#"
  echo "# BEFORE = mapAudit.ts at $BASE — 20 signatures. This is the code that published"
  echo "#          TOTAL 48 / SCORE 2653.8 / DRAWN 2522.5 for the head bake, and the BEFORE"
  echo "#          column below has to reproduce that or nothing beside it is worth reading."
  echo "# AFTER  = this tree — 22 signatures. course-unbuilt reports the 508 tiles of authored"
  echo "#          road citybake --check has warned about on every run of this loop, and"
  echo "#          landuse-staircase reports the land-use fill that no painter repaints."
  echo "#"
  echo "# Neither new signature moves with the map on this series: the six unbuilt spans are"
  echo "# the same six on every bake, so the DELTAS between iterations are unchanged by the"
  echo "# restatement, exactly as they were for iteration 9's correction."
  echo "#"
  printf '%-34s %8s %10s %10s %8s %10s %10s\n' 'bake' 'TOTAL' 'SCORE' 'DRAWN' 'TOTAL' 'SCORE' 'DRAWN'
  printf '%-34s %8s %10s %10s %8s %10s %10s\n' '' '(before)' '(before)' '(before)' '(after)' '(after)' '(after)'
  for s in $SHAS; do
    k=$(echo "$s" | tr -d '~')
    b=$(grep '^# TOTAL ' "/tmp/iter11-before-$k.txt" | head -1)
    a=$(grep '^# TOTAL ' "/tmp/iter11-after-$k.txt" | head -1)
    printf '%-34s %8s %10s %10s %8s %10s %10s\n' "$(label_of "$s")" \
      "$(echo "$b" | awk '{print $3}')" "$(echo "$b" | awk '{print $5}')" "$(echo "$b" | awk '{print $6}')" \
      "$(echo "$a" | awk '{print $3}')" "$(echo "$a" | awk '{print $5}')" "$(echo "$a" | awk '{print $6}')"
  done
  echo ""
  echo "# the two new signatures alone, over the same eight bakes:"
  printf '%-34s %10s %10s %12s %10s\n' 'bake' 'unbuilt n' 'unbuilt m' 'landuse n' 'landuse m'
  for s in $SHAS; do
    k=$(echo "$s" | tr -d '~')
    cu=$(grep '^# course-unbuilt ' "/tmp/iter11-after-$k.txt" | head -1)
    ls=$(grep '^# landuse-staircase ' "/tmp/iter11-after-$k.txt" | head -1)
    printf '%-34s %10s %10s %12s %10s\n' "$(label_of "$s")" \
      "$(echo "$cu" | awk '{print $3}')" "$(echo "$cu" | awk '{print $4}')" \
      "$(echo "$ls" | awk '{print $3}')" "$(echo "$ls" | awk '{print $4}')"
  done
  echo ""
  echo "# per-signature on the head bake, both instruments:"
  k=d7b4256
  printf '%-26s %22s   %s\n' '' 'BEFORE  count  score' 'AFTER   count  score  drawn'
  for sig in built-staircase landuse-staircase course-unbuilt lanes-serving-nothing TOTAL; do
    bl=$(grep "^# $sig " "/tmp/iter11-before-$k.txt" | head -1)
    al=$(grep "^# $sig " "/tmp/iter11-after-$k.txt" | head -1)
    printf '%-26s %10s %11s   %10s %6s %6s\n' "$sig" \
      "$(echo "$bl" | awk '{print $3}')" "$(echo "$bl" | awk '{print $5}')" \
      "$(echo "$al" | awk '{print $3}')" "$(echo "$al" | awk '{print $5}')" "$(echo "$al" | awk '{print $6}')"
  done
  echo ""
  echo "# AND ONE THING THE OLD INSTRUMENT COULD NOT SEE AT ALL."
  echo "# cda745a and bb0aaae read IDENTICALLY on the 20-signature instrument — 48 / 2653.8 /"
  echo "# 2522.5 in every column — and iteration 10 confirmed \"not one road tile moved\"."
  echo "# landuse-staircase reads 2681 on one and 2708 on the other. Both are true; the bakes"
  echo "# are different blobs and what moved was land use, which nothing was measuring:"
  node evidence/iter11-instrument/probe-bakediff.mjs \
    /tmp/iter11-bake-cda745a.ts /tmp/iter11-bake-bb0aaae.ts | sed 's/^/#   /'
} > "$OUT"
cat "$OUT"
