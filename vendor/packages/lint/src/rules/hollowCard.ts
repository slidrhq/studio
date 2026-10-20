import {
  walkElements,
  type Deck,
  type Element,
  type Frame,
  type GroupElement,
  type Slide,
} from '@slidr/model';
import { area, fitsIn, slideArea } from '../geometry';
import type { Item, Rule } from '../rule';
import { isMeaningfulShape } from '../visual';
import { contentBox } from './coverage';

/** A card may leave this share of its height empty beyond its padding (ADR-099). */
export const MAX_EMPTY = 0.2;
/** Less room than this is a generous padding, not an empty card. */
export const MIN_EMPTY = 120;
/** The most padding one end of a card counts: more than this is room the content left. */
export const MAX_PADDING = 96;
/** A box this close to an edge of the slide is a colour field that bleeds, not a card. */
const EDGE = 24;
/** The box of a card covers this much of its group: a badge may stand out over its edge. */
const BASE = 0.9;

const BOXES: ReadonlySet<string> = new Set(['rect', 'roundRect']);

/**
 * The box of a card (ADR-073): the bottom element of a group, a rectangle that is drawn and is a
 * visual of its own (not a bar, not a background panel), upright, clear of the slide's edges,
 * not a picture, and as large as the group, give or take a badge over its edge. Rectangles that
 * are not grouped with what lies on them are the parts of a drawing (the bars of a chart, the
 * columns of a schedule) and are not judged.
 */
function isBox(
  item: Item,
  group: GroupElement,
  slide: Frame,
  turned: ReadonlySet<string>,
): boolean {
  const { element, measure } = item;
  if (element.type !== 'shape' || element.rotation !== 0 || turned.has(element.id)) return false;
  if (element.geometry.kind !== 'preset' || !BOXES.has(element.geometry.preset)) return false;
  if (element.fill.kind === 'image' || !isMeaningfulShape(element, slide)) return false;
  if (area(element.frame) < BASE * area(group.frame)) return false;
  return fitsIn(measure.box, { x: EDGE, y: EDGE, w: slide.w - 2 * EDGE, h: slide.h - 2 * EDGE });
}

/**
 * The height of a card its content leaves empty, in pixels: the room above the content and below
 * it, less a padding at each end. The padding is the smaller of the two, at most `MAX_PADDING`:
 * content centred in a card twice its height leaves it as empty as content at its top. The room
 * between the parts of the content does not count: a label at the top of a card and a headline
 * at its foot are a composition, not a remainder.
 */
export function emptyHeight(card: Frame, contents: readonly Frame[]): number {
  const bottom = card.y + card.h;
  const inside = contents.filter((box) => box.y < bottom && box.y + box.h > card.y);
  if (inside.length === 0) return 0;
  const above = Math.max(0, Math.min(...inside.map((box) => box.y)) - card.y);
  const below = Math.max(0, bottom - Math.max(...inside.map((box) => box.y + box.h)));
  return above + below - 2 * Math.min(above, below, MAX_PADDING);
}

/**
 * The ids of the slide's copies of its layout's objects (ADR-094), each named after the slide
 * and its object: the template's drawing, sized for any text the slide may be given.
 */
function layoutCopies(deck: Deck, slide: Slide): Set<string> {
  const layout = slide.layoutId ? deck.layouts.find((l) => l.id === slide.layoutId) : undefined;
  return new Set([...walkElements(layout?.objects ?? [])].map((o) => `${slide.id}_${o.id}`));
}

/**
 * L18: a card taller than what it holds. Stretching cards is the easy way to fill a slide (L07
 * counts a card by its box), and it leaves a dead zone with a border around it: three cards
 * down to the bottom margin, a heading and a sentence at the top of each. A card is a group
 * whose bottom element is its box (ADR-073); what it holds is the rest of the group, and the
 * box's own text.
 *
 * Not one of the rules of SPEC 9.2: ADR-099 found the agent giving cards a fixed height that
 * reached the bottom of the slide.
 */
export const L18: Rule = {
  id: 'L18',
  severity: 'warning',
  agent: true,
  check({ deck, slide, items, turned }) {
    const room = slideArea(deck);
    const template = layoutCopies(deck, slide);
    const drawn = new Map(items.map((item) => [item.element.id, item]));
    const hollow: { id: string; height: number; empty: number }[] = [];
    for (const group of walkElements(slide.elements)) {
      if (group.type !== 'group') continue;
      const [base, ...rest] = group.children as [Element?, ...Element[]];
      const box = base && drawn.get(base.id);
      if (!box || template.has(box.element.id) || !isBox(box, group, room, turned)) continue;
      const contents = [
        ...(box.measure.text ? [box.measure.text.ink] : []),
        ...[...walkElements(rest)].flatMap((element) => {
          const item = drawn.get(element.id);
          return item ? (contentBox(item, room) ?? []) : [];
        }),
      ];
      const { h } = box.measure.box;
      const empty = emptyHeight(box.measure.box, contents);
      if (empty >= MIN_EMPTY && empty >= MAX_EMPTY * h) {
        hollow.push({ id: box.element.id, height: h, empty });
      }
    }
    if (hollow.length === 0) return [];
    const each = hollow.map(
      ({ id, height, empty }) =>
        `${id} is ${Math.round(height)}px tall and what it holds needs about ${Math.round(height - empty)}px with its padding (${Math.round(empty)}px, ${Math.floor((empty / height) * 100)}%, empty)`,
    );
    const lead =
      hollow.length === 1
        ? `A card is taller than what it holds: ${each[0]}.`
        : `${hollow.length} cards are taller than what they hold: ${each.join('; ')}.`;
    return [
      {
        elementIds: hollow.map((card) => card.id),
        message: `${lead} Do not stretch cards to fill the slide: give each the height of its content and padding, then fill the room that frees with content: larger type or icons, a picture or a key figure in each card, a second row, a visual beside the cards, or the row centred under the title. If each card holds only a line or two, the points may read better without boxes.`,
      },
    ];
  },
};
