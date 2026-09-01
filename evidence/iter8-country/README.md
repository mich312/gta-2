# Iteration 8 — `country-outside-blocks`

**The filing named a real mechanism and the wrong 507 tiles.**

The finding reads:

> Marsh End 322,740-355,756: 507 tiles of country no block covers are 0.0%
> wood, against 50.8% in the 307 tiles of country inside the 1 rural block(s)
> next to them (0.00x) — the rural fill runs over BLOCKS, so ground outside
> every block was never asked what it is and keeps the bare meadow the ground
> pass wrote

The mechanism sentence is true of the pass in general. It is **false of these
507 tiles**, and that was established before any code was written.

## What was measured first

`probe-attribute.mjs` runs a live bake with `globalThis.__orphanProbe`
installed — a temporary instrumentation in `bake.ts`, since reverted — and
records what the blockless-country pass decided at every tile it walked.
`measure-orphan-region.mjs` floods the audit's own regions and crosses the two.

```
CITY-WIDE blockless rural country: 49 regions, 7549 tiles, 2615 wood (34.6%)
  regions >= 40 tiles: 23, 7117 tiles, 2526 wood

Marsh End 322,740-355,756  507 tiles  0 wood (0.0%)
       507  meadow
```

**All 507 tiles were visited, and all 507 got the verdict `meadow`** — the
wildness field said meadow on every one of them. Across the whole city, of
7,549 tiles of blockless rural country, **zero** were never asked: no tile
came back `ABSENT`, and no tile came back with `own=-1`. Iteration 3's fix
reaches all of it.

The independent control is `measure-field-agreement.mjs`, run against the
pre-iteration-3 asset (`git show e3306c8~2:shared/src/world/city.data.ts`):

```
/tmp/prefix.city.data.ts   (pre-iteration-3)
  inside a rural block:  14808 country tiles, wood 47.9%, field says wood 47.7%, AGREE 90.9%
  outside every block :   6685 country tiles, wood  5.7%, field says wood 32.6%, AGREE 67.1%
shared/src/world/city.data.ts   (as shipped into this iteration)
  inside a rural block:  14808 country tiles, wood 49.0%, field says wood 47.7%, AGREE 91.9%
  outside every block :   6685 country tiles, wood 34.5%, field says wood 32.6%, AGREE 95.9%
```

So the woodland half of the rule is closed and better closed outside the
blocks than inside them. **The audit's one hit is a false positive**, which is
what its own doc comment in `mapAudit.ts` already said and what nobody had
checked.

## What was still open, and is what got fixed

`fillBlock`'s rural branch plants **three** things, not one:

| rule | where | asked by the blockless pass? |
| --- | --- | --- |
| woodland from the wildness field | every rural block | yes, since iteration 3 |
| **hedgerows**, one verge back from every lane | every rural block | **no** |
| **orchard rows** | the fringe band (§14.3 D5) | **no** |

The hedgerow hash is keyed on the world grid *"so a run crosses block corners
unbroken"* — and then a run reaching the edge of the last block stopped dead on
a line nothing draws. `measure-hedgerow-gap.mjs`:

```
  rural country OUTSIDE every block: 7549 tiles
     in the fringe band (§14.3 D5) : 1076
     hedgerow positions unplanted  : 182
     orchard-row positions unplanted: 13
  46 unplanted hedgerow runs; 19 of them touch a hedge that IS planted inside a block
```

The fix moves `hedgerowAt` and `orchardRowAt` out of `fillBlock` into named
predicates in `buildings.ts` (a proven byte identity on its own) and asks them
again over the ground no block covers, keeping the blockless pass's own two
stricter refusals: nothing within one tile of water, nothing across a
held-short mouth.

## Is it the only one? — the city-wide population

`measure-bare-regions.mjs`, on the audit's own definitions (rural country that
no block's box covers, flooded into regions, district ownership resolved the
way `mapAudit`'s `ownerPlane` resolves it):

| asset | regions | tiles | wood | BALD regions >= 40 tiles | bald tiles | field calls wood in them |
| --- | --- | --- | --- | --- | --- | --- |
| pre-iteration-3, `e3306c8~2` | 49 | 7549 | 692 (9.2%) | **21** | 3530 | 1379 |
| iterations 3-7, as shipped in | 49 | 7549 | 2615 (34.6%) | **5** | 928 | 18 |
| iteration 8, this change | 49 | 7549 | 2777 (36.8%) | **1** | 507 | **0** |

