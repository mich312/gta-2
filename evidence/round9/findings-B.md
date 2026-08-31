# Round 9 — Lens B (the renderer, and what the player actually sees)

Measured on `ee29b03` (`claude/loop-driven-agent-approach-tgnfpj`), against the
round's stated ground truth. Dev server on port 5981.

Ground truth taken as given; nothing re-run. Individual checks below.

---

## The HUD's world-space overlay and the 3D world disagree by up to 14 world px — the identity it uses was verified at `pitch: 0` and the shipped camera is 10°
severity: significant
lens: B
where: `client/src/render/renderer.ts:801` (the stated identity), `client/src/main.ts:246` (`GAME_PITCH` default 10), consumers `renderer.ts:816` (`drawNameTags`) and `client/src/render/hud.ts:406-407` (bullet tracers)
evidence:
`drawNameTags`'s docstring states the rule the HUD layer draws by:

> *"the mapping is the same for both: **the 3D camera hangs straight down over
> the middle of the same frame**, so a point on the ground lands at `world - cam`
> in either view. That is the same identity the radar and mouse aim rely on."*

It does not hang straight down. `GAME_PITCH` is **10** (`main.ts:246`), and
`REVIEW-3D.md` "Part four: the lean, closed" verified the frames agree **"at
pitch 0 with the world tile grid overlaid"** — before the same document's
"The camera tilts 10°" landed.

Projected a grid of ground points through the real `CityView` camera and
compared against `world - cam`. Run at the frame the client actually uses at
1280×720 (`fitViewport` → zoom 2, 640×360 world px), which is the frame
`evidence/round9/B-client-3d-night.png` was shot at:

```
pitch=10 viewHeight=360 viewWidth=630
  frac x  frac y |  3D lands at   |  HUD draws at  |  error (world px)
   0.05    0.05  |   44.4   27.7 |   31.5     18 |   12.9    9.7
   0.95    0.05  |  585.6   27.7 |  598.5     18 |  -12.9    9.7
   0.05    0.50  |   31.5    180 |   31.5    180 |      0      0
   0.95    0.50  |  598.5    180 |  598.5    180 |      0      0
   0.05    0.95  |   17.3  347.5 |   31.5    342 |  -14.2    5.5
   0.95    0.95  |  612.7  347.5 |  598.5    342 |   14.2    5.5
```

**The control is exact.** The same probe at `pitch=0` prints `0 0` on every one
of the fifteen rows — i.e. it reproduces `REVIEW-3D.md`'s "same tiles in the
same places" and shows the divergence is entirely the 10°:

```
pitch=0 viewHeight=360 ... |      0      0   (all 15 rows)
```

At the view ceiling (`MAX_VIEW` 700×400) it reaches 15.8 px horizontally and
10.8 px vertically (`B-probe-project-400` — rerun with the args below).

repro:
```
pnpm --filter client dev --port 5981
node evidence/round9/B-probe-project.mjs 10 360     # the shipped camera
node evidence/round9/B-probe-project.mjs 0  360     # the control: all zeros
node evidence/round9/B-probe-project.mjs 10 400     # the view ceiling
```
why it matters: a remote player's name tag and every bullet tracer are drawn by
the HUD pass at `world - cam` over a 3D frame that puts the same ground point
somewhere else — up to ~14 world px away at the frame edge, which is a whole
pedestrian (a body is ~14 px). It is exactly 0 at screen centre and along the
frame's horizontal midline, which is why it has survived nine rounds: the local
player, where everyone looks, is the one place it cannot show.
Aim is **not** affected — I checked: `keyboard.ts:138` sends an *angle* from the
player's screen position, and the induced angular error at the worst corner is
0.3°, so this is a drawing-alignment defect and not a shooting one.
prior art: `REVIEW-3D.md` Part four (verified at pitch 0) and its
"The camera tilts 10°" entry — the two are in the same document and were never
reconciled. Not in `GAPS.md`, `BUGS.md`, `REVIEW.md`, `REVIEW-3D.md`'s
"Still open, and why", or `REVIEW-QUEUE.md`.

---

## In 2D, a respray garage and a clinic wear the clothing shop's shopfront — `palette.shopSpray` exists and this painter never reads it
severity: significant
lens: B
where: `client/src/render/tiles.ts:2788-2793` (`paintShops`, chunk step 5 — drawn last, over everything)
evidence: the three-way accent falls through to `palette.shopClothing`:

