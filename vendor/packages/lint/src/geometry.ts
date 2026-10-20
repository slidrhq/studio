import type { Deck, Frame } from '@slidr/model';

/** Safe margins of the design guidelines (SPEC 9.1): 96px at the sides, 80px above and below. */
export const SAFE_MARGIN = { x: 96, y: 80 };

/** Rendering lands on fractions of a pixel; a box may be this far out before it counts. */
export const SLACK = 1;

export function slideArea(deck: Deck): Frame {
  return { x: 0, y: 0, w: deck.size.w, h: deck.size.h };
}

/** The slide inside its safe margins: 1728x920 on a 1920x1080 slide. */
export function contentArea(deck: Deck): Frame {
  return {
    x: SAFE_MARGIN.x,
    y: SAFE_MARGIN.y,
    w: deck.size.w - 2 * SAFE_MARGIN.x,
    h: deck.size.h - 2 * SAFE_MARGIN.y,
  };
}

export function area(box: Frame): number {
  return box.w * box.h;
}

/** The part two boxes share; undefined when they are apart. Boxes that only touch share nothing. */
export function intersection(a: Frame, b: Frame): Frame | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

export interface Sides {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far a box reaches past each side of an area; 0 on the sides where it stays inside. */
export function excess(box: Frame, within: Frame): Sides {
  return {
    left: Math.max(0, within.x - box.x),
    top: Math.max(0, within.y - box.y),
    right: Math.max(0, box.x + box.w - (within.x + within.w)),
    bottom: Math.max(0, box.y + box.h - (within.y + within.h)),
  };
}

/** Whether a box stays inside an area, give or take the slack. */
export function fitsIn(box: Frame, within: Frame): boolean {
  return Object.values(excess(box, within)).every((v) => v <= SLACK);
}

/** Whether nothing of a box is inside an area. */
export function isOutside(box: Frame, within: Frame): boolean {
  // A horizontal line has no height and still shows.
  const w = Math.max(box.w, 1);
  const h = Math.max(box.h, 1);
  return (
    box.x >= within.x + within.w ||
    box.x + w <= within.x ||
    box.y >= within.y + within.h ||
    box.y + h <= within.y
  );
}

/** "34px past the right edge and 12px past the bottom edge", for the sides a box is out on. */
export function describeExcess(sides: Sides): string {
  const parts = (['left', 'top', 'right', 'bottom'] as const)
    .filter((side) => sides[side] > SLACK)
    .map((side) => `${Math.round(sides[side])}px past the ${side} edge`);
  return parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    : (parts[0] ?? '');
}

/** "x 160..900, y 140..500": where a box is, for a message. */
export function describeBox(box: Frame): string {
  const n = Math.round;
  return `x ${n(box.x)}..${n(box.x + box.w)}, y ${n(box.y)}..${n(box.y + box.h)}`;
}
