#!/bin/sh
# Watch every control iteration 9 added GO RED.
#
# Nine instruments in this exercise have been caught lying, five of them found
# by a control rather than by a failure. A control nobody has seen fail is not
# a control. This breaks the tool five different ways, one at a time, and
# prints what each break does to `--selftest`; every run must end non-zero and
# name the leg that caught it.
#
#   sh evidence/iter9-instrument/red-controls.sh
#
# It edits `server/src/tools/mapAudit.ts` in place and puts it back. It never
# uses `git stash` — refs/stash is shared between worktrees in this project and
# two agents have already popped each other's work out of it.
set -e
SRC=server/src/tools/mapAudit.ts
KEEP=/tmp/iter9-red-keep.ts
cp "$SRC" "$KEEP"

restore() {
  cp "$KEEP" "$SRC"
  pnpm build >/dev/null 2>&1
}
trap restore EXIT

probe() {
  # $1 = label, $2 = grep pattern for the lines that should have gone red
  pnpm build >/dev/null 2>&1
  set +e
  node server/dist/tools/mapAudit.js --selftest > /tmp/iter9-red-out.txt 2>&1
  code=$?
  set -e
  echo "=== $1"
  grep -E "$2" /tmp/iter9-red-out.txt || echo "  (pattern not found — THE CONTROL DID NOT REPORT)"
  echo "  --selftest exit = $code   (must be 1)"
  echo ""
  cp "$KEEP" "$SRC"
}

echo "# iteration 9 red controls — each break must make --selftest exit 1"
echo ""

# -- 1. the copied wildness constants drift away from bake.ts -----------------
sed -i 's/^const WILD_SEED = 0x7009d5;$/const WILD_SEED = 0x7009d6;/' "$SRC"
probe "1. WILD_SEED off by one — the audit is asking a different field" \
  "wildAt|DRIFTED|COPIED FIELD"

# -- 2. the wildBare gate suppresses everything, not just answered ground -----
sed -i 's/^    if (f.wildBare === 0) continue;$/    if (f.wildBare >= 0) continue;/' "$SRC"
probe "2. the gate refuses every region — a real defect suppressed" \
  "country-outside-blocks  (FIRED|BLIND|NOPLANT|REFUSED|LEAKED)"

# -- 3. the wildBare gate is not there at all --------------------------------
sed -i 's/^    if (f.wildBare === 0) continue;$/    if (f.wildBare < 0) continue;/' "$SRC"
probe "3. the gate is gone — the answered-meadow region leaks back in" \
  "country-outside-blocks  (FIRED|BLIND|NOPLANT|REFUSED|LEAKED)"

# -- 4. the drawn census stops reading the chains ----------------------------
sed -i 's/^    return coast.has(i) || band.has(i) || deck.has(i);$/    return true; \/\/ RED CONTROL: pretend every tile is on a curve/' "$SRC"
probe "4. onCurve always true — every staircase claims to be invisible" \
  "built-staircase     (SPLIT|STUCK|WHOLE|PARTIAL|UNCOVER|BLIND|DECKS)"

# -- 5. the pre-iteration-9 face census, restored ----------------------------
sed -i 's/^                faces++;$/                if (at(ox, oy) !== T_WATER) continue; \/\/ RED CONTROL: the iteration-8 census\n                faces++;/' "$SRC"
probe "5. faces counted only onto open water — the inland quays go blind again" \
  "built-staircase     (SPLIT|STUCK|WHOLE|PARTIAL|UNCOVER|BLIND|DECKS)"

# -- 6. the road-deadend plant stops clearing ground past its own cap --------
sed -i 's/^        const \[x, y\] = findMeadow(base, 5, 14 + CAP_LOOKAHEAD + 2, 80);$/        const [x, y] = findMeadow(base, 5, 16, 80); \/\/ RED CONTROL: the iteration-6..8 staging/' "$SRC"
probe "6. the road-deadend plant lands on ground a street crosses — the bug that shipped for three iterations" \
  "road-deadend|DID NOT FIRE"

echo "# restored; confirming the tool is green again"
pnpm build >/dev/null 2>&1
set +e
node server/dist/tools/mapAudit.js --selftest > /tmp/iter9-red-out.txt 2>&1
echo "  --selftest exit = $?   (must be 0)"
set -e
tail -12 /tmp/iter9-red-out.txt
