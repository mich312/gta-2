#!/bin/sh
# Retake every plate and number in this directory.
#
#   pnpm build && sh evidence/iter2-bevel/retake.sh
#
# Iteration 2, the `built-staircase` finding. The pairs matter: a `--tiles`
# render is the RASTER alone and a plain one is what the game draws, and the
# whole question this round asked is which of the two the player sees.
set -e
node evidence/iter2-bevel/measure.mjs > evidence/iter2-bevel/measure.txt
node server/dist/tools/mapAudit.js --only=built-staircase --all > evidence/iter2-bevel/mapaudit-builtstair-after.txt
node server/dist/tools/mapAudit.js > evidence/iter2-bevel/mapaudit-all-after.txt
node server/dist/tools/mapAudit.js --selftest > evidence/iter2-bevel/selftest-after.txt

R() {
  node server/dist/tools/mapgen.js --crop="$2" --scale="$3" --out="evidence/iter2-bevel/$1.png" $4 >/dev/null
  echo "  evidence/iter2-bevel/$1.png  ($2)"
}
# The worst quay staircase in the city (59 tiles, 16 treads), both layers.
# The raster steps; the render is one smooth curve, because `paintShoreTile`
# repaints every tile the coast course crosses and `paintShoreMaterial` has a
# T_BANK case. Nothing of this staircase reaches a player.
R quay-427-678-tiles   387,638,79  10 --tiles
R quay-427-678-vector  387,638,79  10
# The same quay's LANDWARD chain, which the detector also reports: quay
# against pavement, road and field. No curve describes that edge, so it is
# drawn — and at this contrast it is not findable by eye either.
R quay-640-382-landward-vector  614,356,52 14
