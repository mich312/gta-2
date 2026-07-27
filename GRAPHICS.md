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
