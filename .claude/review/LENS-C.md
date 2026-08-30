# Lens C — the simulation: physics, damage, car AI, police

Read `CAR-AI.md` and `DAMAGE.md` first, and `FEATURES.md` for what the game
claims to do.

The simulation is deterministic and shared: `shared/src/sim` runs on the
authoritative Node server and, predicted, in the browser. The server is the
authority; the client predicts. Anything the client can assert that the server
does not check is a defect, not a feature.

## Exercise it

```bash
pnpm parity            # ci/hostParity.mjs — the hosts agreeing
pnpm chase             # escape rate per star level, over several seeds
pnpm bots              # the bot harness
pnpm replay            # replay a recorded session
PROVING_GROUND=1 node server/dist/index.js   # free cars and kit, for physics
```

`pnpm chase` and `pnpm parity` produce numbers. A number that contradicts a
claim in the docs is a first-class finding.

## Care about

- **Determinism holes.** Anything in the shared sim that reads wall-clock
  time, unordered iteration, floating-point that differs by host, or an RNG
  stream not drawn from the seeded generator.
- **Trust boundaries.** What a crafted `SimCommand` can do. What the server
  takes on faith from the client.
- Physics a player can break: collision escape, geometry tunnelling, speeds
  or forces with no bound.
- Tuning that contradicts its own stated intent (`tuning.ts`, `police.json`
  presets, the difficulty presets).
- The economy and persistence ledger: what can go negative, what can be
  duplicated, what survives a reconnect that should not.

## Do not

Do not review rendering. If a bug is only visible and not simulated, it
belongs to lens B.
