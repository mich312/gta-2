# Round 5 — lens A (worldgen and the map)

Base `45bfb3b`. Ground truth taken as given; the whole suite was not re-run.

## The bake carves respray garages through eight of the city's landmarks
severity: blocking
lens: A
where: `shared/src/world/amenities.ts:270` (`placeShopsFixed`'s `for (const [bi, b] of city.buildings.entries())`), called from `shared/src/world/bake.ts:855`
evidence: `node evidence/round5/A-repro-shops-in-landmarks.mjs` prints, off the shipped `city.data.ts` bytes:

```
spray shop, door 411,298 -> inside tower    "The Spire"            (rect 407,298 8x8)
spray shop, door 395,147 -> inside tower    "Halloran Building"    (rect 391,147 8x8)
spray shop, door 327,175 -> inside hospital "St. Brannoch"         (rect 323,176 9x7)
spray shop, door 473,440 -> inside police   "Kelvin Road Station"  (rect 470,441 7x7)
spray shop, door 578,424 -> inside hospital "Seaview Infirmary"    (rect 574,425 9x7)
spray shop, door 110,210 -> inside hospital "Riverside Infirmary"  (rect 106,211 9x7)
spray shop, door 312,462 -> inside police   "Sunridge Station"     (rect 309,463 7x7)
spray shop, door 539,548 -> inside police   "Marsh Post"           (rect 536,549 7x7)

8 of 66 shops are carved into a landmark.

--- Kelvin Road Station (police) 470,441 7x7 ---     --- The Spire (tower) 407,298 8x8 ---
 440 :::::::::                                       297 ::::##::::
 441 :BBBFFBB:   <- two-tile garage door             298 ::::::::::
 442 :BFFFFFB:                                       299 ::BBBFFB::   <- garage door
 443 :BFFFFFB:                                       300 ::BFFFFB::
 444 :BFFFFFB:                                       301 ::BFFFFB::
 445 :BFFFFFB:                                       302 ::BFFFFB::
 446 :BFFFFFB:                                       303 ::BFFFFB::
 447 :BBBBBBB:                                       304 ::BBBBBB::
 448 :::::::::                                       305 ::::::::::
legend  : pavement  B building  F floor  # road
```

  Renders: `evidence/round5/A-kelvin-road-station.png` (the station as a hollow
  ring with a notch), `evidence/round5/A-the-spire-tiles.png` (the raster the
  game actually uses — the named skyscraper is a 6x6 wall ring round a 4x4
  room). `evidence/round5/A-the-spire.png` is the same place with the vector
  mass layer on, which hides it: the building RECORD is still a solid tower.

  Mechanism, all in one place. `stamp()` pushes each landmark's own mass into
  the same `buildings` array as the houses (`bake.ts:394`) and marks it in a
  `landmarkBuilt` WeakSet. That set is consulted in exactly one place — the
  block-clearing pass at `bake.ts:528`, added by WORLDGEN.md §30.2. The last
  thing `bakeCity` does (`bake.ts:855`) is hand that whole array to
  `placeShopsFixed`, which walks it with no landmark filter, picks a landmark
  stamp by its inherited `district` field, and calls `carveInterior` on it:
  the mass becomes a one-tile wall ring, a `T_FLOOR` room, and a two-tile
  garage door punched through a wall the plan asked to be solid
  (`RECIPES.police`/`tower`/`hospital` all give `parts: (w,h) => [[0,0,w,h]]`).

  Why it is only the sprays, and only this city: the plan's spray quota is 26
  and a respray needs a wide door that most candidates cannot open, so the
  search relaxes through `minDist` and `minSize` until it reaches the landmark
  records, which sit at the END of `buildings`. Baked plangen seeds 7, 512 and
  900 have 0 landmark-hosted shops — this is a defect of the shipped city, not
  of generated ones, so no sweep would have found it.
repro: `pnpm build && node evidence/round5/A-repro-shops-in-landmarks.mjs`
  Renders: `node server/dist/tools/mapgen.js --crop=462,433,24 --scale=36 --out=/tmp/a.png`
  and `node server/dist/tools/mapgen.js --tiles --crop=400,291,24 --scale=36 --out=/tmp/b.png`
why it matters: three of the eight are POLICE STATIONS. A respray is
  `clearHeat` (`shared/src/sim/step.ts:246`) — "heat, wanted level and the
  interest of every cop already on the street all go at once" — so the way to
  end a chase is to drive into the nearest police station. Three more are
  hospitals, whose clinic and respray now share one door tile
  (`currentShopKind` splits them on foot-vs-driving, so the menus do not
  collide, but the geometry does). The last two are the two named towers on
  the skyline, which the tile plane — the plane collision and the 2D ground
  read — renders as single-storey sheds you can drive inside.
prior art: none found. WORLDGEN.md §30.2 fixed the neighbouring bug (the
  clear pass eating a landmark's building) and introduced the very
  `landmarkBuilt` set this pass does not consult. `city.test.ts`'s "gives
  stadiums and power stations an inside, not a slab" asserts the OPPOSITE
  property for two kinds and says nothing about the other eleven;
  `checkCity` has no rule about it, and `shippedCity.test.ts` is silent —
  the shop doors are on pavement and the entries are on floor, so rule 3
  passes.

## Marsh Post's east wall is painted over by the block yard fill
severity: nit
lens: A
where: `shared/src/world/bake.ts:433` (unclaimed landmarks stamped BEFORE the block fill loop at `bake.ts:495`), against `shared/src/world/buildings.ts:856` (`residential` yard = `T_PARK`)
evidence: `node evidence/round5/A-repro-shops-in-landmarks.mjs`, last block:

```
--- Marsh Post (police) 536,549 7x7 ---
 548 :::::ppp:
 549 :BBBFFpp:
 550 :BFFFFFp:      x=542, rows 549..554, plus 541,549:
 551 :BFFFFFp:      seven tiles of the stamped wall are T_PARK,
 552 :BFFFFFpp      so the room is open to the garden on its
 553 :BFFFFFpp      whole east side and its north-east corner.
 554 :BFFFFFpp
 555 :BBBBBBB:
```

  Marsh Post is the ONLY landmark this happens to (a census over the shipped
  bytes: 7 tiles, one building record, zero elsewhere). `stamp()` paints all
  49 tiles `T_BUILDING`; New Suburbs is `crescent`, so its blocks go through
  `fillRegion`, whose residential yard material is `T_PARK` and which writes
  through the block mask with no `landmarkBuilt` guard and no `paintable`
  guard. The landmark only gets its plot back if it CLAIMED a block
  (`bake.ts:513`), and Marsh Post did not.
repro: `pnpm build && node evidence/round5/A-repro-shops-in-landmarks.mjs`;
  render `node server/dist/tools/mapgen.js --crop=524,540,32 --scale=32 --out=/tmp/c.png`
  (`evidence/round5/A-marshpost.png`) — the station reads as a C, not a ring.
why it matters: a named police station with a hole in its wall, and seven
  tiles where the building RECORD says wall and the tile plane says grass —
  so the mass and the collision disagree over the same ground. Same family as
  WORLDGEN.md §30.2, which fixed the clear pass and left the fill pass.
prior art: WORLDGEN.md §30.2 records the earlier half of this ("something
  afterwards had removed the result"); it does not record the yard fill.

## Five motorboats are moored in two ornamental park ponds
severity: nit
lens: A
where: `shared/src/world/amenities.ts:1078` (`placeBoatSpawns`)
evidence: flooding water-or-bridge from the map border (bridges are open to a
  boat — `collide.ts:45`, `plainSolid`) leaves five moorings off the sea:

```
boat at tile 502,56   landlocked water 86 tiles, bbox 499,54..507,65   (Ravenhill Park pond)
boat at tile 500,63   same pond
boat at tile 298,646  landlocked water 107 tiles, bbox 295,642..305,653 (Sunridge Park pond)
boat at tile 296,648  same pond
boat at tile 297,649  same pond
```

  `placeBoatSpawns` asks for a 3x3 of open water and a bank within three tiles
  and never asks whether that water reaches anywhere. A 9x11 pond satisfies
  both. (The other 455 moorings are on the sea; the big inner reaches of the
  strait are NOT cut off, because a deck is passable in the water medium.)
repro: `pnpm build && node evidence/round5/A-repro-pond-boats.mjs`
why it matters: cosmetic, and small — but it is a speedboat sitting in a duck
  pond in the middle of the city's showpiece park, and the two ponds are the
  ones the §29 work gave rings and beaches to precisely so they would read as
  ponds.
prior art: BUGS.md §9.2 established that no boat is shut in by a BRIDGE, and
  that is still true; it does not consider a pond.

---

## Checked, and clean — so this lens has one finding above nit level

Written out because "we found nothing here" is only worth something if it
says where it looked.

- **Freshness and the checker.** `shippedCity.test.ts` really does decode the
  committed bytes and run `checkCity` on them, errors AND warnings pinned by
  name; `city.test.ts` "is the city the plan bakes to, tile for tile" really
  does re-bake and demand zero differing tiles outside `T_RAMP`. Both hold.
- **The six pinned bridging warnings** reproduce verbatim from
  `citybake --check` at this sha. Not re-filed (R1-A01, escalated).
- **R1-A03 holds in the shipped artifact**: The Docks has its cross streets
  (`evidence/round5/A-docks.png`) — a real grid, not the 27x158 strips.
- **R1-A02 holds**: Hollis Creek is crossed (`evidence/round5/A-hollis.png`).
- **R1-A08 holds**: both huts are off both slabs — the 3x3 hut now sits on
  `T_LOT` at the west end of each rect with the runway slab beginning three
  tiles east, and `T_RUNWAY` outside an airstrip rect is 0.
- **Amenity placement**, whole city: 1476 vehicle spawns all on `T_ROAD`,
  8473 ped spawns all on `T_SIDEWALK`, 16 player spawns all on `T_SIDEWALK`,
  1476 parking spots all on `T_ROAD`, 460 boat spawns all on `T_WATER`,
  610 pickups and 400 packages all on open ground. Nothing in a wall or the
  sea.
- **Buildings against the tile plane**: 4014 records, zero overlapping tiles,
  zero tiles off the map, zero `T_BUILDING` tiles with no record. The only
  records over non-wall ground are shop/landmark interiors (`T_FLOOR`) and
  the bounding-box corners of `angle`d masses, which is what a rotated
  footprint in an axis-aligned box looks like — plus the seven Marsh Post
  tiles filed above.
- **Landmarks**: no two rects overlap; no runway tile outside an airstrip;
  `byAir` is clean (no steppable shore on Gannet Rock, runway on its own
  ground).
- **Water**: 21 water components; every one of them except the two park ponds
  above is reachable from the sea by a boat once bridge decks are counted as
  passable, which they are.
- **Ghost ground**: no `T_FLOOR` outside a shop room except the 26 second
  halves of wide garage doors; three pavement components with no carriageway
  within two tiles, all of them park footpaths.
- **The authoring path** (`plan.ts`): `pitchX`/`pitchY`/`street.width` are
  parsed as integers with no positivity check, and `pitchX: 0` on an urban
  grid borough bakes silently to one street (`layout.ts:1147`, `cuts` returns
  `[start]` when `pitch < width + 3`). Deliberately NOT filed: it is the same
  shape as R1-A06, whose fix was scoped on purpose, and plangen itself writes
  `pitchX: 0` for parks, so the value is legal.
- **Not re-filed** (prior art): the Coast Road / Marsh Causeway / Ring east
  crossing escalations; the 68 sub-30-degree course junctions (WORLDGEN.md
  §23.3); lattice-on-lattice merging (§23.3, §28.3); `shared/src/world`'s
  unpinned trig (R1-C07).
