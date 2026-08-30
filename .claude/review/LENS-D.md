# Lens D — the seams: netcode, persistence, CI, and stale evidence

You have the least-documented lens on purpose: the places where two systems
meet and neither one's doc covers the join.

## Care about

- **Reconnect.** What the session restores and what it quietly drops. Are
  reconnects really exempt from `MAX_PLAYERS`, as the README says?
- **The interest radius.** `INTEREST_RADIUS` (600 px) decides what is sent.
  What breaks for an entity that was outside it and comes back in?
- **Persistence.** `PERSIST_PATH` is SQLite via `node:sqlite`, or a JSON file
  store. Two backends, one contract — do they actually agree? What is written
  on a dirty shutdown?
- **The deploy gate.** `.github/workflows/test.yml` and `deploy.yml`. The
  suite is supposed to block a bad main from shipping. Read both and say
  whether it really does — including `ci/test.mjs`'s known-error filter,
  which suppresses one exact vitest signature and could in principle
  suppress a real failure that happens to carry it.

## The staleness spot-check — do this one, it is cheap and it decays

`evidence/README.md` claims a retake command for nearly every PNG. Pick
**three** entries, run their retake commands, and compare against the
committed picture. An evidence file that no longer matches what its own
command produces is a finding: the project's published record of itself has
drifted from the code.

```bash
node ci/playLocal.mjs
pnpm mapgen --crop=<x>,<y>,<w> --out=evidence/<round>/<name>.png
```

Write retakes to `evidence/<round>/`, never over the committed ones.

## Do not

Do not review sim internals (lens C) or rendering (lens B). You are reviewing
the joins, the operational story, and whether the repo's own record is true.
