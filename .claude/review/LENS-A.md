# Lens A — worldgen and the map

Read `WORLDGEN.md` before anything else — it is 260 KB and the largest single
record of intent in the repo. Skim its table of contents, then read the
sections bearing on what you look at.

The city is **authored**, not generated: drawn in `shared/data/city-plan.json`,
validated by `plan.ts`, baked offline by `pnpm citybake`, shipped as bytes in
`city.data.ts`, decoded identically on every host. There is one city and it is
the same one every time.

## Look at it

```bash
pnpm mapgen                          # the whole city
pnpm mapgen --crop=<x>,<y>,<w>       # anywhere suspicious, close up
pnpm mapgen --sheet                  # the contact sheet
pnpm mapgen --net --crop=<x>,<y>,<w> # the road network as a graph
```

Write renders to `evidence/<round>/`, never over the published ones.

## Care about

- The bake's repair-vs-refuse rules: what it silently fixes that it should
  refuse, and what it refuses that it could fix (`bake.ts`).
- Whether the shipped `city.data.ts` actually passes `checkCity` — and whether
  anything in the test suite asserts that, or only the tools do.
- Coastline, cliff and shore correctness: the vector coast, the bevel pass,
  the staircase cuts (§15.4).
- Street network connectivity and the land-use ladder — the invariants
  `shared/test/city.test.ts` claims to hold, and whether it really holds them.
- The authoring path: does a bad plan fail at authoring time with a message
  that names the fix, as `plan.ts` intends?

## Do not

Do not review the 3D rendering of the map — that is lens B. Your subject is
the plan, the bake, the shipped bytes, and the top-down render that shows
them.