```ts
const accent =
  shop.kind === 'depot'
    ? DEPOT_ACCENT
    : shop.kind === 'gun'
      ? palette.shopGun
      : palette.shopClothing;      // <- 'spray' and 'clinic' land here
```

The two sibling paths in the same tree both carry the full four-way including
`palette.shopSpray`: `tiles.ts:1826-1833` (`paintShopFloor`) and
`client/src/three/cityGeometry.ts:570-575` (the 3D threshold accent).

Read the pixels back out of the shipped painter — `TileLayer.buildChunk`, the
canvas the 2D renderer blits — for one shop of each kind on seed 7:

```
palette    shopGun #c8583c   shopClothing #3ca0c8   shopSpray #c8a13c
shop count {"gun":20,"clothing":20,"spray":26,"clinic":5}
gun       door 108,251     awning #d6826d  doormat #e9bcb1
clothing  door 268,153     awning #6db8d6  doormat #b1d9e9
spray     door 615,467     awning #6db8d6  doormat #b1d9e9
clinic    door 606,143     awning #6db8d6  doormat #b1d9e9
```

Pixel-identical to the clothing shop, on **31 of the city's 71 shops (44%)**.

repro:
```
pnpm --filter client dev --port 5981
node evidence/round9/B-probe-shopcolour.mjs
```
why it matters: `BUGS.md` §2.5 rests the whole 3D shop-accent fix on the stated
invariant *"in 2D the shop's accent colour is how you identify it"* — and in 2D
it does not identify the most common shop in the city. A respray garage is where
you go to lose the police; from the street it is painted the same blue as a
clothes shop. The colour it should wear is already in the palette and already
used by two other call sites.
prior art: `BUGS.md` §2.5 names `shopSpray` as part of what it fixed — but only
for the 3D threshold. The 2D shopfront painter is not mentioned anywhere in
`GAPS.md`, `BUGS.md`, `REVIEW.md`, `REVIEW-3D.md` or `REVIEW-QUEUE.md`.

---

## `spriteMesh` does honour `alpha` now, and two comments that say it does not are still holding every aircraft's height down
severity: nit
lens: B
where: `client/src/three/spriteMesh.ts:52-57` and `client/src/three/entities.ts:169-176`, against `client/src/three/spriteMesh.ts:156`
evidence: both comments assert the opposite of the code beside them.
`spriteMesh.ts:52` — *"Authored for the 2D pass and **not honoured here**"*;
`entities.ts:169` — *"Their rotor discs are authored with `alpha` and
`noOutline`, and `spriteMesh` honours neither, so each one renders as an opaque
outlined drum that swallows the fuselage. **Raising these makes the drum worse,
not the aircraft better**"*.

But `spriteMesh.ts:156` reads:

```ts
const plate = s.alpha !== undefined && s.alpha < 0.5;
```

and every `rotorBlur` disc in `shared/data/sprites.json` is `alpha: 0.22` or
`0.16` (`heli`, `chopper`, `gunship`) and `0.25` (`plane`) — all under 0.5, so
all four are already drawn as thin plates. `REVIEW-3D.md` Part three records the
fix: *"Aircraft were opaque drums… now drawn as a thin plate at its own height."*

repro:
```
grep -n 'const plate = s.alpha' client/src/three/spriteMesh.ts
python3 -c "import json;d=json.load(open('shared/data/sprites.json'))['sprites'];\
print([(k,[s.get('alpha') for s in d[k]['shapes'] if 'alpha' in s]) for k in ('heli','chopper','gunship','plane')])"
```
why it matters: not the comment — the consequence. `Z_BY_SPRITE`
(`entities.ts:172-176`) pins `heli`/`gunship`/`chopper`/`plane` at **1.5**, the
bare `Z_EXAGGERATION` default, and says in so many words that they are left
there *because* of the drum. The drum is gone, so four vehicle kinds are still
carrying a height decision whose only stated reason no longer exists — every
other vehicle in that table was tuned deliberately.
prior art: `REVIEW-3D.md` "Still open" carries the drum, and Part three closes
it; nothing records that the two in-code notes and the aircraft heights were left
behind.

---

## Checked and deliberately not filed

- **`ci/shot.mjs` cannot photograph any live page.** `waitUntil: 'networkidle'`
  at playwright's 30 s default never arrives on a page with a render loop, and
  on this box the flyover is worse. Already the subject of round 8's
  `playLocal` work and `evidence/round3/F-R1-B01-shot.mjs`; my own
  `B-shot.mjs` / `B-client-shot.mjs` are the same workaround again. Not
  re-filed.
