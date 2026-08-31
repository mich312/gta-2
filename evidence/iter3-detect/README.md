# iter3-detect — three course- and region-shaped signatures

`pnpm mapaudit` grew `course-coverage-outlier`, `street-serves-nothing` and
`lanes-serving-nothing`. The existing 47 findings are byte-identical before
and after (`before-findings.txt` vs `after-old-findings.txt`).

## Retakes

```bash
# the runs
node server/dist/tools/mapAudit.js --all                       # after-all.txt
node server/dist/tools/mapAudit.js --selftest                  # selftest-after.txt
git show 1469611:shared/src/world/city.data.ts > /tmp/old.city.data.ts
node server/dist/tools/mapAudit.js --data=/tmp/old.city.data.ts --summary   # calib-1469611-after.txt
node server/dist/tools/citybake.js --check                     # citybake-check.txt

# course-coverage-outlier: the two boroughs with almost no centrelines
node server/dist/tools/mapgen.js --crop=430,150,90 --scale=10 --out=evidence/iter3-detect/coverage-spine-430-150.png
node server/dist/tools/mapgen.js --crop=250,520,90 --scale=10 --out=evidence/iter3-detect/coverage-oldsuburbs-250-520.png

# street-serves-nothing: all four hits, two right and two wrong
node server/dist/tools/mapgen.js --crop=453,351,32 --scale=16 --out=evidence/iter3-detect/serves-islet-469-361.png
node server/dist/tools/mapgen.js --crop=70,490,32  --scale=16 --out=evidence/iter3-detect/serves-spit-80-505.png
node server/dist/tools/mapgen.js --crop=645,142,40 --scale=16 --out=evidence/iter3-detect/serves-coast-669-153.png
node server/dist/tools/mapgen.js --crop=687,271,40 --scale=16 --out=evidence/iter3-detect/serves-coast-711-282.png

# lanes-serving-nothing: both hits
node server/dist/tools/mapgen.js --crop=383,250,177 --scale=6  --out=evidence/iter3-detect/lanes-headland-393-312.png
node server/dist/tools/mapgen.js --crop=440,310,110 --scale=10 --out=evidence/iter3-detect/lanes-headland-zoom.png
node server/dist/tools/mapgen.js --crop=260,305,110 --scale=10 --out=evidence/iter3-detect/lanes-westbank-267-312.png
```

## What the pictures say

| picture | verdict |
| --- | --- |
| `coverage-spine-430-150.png` | one avenue and one diagonal carry kerb casing and marks; every other street in the downtown grid is bare tarmac. 3 courses in a 9,601-tile borough. **true** |
| `coverage-oldsuburbs-250-520.png` | the ring and one diagonal are treated, the whole local grid is not. 4 courses in 6,129 tiles. **true** |
| `serves-islet-469-361.png` | a lozenge of tarmac with a rounded cap at each end, on the islet, entered sideways off Kelvin Bridge. **true** — the signature's control |
| `serves-spit-80-505.png` | a capped cross-bar at the tip of the spit, joined only at mid-span. **true** |
| `serves-coast-669-153.png` | an ordinary diagonal street with houses on both sides; the course was trimmed at the quay, the street was not. **false** |
| `serves-coast-711-282.png` | same shape, coastal grid street. **false** |
| `lanes-headland-393-312.png`, `lanes-headland-zoom.png` | a wide unmarked arterial curving across an empty headland, 1,197 road tiles, no building anywhere on it. **true** |
| `lanes-westbank-267-312.png` | a fan of cul-de-sac bulbs poking into empty un-districted ground, 41.5% road and 10 built tiles. **true**, though some of the tarmac is the bridge approaches passing through |

So: `course-coverage-outlier` 0/2 false, `lanes-serving-nothing` 0/2 false,
`street-serves-nothing` 2/4 false — which is why that one ships `noisy`.
