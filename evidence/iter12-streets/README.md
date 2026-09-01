# Iteration 12 — `street-serves-nothing` settled, and `edge-notch` attributed

Two things were open. Both are answered by measurement, and the answers are not
the ones the filings expected.

```
TOTAL 81 -> 76      SCORE 5528.8 -> 5472.0      DRAWN 5119.5 -> 5062.8
street-serves-nothing   5 findings / 227 tiles  ->  0 / 0
citybake --check        1 warning               ->  1 warning (unchanged)
reachability            102,059 / 1 / 473.9 / 0 ->  unchanged
blocks / buildings      1185 / 4005             ->  unchanged
```

**No map byte was changed.** The only source files touched are
`server/src/tools/mapAudit.ts` (the detector), `server/test/streetsServingNothing.test.ts`
(new) and `shared/test/city.test.ts` (one test appended). Nothing in
`shared/src/world/`, `client/`, `bevel.ts`, `layout.ts` or `bake.ts`.

---

## 1. The strict population, and the control iteration 10 could not produce

Iteration 10 published no headline because its own control refused one:

```
courses with ZERO joining tarmac anywhere:      0
=> the measure NEVER reads zero — BROKEN, it cannot discriminate
```

`population-loose-repro.txt` reproduces its numbers exactly on this tree —
363 road courses, 44 short fragments, 42 joining at both ends, 0 terminal,
5 flagged, "11.4%".

**Why it cannot read zero.** `joins()` calls a road tile "own" if it is within
`width/2 + 0.5` of the centreline and counts any adjacent road tile outside that
set as a join. The bake paints a course with a swept disc **plus a round cap**,
so every course's own paint reaches past that radius and every course joins
itself. Not a broken tally — a wrong definition.

### The strict figure — `population-strict.txt`

