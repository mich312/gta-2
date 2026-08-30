# Lens B — the renderer, and what the player actually sees

Round `round1`, at `1469611` (+ the review-loop commit). Ground truth taken as
given: build clean, 943 tests green, `citybake --check` clean. No finding below
is a failing test; all five are evidence type (b) or (c).

Everything was shot against `http://localhost:5373/` with the offline host, at
the **shipped** camera (`?render=3d` is the default, `GAME_PITCH` 10), so the
frames below are the game as it opens.

**One harness note that every repro needs.** `ci/shot.mjs` shoots at 2200×1000
with Playwright's default 30 s screenshot timeout, and on this box the real
client in 3D cannot present a frame inside it — every attempt died with
`page.screenshot: Timeout 30000ms exceeded`. The four game frames below were
taken with a copy of `ci/shot.mjs` at 1280×720, a long settle and a long
screenshot timeout. It is quoted once here and referred to as `shot2.mjs`:

```bash
cat > /tmp/shot2.mjs <<'EOF'
import { chromium } from 'playwright';
const [url, out] = process.argv.slice(2);
const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(Number(process.env.SETTLE ?? 3000));
await p.screenshot({ path: out, timeout: 240000 });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
EOF
cp /tmp/shot2.mjs ./shot2.mjs      # must sit inside the repo to resolve `playwright`
```

**On `WAIT_GROUND`.** The flyover shot below uses it, as the lens requires.
The four game frames cannot: `main.ts` never exposes `globalThis.__ground` (only
`city3d.html` does), so `WAIT_GROUND` on the real client just burns its 180 s
timeout and prints "residency timeout, shooting anyway". `SETTLE=170000` on the
3D frames does the same job — it is a longer wait than `WAIT_GROUND=24` would
have granted — and the painted ground is fully resident in all four: the kerb
shading, paving joints, manholes and skid dashes are present and pixel-for-pixel
identical between the 2D and 3D frames, which is the check `WAIT_GROUND` exists
to make.

Pixel values below were read back out of the PNGs with a canvas in headless
chromium; every one is quoted inline so nothing is load-bearing but the images.

---

## Street lamps and shop signs burn at midday in the 3D renderer