- **The only `pageerror`/console error any page produces is `GET /favicon.ico
  404`** — on all six contact sheets, `city3d.html` and the real client, 2D and
  3D. Dev-server artifact, not a finding.
- **R1-B04 holds.** The flyover HUD reads `draws 197  instances 610930  tris
  6964k`, not `draws 1  tris 0k` (`evidence/round9/B-circus-day.png`,
  `B-spire-day-p10.png`).
- **R1-B02 still reproduces and is still open** (prior art, not re-filed): at
  the same seed, hour and camera, `B-client-2d-night.png` carries dozens of warm
  window pools ringing every block and `B-client-3d-night.png` carries none —
  `drawWindows` is still 2D-only.
- **R1-B03**: not re-filed. Closed won't-fix by the user.
- **`ci/renderBench.mjs` pinning both arms to `render=2d`**: not re-filed,
  refuted in round 3.
- **Signal-head placement parity**: `worldObjects.ts:277-281` and
  `renderer.ts:1110-1113` compute `px`/`py` from the same `CARDINALS`, the same
  `+5` along the arm and the same exported `RIGHT_OFFSET`. Character for
  character the same. Holds.
- **Scenery planting parity** (`3D.md` "Planting" claims the identical hash and
  thresholds): `scenery.ts:185-215` and `tiles.ts:2294-2302` agree exactly on
  `T_PARK` (`hash2(tx,ty,71)` > 0.92 tree / > 0.87 bush). The `T_TREES`
  divergence (0.55) is documented in place as a deliberate canopy decision.
  Holds.
- **`facade`/`road`/`ground`/`ground-wet` sharing one `customProgramCacheKey`
  each**: checked in the installed `three@0.185.1` —
  `three.module.js:18184-18216` keys the program cache off
  `materialProperties.programs`, which is per material, so `onBeforeCompile`
  runs once per material and every chunk keeps its own uniform objects. No bug.
- **`?night=0` is not swallowed**: `main.ts:151-156` returns `null` only on a
  missing/non-finite parameter and `sceneNight` uses `??`. Fine.
- **`worldResolutionMult` / `imageRendering`** (`main.ts:840-905`): walked the
  whole-step and fractional-zoom cases at dpr 1 and 2; the `pixelated` test is
  right in each. No finding.

## Suspicions — measured nowhere near enough to file

1. **A shop's interior light burns at full night brightness at midday, in both
   renderers.** `lights3d.ts:406-417` and `renderer.ts:534-536` both push the
   room light at a constant `alpha: 0.5` with no `lit` factor, where the sign
   beside it is `0.45 * lit` and the lamp `0.5 * lit`. Through
   `intensityOf` (`lights3d.ts:837-839`, `GAIN` 5, `SIGN_Z` 16) that is
   **640 cd at noon** against the street lamp's 73.5 that R1-B01 was filed over
   — and 3D has no occluders, where the 2D comment says the 2D one is
   *"Shadowed, which is what makes the light spill out through the doorway and
   nowhere else."* Against it: `RANK.lamp` (4) outranks `RANK.shop` (3), so with
   16 point slots the room light may rarely win one; and both renderers author
   it identically, which is the shape the user closed R1-B03 on. I could not
   stage a shop in frame in the real client at 0.34 fps, so **this is arithmetic
   with no picture behind it.** One cheap check: force the camera over a shop
   at `night=0` with and without `?lights=off` and read the luma, exactly as
   `evidence/round3/V-R1-B01-*` did.
2. **`lights3d` turnover was 4 with the player standing still.** The file's own
   criterion (`lights3d.ts`, `counts()`) is *"Standing still it should sit at
   zero; every unit above that is a light that popped."* The single sample
   behind `B-client-3d-night.png` reads
   `{"points":16,"spots":4,"wanted":87,"turnover":4}` with the player on foot
   and no input. **One frame, and ambient traffic was moving**, which may
   account for all of it legitimately. A distribution over 30 frames would
   settle it.

## Housekeeping

`mapinfo-tmp.mjs` and `req-tmp.mjs` at the repo root were my scratch files; they
were swept into `1bd07a9` by something other than me. I have deleted them in the
working tree — that deletion is mine and is safe to keep.
