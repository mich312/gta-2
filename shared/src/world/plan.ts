import { DISTRICT_TYPES, LANDMARK_KINDS, type DistrictType, type LandmarkKind } from './types.js';

/**
 * The authored city (WORLDGEN.md §12).
 *
 * There is one city and it was drawn, not rolled. This file is the schema for
 * the drawing: `shared/data/city-plan.json` holds the coastline as a picture,
 * the boroughs as rectangles, the avenues as lines, and every landmark at the
 * spot somebody chose for it. `layout.ts` expands it into tiles and blocks and
 * `bake.ts` freezes the result into `shared/data/city.json`, which is what the
 * game actually loads.
 *
 * Nothing here is sampled from noise and nothing depends on a seed. Two things
 * follow, and they are the whole reason for the change: the map can be looked
 * at and judged as a map — a bad junction is a bad junction, not one seed in
 * forty — and it can be validated ONCE, offline, exhaustively (every borough
 * reachable, every landmark approachable, no street ending in the sea) instead
 * of hoped about at runtime.
 */

/** One rectangle of city, in tiles: `[x, y, w, h]`. */
export type PlanRect = [number, number, number, number];

export interface StreetGrid {
  /** Street pitch in tiles along x (0 = no streets: the rect is one block). */
  pitchX: number;
  pitchY: number;
  /** Carve width of a secondary street. */
  width: number;
}

export interface PlanDistrict {
  name: string;
  borough: string;
  district: DistrictType;
  rect: PlanRect;
  street: StreetGrid;
  /**
   * Open country: lane-scale subdivision, no kerbs, meadow and woodland
   * instead of a block interior. The countryside of a city that has edges —
   * the bottom of the map, where the farm and the airfield are.
   */
  rural: boolean;
}

export interface PlanAvenue {
  name: string;
  /** `h` runs along x at `pos`; `v` runs along y at `pos`. */
  axis: 'h' | 'v';
  pos: number;
  from: number;
  to: number;
  width: number;
}

export interface PlanLandmark {
  kind: LandmarkKind;
  name: string;
  rect: PlanRect;
}

export interface CityPlan {
  name: string;
  /** Tiles per character of the `coast` picture. */
  chunkTiles: number;
  /**
   * The longest water crossing, in tiles, a road will carry a bridge over.
   * Wider than this and the water is sea: the road stops at the quay and the
   * boat is the way across.
   */
  maxBridgeSpan: number;
  /** The coastline, one character per `chunkTiles` square: `~` water, `#` land. */
  coast: string[];
  districts: PlanDistrict[];
  avenues: PlanAvenue[];
  landmarks: PlanLandmark[];
  shopQuota: { gun: number; clothing: number; spray: number };
  /** Minimum distance between two shops of the same kind, in tiles. */
  shopSpacingTiles: number;
  widthTiles: number;
  heightTiles: number;
}

function fail(msg: string): never {
  throw new Error(`city plan: ${msg}`);
}

function int(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${name} must be an integer`);
  return v as number;
}

function rect(v: unknown, name: string): PlanRect {
  if (!Array.isArray(v) || v.length !== 4) fail(`${name} must be [x, y, w, h]`);
  const r = (v as unknown[]).map((n, i) => int(n, `${name}[${i}]`)) as PlanRect;
  if (r[2] <= 0 || r[3] <= 0) fail(`${name} must have positive extent`);
  return r;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} must be a non-empty string`);
  return v as string;
}

export function parseCityPlan(raw: unknown): CityPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const chunkTiles = int(r['chunkTiles'], 'chunkTiles');
  if (chunkTiles <= 0) fail('chunkTiles must be positive');

  const coast = r['coast'];
  if (!Array.isArray(coast) || coast.length === 0) fail('coast must be a non-empty array of rows');
  const rows = coast as string[];
  const cols = (rows[0] as string).length;
  for (const [i, row] of rows.entries()) {
    if (typeof row !== 'string' || row.length !== cols) {
      fail(`coast row ${i} is not ${cols} characters`);
    }
    for (const ch of row) if (ch !== '~' && ch !== '#') fail(`coast row ${i}: unknown glyph '${ch}'`);
  }

  const districts = (r['districts'] as unknown[] | undefined ?? []).map((d, i): PlanDistrict => {
    const o = d as Record<string, unknown>;
    const district = str(o['district'], `districts[${i}].district`) as DistrictType;
    if (!DISTRICT_TYPES.includes(district)) fail(`districts[${i}]: unknown district ${district}`);
    const s = (o['street'] ?? {}) as Record<string, unknown>;
    return {
      name: str(o['name'], `districts[${i}].name`),
      borough: str(o['borough'], `districts[${i}].borough`),
      district,
      rect: rect(o['rect'], `districts[${i}].rect`),
      street: {
        pitchX: int(s['pitchX'], `districts[${i}].street.pitchX`),
        pitchY: int(s['pitchY'], `districts[${i}].street.pitchY`),
        width: int(s['width'], `districts[${i}].street.width`),
      },
      rural: o['rural'] === true,
    };
  });
  if (districts.length === 0) fail('at least one district is required');

  const avenues = (r['avenues'] as unknown[] | undefined ?? []).map((a, i): PlanAvenue => {
    const o = a as Record<string, unknown>;
    const axis = str(o['axis'], `avenues[${i}].axis`);
    if (axis !== 'h' && axis !== 'v') fail(`avenues[${i}].axis must be 'h' or 'v'`);
    return {
      name: str(o['name'], `avenues[${i}].name`),
      axis,
      pos: int(o['pos'], `avenues[${i}].pos`),
      from: int(o['from'], `avenues[${i}].from`),
      to: int(o['to'], `avenues[${i}].to`),
      width: int(o['width'], `avenues[${i}].width`),
    };
  });

  const landmarks = (r['landmarks'] as unknown[] | undefined ?? []).map((l, i): PlanLandmark => {
    const o = l as Record<string, unknown>;
    const kind = str(o['kind'], `landmarks[${i}].kind`) as LandmarkKind;
    if (!LANDMARK_KINDS.includes(kind)) fail(`landmarks[${i}]: unknown kind ${kind}`);
    return { kind, name: str(o['name'], `landmarks[${i}].name`), rect: rect(o['rect'], `landmarks[${i}].rect`) };
  });

  const quota = (r['shopQuota'] ?? {}) as Record<string, unknown>;
  const plan: CityPlan = {
    name: str(r['name'], 'name'),
    chunkTiles,
    maxBridgeSpan: int(r['maxBridgeSpan'], 'maxBridgeSpan'),
    coast: rows,
    districts,
    avenues,
    landmarks,
    shopQuota: {
      gun: int(quota['gun'], 'shopQuota.gun'),
      clothing: int(quota['clothing'], 'shopQuota.clothing'),
      spray: int(quota['spray'], 'shopQuota.spray'),
    },
    shopSpacingTiles: int(r['shopSpacingTiles'], 'shopSpacingTiles'),
    widthTiles: cols * chunkTiles,
    heightTiles: rows.length * chunkTiles,
  };

  for (const d of plan.districts) {
    const [x, y, w, h] = d.rect;
    if (x < 0 || y < 0 || x + w > plan.widthTiles || y + h > plan.heightTiles) {
      fail(`district ${d.name} is outside the map`);
    }
  }
  for (const l of plan.landmarks) {
    const [x, y, w, h] = l.rect;
    if (x < 1 || y < 1 || x + w > plan.widthTiles - 1 || y + h > plan.heightTiles - 1) {
      fail(`landmark ${l.name} is outside the map`);
    }
  }
  return plan;
}
