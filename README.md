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

Open http://localhost:5173 in as many tabs as you like (4–8 players). The game
fills the browser window: the world view grows with it, at a zoom that keeps
the art on whole pixels.

| Query parameter | Effect |
| --- | --- |
| `?local=1` | **no server**: run the whole game in a Web Worker in this tab. `?seed=`, `?peds=`, `?roam=0`, `?interest=`, `?proving=1`, `?difficulty=` are the offline equivalents of the server's environment variables |
| `?server=ws://host:port` | connect elsewhere (default `ws://<hostname>:8080`) |
| `?night=0..1` | force the hour, 0 midday to 1 midnight. A day is 24 minutes long, so this is the only practical way to look at the night lighting |
| `?lights=cheap` | keep the grade and the lamps, drop the shadow casting and the bloom |
| `?lights=off` | no lighting pass at all |

### Controls

| Input | Action |
| --- | --- |
| WASD / arrows | walk (screen-relative: up goes up), drive (up=throttle, down=brake/reverse, left/right=steer) |
| Mouse | aim; click or Space to fire, on foot or out of a car window |
| E / Enter | enter/exit car, context action |
| F | use the car's fitting: fire the guns, drop a mine or slick, arm the bomb |
| 1–8 | switch weapon slot |
| Y U I O H J N P | buy items while inside a shop (or in its doorway) — guns, clothes, resprays, car fittings, hospital treatment |
| R / G | answer a ringing payphone / walk away from the job |
| M | mute / unmute sound |
| L / K | log in / register (optional — guests always play) |
| ` (backquote) | debug overlay: tick, RTT, bandwidth, hitboxes (including the oriented box a car really collides with), prediction ghost |

### Server environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | WebSocket bind |
| `SEED` | random | city + session seed |
| `WEAPONS_LOST_ON_DEATH` | `true` | death costs your guns (design flag) |
| `PED_COUNT` | `200` | pedestrians per session |
| `ROAM` | `1` | the window follows the players — the world is infinite in all directions (`0` pins it) |
| `INTEREST_RADIUS` | `600` | px; entities beyond it aren't sent |
| `PERSIST_PATH` | `data/persist.db` | SQLite (node:sqlite); `.json` = file store |
| `DIFFICULTY` | `normal` | police preset: `relaxed`, `normal` or `hard` (`police.json` → `presets`). Server-side: in a shared city a per-player difficulty is a cheat |
| `PROVING_GROUND` | unset | `1` adds a debug room by the spawn that hands out vehicles and kit for nothing. **Free-cars room — off unless you ask** |
| `REPLAY` / `REPLAY_DIR` | on / `replays` | input recording (`REPLAY=0` off) |

### Testing a physics change

```bash
PROVING_GROUND=1 node server/dist/index.js
```

You spawn on the doorstep of a proving ground: walk in and the shop keys
(`Y U I O H J N P`) hand over a tank, a car, six cars laid out in a row to
drive down, a bus, a truck, every weapon, full health, and $10,000 — free, and
with no ledger, standings or district in the way. Green on the minimap.

Turning it on changes nothing about the city: the same seed gives the same
streets, buildings, parked cars, props and pickups with the room and without
it, so a bug you find with it open is still there when you close it. The one
thing it does change is where you start, which is the point. Everything it
hands out arrives as an ordinary `SimCommand`, so the session still records and
replays like any other.

`node:sqlite` needs Node 22.5+ (22.5–22.12 also need `--experimental-sqlite`)
from a build compiled with SQLite support. Where it is missing — the runtime
reports `Unknown builtin module: node:sqlite` — the server no longer fails to
start: it prints a warning and persists to the sibling `.json` file via the
file store instead. Set `PERSIST_PATH=data/persist.json` to choose that
deliberately and silence the warning.

Every kind of vehicle can be found somewhere: an ambulance at a hospital, a
digger at the quarry, a pickup at the farm, the tank behind a police station.
Those homes are marked on the minimap, and there is a test that walks the
whole roster rather than spot-checking it.

All gameplay numbers live in `shared/data/*.json` (movement, vehicles,
weapons, police, peds, ambulance, props, economy, fittings, worldgen, palette)
— restart the server to apply; clients receive tunables in the welcome message.

## Tooling

```bash
pnpm test                                   # vitest across shared + server
pnpm bots --count=8 --script=brawl --duration=60   # headless multiplayer harness
                                            # scripts: idle|cruise|circle|joyride|brawl|jitter
pnpm mapgen --seed=7                        # render a city to PNG without the game
pnpm chase                                  # the chase bench: escape rate + survival time
                                            #   per star level, over several seeds
pnpm sprites                                # regenerate the sprite sheet
pnpm sprites -- --preview=8 --only=car      # + a zoomed contact sheet to eyeball
pnpm replay replays/<file>.jsonl            # re-simulate a recording, verify hashes
node server/dist/tools/persistCheck.js      # e2e: purchase survives server restart
pnpm parity [seed] [ticks]                  # the same sim in Node and in a browser,
                                            #   tick for tick (needs the client dev
                                            #   server up; see `?local=1` above)
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
  player with rewind/replay reconciliation, interpolates everything else. The
  world view is sized to the browser window (480×270 world pixels at 1080p, up
  to a 700×400 ceiling) and drawn into a backing store twice that size, and the
  local player is sampled between simulation ticks so motion is continuous at
  any display rate. Lights are shadow-cast against the tile grid — a lamp lights
  its own street and not the block behind it.

See `PLAN.md` for the architecture, `GRAPHICS.md` for the renderer and art
direction, and `PROGRESS.md` for the per-phase log. `GTA.md`, `GAPS.md`,
`FEATURES.md` and `ROADMAP.md` are the feature backlogs, all of them now
delivered. `SHIP.md` is the current forward plan — not more systems, but what
it would take to turn this into a game somebody buys.
