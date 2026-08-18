# PLAN-MAPDESIGN.md — the crossings, the decks, and what two outside eyes found

The fix plan for what `REVIEW-MAPDESIGN.md` left open and what two independent
reviewers found when they were shown the renders with no access to the docs.
Sequenced the way `PLAN-WORLDGEN.md` established and this branch has now used
four times: measure first, paint-only fixes before anything that moves a tile,
**one** declared rebake carrying every tile change at once, then the expensive
thing that needs an experiment before it needs a decision.

House rules this plan inherits, unchanged:

- **A bake-changing fix does not ship alone.** Everything that moves a tile
  lands in Wave 2's single rebake, with the evidence renders retaken.
- **Every fix ships with its invariant** — the test that would have caught it.
- **Every claim carries its measurement.** The numbers below were taken on the
  city as it stands at the head of this branch; each item says how to retake
  them.

And one rule this branch added, because it cost an hour:

- **The pin that moves is not always the pin that is wrong.** Four citywide
  pins (empty blocks ≤ 3, merged tarmac ≤ 230, long courses ≥ 90, angle-cut >
  40%) plus `citybake --fit` are the battery every bake-changing item is
  judged by. When one moves, find the cause before retuning the thing that
  moved.

---

## Wave 0 — make the battery one command (S, no bake change)

The four pins live in three test files and a tool, and this branch checked them
by hand a dozen times. That is the only reason the Beachfront detour in §47.2
took as long as it did to spot.

| # | Fix | Where | Gate |
|---|---|---|---|
| 0.1 | **`pnpm mapaudit`** — one report: the four pins, the crossing census, the detour percentiles (landmark-to-landmark p50/p90/worst), bare ground by region, and turf land-spread. Everything this branch measured with throwaway scripts. | new `server/src/tools/mapAudit.ts` | Running it on the current head reproduces the numbers in §44–§47 |
| 0.2 | **Detour as a pinned invariant.** The strait fix took p90 from ×2.49 to ×1.88 and nothing holds it there. Assert p90 ≤ 2.0 over landmark pairs. | `shared/test/city.test.ts` | A future plan edit that quietly removes a crossing fails here, not in a review a year later |

---

## Wave 1 — paint only (renderer, ships without touching the city)

**1.1 A deck must read as a structure, not as asphalt on the sea (M).**
Two reviewers, working from different images and told nothing about each
other, independently called the strait crossings "a road drawn on the ocean"
and "roads laid on the surface of the sea". Both were wrong about the cause —
the tiles are `T_BRIDGE` and the crossings are real — and both were right about
the reading, which is what matters.

What is actually there: `tiles.ts:1751` *does* draw a parapet, kerb-coloured,
on every deck edge facing open water. At map scale that rail is
`max(1, TD/10)` — a single pixel at 8 px per tile, which is why nobody sees it.
In 3D there is no bridge material at all: `cityGeometry.ts:323` maps `T_BRIDGE`
to `{ key: 'road', color: col('road'), road: true, line: ROAD_LINE }`, so a
deck is painted as a road and nothing else.

The fix is three cheap things, none of which touches a tile:
- **Weight the parapet** so it survives at map scale — scale the rail with the
  zoom rather than the tile, and take it from the kerb palette entry it already
  uses.
- **A shadow on the water** under the deck, on the sun side, the width of the
  span. This is what says "the road is above the water" in one stroke.
- **Piers.** Every N tiles along the deck, a darker block in the water beside
  the parapet line.

*Invariant:* a painter test that renders a strait chunk and asserts a deck tile
differs from a road tile in more than its neighbours — concretely, that the
parapet and shadow pixels exist on a deck and do not exist on a carriageway.
*Retake:* `pnpm mapgen --crop=545,265,55,125 --scale=8`.

**1.2 Confirm, then fix, markings on unpaved ground (S).**
The two reviewers **contradict each other** here and the plan must resolve it
before any code moves. The 2D reviewer measured the whole map and reported the
class clean: "no road markings painted on unpaved ground (every dash has
asphalt within 2 px)". The 3D reviewer, from the flyover, listed centreline
dashes on grass at two places and crosswalk ladders on grass at six. Wave 0's
audit answers it: count marking pixels whose tile is not carriageway. If the
count is zero, close the item and record that the ribbon clip added in
`WORLDGEN.md` §23.2 holds. If it is not, the clip has a hole and the fix goes
where §2.2 of the worldgen review put it.

**1.3 The kerb that isn't (S–M).**
Both reviewers independently flagged the alternating grass/pavement squares
where a plaza or verge meets grass — "a broken blend between two tile
materials", "reads as accidental, not stylised". `REVIEW-WORLDGEN.md` §2.7 had
recorded the same transitions as *intended texture*, which is the disagreement
worth settling: a two-tone **field** reads as texture, a two-tone **boundary**
reads as a bug, and the painter is using one rule for both. Fix: at a
material boundary, draw the kerb line the block edges already use; keep the
dither strictly inside a single material.

**NOT a defect, and recorded so nobody "fixes" it:** yellow chevrons on a bare
lot. `amenities.ts:1421` places stunt ramps *only* on `T_LOT`, with a clear
run-up — a ramp in a car park is the feature. Two reviewers called it a bug;
the code is right and the plan says so.

---

## Wave 2 — the one declared rebake (every tile change, batched)