Same 44, with each join split into FOREIGN (inside another baked course's band)
and ORPHAN (inside nobody's):

```
LOOSE  : both ends join 42   one end 2   NEITHER (terminal) 0
FOREIGN: both ends join 33   one end 7   NEITHER (terminal) 4
         of the 4 terminal, the detector flags 3; it flags 5 of 44 overall
```

**Strict: 4 of 44, not 0 of 44.** The control that says the strict measure reads
both ways, which is the thing iteration 10 lacked:

```
CONTROL 1  FOREIGN reads zero at both ends for    24 / 363
           FOREIGN reads NONZERO at both ends for 274 / 363
           => FOREIGN CAN read zero AND nonzero — it discriminates
           => LOOSE never reads zero — reproduces iteration 10s broken control
CONTROL 2  course #10 shifted -200,-200: own=19  foreign 0/6/6   (identical code path)
CONTROL 3  longest course #1 (1605 tiles, ring): foreign 53/92/52 — nonzero at both
           ends, as a plumbed-in road must be
```

So the "11.4% of indistinguishable fragments" framing is dead: the detector is
not sampling, it correlates with the strict measure — 3 of the 4 strict-terminal
fragments, plus 2 that are not, and it misses `#332 536,616->553,616`.

### But FOREIGN is wrong too, and dumping the ground is what showed it

`dump-298.txt`. `#298 254,568->266,568` reads `foreign 0/0/0`, and its west end
runs straight into a north-south street at x=253-255 (rows 559-566). That street
belongs to **no baked course** — most of this map's residential tarmac is carved
from the block grid, not painted from a course. `FOREIGN 0` means "meets no
AUTHORED road", which is not the question the signature asks.

### The measure with neither flaw — `escape.txt`

Flood the carriageway from an endpoint; count tiles reached in 60 steps that are
not this street's own paint. It never asks who owns a tile.

**My first version of it was wrong and its own controls said so** — it forbade
the course's band outright, which walls an endpoint in behind its own tarmac:
the ring read `escape 0 / 0`. Fixed by gating on arc length along the centreline.
All four controls then pass:

```
CONTROL 1  8 populated buckets over 726 course ends — the measure spreads
CONTROL 2  course #10 shifted -200,-200: escape 0 (identical code path)
CONTROL 3  longest OPEN-ENDED course #2, 439 tiles: escape 706 / 1775 — saturates
CONTROL 4  #298, read off the tile dump by eye first:
             WEST end -> must be HIGH: 656
             EAST end -> must be LOW :   3
           one course, read both ways — it discriminates WITHIN a street
```

**Result: 0 of the 69 courses in the detector's length window are terminal at
both ends.** Every one of the five has an end opening onto hundreds of tiles.

## 2. Verdict per finding — all five, none skipped

`why-it-fires.txt` prints, for each end, how far the detector's straight ray gets
and how far you get **following the tarmac** (net displacement, no revisiting —
the first version returned step count and could circle inside one tile forever).

| # | site | ray A/B | follow away A/B | escape A/B | verdict |
| --- | --- | --- | --- | --- | --- |
| 129 | 669,153→660,171 | 2 / 1 | 71.1 / 34.8 | 1453 / 2158 | **FALSE POSITIVE** — a diagonal street through downtown, crossing others at junctions (`site-129-coast.png`) |
| 163 | 711,282→704,301 | 3 / 1 | 105.3 / 78.6 | 1386 / 886 | **FALSE POSITIVE** — coast street, course trimmed at the waterline, tarmac carries on round the bend |
| 272 | 469,361→469,373 | 3 / 1 | 3.9 / 15.6 | 182 / 184 | **FALSE POSITIVE** — see below |
| 298 | 254,568→266,568 | 2 / 3 | 114.7 / 3.0 | 656 / 3 | **FALSE POSITIVE on "both"** — its EAST end is a real cap, two tiles short of the ring: the ring shave, §14.3 D6, settled by `road-stops-short` in iteration 9 (`site-298-ringshave.png`). Its west end is open. |
| 362 | 80,505→91,508 | 3 / 1 | 86.7 / 78.9 | 732 / 479 | **FALSE POSITIVE** — both ends open |

Plus one the detector **misses**: `#332 536,616->553,616` is strict-terminal under
FOREIGN and not flagged, because its straight ray reads `Infinity` at both ends.
Under end-escape it is 566 / 8 — one open end — so not a defect either.

### #272, the signature's own designed exemplar, was described wrongly

`mapAudit.ts` called it "the islet in the strait … a fully painted 11.7-tile
street with a cap at each end, entered only by leaving Kelvin Bridge sideways at
mid-span". `dump-272-islet-wide.txt` and `site-272-islet.png` refute that: it is
the **main street of a built-up headland**, with buildings, lots and pavements
either side, running north into a ring road round a lagoon (182 tiles of it) and
south to the tip of the peninsula. Only the south end is a cap. The comment has
been corrected in the source.

## 3. The fix, and the control that says it was narrowed and not switched off

`streetsServingNothing` now requires the ray to die **and** `endEscape` to find
no more than `capEscape` (24) tiles of other carriageway at each end.

```
mapaudit          street-serves-nothing  5 / 227  ->  0 / 0
mapaudit --selftest   street-serves-nothing  FIRED  5 -> 6   (before)
                      street-serves-nothing  FIRED  0 -> 1   (after)
```

The selftest plants a 3-wide, 13-long carriageway with a course down it in a
meadow 300 tiles from anything. **It still fires on it.** That is what says the
gate narrowed the signature rather than silencing it.

`--selftest` still exits 1 on `shore-staircase  SILENT 0 -> 0`, which predates
this iteration and is unchanged (`selftest-before.txt`, `selftest-after.txt`).
One signature red before, the same one red after.

### The regression test, both ways

`server/test/streetsServingNothing.test.ts`, run on the pre-fix detector
(`regression-test-PREFIX.txt`) and on this one (`regression-test-FIXED.txt`):

```
PRE-FIX   × reports nothing on the shipped bake
            → # street-serves-nothing  5  227  56.8  56.8: expected 5 to be +0
          × still fires on a street planted in open field
            → expected '# street-serves-nothing  FIRED    5 -…' to match /0 -> 1/
          ✓ has no street on the shipped map with a cul-de-sac at both ends

FIXED     ✓ reports nothing on the shipped bake, where the pre-fix ray reported five
          ✓ still fires on a street planted in open field
          ✓ has no street on the shipped map with a cul-de-sac at both ends
```

The third test is the one that survives a re-tuning of the gate: it re-derives
the escape measure from the shipped map independently of the tool, carries #298
as its own two-way control, and goes red if a rebake ever strands a street for
real.

## 4. `edge-notch` at 625,642 — REAL, but NOT this loop's litter

The filing says it "appeared in iteration 11's bake and did not exist before",
and calls it a regression from that iteration's Coast Road reroute. The first
half is true. The second is not. `notch.txt`:

```
edge-notch, rule for rule, on both bakes
  before iteration 11: 0        after: 1        appeared: 625,642 water in sand
CONTROL — 1840 tiles differ between the two bakes
  notches that appeared or vanished on ground neither bake changed: 0
  => the rule reads the tiles and nothing else

625,642 was water, is water
  neighbour 624,642: bank -> sand
  neighbour 625,641: bank -> sand
  neighbour 625,643: sand -> sand
```

**The water did not move.** Iteration 11 turned quay into beach at two of its
neighbours, and `edgeNotches` needs the three differing neighbours to be the same
NATURAL material — `T_BANK` is not natural. The identical geometry was invisible
to the signature while it was quay-lined and legible the moment it became beach.

And the hazard is unchanged to the tenth. Sampling the shipped
`isSolidAtWorld` 8×8 across the tile, through the real `shoreCut` chord that
both the renderer and the movement solver use:

```
CONTROL — open sea at 640,642: 1.00   dry beach at 623,643: 0.00
  625,642 solid-to-land BEFORE 0.77 -> AFTER 0.77
  625,641 solid-to-land BEFORE 0.05 -> AFTER 0.05
  625,643 solid-to-land BEFORE 0.00 -> AFTER 0.00
  624,642 solid-to-land BEFORE 0.00 -> AFTER 0.00
```

So: a **real** one-tile bite in the waterline — 0.77 solid between neighbours at
0.00, visible in `edge-notch-625x642.png` as a square step in an otherwise curved
beach edge — that is **pre-existing**, open to the sea on its east side, and not
a rock anyone can be trapped behind. It is left in place and left FIRING as a
finding. Curing it means moving the water mask in `layout.ts`/`bake.ts`, both
contested this iteration, and a full rebake, for one tile at the edge of the sea.

Pinned by `shared/test/city.test.ts` → "carries at most the one single-tile bite
the waterline is known to have", which asserts the set is **exactly**
`['625,642']` and separately that no such notch is landlocked. A ceiling would
let it be quietly cured and this decision reversed with nothing going red.

## Files

| file | what it is |
| --- | --- |
| `population-strict.mjs/.txt` | the strict population, with the three controls |
| `orphan-split.mjs/.txt` | self-leak vs unowned vs foreign, and the geodesic |
| `components.mjs/.txt` | the carriageway is one 102,059-tile piece; 7 with the bridges cut |
| `escape.mjs/.txt` | the course-blind end measure and its four controls |
| `why-it-fires.mjs/.txt` | ray vs following the tarmac, per end |
| `dump.mjs`, `dump-*.txt` | the tile plane with course centrelines overlaid |
| `notch.mjs/.txt` | edge-notch before/after, and what a car meets there |
| `site-*.png`, `edge-notch-*.png` | all at `ground resident=` target, per LENS-B |
| `mapaudit-before/after.txt`, `selftest-before/after.txt` | the instrument, both sides |
| `regression-test-PREFIX/FIXED.txt` | the new test failing then passing |
| `full-suite.txt`, `citybake-check-after.txt`, `reachability-after.txt` | the chain |

## Reruns

```bash
pnpm build
node evidence/iter12-streets/population-strict.mjs
node evidence/iter12-streets/escape.mjs
node evidence/iter12-streets/why-it-fires.mjs
node evidence/iter12-streets/components.mjs
node evidence/iter12-streets/dump.mjs 469 367 22
git show 4f1d620^:shared/src/world/city.data.ts > /tmp/old.city.data.ts
node evidence/iter12-streets/notch.mjs /tmp/old.city.data.ts
```
