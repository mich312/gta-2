# BUGS — a play-test of the 3D renderer

A bug hunt against `main` at `2a9a990`, driving the real client with the
offline host (`?local=1`), the flyover (`/city3d.html?fly=1`) and a headless
`Session` in Node. Everything below is reproducible from the commands quoted;
the screenshots are in `evidence/bug-*.png`.

**All 757 tests pass.** Nothing here is a regression a test caught — these are
places the 3D renderer and the simulation were never checked against each
other, and the gaps are wide enough to see from the pavement.

---

## §1 The root cause behind every geometry complaint

`shared/src/world/volume.ts` builds a **volume grid** — a stack of solid spans
per tile, with a `ground` height for each column. `shared/src/world/collide3.ts`
resolves movement against it. Both are careful, well-documented, and:

```
$ grep -rn "buildVolumeGrid\|move3\|supportForBox" shared/src server/src client/src --include=*.ts
shared/src/index.ts:38:export * from './world/collide3.js';
client/src/three/cityGeometry.ts:2:import { ..., buildVolumeGrid, spansAt } from 'shared';
client/src/three/cityGeometry.ts:76:  const vg = buildVolumeGrid(map);
```

**Nothing in the simulation uses either of them.** `step()` still collides on
the flat tile grid in `shared/src/world/collide.ts`, where a tile is solid or
it is not and nothing has a height. Ground vehicles are pinned to `z = 0`
(`vehicle.ts:633`); pedestrians and players never leave it. Only aircraft
carry altitude.

So the 3D city is modelled from a height field the game itself does not
believe in. `collide3.ts` is exercised by exactly one unit test
(`shared/test/volume.test.ts`) and by no gameplay at all.

Every finding in §2 is a consequence of that one split.

---

## §2 Terrain

### 2.1 Bridges are drawn 46 px above the road they join — CRITICAL

`evidence/bug-bridge-deck.png`

`volume.ts` gives a bridge tile a deck span at `[40, 46)` and reports
`ground = 46`. The road either side reports `ground = 0`. The simulation
ignores both and drives across at `z = 0`.

Walking one bridge row of seed 7 through `buildVolumeGrid`, and counting what
touches a bridge tile anywhere in the city:

```
bridge start tile [ 62, 178 ]
58:ROAD(g=0) … 61:ROAD(g=0) 62:BRIDGE(g=46) … 78:BRIDGE(g=46) 79:ROAD(g=0) …
bridge tiles=163 adjacency: ramp=0 road=30
```

Two things fall out of that:

- **There is no approach.** Not one of the 163 bridge tiles in seed 7 has a
  `T_RAMP` neighbour. The deck starts as a sheer 46 px face rising out of the
  carriageway — visible in the screenshot as a vertical wall with the road
  markings running straight into it.
- **Traffic drives underneath its own bridge.** The screenshot places cars at
  `z = 0` — the height the sim actually gives them — along the row that crosses
  the deck. The first two are on the road; every one after that is *swallowed*.
  A player crossing the river disappears for the length of the span.

Two smaller defects in the same block of code
(`client/src/three/cityGeometry.ts:225–244`):

- The bucket key is chosen per **tile**, then every **span** of that tile is
  pushed into it. A bridge column has two spans, so the water underneath the
  deck is emitted as a road-coloured solid (with an outline hull) at
  `[-16, -8)` instead of water. The instance dump confirms it: the `deck`
  bucket holds `334 = 2 × 167` boxes.
- Markings are only applied when `key === 'road'` (line 212). A bridge is
  `key === 'deck'`, so the centre line and the crossings stop dead at the
  riverbank and resume on the far side.

### 2.2 Woodland is an elevated plateau of plain grass — CRITICAL

`evidence/bug-woodland-plateau.png`

This is the "some grass patches are elevated" report, and it is two bugs
stacked.

`volume.ts` gives `T_TREES` a span to `TREE_Z = 36` — a canopy you cannot
drive through, which is the intent. But `cityGeometry.ts:84` paints tile 11
with the same colour as open field and parkland:

```ts
grass: { match: (t) => t === 4 || t === 0 || t === 11, color: hex(palette.grassDark) },
```

and `scenery.ts:98` plants the tree and bush models at **`z = 0`**, i.e. 36 px
*inside* the slab they are meant to be standing on.

The result is a 36 px mesa of featureless grass with every tree buried in it.
At the game's own camera pitch (0°) it is indistinguishable from an open
field — the player sees lawn and drives into a wall. From an angle you see
only the shadows of blocks whose colour matches the ground they sit on.

It is not a rounding error either: 2350 woodland tiles in seed 7, and the
`hash2 > 0.92` roll yields 311 tree meshes across the whole map — all of them
invisible.

### 2.3 Fourteen terrain types render as three colours — MAJOR

`palette.json` carries a distinct colour for every surface. The 3D renderer
uses three of them. Instance counts from the live scene graph make it exact:

