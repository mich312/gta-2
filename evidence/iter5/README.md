# iteration 5 — `lanes-serving-nothing`, and what is really laying them

Everything here is measured on the plan at `7769a2c`. `pnpm build` first: the
scripts read `shared/dist`, the same decoder `mapaudit` uses.

## the fix, and the picture of it

| | |
|---|---|
| `shoulder-before.png` / `shoulder-after.png` | the strait shoulder, `pnpm mapgen --crop=270,315,105`. Before: a promenade traced round an empty peninsula. After: gone. The Ring and the Old Bridge, which are 52.5% of that region's tarmac, are untouched. |
| `crop-shoulder-before.txt` / `crop-shoulder-after.txt` | the same ground as tiles — `node evidence/iter5/crop.mjs 265,315,370,360`, with `CITY_DATA=` pointing at the old asset for the before. |

Retake the before with

```bash
git show 7769a2c:shared/src/world/city.data.ts > /tmp/before.city.data.ts
CITY_DATA=/tmp/before.city.data.ts node evidence/iter5/crop.mjs 265,315,370,360
```

## the measurements

| file | what it answers |
|---|---|
| `probe-owner-vs-polygon.mjs` | how far past the authored outlines the D1 ownership flood reaches, and how much carriageway sits at each depth. 27,065 tiles of land outside every polygon, 6,127 of them carriageway, reaching 80 tiles out. |
| `probe-which-pass.mjs` | which PASS lays that carriageway. Needs a temporary hook (below). The answer is the headline: on the headland it is the esplanade (563) and the seam street (343), not the lattice (82). |
| `probe-pass-crop.mjs` | the same, drawn, one letter per pass. |
| `probe-reach.mjs` | every out-of-polygon tile by pass and by how far it stands from its own borough's polygon. The lattice never gets past 24; the esplanade reaches 80. |
| `probe-seam-outside.mjs` | three candidate rules for refusing a seam street, and the town standing beside every run each one would drop. |
| `probe-whole-runs.mjs` | the same question asked a whole run at a time, which is the only unit that does not leave half a road ending in a field. This is the script the `CLAIM_REACH` constant is calibrated against. |
| `measure-reachability.mjs` | components of carriageway and mean landmark-to-landmark travel distance. Run it on both assets. |

`probe-which-pass.mjs`, `probe-pass-crop.mjs`, `probe-reach.mjs`,
`probe-seam-outside.mjs` and `probe-whole-runs.mjs` need a hook that is **not**
in the shipped tree — the pass loop in `shared/src/world/layout.ts` has to call
`globalThis.__LAYOUT_PROBE__?.(pass.name, tiles)` after each pass. Never
`git stash` to put it in and take it out (`.claude/review/FIXER.md`): copy the
file aside, patch, build, measure, copy back.

```ts
  for (const pass of passes) {
    pass();
    const probe = (globalThis as { __LAYOUT_PROBE__?: (n: string, t: Uint8Array) => void })
      .__LAYOUT_PROBE__;
    if (probe !== undefined) probe(pass.name, tiles);
  }
```

## the outputs, as taken

`mapaudit-before.txt` / `mapaudit-after.txt`, `citybake-check-before.txt` /
`citybake-check-after.txt`, `deadends-before.txt` / `deadends-after.txt`
(identical), `reachability-before.txt` / `reachability-after.txt`, and the
probe outputs `probe-*.txt`.
