import type { Frame, Point } from './schema';

/** Brings an angle into [0, 360). */
export function normalizeAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function frameCenter(frame: Frame): Point {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

/** Cosine and sine of an angle in degrees, exact at the quarter turns (cos 90° is 6e-17 otherwise). */
function cosSin(degrees: number): [number, number] {
  const rad = (degrees * Math.PI) / 180;
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [snap(Math.cos(rad)), snap(Math.sin(rad))];
}

/** Rotates a vector clockwise (y points down, as on the slide). */
export function rotateVector(v: Point, degrees: number): Point {
  const [cos, sin] = cosSin(degrees);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/** The axis-aligned box that contains a frame after it is rotated around its centre. */
export function rotatedBounds(frame: Frame, rotation: number): Frame {
  if (normalizeAngle(rotation) === 0) return { ...frame };
  const [cos, sin] = cosSin(rotation).map(Math.abs) as [number, number];
  const w = frame.w * cos + frame.h * sin;
  const h = frame.w * sin + frame.h * cos;
  const c = frameCenter(frame);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** The smallest box that contains all the given boxes. */
export function unionBounds(boxes: readonly Frame[]): Frame {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.w);
    bottom = Math.max(bottom, b.y + b.h);
  }
  if (left === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: left, y: top, w: right - left, h: bottom - top };
}