severity: significant
lens: B
where: `client/src/three/lights3d.ts:361` (`const lit = 0.15 + 0.85 * night`), consumed at `:379` (street lamps) and `:400` (shop signs); `evidence/round1/B-lamp-noon-3d.png` against `evidence/round1/B-lamp-noon-2d.png`
evidence: Two frames of the same lamp, same seed, same forced hour `?night=0` — midday.
In 3D (`B-game-3d-day.png`, crop `B-lamp-noon-3d.png`) the bulb is blown to
`rgb(244,239,221)` at (1112,588) with a warm elliptical pool spilling across the
pavement and onto the carriageway, and a bloom halo around it. In 2D
(`B-game-2d-day.png`, crop `B-lamp-noon-2d.png`) the identical lamp at the
identical pixel is an unlit prop at `rgb(70,71,59)` and throws nothing.
A second lamp at (745,356): 3D `rgb(244,239,221)`, 2D `rgb(94,84,87)`.
The arithmetic matches the picture: at `night = 0`, `lit` = 0.15, so every lamp
in view is pushed with `alpha = 0.5 * 0.15 = 0.075`, and `intensityOf`
(`lights3d.ts:837`, `GAIN` 5, `ref = LAMP_Z = 14`) turns that into
`0.075 * 5 * 196 ≈ 74` cd of real point light 14 px above the pavement.
Note the same file already diagnosed this exact failure for the *other* light
family two hundred lines down (`lights3d.ts:576-583`): "*`lit` never drops below
0.15 because a street lamp keeps a little presence by day … That floor was
invisible until the bloom pass arrived and turned 'slightly on' into a glowing
halo on the tarmac at midday.*" Headlights got a 0.06 floor out of that
sentence; the lamps it names were left at 0.15, and the bloom pass it names is
on by default. The shop-sign half of this (`:400`, `0.45 * lit`) is the same
line and the same arithmetic; only the lamp is photographed.
That `?night=0` really did reach the light layer is settled by the third finding
below: the tarmac in this very frame matches the 2D midday tarmac to within
2/255, so `view.setNight(0)` ran — and `main.ts:897` and `main.ts:945` feed
`view.setNight` and `lights3d.update` the same `lights.nightAmount`.
repro:
```bash
pnpm --filter client dev -- --port 5373    # any port; substitute below
SETTLE=170000 node shot2.mjs "http://localhost:5373/?local=1&seed=7&night=0" /tmp/3d-day.png
SETTLE=25000  node shot2.mjs "http://localhost:5373/?local=1&seed=7&night=0&render=2d" /tmp/2d-day.png
# crop (1060,555) 110x70 out of each and compare — or just look at the
# bottom-right block of /tmp/3d-day.png
```
why it matters: A street lamp lit at noon is the single clearest "this is a
render, not a city" tell, it is the one thing the day/night cycle exists to
avoid (`GAPS.md` §"What changes with it": *"Lamps and shop lights fade in at
dusk instead of burning at noon"*), and it is on screen in the default
renderer's default hour. It also spends lamp slots out of a 16-light budget all
day long.
prior art: `REVIEW-3D.md` §Fixed/Lighting records the **vehicle** version
("Vehicle lights ignored the hour entirely — `void lit;`") as fixed, and
`GAPS.md:579` states the intended rule. The street-lamp/shop-sign floor is not
recorded anywhere.

---

## The lit windows that carry 2D night have no equivalent the 3D camera can see

severity: significant
lens: B
where: `client/src/render/renderer.ts:1014` (`drawWindows`, `MAX_WINDOWS = 96`, called at `:519`) against `client/src/three/facade.ts:128` and `:203`; `evidence/round1/B-night-block-3d.png` against `evidence/round1/B-night-block-2d.png`
evidence: One city block (screen 830,160 → 1250,580), `?night=0.6`, both
renderers, same seed. In 2D the block is ringed with warm window glows — the
brightest of them measures `rgb(232,191,144)` at (1055,328) — sitting on the
*roof edge* of every building, exactly where `drawWindows` puts them: it walks
every building's **edge tiles** and emits up to 96 point lights at
`(tx + 0.5 ± 0.42, ty + 0.5 ± 0.42)`, which a straight-down camera sees.
In 3D the same five buildings carry **no** window light at all on any surface
the camera can see. `lights3d.ts` emits only `lamp`, `shop`, `muzzle`, `head`
and `red` (grep `kind: '` — seven sites, none of them windows), and the 3D
window treatment lives in the facade shader, gated to vertical faces by
`float side = 1.0 - min(1.0, abs(vWorldNormal.z) * 4.0)` (`facade.ts:128`) and
applied to `diffuseColor` (`facade.ts:203`) — i.e. albedo, multiplied by a
moonlit rig, not emission. On the one wall strip the pitch-10 camera does see
(x 1016–1035), the brightest "lit" window in the whole frame measures
`rgb(134,117,94)` — a muddy tan, against 2D's `rgb(232,191,144)`.
repro:
```bash
SETTLE=170000 node shot2.mjs "http://localhost:5373/?local=1&seed=7&night=0.6" /tmp/3d-night.png
SETTLE=25000  node shot2.mjs "http://localhost:5373/?local=1&seed=7&night=0.6&render=2d" /tmp/2d-night.png
# crop (830,160) 420x420 from each
```
why it matters: `GRAPHICS.md` calls these "the cheapest thing here and close to
the most valuable … a scatter of warm rectangles around the edge of every block
after dark". They are most of what makes the 2D city look inhabited at night,
and in the shipped renderer they are gone — the buildings are dark slabs and
the only light in the block is whatever the 16-slot lamp budget reached.
prior art: `REVIEW-3D.md` §Not fixed has "**The window hash has no per-building
salt**", which is about the facade shader's *pattern* and has since been fixed
(per-wall-plane salt, `facade.ts:197`). Nothing records that the 3D path has no
window light the game's camera can see.

---

## The two renderers agree on midday and disagree by 1.7× at dusk

severity: significant
lens: B
where: `client/src/three/cityView.ts:91`/`:108` (`DAYLIGHT`/`MOONLIGHT`, lerped in `setNight`, `:444`) against `client/src/render/config.ts:62-63` (`GRADE_DAY`/`GRADE_NIGHT`); `evidence/round1/B-game-3d-night.png` against `evidence/round1/B-game-2d-night.png`
evidence: Same seed, same forced hour, same camera, four frames. Carriageway
tarmac well inside the vignette's inner radius (230 px), so no grade term is in
play, sampled at four screen positions:

| pixel | 3D `?night=0` | 2D `?night=0` | 3D `?night=0.6` | 2D `?night=0.6` |
|---|---|---|---|---|
| (640,150) | `rgb(50,54,57)` | `rgb(50,53,57)` | `rgb(20,24,33)` | `rgb(36,41,52)` |
| (700,60)  | `rgb(51,55,57)` | `rgb(49,51,55)` | `rgb(19,24,33)` | `rgb(34,39,50)` |
| (460,470) | `rgb(51,54,57)` | `rgb(50,53,57)` | `rgb(19,24,33)` | `rgb(36,41,52)` |
| (500,500) | `rgb(51,54,57)` | `rgb(50,53,57)` | `rgb(20,24,33)` | `rgb(36,41,52)` |

At midday the two agree to within 2/255 — `BUGS.md` §4's calibration holds and
is worth recording as healthy. At `night=0.6` the same tarmac is luma 23.8 in
3D against 40.7 in 2D, **0.58×**. Whole-frame (HUD masked) histograms say the
same: 31% of the 3D frame is below luma 32 against 5% of the 2D frame.
The mechanism is two independently-tuned ramps that meet only at one end: the
3D rig falls from `sun 2.95 / ambient 1.18 / hemi 0.62` to
`0.21 / 0.4 / 0.39` — 53% of daylight at t = 0.6 — while the 2D grade's multiply
falls only from 252/255 to `lerp(252, 144, 0.6) = 187`/255, 73%.
repro: the four `shot2.mjs` commands from the two findings above, then read
back the pixels listed.
why it matters: `BUGS.md` §4 states the invariant — "*Switching renderers
changed the hour*" — and closed it on one measurement at noon. Everywhere else
on the clock it is still true, and it is worse than a taste difference here: at
dusk the shipped renderer is nearly half as bright as the fallback while also
carrying a fifth of its lights, so `?render=2d` and the default are two
different times of night.
prior art: `BUGS.md` §4 "Day/night parity — FIXED" measured midday only and says
in terms that "the night end is untouched from where it was tuned".
`REVIEW-3D.md` §"Still open from the play-tests" records the *lamp count* gap
("Night still has fewer pools than 2D"); the base level of unlit surfaces is a
separate number and is not recorded. Filed as a promotion of §4 from "midday
calibrated" to "calibrated at one point on a two-point curve".

---

## `city3d.html`'s draw/triangle readout has reported `draws 1 tris 0k` since the post chain landed

severity: nit
lens: B
where: `client/city3d.html:102-106` reading `client/src/three/cityView.ts:564` (`stats()`), after `render()` at `:534` runs `PostChain.render()` (`client/src/three/post.ts:157`)
evidence: `evidence/round1/B-fly-downtown.png` — the on-screen HUD of the
flyover reads `draws 1  instances 619445  tris 0k` for a 4,066-building city.
The repo's own `evidence/baseline-fly-centre.png` reads the same. The cause is
mechanical: `stats()` reads `renderer.info.render` *after* `composer.render()`,
and three.js resets `info` at the top of every `WebGLRenderer.render()` call
(`node_modules/.pnpm/three@0.185.1/.../three.module.js:17696`,
`if ( this.info.autoReset === true ) this.info.reset();`). `EffectComposer`
drives each pass through `renderer.render`, so what survives is the last one —
the grade `ShaderPass`: one fullscreen quad, two triangles, which prints as
`tris 0k`. `instances` is the only figure that survives because it is a
build-time count, not a renderer one. For contrast, the pre-post-chain
`evidence/city-3d-facades.png` reads `draws 79 instances 63892 tris 1390k`.
repro:
```bash
pnpm --filter client dev -- --port 5373
WAIT_GROUND=24 node ci/shot.mjs \
  "http://localhost:5373/city3d.html?fly=1&at=470,190&h=300&pitch=45&night=0" \
  /tmp/fly.png
# read the HUD block in the top-left corner
```
why it matters: this is the instrument every 3D figure in `3D.md` and
`REVIEW-3D.md` is quoted from — "9 draw calls … 762k triangles",
"179 draws, 3.2M triangles", "draw calls rise from 212 to ~320". On a box with
no GPU it is the *only* frame-cost signal there is, and it has been reading
1 and 0 for the whole of the culling and dressing work. `REVIEW-3D.md` opens
with "every instrument was broken simultaneously, which is how 5.8M triangles a
frame survived a previous bug hunt"; this is the same instrument, broken again
by a later change. One `renderer.info.autoReset = false` plus a manual reset
around the composer fixes it.
prior art: `REVIEW-3D.md` §"The shape of the problem" and §"The HUD, and the
instruments" list three broken instruments (the fps readout, `renderMs`,
`pnpm bench`) and record them fixed. This is a fourth, introduced afterwards,
and is not recorded.

