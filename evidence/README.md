# Evidence

## The street: bodies, dropped guns, and the ambulance

Captured from a browser against a real server, with the casualties staged in
the session so the shot could be taken at all — ordinary play produces them
readily enough and never on cue.

| file | what it shows |
|---|---|
| `street-ambulance.png` | An ambulance that turned itself out to a casualty, pulled up on the road beside the scene with its brake lights on. On the pavement to the left: an officer's body, a pedestrian's, the casualty it came for, and two dropped guns. |
| `street-down.png` | The same corner at 4×. Top, an officer's body — flat, drained, still. Bottom left, the casualty — colour kept, and breathing, because an ambulance is coming for them and nothing is coming for the officer. Telling those two apart is the whole reason `drawBody` takes a flag. The grey bars are guns their owners dropped. |

## Damage

What the damage model looks like, for the change described in `DAMAGE.md`.

| file | what it shows |
|---|---|
| `damage-ladder.png` | One car at every rung of the breakage ladder, drawn through the real `drawVehicle` and the real light pass. |
| `damage-ladder-lamps.png` | The top row at full scale — showroom, one knock, bumper off, LEFT lamp out. The headlight cone narrows and shifts to the surviving lamp. |
| `hud-1-fresh.png` / `hud-2-damaged.png` | The HUD damage panel at 8×, before and after a prang. The damaged one is `broken = 0x4301`: front bumper, LEFT headlight only, both front tyres. |
| `live-*-hud.png` | The same panel, captured from a browser driving the actual game. |

The ladder sheet regenerates on demand — run the dev server and open
`/damage-sheet.html`. It is the quickest way to check the drawing after
touching any of the damage rendering, and it is why the sheet exists rather
than these files: the PNGs are a snapshot, the page is the tool.
