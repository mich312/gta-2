# iteration 6 — the D1 flood was not the lever, and what was

Everything here is measured against the bake at `ffb2e89` (iteration 5's close)
on one side and this iteration's on the other. `pnpm build` first: the scripts
read `shared/dist`, the same decoder `mapaudit` uses.

Retake the "before" side of any script with

```bash
git show ffb2e89:shared/src/world/city.data.ts > /tmp/before.city.data.ts
CITY_DATA=/tmp/before.city.data.ts node evidence/iter5/crop.mjs 424,296,558,318
node server/dist/tools/mapAudit.js --data=/tmp/before.city.data.ts
LABEL=before node evidence/iter5/measure-reachability.mjs /tmp/before.city.data.ts
```

## the picture

| | |
|---|---|
| `spine-edge-before.png` / `spine-edge-after.png` | The Spine's southern edge, `node server/dist/tools/mapgen.js --crop=424,290,140,40`. Before: seven street stubs poke out of the bottom of downtown into a meadow. After: a street runs across their feet and the grid closes. |
| `crop-spine-edge-before.txt` / `crop-spine-edge-after.txt` | the same ground as tiles, `node evidence/iter5/crop.mjs 424,296,558,318`. |

## the measurements that decided it

`probe-attribute.mjs`, `probe-passmap.mjs` and `probe-deadends.mjs` need a hook
that is **not** in the shipped tree — the pass loop in
`shared/src/world/layout.ts` has to call
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

| file | what it answers |
|---|---|
| `probe-attribute.mjs` / `.txt` | for the regions `lanes-serving-nothing` **actually flags** — mapAudit's own connected components of land outside every polygon, not a bounding box round them — which pass laid every carriageway tile, and what removing each pass would leave. This is the measurement that rules road removal out for both regions. |
| `probe-deadends.mjs` / `.txt` | the nine `road-deadend` sites one at a time: pass, owner, fabric, `polyBounds`, whether the cap is inside its own polygon, and its `claimDepth`. |
| `probe-passmap.mjs` / `passmap-regionB.txt` | one letter per carriageway tile, the pass that laid it. Region B's 767 authored tiles are The Ring's two carriageways and the Old Bridge. |
| `probe-region.mjs` / `region-a-poly.txt`, `region-a-owner.txt`, `region-b-poly.txt` | the two regions drawn: what is inside a polygon, and who the D1 flood gave the rest to. No hook needed. |
| `probe-town-reach.mjs` / `probe-town-reach-24.txt` | the cost of the other direction — if the block cut clipped to owner-within-`CLAIM_REACH` instead of `polyBounds`, how much ground changes hands. 12,782 tiles, over sixteen boroughs including three rural parishes and two parks. No hook needed. |
| `probe-lane-picker.mjs` / `-before.txt`, `-after.txt` | why `shared/test/prediction.test.ts` broke: `drivableLane` picked its lane on a **spawn displacement**, not on driving. Same signature on both bakes. No hook needed. |

## the outputs, as taken

`mapaudit-before.txt` / `mapaudit-after.txt` (55 → 49 findings; `road-deadend`
9 → 4, `road-width-jump` 1 → 0, nothing else moved),
`citybake-check-before.txt` / `citybake-check-after.txt` (exit 0, the same six
warnings on both sides), `citybake-bake-after.txt`,
`reachability-before.txt` / `reachability-after.txt` (1 component both sides,
mean landmark-to-landmark 491.6 unchanged to the decimal, 0 unreachable,
+294 carriageway tiles), and
`regression-test-control-before.txt` / `-after.txt` — the new test's control,
six caps on the pre-fix bake and none on this one.
