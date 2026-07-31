import { describe, expect, it } from 'vitest';
import { vehicleShade } from '../src/three/entities.js';

/**
 * An exploded car has to look exploded in 3D.
 *
 * The 2D renderer draws a wreck under a 72% black wash; the 3D one never read
 * `condition` at all, so a burnt-out shell kept its paint at worst 45% darker
 * — a car parked out of the sun rather than one that had blown up. The shade
 * is the whole of the 3D wreck treatment, so it is the thing to pin.
 */
describe('vehicleShade', () => {
  it('chars a wreck far darker than any surviving car', () => {
    const wreck = vehicleShade('wreck', 1);
    // Darker than the worst wear can make a running car...
    expect(wreck).toBeLessThan(vehicleShade('ok', 1) / 2);
    // ...but not black: it still reads as the colour of car it was.
    expect(wreck).toBeGreaterThan(0.1);
  });

  it('leaves running cars on the wear ramp the 2D dents follow', () => {
    expect(vehicleShade('ok', 0)).toBe(1);
    expect(vehicleShade(undefined, 0)).toBe(1);
    expect(vehicleShade('ok', 1)).toBeCloseTo(0.55, 5);
    // Burning is not yet wrecked: the paint is scorched by wear, not by state.
    expect(vehicleShade('burning', 0.5)).toBeCloseTo(vehicleShade('ok', 0.5), 5);
  });
});
