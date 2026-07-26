# topdown-city

Browser-based, real-time multiplayer, top-down open-city sandbox — original
work in the genre of early top-down open-city action games. TypeScript
throughout; deterministic 30 Hz simulation shared between an authoritative
Node server and a Canvas-2D client.

## Run it

```bash
pnpm install
pnpm build          # tsc -b (shared + server)
node server/dist/index.js          # terminal 1 — server on ws://127.0.0.1:8080
pnpm --filter client dev           # terminal 2 — Vite on http://localhost:5173
```

Open http://localhost:5173 in as many tabs as you like (4–8 players).
The client connects to `ws://<hostname>:8080` by default; override with
`?server=ws://host:port`.

### Controls

| Input | Action |
| --- | --- |
| WASD / arrows | walk, drive (up=throttle, down=brake/reverse, left/right=steer) |
| Mouse | aim; click or Space to fire |
| E / Enter | enter/exit car, context action |
| 1–8 | switch weapon slot |
| Y / U / I / O | buy items while standing in a shop doorway |
| L / K | log in / register (optional — guests always play) |
| ` (backquote) | debug overlay: tick, RTT, bandwidth, hitboxes, prediction ghost |

### Server environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | WebSocket bind |
| `SEED` | random | city + session seed |
| `WEAPONS_LOST_ON_DEATH` | `true` | death costs your guns (design flag) |
| `PED_COUNT` | `200` | pedestrians per session |
| `INTEREST_RADIUS` | `600` | px; entities beyond it aren't sent |
| `PERSIST_PATH` | `data/persist.db` | SQLite (node:sqlite); `.json` = file store |
| `REPLAY` / `REPLAY_DIR` | on / `replays` | input recording (`REPLAY=0` off) |

All gameplay numbers live in `shared/data/*.json` (movement, vehicles,
weapons, police, peds, props, economy, worldgen, palette) — restart the
server to apply; clients receive tunables in the welcome message.

## Tooling

```bash
pnpm test                                   # vitest across shared + server
pnpm bots --count=8 --script=brawl --duration=60   # headless multiplayer harness
                                            # scripts: idle|cruise|circle|joyride|brawl|jitter
pnpm mapgen --seed=7                        # render a city to PNG without the game
pnpm sprites                                # regenerate legacy sprite sheet (unused by the client)
pnpm replay replays/<file>.jsonl            # re-simulate a recording, verify hashes
node server/dist/tools/persistCheck.js      # e2e: purchase survives server restart
```

The bot harness is the multiplayer verifier: it fails on hash desyncs,
tick-spread, prediction corrections beyond threshold, or per-client
bandwidth over 50 KB/s. Every session records a replay; a replay that stops
re-simulating to identical hashes is the desync alarm.

## Layout

- `shared/` — the entire deterministic simulation + worldgen + wire protocol.
  Zero DOM, zero Node imports. Both other packages import it.
- `server/` — authoritative 30 Hz session over `ws`; economy (append-only
  ledger, shops, scrypt accounts) lives here, outside the sim, and touches it
  only through recorded SimCommands.
- `client/` — Vite + Canvas 2D. Rendering and input only; predicts the local
  player with rewind/replay reconciliation, interpolates everything else.

## Graphics

The client renders through a layered pipeline (`client/src/render/`), all
Canvas 2D at a fixed 480×270 internal resolution, no external assets:

- **Procedural sprite atlas** (`atlas.ts`) — people, cars and props are
  painted in code and pre-baked at 48 rotation steps; palettes (outfits,
  car colours, cop cap) are part of the sprite key, walk cycles are frames.
- **Chunked ground** (`ground.ts`) — tiles bake into cached 128px chunks
  with asphalt speckle, lane paint, kerbs, slab seams, cracks, grass dither
  and manholes; every mark hashes off (seed, tile), so all clients agree.
- **Fake-3D buildings** (`buildings.ts`) — GTA2-style perspective extrusion:
  roofs shear away from the screen centre, walls occlude entities behind
  them, roof furniture / helipads / seams hash per building. At night a
  third of the windows glow.
- **Lighting** (`lighting.ts`) — a day/night cycle derived from the server
  tick (shared by every client for free), with a lightmap punched by street
  lamps, shop signs, headlight cones and muzzle flashes.
- **Weather** (`weather.ts`) — deterministic per-day forecast; rain rolls in
  smoothly, darkens the sky and splashes on the ground.
- **Particles + decals** (`particles.ts`, `decals.ts`) — pooled sparks,
  smoke, blood, debris, exhaust; ring-buffered skid marks and stains.
- **Camera** (`camera.ts`) — smoothed follow with velocity look-ahead and
  trauma-based shake (honours `prefers-reduced-motion`).
- **HUD + minimap** (`hud.ts`, `minimap.ts`, `post.ts`) — ghost-damage
  health bar, weapon glyphs, kill feed, wanted stars, a baked city minimap
  with live blips, vignette and hit flashes.

Query params: `?gfx=low` disables lighting/particles/weather;
`?tod=day|night|dusk` pins the clock for screenshots and debugging.

See `PLAN.md` for the architecture and `PROGRESS.md` for the per-phase log.
