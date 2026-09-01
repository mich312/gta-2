#!/bin/sh
# Watch every control iteration 11 added GO RED.
#
# Ten instruments in this exercise have been caught lying, five of them found
# by a control rather than by a failure — one of them a selftest that planted
# zero defects and passed on `0 === 0`. A control nobody has seen fail is not a
# control. This breaks the tool seven different ways, one at a time, and prints
# what each break does to `--selftest`; every run must end non-zero and name
# the leg that caught it.
#
#   sh evidence/iter11-instrument/red-controls.sh
#
# It edits `server/src/tools/mapAudit.ts` in place and puts it back. It never
# uses `git stash` — refs/stash is shared between worktrees in this project and
# two agents have already popped each other's work out of it.
#
# NOTE ON READING THE EXIT CODE. It is captured on its own line, not through a
# pipe. `... --selftest | tail -12; echo $?` reads TAIL's status, and that exact
# mistake hid a red `--selftest` for three iterations of this loop.
set -e
SRC=server/src/tools/mapAudit.ts
KEEP=/tmp/iter11-red-keep.ts
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
  node server/dist/tools/mapAudit.js --selftest > /tmp/iter11-red-out.txt 2>&1
  code=$?
  set -e
  echo "=== $1"
  grep -E "$2" /tmp/iter11-red-out.txt || echo "  (pattern not found — THE CONTROL DID NOT REPORT)"
  echo "  --selftest exit = $code   (must be 1)"
  echo ""
  cp "$KEEP" "$SRC"
}

echo "# iteration 11 red controls — each break must make --selftest exit 1"
echo ""

# -- 1. course-unbuilt goes blind entirely -----------------------------------
sed -i 's/^function unbuiltCourses(a: Audit, plan: CityPlan): Finding\[\] {$/function unbuiltCourses(a: Audit, plan: CityPlan): Finding[] { if (a \&\& plan) return []; \/\/ RED CONTROL/' "$SRC"
probe "1. the signature returns nothing — 508 tiles of missing road disappear" \
  "course-unbuilt +(FIRED|SILENT|NOMAG|BLIND|FALSE\+)"

# -- 2. the gap gate is so wide nothing can trip it ---------------------------
sed -i 's/^        if (g.len <= road.width) continue;$/        if (g.len <= road.width * 100) continue; \/\/ RED CONTROL/' "$SRC"
probe "2. the gap gate is 100x too wide — a real hole reads as rasteriser rounding" \
  "course-unbuilt +(FIRED|SILENT|NOMAG|BLIND|FALSE\+)"

# -- 3. a bridge deck stops counting as carriageway ---------------------------
# The pier is laid as T_BRIDGE, so this is the version of the signature that
# calls a working crossing a hole. Only the SILENT leg of the quay control can
# see it: the plant and the six shipped findings are all unaffected.
sed -i 's/^          if (t === T_ROAD || t === T_BRIDGE) return true;$/          if (t === T_ROAD) return true; \/\/ RED CONTROL/' "$SRC"
probe "3. a deck is not carriageway — every bridge in the city becomes a hole" \
  "course-unbuilt +(FIRED|SILENT|NOMAG|BLIND|FALSE\+)"

# -- 4. landuse-staircase stops asking the curve layer ------------------------
sed -i 's/^    if (uncovered < LANDUSE_UNCOVERED) continue;$/    if (uncovered < -1) continue; \/\/ RED CONTROL/' "$SRC"
probe "4. the curve-layer gate is gone — the signature re-reports the coastline" \
  "landuse-staircase +(COAST|UNCOVER|PAINTED|FALSE\+|BROKEN)"

# -- 5. the smoothing layer claims to cover everything ------------------------
sed -i 's/^    return onCurve(x, y) || bev\[y \* W + x\] !== BEV_NONE;$/    return true; \/\/ RED CONTROL: pretend every tile is repainted/' "$SRC"
probe "5. every tile claims a painter — a fully drawn defect reads as invisible" \
  "landuse-staircase +(FIRED|SILENT|NOMAG|COAST|UNCOVER|PAINTED|BROKEN)"

# -- 6. the land-use plant plants nothing -------------------------------------
# The failure that passed on `0 === 0` in this exercise: a plant that stages no
# defect and a checker that never notices. `fired` is `after > before`, so a
# plant that does nothing reads SILENT rather than passing.
sed -i 's/^            for (let dy = 0; dy < 6; dy++) t\[(y + s + dy) \* W + x + s \* 5 + dx\] = T_TREES;$/            for (let dy = 0; dy < 0; dy++) t[(y + s + dy) * W + x + s * 5 + dx] = T_TREES; \/\/ RED CONTROL/' "$SRC"
probe "6. the plant stamps no trees — a control that stages nothing must not pass" \
  "landuse-staircase +(FIRED|SILENT|NOMAG)"

# -- 7. the land-use census quietly narrows -----------------------------------
# Iteration 9's bug, in this signature's shape: a census that asks about a
# SUBSET of the boundary and defaults the rest. Nothing else can see it — the
# plant still fires, the coast is still silent, the magnitudes barely move.
sed -i 's/^            faces++;$/            if (run > 1) faces++; \/\/ RED CONTROL/' "$SRC"
probe "7. the census skips one face per run — the WHOLE leg is the only witness" \
  "landuse-staircase +(WHOLE|PARTIAL)"

echo "# every break above must show exit 1. A break that exits 0 is a control"
echo "# that is not watching, which is the tenth instrument's failure exactly."
