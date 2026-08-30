# Lens B — the renderer, and what the player actually sees

Read `3D.md` and `GRAPHICS.md` first. 3D is the default renderer;
`?render=2d` falls back to the original Canvas-2D one. Only the world layer
differs — HUD, minimap, overlay, input and prediction are shared.

## Take your own pictures

```bash
pnpm --filter client dev            # then, in another shell:
WAIT_GROUND=24 node ci/shot.mjs \
  "http://localhost:5173/city3d.html?fly=1&at=<x>,<y>&h=300&pitch=45&night=0" \
  evidence/<round>/<name>.png
```

**`WAIT_GROUND` is not optional.** Under this box's software renderer the
painted ground fills at two chunks a frame; shooting early photographs the
flat instanced slabs instead of the city. A previous review made exactly that
mistake and documented it so the next one would not — do not be the next one.

The contact sheets are pages in `client/`: `body-sheet.html`,
`damage-sheet.html`, `fall-sheet.html`, `flight-sheet.html`, `hud-sheet.html`,
`vehicle-sheet.html`. Shoot them with `ci/shot.mjs` too.

And drive the real game, which is a different thing from the sheets:

```bash
node ci/playLocal.mjs        # offline host, fixed seed, real keys and mouse
```

## Care about

- Geometry that is wrong at eye level: seams, holes, z-fighting, things
  floating or sunk, buildings leaning the wrong way.
- Lighting and the night pass — `?night=0..1` forces the hour, and it is the
  only practical way to see it.
- The parity claims the docs make between 2D and 3D. Check one or two rather
  than trusting the table.
- The HUD drawing on a transparent canvas over a three.js world.
- Page errors: `ci/shot.mjs` and `ci/play.mjs` both collect `pageerror`. A
  console exception nobody has noticed is a finding with evidence attached.

## Do not

Do not review how the map was baked — that is lens A. Your subject is what
comes out of the renderer.
