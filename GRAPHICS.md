# Graphics: performance and art direction

Two problems, one document. The first half is why the game felt laggy and what
was changed. The second half is the art direction — what the reference points
actually did, what we do instead, and what is still ahead.

---

## Part 1 — Why it wasn't fluid

The frame rate was never the problem. The renderer was hitting 60 fps the whole
time; it just wasn't *moving* at 60 fps.

### The staircase

The simulation runs at 30 Hz. The old renderer drew `predictor.predicted.pos`
directly — the raw, tick-quantised position. On a 60 Hz display that means the
avatar and the camera advance on every second frame and stand still on the
other one. Measured on a walking player, sampling the drawn position on every
animation frame:

```
raw prediction    frames=88  stalled=44 (50%)  mean=4.30px
drawn position    frames=88  stalled=0  ( 0%)  mean=2.15px   <- after the fix
```

Half of all frames were duplicates. At 144 Hz it would have been 79%. That is
exactly what "laggy" looks like when the counter says 60.

The fix is `render/smoothing.ts`: keep the pose from before and after the most
recent tick and sample between them by `acc / TICK_MS`. Nothing in the
simulation changes and no input lag is added — the target is still the freshest
predicted state, we just stop drawing it as a step function. Server
reconciliations go through `correct()`, which moves the target without moving
the origin, so a correction glides in over the rest of the tick instead of
snapping.

Aim angle gets the same treatment, for the same reason.

### The camera quantisation

The camera was floored to whole world pixels. At a 4× window scale that is a
4-CSS-pixel jump per step, and the whole world jolts sideways with it.

Now the camera is a float, the backing store holds 2 device pixels per world
pixel, and exactly one rounded origin is computed per frame:

```ts
const originX = Math.round(-cam.x * RENDER_SCALE);
const dx = (wx) => originX + Math.round(wx * RENDER_SCALE);
```

Everything — cached ground chunks, entities, decals, lights — derives from that
single origin, so the scene translates as one rigid body. No seams open between
cached chunks and nothing shivers against the ground. Camera granularity
improves 2–4× and stays crisp, because the art still lands on whole device
pixels.

### The unbounded accumulator

`while (acc >= TICK_MS)` had no ceiling. Come back to a backgrounded tab, or
return from the blocking `window.prompt` in the login path, and the loop would
try to simulate every tick that elapsed — hundreds of them — in one frame.
`MAX_CATCHUP_TICKS` and `MAX_FRAME_MS` bound both the queue and the one absurd
delta a stall produces.

### The per-frame repaint

`drawWorld` repainted roughly 500 flat `fillRect`s every frame and walked every
shop in the city while it was at it. That capped both the frame rate and — more
importantly — the amount of detail the ground could ever carry, because
anything drawn there was paid for 60 times a second.

`render/tiles.ts` inverts it: the city is painted once per 8×8-tile chunk into
an offscreen canvas and blitted thereafter. Lane markings, kerbs, paving joints,
roof clutter, extruded walls and cast shadows are now effectively free. Builds
are capped at 3 per frame, and leftover budget prefetches the ring just outside
the viewport, so driving into fresh ground finds it already painted.

Measured over 6 seconds of continuous movement: `p50 16.7ms, p95 17.0ms,
p99 19.5ms, max 22.7ms`, no frame over 33 ms.

### Smaller things that were costing real time

- **Rotation.** Sprites were rotated with `ctx.rotate` on every draw, which
  costs a transform flush and resamples the art at every angle — small pixel
  sprites visibly crawl as they turn. Angles are now baked once into their own
  canvas, lazily and cached, so drawing is a plain axis-aligned blit.
- **Text.** A `fillText` per entity per frame is one of the most expensive
  things on a 2D canvas. Name tags are rasterised once into a small canvas and
  reused.
- **Context.** `getContext('2d', { alpha: false })` lets the compositor skip
  blending the canvas against the page.
- **Interpolation clock.** The remote-entity clock was servoed on snapshot
  arrival, which made the correction depend on the display rate, and hard-clamped
  at the head of the buffer, so a late packet froze every remote entity and then
  jumped. It is now dilated per frame — drifting towards the head slows it,
  falling behind speeds it up — so jitter shows up as easing rather than
  stuttering.

---

## Part 2 — The look

### What the reference actually did