| 3D bucket | colour | instances | what is actually in there |
|---|---|---|---|
| `grass` | `#284027` | 20877 | field (16808) + park (1719) + **woodland** (2350) |
| `other` | `#45463f` (`lot`) | 2847 | lot (1811) + **beach** (888) + **quay** (90) + shop floor (38) + ramp (20) |
| `road` | `#33383f` | 15710 | road (15082) + **runway** (294) + bridge spans (334) |

The 2D renderer has a painter per type (`tiles.ts:441–470`): `paintLot`,
`paintBank`, `paintRunway`, `paintRamp`, `paintShopFloor`, and `paintGrass`
called with `palette.trees/treesLight` for woodland and `palette.sand/sandDark`
for beach. Unused in 3D: `field #2b3630`, `park #2f4c33`, `trees #22391f`,
`sand #b0a074`, `bank #77705f`, `runway #3a3d42`.

The beach is the worst of it — `#b0a074` (pale sand) drawn as `#45463f` (dark
industrial olive). Sampled from the flyover at the shoreline: `#5d5b49`, which
is the lot colour under sun, not sand.

### 2.4 The runway is striped like a street — MINOR

`evidence/bug-runway-markings.png`

`isRoad()` (`cityGeometry.ts:102`) counts `T_RUNWAY` as road, so the
carriageway-centre-line rule paints a **dashed yellow road centre line** down
the full length of the airstrip. The one surface an aeroplane can take off
from is signed as a B-road.

### 2.5 Shop interiors are open shafts cut through the building — MAJOR

`evidence/bug-shop-shaft.png`

A shop's `T_FLOOR` tiles sit at `z = 0` inside a building whose tiles run
solid to the roof. In 3D that is a light-well punched from the roof down to
the pavement, with window-covered facades looking into it. Top-centre of the
screenshot: a five-storey block with a U-shaped hole through it.

### 2.6 The map ends in sky — MINOR

No skirt, no fog, no horizon. Near the window edge the ground simply stops and
the background colour begins.

---

## §3 Bodies (`client/src/three/entities.ts`)

`evidence/bug-3d-bodies.png` — the vehicle meshes, built by the same
`spriteGeometry()` calls the game uses.

### 3.1 The tank has no turret — MAJOR

`sprites.json` carries `tank_turret` (a 44 px barrel, a ring and a hatch), and
`vehicles.json` gives the tank `turretOffset: -4.5`. The 2D renderer draws it
as a second sprite pivoted on the ring, traversing to the driver's aim
(`renderer.ts:1609–1621`), and holds it there on a wreck.

`entities.ts` has no turret code at all — `grep -n turret client/src/three/`
returns nothing. In 3D the tank is a bare hull. The gun it fires with `F` is
not drawn, and there is nothing on screen to say where it is pointing.

### 3.2 Motorcycles and bicycles ride with nobody on them — MAJOR

Same mechanism, same omission. `vehicles.json` gives `moto`, `copbike` and
`bicycle` a `riderOffset`, and the 2D renderer composites a rider at the
saddle — falling back to `ped_v0_f0` for an AI driver, with a comment saying
exactly why:

> *"A ped-ridden bike in traffic has no player driver, so it falls back to a
> pedestrian: an empty motorcycle travelling at 60 px/s is a worse bug than a
> generic rider."* — `renderer.ts:166`

`entities.ts` never reads `riderOffset`. `traffic.json` spawns `moto` at
weight 5 and `bicycle` at weight 4, so the 3D city has driverless bikes
cruising it at speed — the exact bug that comment was written to prevent.

### 3.3 Nobody animates — MAJOR

This is the "no movement of people" report, and the people are innocent. The
simulation moves them correctly. Stepping a headless `Session` for 900 ticks
and diffing every pedestrian's position against where it started:

```
PEDS  tracked=168 moved=168 still=0 mean=211.3px max=558.4px over 30s
```

The `ped`, `cop` and `player` sprite definitions carry `"frames": 4` and an
`anim` block — per-shape offsets that swing the legs and arms:

```json
"frames": 4,
"anim": { "0": [[2,0],[0,0],[-2,0],[0,0]], "1": [[-2,0],[0,0],[2,0],[0,0]], … }
```

`spriteMesh.ts` reads `def.shapes` and nothing else. It ignores `frames` and
`anim` entirely, so it can only ever build frame 0. The 2D renderer picks
`_f0..f3` off distance walked (`walkFrame()`, `renderer.ts:334`).

Every pedestrian, officer and player in 3D therefore *slides* — moving, but
locked in a single standing pose. From the game's camera that reads as a city
of statues on rails, which is precisely the complaint.

### 3.4 Every pedestrian wears the same shirt — MINOR

`ped` has six shirt variants. `entities.ts:218` builds one pool at variant 0
and puts all 400 pedestrians in it. 2D draws `ped_v${variant}_f${frame}`.

### 3.5 Vehicle colour ignores the simulation — MAJOR

