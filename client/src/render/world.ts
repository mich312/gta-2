import {
  type CityMap,
  type Vec2,
  DISTRICT_TYPES,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SIDEWALK,
  TILE_SIZE,
} from 'shared';
import palette from 'shared/data/palette.json';

const BASE_COLORS: Record<number, string> = {
  [T_FIELD]: palette.field,
  [T_ROAD]: palette.road,
  [T_SIDEWALK]: palette.sidewalk,
  [T_PARK]: palette.park,
  [T_LOT]: palette.lot,
};

/** Draw the visible slice of the city's tile layer. */
export function drawWorld(ctx: CanvasRenderingContext2D, map: CityMap, cam: Vec2): void {
  const tx1 = Math.max(0, Math.floor(cam.x / TILE_SIZE));
  const ty1 = Math.max(0, Math.floor(cam.y / TILE_SIZE));
  const tx2 = Math.min(map.widthTiles - 1, Math.floor((cam.x + INTERNAL_WIDTH) / TILE_SIZE));
  const ty2 = Math.min(map.heightTiles - 1, Math.floor((cam.y + INTERNAL_HEIGHT) / TILE_SIZE));

  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      const tile = map.tiles[ty * map.widthTiles + tx] as number;
      const sx = tx * TILE_SIZE - cam.x;
      const sy = ty * TILE_SIZE - cam.y;
      if (tile === T_BUILDING) {
        const d = DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number] as string;
        ctx.fillStyle =
          (palette.building as Record<string, string>)[d] ?? palette.building.downtown;
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        // Cheap depth cue: darker edge where the building meets open ground.
        const below =
          ty + 1 < map.heightTiles ? (map.tiles[(ty + 1) * map.widthTiles + tx] as number) : -1;
        if (below !== T_BUILDING) {
          ctx.fillStyle =
            (palette.buildingEdge as Record<string, string>)[d] ?? palette.buildingEdge.downtown;
          ctx.fillRect(sx, sy + TILE_SIZE - 3, TILE_SIZE, 3);
        }
      } else {
        ctx.fillStyle = BASE_COLORS[tile] ?? '#ff00ff';
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        if (tile === T_ROAD && (tx + ty) % 4 === 0) {
          // Sparse lane texture so driving reads speed later.
          ctx.fillStyle = palette.roadMark;
          ctx.fillRect(sx + 7, sy + 7, 2, 2);
        }
      }
    }
  }

  // Shop doorways: bright zone tiles + a sign block on the building.
  for (const s of map.shops) {
    const sx = s.doorX * TILE_SIZE - cam.x;
    const sy = s.doorY * TILE_SIZE - cam.y;
    if (sx < -TILE_SIZE || sy < -TILE_SIZE || sx > INTERNAL_WIDTH || sy > INTERNAL_HEIGHT) continue;
    ctx.fillStyle = s.kind === 'gun' ? palette.shopGun : palette.shopClothing;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
    ctx.globalAlpha = 1;
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s.kind === 'gun' ? 'GUNS' : 'WEAR', sx + TILE_SIZE / 2, sy - 2);
    ctx.textAlign = 'left';
  }
}
