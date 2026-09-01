# `lanes-serving-nothing` x 2 — investigated, not fixed

An investigation, not a fix. The finding has two opposite answers and picking
one changes what the city IS, which is an author's call and not a fixer's.
Everything below is measured on the shipped bake at `e3306c8`; the raw output
is `part2-measurements.txt` and the three scripts beside it reproduce it
(`pnpm build` first).

## What the two regions actually are

| | **A — the headland** `393,312-549,365` | **B — the strait shoulder** `267,312-365,375` |
|---|---|---|
| land outside every district polygon | 5,749 tiles | 3,237 tiles |
| carriageway | 1,197 (20.8%) | 1,343 (41.5%) |
| built | **0** | 10 tiles / 2 buildings |
| materials | field 4,222, road 1,178, bank 315, bridge 19 | field 1,514, road 851, **bridge 492**, bank 345 |
| borders | The Spine 124 tiles of seam, Beachfront 40, Ravenhill 31, Old Quarter 2 — **all urban** | Ravenhill 90, The Terraces 12 — **all urban** |
| shops / landmarks / blocks on it | 0 / 0 / 0 | 0 / 0 / 0 |
| pavement on it | 8 tiles | 12 tiles |

**Neither region borders a rural borough.** Both hang off downtown.

## Is B a false positive? Partly — 52.5% of it, and no more

The caveat already recorded is correct and now has a number. Attributing every
carriageway tile to the nearest authored road in `city-plan.json`:

| region | The Ring | Old Bridge | Kelvin Bridge | no authored road within 6 tiles |
|---|---|---|---|---|
| A, headland | — | — | **241** (20.1%) | **956 (79.9%)** |
| B, shoulder | **429** | **276** | — | **638 (47.5%)** |

So in B, 705 of 1,343 tiles (52.5%) are The Ring and the Old Bridge approach
passing THROUGH — 492 of them are literally bridge deck. That tarmac is doing
its job and is not the finding. What is left is 638 tiles of lattice street
with nothing on either side, which is the same defect as A at half the size.
**B is a half false positive, not a false positive.** Its `41.5% road` headline
is the misleading number; `638 lattice tiles on 3,237 tiles of land` is the
honest one.

A is the reverse: only a fifth of its tarmac is the Kelvin Bridge approach, and
956 tiles are lattice streets that run north off The Spine, cross five hundred
metres of empty field and stop. `crop-headland-shipped.txt` is what that looks
like — six street mouths along y=311, four-wide, running twenty to forty tiles
into unbroken meadow.

## Option 1 — take the lanes away

Reachability is measured, not asserted: 4-connected components of carriageway,
and mean carriageway travel distance from Marsh End Airfield to the other 26
landmarks.

| what is removed | components | mean travel distance | stranded |
|---|---|---|---|
| nothing (baseline) | 1 x 100,742 | 485.2 | — |
| **A's lattice only** (956 tiles) | 3: 99,702 + 80 + 4 | **485.2 (unchanged)** | 84 tiles |
| A's lanes, all 1,197 | 2: 99,465 + 80 | 519.6 (**+7.1%**) | 80 tiles |
| **B's lattice only** (638 tiles) | 3: 100,090 + 7 + 7 | **485.2 (unchanged)** | 14 tiles |
| B's lanes, all 1,343 | 1 x 99,399 | 491.3 (+1.3%) | 0 tiles |

**The headland's lanes are NOT load-bearing — but its bridge approach is.** The
two questions have different answers and the finding conflates them. Deleting
A's 956 lattice tiles leaves travel distance across the city bit-identical and
strands 84 tiles in two crumbs; deleting the Kelvin Bridge approach with them
costs 7.1% on every journey, which is the one thing that must not happen. So
"take the lanes away" is only safe as *take away the lanes that are not under
an authored course*, and any implementation has to be keyed on the courses
rather than on the region.

Cost of the removal option: **1,594 carriageway tiles** (956 + 638), 1.6% of
the city's carriageway, plus 98 tiles of stranded crumb to clean up and 20
tiles of orphaned pavement. Nothing else lives on that ground — no shops, no
landmarks, no blocks, no buildings except B's two.

## Option 2 — give the land something to serve

There is plenty of ground for it: A has 4,552 non-road non-built tiles (3,510
of them within eight tiles of an existing lane), B has 1,884 (all of them
within eight). What it would cost depends entirely on which treatment:

| treatment | density used | A | B | both |
|---|---|---|---|---|
| **smallholding / rural** | rural blocks ship 2.2% built | ~100 built tiles, ~9 buildings | ~42 tiles, ~4 buildings | **~13 buildings, ~142 tiles** |
| **urban fringe** (extend §14.6 D5) | urban blocks ship 20.8% built | ~945 tiles, ~85 buildings, +1,534 pavement/lot | ~391 tiles, ~35 buildings, +635 pavement/lot | **~120 buildings (+3.0% of 4,012), ~1,336 built tiles, ~2,169 pavement/lot** |

The two differ by an order of magnitude and they are not the same city.

**The character argument cuts against the urban treatment.** Both regions
border only urban boroughs — The Spine and Ravenhill, pitch 15x12 and 17x14 —
so "extend the fringe pass" means extending a DOWNTOWN pitch across the
headland every player crosses between the two halves of the city, adding ~120
buildings and 2,169 tiles of pavement to a piece of ground that currently
reads as open coast. And pavement is not cosmetic here: iteration 3's withdrawn
kerb fix moved `police.test.ts` and `secrets.test.ts` off their staging with
403 tiles of it; 2,169 is five times that.

**The character argument also cuts against the rural treatment**, more quietly.
A smallholding pass would put Marsh End's 2.2% density on a headland that
touches The Spine — a parish two blocks from downtown. It is 13 buildings, so
it is cheap, but it is a new kind of place rather than more of an existing one.

## What the numbers say, without making the call

- **B is 52.5% arterial.** Its headline road share overstates the defect by
  about half. Whatever is decided for A applies to B at half scale.
- **Nothing routes through A's lattice.** 956 tiles can go at zero cost to
  travel distance. Its 241-tile Kelvin Bridge approach cannot: 7.1%.
- **Removal is ~1,594 tiles; the urban build-out is ~3,505 tiles and ~120
  buildings; the rural build-out is ~142 tiles and ~13 buildings.** Removal is
  the smallest change to the map and the only one that does not invent a new
  character for ground that borders downtown.
- **A third answer exists and is cheaper than either**: leave the ground as it
  is and stop the lattice from being carved onto land no polygon claims, which
  is where the tiles came from in the first place. That is a change to the
  carve, not to the fringe pass, and it makes the removal option unnecessary
  on the next rebake rather than needing 1,594 tiles taken back out of this one.
