/**
 * The geometry half of the parallax extrusion, with no canvas in sight.
 *
 * Separated so it can be tested. The direction a building leans and which of
 * its walls that exposes are exactly the kind of thing that looks plausible in
 * a screenshot while being inside out — the first version of this drew every
 * wall on the side the roof had just covered, which is invisible, and shaded
 * both of them by the wrong normal. Neither was obvious by eye at 1.6 px a
 * storey. Both are one assertion each here.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Quad {
  /** Flat [x0,y0, x1,y1, x2,y2, x3,y3]. */
  pts: number[];
  /** Outward normal of the exposed face, one of -1/0/1 per axis. */
  nx: number;
  ny: number;
}

export interface Extrusion {
  /** The mass at ground level: the footprint, unmoved. */
  base: Rect;
  /** The footprint displaced by the parallax lift. */
  roof: Rect;
  /** The walls the displacement exposes: 0, 1 or 2 of them. */
  faces: Quad[];
  dx: number;
  dy: number;
}

/**
 * Where a building's roof lands, and which walls that reveals.
 *
 * `base` is in device pixels. `offX/offY` are how far the roof is displaced —
 * away from the screen centre, in proportion to height, computed by the
 * caller because it owns the camera.
 *
 * The exposed wall is on the edge the roof moved *away from*: a roof
 * displaced left uncovers the strip at the base's right edge. The face's
 * outward normal therefore points against the displacement, which is what
 * decides whether it catches the sun.
 */
export function extrusionOf(base: Rect, offX: number, offY: number): Extrusion {
  const dx = Math.round(offX);
  const dy = Math.round(offY);
  const x0 = base.x;
  const y0 = base.y;
  const x1 = base.x + base.w;
  const y1 = base.y + base.h;

  const faces: Quad[] = [];
  if (dx !== 0) {
    const edge = dx > 0 ? x0 : x1;
    faces.push({
      pts: [edge, y0, edge, y1, edge + dx, y1 + dy, edge + dx, y0 + dy],
      nx: dx > 0 ? -1 : 1,
      ny: 0,
    });
  }
  if (dy !== 0) {
    const edge = dy > 0 ? y0 : y1;
    faces.push({
      pts: [x0, edge, x1, edge, x1 + dx, edge + dy, x0 + dx, edge + dy],
      nx: 0,
      ny: dy > 0 ? -1 : 1,
    });
  }

  return {
    base,
    roof: { x: x0 + dx, y: y0 + dy, w: base.w, h: base.h },
    faces,
    dx,
    dy,
  };
}

/**
 * How far a building's roof is displaced, in world px.
 *
 * Normalised against the half-extents of the view so a building at the screen
 * edge leans by its full height and one directly under the camera does not
 * lean at all. That normalisation is what makes the camera read as being
 * above the city rather than in front of a painting of it — and it is also
 * what stops the effect depending on the size of the player's window.
 */
export function parallaxOffset(
  buildingCentreX: number,
  buildingCentreY: number,
  camCentreX: number,
  camCentreY: number,
  halfW: number,
  halfH: number,
  lift: number,
): { x: number; y: number } {
  return {
    x: ((buildingCentreX - camCentreX) / halfW) * lift,
    y: ((buildingCentreY - camCentreY) / halfH) * lift,
  };
}

/**
 * The same extrusion for a mass that is not square to the world (§20).
 *
 * `corners` is the rotated footprint in device pixels, clockwise. Every edge
 * whose outward normal opposes the displacement is exposed — for a square
 * base that is the one or two `extrusionOf` finds, and for a turned one it is
 * whichever two of the four now face the way the roof moved away from. The
 * normal comes off the edge rather than off the axis, so the sun test the
 * caller does is unchanged.
 */
export function rotatedExtrusionOf(
  corners: ReadonlyArray<readonly [number, number]>,
  offX: number,
  offY: number,
): { faces: Quad[]; dx: number; dy: number } {
  const dx = Math.round(offX);
  const dy = Math.round(offY);
  const faces: Quad[] = [];
  if (dx === 0 && dy === 0) return { faces, dx, dy };
  for (let i = 0; i < corners.length; i++) {
    const [ax, ay] = corners[i] as readonly [number, number];
    const [bx, by] = corners[(i + 1) % corners.length] as readonly [number, number];
    // Clockwise winding on screen (y down) puts the outward normal a quarter
    // turn anticlockwise from the edge direction.
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;
    // Exposed only if the roof moved away from this face.
    if (nx * dx + ny * dy >= 0) continue;
    faces.push({
      pts: [ax, ay, bx, by, bx + dx, by + dy, ax + dx, ay + dy],
      nx,
      ny,
    });
  }
  return { faces, dx, dy };
}
