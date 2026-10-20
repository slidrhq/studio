import type { Frame } from '@slidr/model';
import { contentArea, slideArea } from '../geometry';
import type { Drawn, Rule } from '../rule';
import { hasPhoto } from '../visual';
import { contentBox } from './coverage';

/** An empty band this share of the content area's height is a dead zone (SPEC 9.1: a quarter). */
export const MAX_BAND = 0.25;
/** The band counts when it is this much deeper than the room above the content: not a centred slide. */
const LOPSIDED = 0.15;
/** What begins below this share of the content area is the foot of the slide, not its content. */
const FOOT = 0.93;

const FOOT_ROLES: ReadonlySet<string> = new Set(['footer', 'slideNumber', 'logo']);

/** The content of a slide between its head and its foot: no footer, slide number or logo. */
function body({ items, drawings }: Drawn, slide: Frame, foot: number): Frame[] {
  const boxes = items.flatMap((item) =>
    item.element.role && FOOT_ROLES.has(item.element.role) ? [] : (contentBox(item, slide) ?? []),
  );
  return [...boxes, ...drawings].filter((box) => box.y < foot);
}

/**
 * L17: an empty band at the bottom of the slide. The coverage rule (L07) measures the box
 * around the content, and a footer at the bottom stretches that box over whatever is empty
 * above it; this rule measures the room between the lowest content and the bottom margin. A
 * quarter of the content area left empty under content that starts at the top is the dead zone
 * the guidelines name. Content that is centred, with as much room above it as below, is a
 * decision, and so is a slide over a photograph.
 *
 * Not one of the rules of SPEC 9.2: ADR-042 found the agent leaving such bands, and nothing
 * measured them.
 */
export const L17: Rule = {
  id: 'L17',
  severity: 'warning',
  agent: false,
  check(ctx) {
    const slide = slideArea(ctx.deck);
    const safe = contentArea(ctx.deck);
    const foot = safe.y + FOOT * safe.h;
    const own = body(ctx, slide, foot);
    if (own.length === 0 || hasPhoto(ctx.background)) return [];
    const boxes = [...own, ...body(ctx.layout, slide, foot)];
    const lowest = Math.max(...boxes.map((box) => box.y + box.h));
    const highest = Math.min(...boxes.map((box) => box.y));
    const below = safe.y + safe.h - lowest;
    const above = Math.max(0, highest - safe.y);
    if (below < MAX_BAND * safe.h || below - above < LOPSIDED * safe.h) return [];
    return [
      {
        elementIds: [],
        message: `The bottom ${Math.round(below)}px of the content area is empty: nothing between y ${Math.round(lowest)} and the bottom margin at ${safe.y + safe.h}, while the content begins ${Math.round(above)}px from the top margin. Spread the content down the slide, enlarge it, or centre it.`,
      },
    ];
  },
};
