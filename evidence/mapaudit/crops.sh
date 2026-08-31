#!/bin/sh
# Retake every crop the round-11 mapAudit calibration looked at.
#
#   pnpm build && sh evidence/mapaudit/crops.sh
#
# The crop arguments come straight out of the tool's own output — every
# finding line is already a `--crop=` argument, which is the point of the
# format. `pnpm mapaudit --dump=x,y,w` prints the same tiles as letters,
# which is what actually settled most of these calls: a render at sixteen
# pixels a tile cannot always tell a lot from a pavement.
set -e
R() {
  name=$1
  node server/dist/tools/mapgen.js --crop="$2" --scale="$3" --out="evidence/mapaudit/$name.png" "$4" >/dev/null
  echo "  evidence/mapaudit/$name.png  ($2)"
}

# --- TRUE POSITIVES, confirmed by eye and by --dump ------------------

# road-stops-short: a street ending a tile or three short of the one it runs
# at, with grass or pavement where the junction should be.
R stopsshort-426-51      414,39,24   16
R stopsshort-410-103     398,91,24   16
R stopsshort-641-437     629,425,24  16
R stopsshort-264-385     252,373,24  16

# kerb-missing: a building face laid straight onto the carriageway on a block
# that has pavement on its other three sides.
R kerb-497-91            483,81,28   16
R kerb-308-464           295,454,26  16
R kerb-583-425           570,415,27  16

# crossing-missing: what is left of Hollis Creek after the round-1 fix.
R crossing-hollis-383    343,433,80  10
R crossing-hollis-367    327,465,80  10
R crossing-hollis-382    342,460,80  10

# road-deadend: a country lane stopping in a meadow, and the five streets of
# the Foundry all guillotined on row 311.
R deadend-414-611        402,599,24  16
R deadend-cluster-y311   420,282,140 8

# --- FALSE POSITIVES, kept as the evidence for each gate -------------

# Four parallel Kelvin bridge decks reported as four uncrossed gaps, before
# the bridge-flank rule. `--maxgap=20` and an earlier build reproduce it.
R fp-crossing-kelvin     236,262,110 8
# A park walk read as orphaned pavement, before path courses were subtracted.
R fp-walkorphan-park     377,609,49  16
# A dual carriageway closing round the end of its median, read as a width jump.
R fp-widthjump-549-193   535,179,28  16
# Scattered trees on a wood/meadow edge: 482 edge-notch hits, all of them this.
R fp-notch-treeline      120,600,40  16 --tiles

# --- The coast, for the record ---------------------------------------
# The worst staircase tread in the city (1.7x, under the 2.0 gate): the
# raster with the curve layer off, which is what a tread argument needs.
R shore-638-645          621,628,34  16 --tiles

# --- The two signatures the round-11 visual sweep asked for ----------
# Gannet Rock: a ruler-straight 7x32 corridor of meadow through woodland
# the plan calls deliberately trackless, with no road in it. Raster only,
# because the whole finding is the absence of anything the curve layer draws.
R barecorridor-gannet    84,595,52   12 --tiles
# South Sound Bridge: the deck steps every 3-4 tiles, so the bevels in the
# box cannot reach a single one of them. Both layers, because the pair is
# the argument: the stroked course covers the middle of the deck and the
# staircase teeth still show along both its edges.
R builtstair-southsound         146,446,64  12 --tiles
R builtstair-southsound-vector  146,446,64  12
# A quay on a shallow coast, the same shape for the same reason.
R builtstair-quay-427-678       387,638,79  10 --tiles