GTA 2 was not hand-drawn pixel art. Its sprites were **pre-rendered from 3D**
and stored as uncompressed 256-colour graphics across up to 32 pages of 64 KB,
each page 256×256, with a delta system for variations like vehicle damage.
Although the camera was fixed overhead, the world geometry was genuinely 3D and
the sprites were textured polygons — which is where the smooth zooming, the
lighting, and the depth on tall objects came from. Buildings, lamp posts and
trees got a depth-of-field treatment that made a 2D game read as near-3D.
([igrandtheftauto.com](https://www.igrandtheftauto.com/gta2/graphics),
[gtamp.com](https://gtamp.com/gta2/gta2-style-sty-graphics-file-format/),
[gamedev.net](https://www.gamedev.net/forums/topic/69276-how-did-the-gta-2-engine-work/))

Two lessons transfer directly:

1. **Depth is the whole game.** Flat top-down art reads as a board game. What
   made GTA 2 feel like a city was that vertical things looked vertical.
2. **Pre-render everything you can.** They baked lighting and rotation into the
   sprite data because doing it at runtime was unaffordable. Same conclusion
   here, for the same reason — a 2D canvas has no shader stack.

The modern top-down pixel-art literature adds the rest: light from the top so
lower surfaces are darker, shade the outline itself at low resolutions, and
don't pay for 8 directions of hand-authored art when you can derive them
([SLYNYRD](https://www.slynyrd.com/blog/2019/10/21/pixelblog-22-top-down-character-sprites),
[Sandro Maglione](https://www.sandromaglione.com/articles/pixel-art-top-down-game-sprite-design-and-animation)).
The standard way to light 2D sprites is a normal map plus per-pixel lighting, or
a dark scene with light added back on top
([Defold forum](https://forum.defold.com/t/normal-map-lighting-for-2d-pixel-art-sprites/70967),
[mattgreer.dev](https://www.mattgreer.dev/blog/dynamic-lighting-and-shadows/)).

### What we do instead

**Height fields, not normal maps.** Sprites in `shared/data/sprites.json` are
still flat shapes, but every shape carries a `z`. After rasterising, the
generator relights each pixel from that height field: warm highlight where the
neighbour towards the light is lower, cool shade where it is higher, ambient
occlusion in the creases, and a global falloff so low surfaces sit deeper in
shade. Then it traces a contour tinted *from the pixel it hugs* rather than flat
black, which is what stops small sprites reading as stickers.

The result is that a car roof drawn as one polygon at `z: 12` over a body at
`z: 8` gets a bevel, a highlight and a shadow for free. The JSON never describes
a gradient. This is the same trade GTA 2 made — bake the lighting — reached from
the other direction.

**Twice the art resolution, same field of view.** `RENDER_SCALE = 2`. The world
view is still 480×270 world pixels; the backing store is 960×540. A 12
world-pixel character is a 24-pixel sprite. Nothing about visibility or balance
changes, and the detail budget doubles.

**Derived variety, not authored variety.** One car definition and a `variants`
axis emits ten colourways. One character skeleton and a four-frame `anim` map
emits a walk cycle; six shirt colours make 24 pedestrian frames. Rotation is
baked on the client at load, lazily, only for the angles and variants actually
on screen.

**Static extrusion for depth.** Buildings get a wall swept towards the sun-away
direction and a cast shadow onto the street, both painted into the cached
chunk — so the depth cue costs nothing per frame. Roof colour is per *building*,
not per tile, which is what makes a block of roof tiles read as one solid mass
instead of a grid of identical squares.

**Light added back on top.** The scene is graded with one multiply, then lamps,
headlight cones, shop signs and muzzle flashes are drawn additively from
pre-baked textures. Two full-screen composites and one blit per light. The grade
is deliberately gentle — it exists to give the lights somewhere to land, not to
hide the art the tile layer just spent its budget drawing.

### The frame fills the window

The view used to be a fixed 480×270 world pixels, blitted into the largest
whole multiple of its 960×540 backing store that fitted the window and
letterboxed for the rest. That is exact on a 1920×1080 or a 3840×2160 display
and wrong everywhere else: a 1440p monitor played inside black bars with a
third of its glass unused, and an ultrawide lost half of it.

`render/viewport.ts` inverts the rule. Pick the zoom first — preferring a whole
multiple of `RENDER_SCALE`, so one backing-store pixel still covers a whole
number of CSS pixels and nearest-neighbour upscaling stays even — then let the
world view grow to whatever the window has room for:

| window | view (world px) | zoom | canvas |
| --- | --- | --- | --- |
| 1920×1080 | 480×270 | 4 | 1920×1080 |
| 2560×1440 | 640×360 | 4 | 2560×1440 |
| 3440×1440 | 574×240 | 6 | 3444×1440 |
| 1366×768 | 683×384 | 2 | 1366×768 |
| 3840×2160 | 480×270 | 8 | 3840×2160 |

The reference resolutions are unchanged, which matters: the HUD, the camera
lead and every balance number were tuned against that frame.

The field of view has a ceiling — 700×400 world pixels — for two reasons. The
server only streams entities within `INTEREST_RADIUS` (600 px), so a view whose
half-diagonal approaches that would show streets the server has already decided
are empty; and an unbounded 32:9 monitor would hand its owner three times the
situational awareness of a laptop. At the ceiling the half-diagonal is 403 px.

Everything downstream reads the live `viewport` rather than a constant: the
tile layer's visible-chunk span, the HUD and minimap anchors, the mouse-to-world
mapping, the positional-audio listener, and the light pass's buffers, which
resize with it.

### Light that the city can stop

The lights were radial gradients blitted over the finished scene, which meant a
street lamp lit the inside of the block behind it and a headlight beam went
straight through a tower. `render/shadows.ts` fixes that, and it is the cheap
half of what a 2D ray tracer does: instead of marching a ray per pixel, take the
silhouette edges of everything solid near the light and extrude them away from
it. The union of those quads is exactly the set of points no ray reaches —
computed in geometry rather than in samples, a few dozen fills instead of a few
hundred thousand traces.

The occluders are tiles. The city is a grid and buildings own whole cells, so
the silhouette of a block is a handful of axis-aligned segments and finding them
is a scan over the tiles the light can reach. Only the faces that look at the
light and have open ground across them are emitted — the seams inside a block
are already in shadow. Endpoints come out in a consistent rotational order about
the light so every quad winds the same way and one non-zero fill unions them;
wound inconsistently, two overlapping quads cancel and a bright seam opens down
the middle of a wall's shadow. The far edge is a three-point fan rather than a
single chord, because a chord across a wide angle cuts back inside the arc it
stands in for, which shows up in play as a bright wedge sitting on a building.

Three details make it read as lighting rather than as stencilling:

- **The shadow is never black.** `SHADOW_BOUNCE` leaves 17% of the light
  standing. Real streets bounce light off the facing wall, off the road, off
  the sky, and a shadow punched to nothing is a hole cut in the frame. It is
  also the difference between an alley you can fight in and one you cannot see
  in.
- **Static lights are baked.** A lamp post has not moved since worldgen, so its
  shadow is the same answer every frame: it is rendered once into its own sprite
  and blitted thereafter, keyed on kind, radius and world position. That is what
  makes the soft-shadow blur affordable — and softness matters, because a point
  source casts a knife edge and nothing in a city is a point source.
- **Moving lights are rationed.** Headlights, sirens, fires and muzzle flashes
  recompute, up to `MAX_SHADOW_LIGHTS` a frame, sorted by how much screen they
  cover — so the beam of the car you are driving always wins and the twelfth
  siren three blocks away is the one that goes flat.

The best of it is free: a shop's interior light is inside a room whose walls are
solid tiles, so the light spills out through the doorway and nowhere else,
without anybody writing a doorway case.

### The paint, and where the lights stand

Two things on the road surface were saying something false.

**The centre line was not in the centre.** The rule was "the far edge of tile
`floor(width / 2) - 1`", which is the middle only on a road with an even number
of tiles across it. Every secondary road in this city is three tiles wide, so
the line landed on the boundary between the first tile and the second, and the
street had a lane and a half on one side and half a lane on the other. The
simulation never agreed with the paint: `laneOptions` has always put the two
lanes at the true centre of the drivable span, plus and minus a quarter of its
width. `laneCentreInTile` is the paint catching up — and it is a pure function,
so the arithmetic is checked without a canvas.

**Every junction was a string of fairy lights.** Signal heads were emitted per
approach *tile*, so a four-tile arterial arm carried four of them strung right
across the carriageway, half standing over the lanes going the other way — 2465
heads in a city with 228 junctions. A head belongs on the kerb at the near right
of one approach, and that is a local test: a tile carries the head when the tile
one step further towards the driver's right is not another approach tile of the
same junction. The kerb-most tile of each run wins, one head per arm falls out,
and the count drops to 755 — four on a crossroads, three on a T-junction, and a
carriageway split by a central reservation correctly gets one per side.

Which half of a road belongs to which direction is now one fact, `RIGHT_SIGN` in
`roadgrid.ts`, read by the lane model, the signal heads and the stop lines
alike. The stop lines moved with it: they stop at the centre line instead of
crossing it, because a stop line spanning the full width was telling the traffic
leaving a junction to halt at it.

### Lamps that behave like lamps

The old flicker was one sine per lamp, out of phase by id — a gentle collective
breathing that nothing in a real street does. What a street actually has is a
majority of steady lamps, a few that hum, one on the way out that stutters, and
the odd dead one that flashes once a minute and gives up. `lampCharacter(id)`
draws which from a hash of the prop id, so a given lamp is the same lamp for
every player and for the whole session, and `flicker()` is a pure function of
wall-clock, so it is identical at 30 fps and at 144.

The same model drives the fire on a burning car (the one light allowed to
overshoot — a flame that only ever dims reads as a lamp on a dimmer), the
occasional stutter of a shop's neon, and the television flicker in about one lit
window in eight.

Those windows are the cheapest thing here and close to the most valuable: a
scatter of warm rectangles around the edge of every block after dark, hashed off
the tile so it is the same building every night. They cast nothing — a window is
already at the wall it would be occluded by — which is what keeps a hundred of
them affordable.

Explosions and gunfire now light the street too. `Effects.flash` is a light with
a lifetime in world space: a fireball throws a hard white flash that is gone in
a fifth of a second over a slower fire burning down, and every round fired puts
one frame of light on the wall next to you. Before, the only illumination an
explosion produced was the glow on its own sparks.

### The pass, and what it costs

Lights accumulate into their own buffer rather than straight onto the frame,
which is what lets them be post-processed as a group. The buffer is then
downscaled and added back a second time — a bloom, and what stops a bright lamp
reading as a sticker of a lamp.

Two measurements shaped the implementation, both taken driving at night on a
1280×720 backing store:

- A single smoothed 6× magnification of the bloom straight onto the frame cost
  **16 ms**. It is a slow path in the browser's rasteriser and it alone put a
  1440p window under 60 fps. Interpolating up to half size instead costs a
  quarter of the pixels, and doubling *that* with no filter is exactly one world
  pixel per step — which is what this art is made of anyway.
- The soft-shadow blur is the other expensive thing, and driving down a lit
  street brings a whole row of new lamps into view at once. Bakes are rationed
  separately and hard: `MAX_LIGHT_BAKES` is 2 a frame, which is still four times
  faster than a car passes lamp posts. The few that miss out are drawn flat for
  a frame or two at the edge of the screen.

With both in place, frame times over 14 seconds of continuous driving at night:

```
1920x1080 (960x540 backing)    p50 16.7  p95 16.8  p99 16.8
2560x1440 (1280x720 backing)   p50 16.7  p95 16.8  p99 33.4
```

The 1080p figure is identical to the same run before any of this work; 1440p
carries a 78% larger backing store, full shadow casting and the bloom for the
occasional dropped frame — and no letterbox.

`?lights=cheap` keeps the grade and the lamps and drops the shadows and the
bloom, for a machine that cannot afford them; `?lights=off` leaves the scene
ungraded. `?night=0..1` forces the hour, because a day is 24 minutes long and
none of the above is reviewable without it.

### Tooling

```bash
pnpm sprites                          # regenerate the sheet
pnpm sprites -- --preview=8           # + a zoomed contact sheet with pivots
pnpm sprites -- --preview=8 --only=car,cop_f   # just these
```

`sprites.preview.png` is gitignored. It draws every frame on a checkerboard at
whatever zoom you ask for, with a magenta crosshair on the rotation pivot — the
only practical way to judge silhouettes and shading by eye.

---

## What's next

Roughly in order of visual return per unit of work.

1. **True parallax extrusion.** Right now building walls are swept in one fixed
   direction, which is cacheable but loses the parallax. Drawing the visible
   buildings per frame, offset outward from the screen centre in proportion to
   their height, is the actual GTA 2 effect — you'd see the north face of
   buildings north of you and the south face of buildings south of you. Needs
   per-building height in worldgen and a separate pass outside the chunk cache.

2. **Building heights and rooftop variety.** Worldgen already knows the district
   and the building rect; it does not yet know how tall anything is. Height
   would drive extrusion depth, shadow length, and roof detail density all at
   once.

3. **Vehicle damage states.** The generator's delta model is already there in
   spirit — add `variants` on a damage axis, and crumple the body polygon.
   Police vehicles are already drawn (`copcar` is in the sheet) and just need a
   vehicle kind in the sim to hang them on.

4. **Directional character art.** The current characters are one silhouette
   rotated. A dedicated front/back/side set — or at minimum a different arm
   arrangement when moving versus aiming — would make on-foot combat read much
   better than a rotating top-down blob.

5. **Skid marks and tyre tracks.** The decal pool and the emitter both exist
   (`Effects.skid`); it needs a lateral-slip signal from the vehicle sim to
   decide when to lay rubber down.

6. **A day/night cycle.** The lighting pass is already a single grade plus
   additive lights, so animating the ambient colour and turning the lamps up
   after dusk is a small change with a large payoff.

7. **Weather.** Rain as a screen-space particle layer plus a wet-asphalt
   specular tint on the road chunks, driven from a server-authoritative clock so
   everyone sees the same sky.

8. **Sprite sheet budget.** Everything is one PNG and one metadata file today,
   which is fine at 69 frames. Past a few hundred, the shelf packer wants a real
   bin packer and the sheet wants splitting by category.