The signature fires once, and after this change there is exactly one bald
region left — the audit's own — on which the wildness field says meadow on
every single tile. **The population is exhausted:** there is no blockless
rural country anywhere in the city that is bare where any rule of the rural
fill says it should not be. Iteration 3 took 21 bald regions to 5 and the
wild-but-bare tile count 1379 to 18; this takes 5 to 1 and 18 to 0.

## The numbers

| | before | after |
| --- | --- | --- |
| `mapaudit` TOTAL / SCORE | 49 / 2911.8 | **49 / 2911.8** |
| `citybake --check` warnings | 6 | 6 |
| blocks / buildings | 1184 / 4005 | **1184 / 4005** |
| carriageway tiles / components | 100833 / 1 | 100833 / 1 |
| landmark-to-landmark mean | 491.6 over 702 pairs | 491.6 over 702 pairs |
| open-ground pieces (on foot) | 7 | 7 |
| tiles changed | — | 192 (191 planted, 1 ride taken back out), **0 carriageway** |
| hedgerow positions planted / missing outside blocks | 66 / 182 | **220 / 28** |
| city-wide blockless rural country | 7549 tiles, 34.6% wood | 7549 tiles, 36.8% wood |

The audit does not move because no signature covers a missing hedgerow, and
the one signature that names this ground is firing on a false positive that
this change deliberately does not touch. `crop-marshend-before.png` and
`crop-marshend-after.png` are **byte-identical**, which is the proof.

## Pictures

| plate | what it shows |
| --- | --- |
| `crop-marshend-{before,after}.png` | the finding's own crop, `--crop=312,714,54`. Byte-identical: the 507 tiles are meadow on purpose. |
| `zoom-hedgerow-415-620-{before,after}.png` | a lane with a hedge line on its south verge (in a block) and none on its north (in no block); after, both. |
| `zoom-hedgerow-540-656-{before,after}.png` | a hedge run down a lane stopping dead partway; after, it runs to the shore. |
| `eye-hedgerow-423-621-{before,after}.png` | the same lane at eye level. Before: bare grass on the far verge for the width of the shot. |

## Retaking

```bash
pnpm build

# attribution (needs the temporary probe in bake.ts — see the report)
node evidence/iter8-country/probe-attribute.mjs /tmp/orphan-probe.txt
node evidence/iter8-country/measure-orphan-region.mjs /tmp/orphan-probe.txt

# these need no instrumentation
git show e3306c8~2:shared/src/world/city.data.ts > /tmp/prefix.city.data.ts
node evidence/iter8-country/measure-field-agreement.mjs /tmp/prefix.city.data.ts shared/src/world/city.data.ts
node evidence/iter8-country/measure-hedgerow-gap.mjs
POS=1 node evidence/iter8-country/measure-hedgerow-gap.mjs
node evidence/iter8-country/measure-test-figures.mjs shared/src/world/city.data.ts
CLUSTER=1 node evidence/iter8-country/measure-tile-diff.mjs OLD.city.data.ts shared/src/world/city.data.ts
node evidence/iter8-country/measure-walkable.mjs OLD.city.data.ts shared/src/world/city.data.ts
node evidence/iter8-country/measure-safety.mjs OLD.city.data.ts shared/src/world/city.data.ts
node evidence/iter8-country/map-region.mjs 316 718 372 762
node evidence/iter8-country/measure-bare-regions.mjs /tmp/prefix.city.data.ts

node server/dist/tools/mapgen.js --crop=312,714,54
node server/dist/tools/mapgen.js --crop=410,610,28 --scale=20
node server/dist/tools/mapgen.js --crop=530,650,28 --scale=20
```

Eye level, with the dev server up (`pnpm --filter client dev`; note the port it
prints — another agent may hold 5173):

```bash
WAIT_GROUND=20 node evidence/iter7/shot.mjs \
  "http://localhost:5174/city3d.html?fly=1&at=423,626&h=200&pitch=70&night=0" \
  evidence/iter8-country/eye-hedgerow-423-621-after.png
```

`ci/shot.mjs` cannot take a picture on this box (LENS-B is wrong about that);
`evidence/iter7/shot.mjs` is the working stand-in.

**A render reads `shared/dist`, not the asset.** `mapgen` and the 3D client
load `CITY_DATA` through the build, so `citybake` alone is not enough — an
un-rebuilt `dist` silently re-renders the previous bake. That caught this
iteration once: the first "after" plates were the baseline, byte-identical to
the "before" ones and nearly convincing. `mapaudit` and every script in this
directory read `shared/src/world/city.data.ts` from disk and are not affected.
