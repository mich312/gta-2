import {
  type CityMap,
  type FullSnapshot,
  type PlayerState,
  type Vec2,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  T_BUILDING,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_WATER,
  TILE_SIZE,
} from 'shared';
import palette from 'shared/data/palette.json';
import { MINIMAP_SIZE, REMOTE_SHIRTS } from './style.js';
import { shade } from './visualRng.js';

/**
 * City minimap. The base layer is baked once per map: every tile is
 * accumulated into its minimap pixel with a priority vote (road beats
 * sidewalk beats building …) so 1–2 tile roads survive the downscale.
 * Per frame it's one drawImage plus a handful of blips.
 */
export class Minimap {
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;

  constructor(private readonly map: CityMap) {
    this.scale = MINIMAP_SIZE / Math.max(map.widthTiles, map.heightTiles);
    this.base = document.createElement('canvas');
    this.base.width = MINIMAP_SIZE;
    this.base.height = MINIMAP_SIZE;
    const ctx = this.base.getContext('2d');
    if (!ctx) throw new Error('no 2d context for minimap');
    this.bake(ctx);
  }

  private bake(ctx: CanvasRenderingContext2D): void {
    const { map } = this;
    ctx.fillStyle = shade(palette.field, -0.25);
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    // Priority vote per minimap pixel: roads must never vanish.
    const PRI: Record<number, number> = {
      [T_ROAD]: 5,
      [T_SIDEWALK]: 3,
      [T_BUILDING]: 4,
      [T_PARK]: 2,
      [T_LOT]: 1,
      [T_WATER]: 2,
      [T_SAND]: 1,
    };
    const COLOR: Record<number, string> = {
      [T_ROAD]: '#585f6a',
      [T_SIDEWALK]: '#454a52',
      [T_BUILDING]: '#2c3644',
      [T_PARK]: '#2c452f',
      [T_LOT]: '#3c3d36',
      [T_WATER]: '#1e364a',
      [T_SAND]: '#6b6049',
    };
    const winner = new Int8Array(MINIMAP_SIZE * MINIMAP_SIZE).fill(-1);
    const priAt = new Int8Array(MINIMAP_SIZE * MINIMAP_SIZE);
    for (let ty = 0; ty < map.heightTiles; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        const tile = map.tiles[ty * map.widthTiles + tx] as number;
        const pri = PRI[tile] ?? 0;
        const mx = Math.min(MINIMAP_SIZE - 1, Math.floor(tx * this.scale));
        const my = Math.min(MINIMAP_SIZE - 1, Math.floor(ty * this.scale));
        const idx = my * MINIMAP_SIZE + mx;
        if (pri > (priAt[idx] as number)) {
          priAt[idx] = pri;
          winner[idx] = tile;
        }
      }
    }
    for (let my = 0; my < MINIMAP_SIZE; my++) {
      for (let mx = 0; mx < MINIMAP_SIZE; mx++) {
        const tile = winner[my * MINIMAP_SIZE + mx] as number;
        if (tile < 0) continue;
        ctx.fillStyle = COLOR[tile] ?? '#000';
        ctx.fillRect(mx, my, 1, 1);
      }
    }

    // Shops as warm dots so players can navigate to them.
    for (const s of map.shops) {
      ctx.fillStyle = s.kind === 'gun' ? palette.shopGun : palette.shopClothing;
      ctx.fillRect(Math.floor(s.doorX * this.scale), Math.floor(s.doorY * this.scale), 1, 1);
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    me: PlayerState | null,
    snapshot: FullSnapshot | null,
    cam: Vec2,
  ): void {
    const pad = 4;
    const x0 = INTERNAL_WIDTH - MINIMAP_SIZE - pad;
    const y0 = INTERNAL_HEIGHT - MINIMAP_SIZE - pad;

    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(x0 - 2, y0 - 2, MINIMAP_SIZE + 4, MINIMAP_SIZE + 4);
    ctx.drawImage(this.base, x0, y0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(190, 205, 220, 0.35)';
    ctx.strokeRect(x0 - 1.5, y0 - 1.5, MINIMAP_SIZE + 3, MINIMAP_SIZE + 3);

    const toMap = (wx: number, wy: number): [number, number] => [
      x0 + Math.min(MINIMAP_SIZE - 1, Math.max(0, (wx / TILE_SIZE) * this.scale)),
      y0 + Math.min(MINIMAP_SIZE - 1, Math.max(0, (wy / TILE_SIZE) * this.scale)),
    ];

    // Viewport rectangle.
    const [vx, vy] = toMap(cam.x, cam.y);
    const vw = (INTERNAL_WIDTH / TILE_SIZE) * this.scale;
    const vh = (INTERNAL_HEIGHT / TILE_SIZE) * this.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.strokeRect(vx + 0.5, vy + 0.5, vw, vh);

    if (snapshot) {
      for (const p of snapshot.players) {
        if (me && p.id === me.id) continue;
        const [bx, by] = toMap(p.pos.x, p.pos.y);
        ctx.fillStyle = REMOTE_SHIRTS[p.id % REMOTE_SHIRTS.length] as string;
        ctx.fillRect(Math.floor(bx), Math.floor(by), 2, 2);
      }
      // Cops appear when someone is hot — a radar, not a wallhack for peds.
      for (const c of snapshot.cops) {
        const [bx, by] = toMap(c.pos.x, c.pos.y);
        ctx.fillStyle = '#4d7fe0';
        ctx.fillRect(Math.floor(bx), Math.floor(by), 1, 1);
      }
    }
    if (me) {
      const [bx, by] = toMap(me.pos.x, me.pos.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.floor(bx) - 1, Math.floor(by) - 1, 3, 3);
      ctx.fillStyle = '#101418';
      ctx.fillRect(Math.floor(bx), Math.floor(by), 1, 1);
    }
    ctx.restore();
  }
}
