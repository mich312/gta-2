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
| Y / U / I / O | buy items while inside a shop (or in its doorway) |
| M | mute / unmute sound |
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

`node:sqlite` needs Node 22.5+ (22.5–22.12 also need `--experimental-sqlite`)
from a build compiled with SQLite support. Where it is missing — the runtime
reports `Unknown builtin module: node:sqlite` — the server no longer fails to
start: it prints a warning and persists to the sibling `.json` file via the
file store instead. Set `PERSIST_PATH=data/persist.json` to choose that
deliberately and silence the warning.

All gameplay numbers live in `shared/data/*.json` (movement, vehicles,
weapons, police, peds, props, economy, worldgen, palette) — restart the
server to apply; clients receive tunables in the welcome message.

## Tooling

```bash
pnpm test                                   # vitest across shared + server
pnpm bots --count=8 --script=brawl --duration=60   # headless multiplayer harness
                                            # scripts: idle|cruise|circle|joyride|brawl|jitter
pnpm mapgen --seed=7                        # render a city to PNG without the game
pnpm sprites                                # regenerate the sprite sheet
pnpm sprites -- --preview=8 --only=car      # + a zoomed contact sheet to eyeball
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
  player with rewind/replay reconciliation, interpolates everything else. The
  world view stays 480×270 world pixels but is drawn into a backing store twice
  that size, and the local player is sampled between simulation ticks so motion
  is continuous at any display rate.

See `PLAN.md` for the architecture, `GRAPHICS.md` for the renderer and art
direction, and `PROGRESS.md` for the per-phase log.