`entities.ts:283` picks a paint job by hashing the entity id:

```ts
private variantFor(kind: string, id: number): number {
  const n = variantCount(kind);
  return n <= 1 ? 0 : Math.abs(Math.imul(id, 2654435761)) % n;
}
```

The snapshot carries `paint` and `gangId`, and 2D uses both
(`vehicleSpriteName()`, `renderer.ts:96`). Two consequences:

- **Gang cars lose their livery.** 2D returns `gangcar_v${gangId-1}` so you can
  read whose street you are on from a parked car. 3D gives it a random one of
  the four.
- **The street repaints itself on a rebase.** `VehicleState.paint` exists
  *specifically* because a window move re-spawns every parked car with a fresh
  id, and the comment at `state.ts:316` records that the whole street used to
  change colour in front of the player. Keying off the id in 3D reintroduces
  that bug exactly.

---

## §4 Lighting parity — MINOR

The two renderers do not agree on what time of day looks like. Mean frame luma
over the same seed and position, `?night=` swept:

| night | 2D | 3D |
|---|---|---|
| 0 (midday) | 62.7 | 89.7 |
| 0.35 | 55.6 | 71.6 |
| 0.6 | 51.0 | 56.4 |
| 0.85 | 46.8 | 38.4 |

The 2D view never reaches daylight and never reaches darkness; the 3D one
swings nearly twice as far. Switching renderers changes the hour.

Separately, the 3D light budget is `MAX_POINTS = 16` / `MAX_SPOTS = 4`
(`lights3d.ts:57`) against 80–102 lights requested per frame in an ordinary
city block (`__debug.lights3d`). The budget is deliberate and documented, but
the visible result at night is a city with far fewer lit lamps than the 2D
view puts on the same street.

---

## §5 Checked and found healthy

Worth recording, so the next pass does not re-tread it:

- **Simulation tick rate** — 29.9 Hz in 3D, 30.0 Hz in 2D. No drift.
- **Pedestrian movement** — 168/168 peds move, 211 px mean over 30 s (§3.3).
- **Ambient traffic** — 14 AI-driven cars in view, 5–9 under way at any moment.
- **Ped modes** — walk / flee / downed / dead all reached; corpses lie down and
  clear on the corpse clock.
- **Buildings** — heights, roof parapets, rooftop clutter, facades and cast
  shadows all correct and matching the 2D roof colours.
- **Road markings** — centre lines and crossings land on the same tiles in both
  renderers (away from bridges — §2.1).
- **Kerbs** — the 3 px pavement lip is right, and is inside every mover's
  step-up allowance.
- **Test suite** — 65 files, 757 tests, all passing.

---

## §6 Suggested order of work

1. **Decide who owns height.** Either the simulation adopts `collide3.ts` — and
   bridges, ramps, kerbs and canopies become real — or `cityGeometry.ts` stops
   drawing the volume grid and draws the flat world the sim actually runs. Half
   of §2 disappears whichever way it goes; leaving the two disagreeing is what
   produces the floating bridges. Adopting `collide3` is the larger change but
   the one the code was clearly written for; if it lands, bridges need ramp
   approaches generated in `generate.ts` at the same time.
2. **§2.2 woodland** — the cheapest big win. Give tile 11 its own colour
   (`palette.trees`), and plant `SceneryLayer` trees at the column's `ground`
   height rather than at 0. One line each.
3. **§3.1 turret and §3.2 rider** — both are the same shape of fix: a second
   pooled mesh placed at `turretOffset` / `riderOffset` along the hull, one
   turning with the driver's aim and one with the body. The offsets, the art
   and the 2D reference implementation all already exist.
4. **§3.3 walk frames** — teach `spriteMesh.ts` to apply the `anim` offsets and
   cache four geometries per body, then index them from distance walked the way
   `walkFrame()` does. This is the single change that makes the 3D city look
   alive.
5. **§3.5 paint** — pass `v.vehicle.paint` and `gangId` into `variantFor`.
6. **§2.3 / §2.4 terrain colours** — a lookup table; mechanical.

None of §3 needs the height question answered first.

---

## Reproducing

```bash
pnpm install && pnpm build
pnpm --filter client dev

# terrain, no player in the way — drive the camera with __city.lookAt(x, y)
/city3d.html?fly=1&seed=7&pitch=42&h=380

# the game itself, 3D and 2D over the same seed and clock
/?local=1&seed=7&night=0
/?local=1&seed=7&night=0&render=2d

# proving ground: Y hands over a tank
/?local=1&seed=7&proving=1
```

The numbers quoted above came from throwaway probes run against
`server/dist` and `shared/dist` — a headless `Session` stepped and diffed for
§3.3, `generateCity` + `buildVolumeGrid` walked for §2.1–2.3, and the live
scene graph traversed in the browser for the instance counts. Each is a dozen
lines; every figure they printed is quoted inline here, so none of them is
load-bearing.
