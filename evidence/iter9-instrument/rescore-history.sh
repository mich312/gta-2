#!/bin/sh
# Re-score every bake this loop has produced, with the instrument BEFORE
# iteration 9's corrections and with it AFTER, so both series can be read.
#
#   sh evidence/iter9-instrument/rescore-history.sh
#
# `--data` decodes any committed `city.data.ts`, so no worktree per commit is
# needed. The "before" leg checks out the merge-base copy of `mapAudit.ts`,
# measures, and puts the working copy straight back — by `cp`, never by
# `git stash`, because refs/stash is shared between worktrees in this project.
#
# It writes `history.txt` beside this script.
set -e
SRC=server/src/tools/mapAudit.ts
OUT=evidence/iter9-instrument/history.txt
KEEP=/tmp/iter9-history-keep.ts
BASE=bb0aaae   # the merge-base head: the instrument as iterations 5-8 read it

# 7769a2c pre-iteration-5           ffb2e89 post-iteration-5
# b5c7805 post-iteration-5 (instrument added, no map change)
# ce3189b post-iteration-6          cda745a post-iteration-7 (no map change)
# bb0aaae post-iteration-8
# e3306c8~2 is older than the series and is carried as the calibration bake:
# `country-outside-blocks` is KNOWN present on it, so a corrected detector that
# reports it clean would be a corrected detector that had gone blind.
SHAS="e3306c8~2 7769a2c ffb2e89 b5c7805 ce3189b cda745a bb0aaae"

for s in $SHAS; do
  git show "$s":shared/src/world/city.data.ts > "/tmp/iter9-bake-$(echo "$s" | tr -d '~').ts"
done

measure() {  # $1 = before|after
  pnpm build >/dev/null 2>&1
  for s in $SHAS; do
    f="/tmp/iter9-bake-$(echo "$s" | tr -d '~').ts"
    node server/dist/tools/mapAudit.js --data="$f" --summary \
      > "/tmp/iter9-$1-$(echo "$s" | tr -d '~').txt" 2>&1
  done
}

cp "$SRC" "$KEEP"
git show "$BASE":"$SRC" > "$SRC"
measure before
cp "$KEEP" "$SRC"
measure after

{
  echo "# mapaudit re-scored: the same seven bakes, the instrument before and after iteration 9"
  echo "#"
  echo "# BEFORE = mapAudit.ts at $BASE, the code iterations 5-8 published their numbers with."
  echo "# AFTER  = this tree: country-outside-blocks asks the wildness field, built-staircase"
  echo "#          censuses every step face rather than only the ones onto open water, and DRAWN"
  echo "#          is a new column, never a subtraction from SCORE."
  echo "#"
  printf '%-34s %8s %10s %8s %10s %10s\n' 'bake' 'TOTAL' 'SCORE' 'TOTAL' 'SCORE' 'DRAWN'
  printf '%-34s %8s %10s %8s %10s %10s\n' '' '(before)' '(before)' '(after)' '(after)' '(after)'
  for s in $SHAS; do
    k=$(echo "$s" | tr -d '~')
    b=$(grep '^# TOTAL ' "/tmp/iter9-before-$k.txt" | head -1)
    a=$(grep '^# TOTAL ' "/tmp/iter9-after-$k.txt" | head -1)
    bt=$(echo "$b" | awk '{print $3}'); bs=$(echo "$b" | awk '{print $5}')
    at=$(echo "$a" | awk '{print $3}'); as=$(echo "$a" | awk '{print $5}'); ad=$(echo "$a" | awk '{print $6}')
    case "$s" in
      "e3306c8~2") label="e3306c8~2  pre-iteration-3 (calib)";;
      7769a2c) label="7769a2c    pre-iteration-5";;
      ffb2e89) label="ffb2e89    post-iteration-5";;
      b5c7805) label="b5c7805    post-iteration-5 (instr)";;
      ce3189b) label="ce3189b    post-iteration-6";;
      cda745a) label="cda745a    post-iteration-7 (no map)";;
      bb0aaae) label="bb0aaae    post-iteration-8";;
      *) label="$s";;
    esac
    printf '%-34s %8s %10s %8s %10s %10s\n' "$label" "$bt" "$bs" "$at" "$as" "$ad"
  done
  echo ""
  echo "# per-signature, on the two bakes where the correction lands:"
  for s in bb0aaae "e3306c8~2"; do
    k=$(echo "$s" | tr -d '~')
    echo ""
    echo "## $s"
    printf '%-26s %22s   %s\n' '' 'BEFORE  count  score' 'AFTER   count  score  drawn'
    for sig in built-staircase country-outside-blocks TOTAL; do
      bl=$(grep "^# $sig " "/tmp/iter9-before-$k.txt" | head -1)
      al=$(grep "^# $sig " "/tmp/iter9-after-$k.txt" | head -1)
      printf '%-26s %10s %11s   %10s %6s %6s\n' "$sig" \
        "$(echo "$bl" | awk '{print $3}')" "$(echo "$bl" | awk '{print $5}')" \
        "$(echo "$al" | awk '{print $3}')" "$(echo "$al" | awk '{print $5}')" "$(echo "$al" | awk '{print $6}')"
    done
  done
} > "$OUT"
cat "$OUT"