---

## Scenery prop pools still zero-scale their tails, which the file next door documents as the wrong thing to do

severity: nit
lens: B
where: `client/src/three/scenery.ts:270-273` against `client/src/three/entities.ts:385-405` (`Pool.end`) and `client/src/three/worldObjects.ts:148-161` (`SolidPool.end`)
evidence: `SceneryLayer.updateProps` ends every frame with
```ts
for (const pool of this.propPools.values()) {
  for (let i = pool.used; i < pool.mesh.count; i++) pool.mesh.setMatrixAt(i, this.zero);
  pool.mesh.instanceMatrix.needsUpdate = true;
}
```
`mesh.count` is never shortened, and the pools are created at a fixed capacity
of 192 (`scenery.ts:283`) for each of up to eight prop names — `lamp`, `bin`,
`fence`, `barrel` and their four `_broken` twins (`shared/data/props.json`) —
so a frame holding a few dozen props still submits ~1,500 collapsed instances.
Each pool also has an outline twin (`scenery.ts:293`) whose `count` is set once
at construction and never touched, so it pays the same again; the colour pools
carry `castShadow = true`, so the shadow pass pays a third time.
The two other pool implementations in the same directory both shorten `count`,
and `entities.ts:385-397` states the rule in its own docstring: "*a zero-scaled
tail collapses to nothing on screen but is still transformed, still counted and
still walked by the shadow pass … a pool of 200 holding 3 peds paid for 197
invisible ones, twice over, because the outline twin pays it too.*"
repro: read the three `end()`/`updateProps()` implementations side by side —
`client/src/three/scenery.ts:248-275`, `client/src/three/entities.ts:385-405`,
`client/src/three/worldObjects.ts:148-161`.
why it matters: it is the exact defect `REVIEW-3D.md` fixed everywhere else,
left standing in the one layer that was not audited, on a renderer whose frame
cost has never been measured on real hardware.
prior art: `REVIEW-3D.md` §Fixed/"Resources and robustness" — "**Pool tails were
zero-scaled rather than uncounted**, so a pool of 200 holding 3 peds
vertex-shaded and shadow-mapped 197 invisible ones, twice over because of the
outline twin." Recorded as fixed; `scenery.ts` was missed.