**2.1 Bridge the creek (M) — the highest-value item in this plan.**
Measured on the current head: the creek that separates the industrial west of
the south bank from the residential east runs **9,037 water tiles** with
**zero bridge tiles** over it. Streets on both banks run to the waterline and
stop in cul-de-sac caps, several of them directly facing each other across ten
tiles of water.

| across the creek | straight | drive | |
|---|---|---|---|
| (360,445) → (410,445) | 50 | 404 | **×8.1** |
| (350,470) → (400,470) | 50 | 360 | **×7.2** |
| (330,520) → (380,520) | 50 | 198 | ×4.0 |
| (300,555) → (350,555) | 50 | 58 | ×1.2 |

That is worse than the strait was before §44 fixed it (worst ×5.1), and unlike
the strait it separates two districts people live in. It survived every check
because the landmass *is* connected — around the head, at the bottom — so "one
road network" stays true. Detour, not connectivity, is the thing that was never
measured; Wave 0.2 fixes that permanently.

Fix: author **two or three** crossings in `city-plan.json` between y 430 and
y 540, each landing on the street grid on both banks, `bridges: true`, width 4.
The creek is about ten tiles wide, far inside `maxBridgeSpan` 96, so these are
ordinary spans and the §44 machinery carries them: the whole-deck rule refuses
a deck that lands once, and the "road you drew is the road you got" check
refuses a road with a gap in it. Pick the pairs from the caps that already face
each other — the render at `--crop=330,425,110,90 --scale=9` shows five.

*Invariant:* Wave 0.2's detour pin, plus a named assertion that the creek
carries at least two decks. *Expected pin movement:* the four-pin battery must
hold; if merged tarmac rises, the cause is at the new landfalls and the answer
is the alignment, not the pin.

**2.2 Give the towers a silhouette (S).**
§46.3 fixed the height (32 storeys, 1.8× the tallest downtown block) and the
proportion (4×4 and 6×6 shafts, not the 2×2 flagpoles the first cut shipped).
The reviewer's deeper point stands and the after-shot confirms it: the tower is
now unmistakably *big* and still not *distinctive* — "no setback, no crown, no
colour signature", the same box-with-parapet and the same window grid as every
office block around it.

Fix, within the no-overlapping-parts rule `RECIPES` keeps: make the shaft a
ring too, and stand a narrower **spire** inside it — podium ring 6, shaft ring
32, spire 40. That is a setback and a crown out of the vocabulary the table
already has. If a distinct roof colour is wanted as well, it wants a field on
`Building` rather than a hash, and that is its own item.

*Invariant:* extend `city.test.ts`'s "an inside, not a slab" to require **three**
distinct authored heights on a tower, not two.

**2.3 The small change, batched because a rebake is happening anyway (S each).**
The one empty block left in the quay (19×12 at 521,342); a country police post
for Marsh End, whose p95 distance to a station is the worst on the map; and
content on the four uninhabited islets (1,153 / 1,098 / 958 / 735 tiles,
currently zero packages, zero pickups, zero props) — a package apiece is the
cheapest reward-for-exploration the map can buy.

---

## Wave 3 — the CBD, which needs an experiment before it needs a decision (L)

The 2D reviewer's sharpest paragraph, and it agrees with §2.7 and §2.8 of the
review from a completely different direction: "The CBD is wallpaper. ~14×16
near-identical blocks, each with the same two-rows-of-bars arrangement, one
avenue and no other hierarchy — no plaza, no civic mass, no diagonal, no
block-size variation, no landmark. You cannot navigate by it or name any part
of it." It also meets the borough east of it at a hard vertical seam at x≈545
"with no transition at all".

This is the block-pitch item, and this branch has now learned twice that a
fabric change propagates further than it looks: §47.2's greedy polygons moved
landmarks and merged tarmac a hundred tiles away across water. So:

1. **Experiment on one district, measured, before touching The Spine.** Take
   the pin battery, change only `pitchX/pitchY` on a single downtown polygon,
   and report the four pins plus road-share and building-share of dry land.
2. **Only then** decide between the three levers — a coarser pitch, a plaza
   carved as a landmark (`square` already exists as a kind, and King's Circus
   proves it works), and a transition district at the x≈545 seam.

Nothing here ships without the numbers from step 1.

---

## The one decision this plan does not make

**Downtown's ceiling: 18 storeys, or about 14?** §46.3 has the arithmetic. At
18 the skyline reads from three districts away and each block hides ~7.5 tiles
of ground behind it at the playing pitch — wider than a carriageway and both
its pavements. At 14 the occluded band drops under 6 tiles and the skyline goes
with it. Both are defensible; it is a design call about whether this game is
read from the windscreen or from the map, and it belongs to whoever owns that
question, not to this plan.

---

## Sequence, size, risk

| Wave | Items | Size | Bake? | Risk |
|---|---|---|---|---|
| 0 | audit tool, detour pin | S | no | none — it only measures |
| 1 | deck reading, markings check, kerb boundary | S–M | no | renderer only; every item retakes one evidence PNG |
| 2 | **creek crossings**, tower spire, small change | M | **one rebake** | the four pins and `--fit`; expect to re-verify, not to retune |
| 3 | CBD hierarchy | L | one rebake, later | high blast radius — gated behind Wave 0's measurements |

Wave 1 and Wave 2.1 are independent and can go in either order. If only one
thing gets done, it is **2.1**: two named bridges turn a 400-tile detour into a
street network, and every piece of machinery they need is already built and
tested.
