import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, hexToRgb } from './png.js';

/**
 * Placeholder sprite-sheet generator: emits client/public/sprites.png (+ a
 * frame map JSON) from palette + shape descriptors. Art never blocks — a new
 * sprite is a JSON edit, and real pixel art can replace the sheet later
 * without touching code. Sprites face +x (right) and are rotated at draw time.
 */

interface Shape {
  rect?: [number, number, number, number];
  disc?: [number, number, number];
  color: string;
}
interface SpriteDef {
  w: number;
  h: number;
  shapes: Shape[];
}

function main(): void {
  const palette = JSON.parse(
    readFileSync(new URL(import.meta.resolve('shared/data/palette.json')), 'utf8'),
  ) as Record<string, unknown>;
  const defs = (
    JSON.parse(
      readFileSync(new URL(import.meta.resolve('shared/data/sprites.json')), 'utf8'),
    ) as { sprites: Record<string, SpriteDef> }
  ).sprites;

  const resolveColor = (c: string): [number, number, number] => {
    if (c.startsWith('#')) return hexToRgb(c);
    const v = palette[c];
    if (typeof v !== 'string') throw new Error(`sprite color '${c}' not in palette`);
    return hexToRgb(v);
  };

  const names = Object.keys(defs).sort();
  const sheetW = names.reduce((w, n) => w + (defs[n] as SpriteDef).w + 1, 0);
  const sheetH = names.reduce((h, n) => Math.max(h, (defs[n] as SpriteDef).h), 0);
  const rgba = new Uint8Array(sheetW * sheetH * 4); // transparent

  const frames: Record<string, { x: number; y: number; w: number; h: number }> = {};
  let cursor = 0;
  for (const name of names) {
    const def = defs[name] as SpriteDef;
    frames[name] = { x: cursor, y: 0, w: def.w, h: def.h };
    for (const shape of def.shapes) {
      const [r, g, b] = resolveColor(shape.color);
      const put = (x: number, y: number): void => {
        if (x < 0 || y < 0 || x >= def.w || y >= def.h) return;
        const i = (y * sheetW + cursor + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      };
      if (shape.rect) {
        const [x, y, w, h] = shape.rect;
        for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put(px, py);
      } else if (shape.disc) {
        const [cx, cy, rad] = shape.disc;
        for (let py = cy - rad; py <= cy + rad; py++) {
          for (let px = cx - rad; px <= cx + rad; px++) {
            const dx = px - cx;
            const dy = py - cy;
            if (dx * dx + dy * dy <= rad * rad) put(px, py);
          }
        }
      }
    }
    cursor += def.w + 1;
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../client/public');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'sprites.png'), encodePng(sheetW, sheetH, rgba));
  writeFileSync(join(outDir, 'sprites.meta.json'), JSON.stringify(frames, null, 2));
  console.log(`sprites: ${names.join(', ')} -> client/public/sprites.png (${sheetW}x${sheetH})`);
}

main();
