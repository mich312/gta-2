# Evidence

## The street: bodies, dropped guns, and the ambulance

Captured from a browser against a real server, with the casualties staged in
the session so the shot could be taken at all — ordinary play produces them
readily enough and never on cue.

| file | what it shows |
|---|---|
| `street-ambulance.png` | An ambulance that turned itself out to a casualty, pulled up on the road beside the scene with its brake lights on. On the pavement to the left: an officer's body, a pedestrian's, the casualty it came for, and two dropped guns. (Taken before the body and blood rework below, so the figures in it are the old flattened sprites.) |
| `street-blood-1-spray.png` | A second after the shooting, at 4×. The droplets are down: each mark on the pavement is where one of them actually landed, so the arc on the ground is the arc the blood took. The figures are laid out along the ground — head, torso, legs — rather than standing sprites squashed towards the camera. |
| `street-blood-2-pooled.png` | The same corner five seconds later. The pools have spread out from under each body and stopped; the spatter is still where it fell. One of those on the left is a casualty rather than a corpse — smaller, brighter pool, and it breathes. |
| `bodies.png` | Every state somebody can be found on the floor in, at seven angles, drawn through the real `drawBody`. Row 1 is a standing figure for scale — a head, two shoulders and the tops of two feet. The rest are drawings of their own rather than that one stretched: dead face-down (no face, the back of the head), dead on the back (face up), and — the one that earns its keep — **downed**, curled on one side with an arm across the chest, because a casualty on the bleed-out clock has an ambulance coming and a corpse does not. |

## Damage

What the damage model looks like, for the change described in `DAMAGE.md`.

| file | what it shows |
|---|---|
| `damage-ladder.png` | One car at every rung of the breakage ladder, drawn through the real `drawVehicle` and the real light pass. |
| `damage-ladder-lamps.png` | The top row at full scale — showroom, one knock, bumper off, LEFT lamp out. The headlight cone narrows and shifts to the surviving lamp. |
| `hud-1-fresh.png` / `hud-2-damaged.png` | The HUD damage panel at 8×, before and after a prang. The damaged one is `broken = 0x4301`: front bumper, LEFT headlight only, both front tyres. |
| `live-*-hud.png` | The same panel, captured from a browser driving the actual game. |

## Retaking these

```bash
pnpm --filter client dev
node ci/shot.mjs http://localhost:5173/body-sheet.html evidence/bodies.png '#sheet'
```

Both contact sheets are pages rather than scripts, and both draw through the
real renderer rather than through a copy of it — the sprite generator's own
preview knows what it drew, and these know what the game asks for. The two
have disagreed.

The ladder sheet regenerates on demand — run the dev server and open
`/damage-sheet.html`. It is the quickest way to check the drawing after
touching any of the damage rendering, and it is why the sheet exists rather
than these files: the PNGs are a snapshot, the page is the tool.
