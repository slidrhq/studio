import type {
  CommandOf,
  Direction,
  Element,
  Frame,
  Layout,
  Placeholder,
  PlaceholderRole,
  Slide,
} from '@slidr/model';
import { seatAlign } from './align';
import { equalJson } from './json';

/*
 * Moving a slide from one layout to another (SPEC 5.5): the layout is found by archetype, and the
 * elements find their placeholders by role. Switching a template and turning a deck to the other
 * direction are both built on this.
 */

const sameFrame = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * What is as tall as its content needs: a text box and a table. Their height says how much was
 * written, not where they were put.
 */
const TALL_AS_CONTENT: ReadonlySet<Element['type']> = new Set(['text', 'table']);

/**
 * Whether an element is where its placeholder put it. The model has no link from an element to
 * its placeholder, so the frame is the test: one that was moved or resized by hand has a frame of
 * its own, and keeps it.
 *
 * A text box or a table that only differs from its placeholder in height is still on it. Text
 * that outgrew its box gets a taller one, from the design check's fix or from the handle at the
 * foot of the box, and a table grows with its rows; neither took the element off its seat, and
 * the next switch of template must not leave it behind (see `followPatch` for the height).
 */
export function sitsOn(element: Element, placeholder: Placeholder): boolean {
  const { x, y, w, h } = element.frame;
  const seat = placeholder.frame;
  if (x !== seat.x || y !== seat.y || w !== seat.w) return false;
  return h === seat.h || TALL_AS_CONTENT.has(element.type);
}

function byRole<T extends { role?: PlaceholderRole }>(items: readonly T[]) {
  const groups = new Map<PlaceholderRole, T[]>();
  for (const item of items) {
    if (!item.role) continue;
    const group = groups.get(item.role);
    if (group) group.push(item);
    else groups.set(item.role, [item]);
  }
  return groups;
}

/** A placeholder of a layout, and its place among the layout's placeholders of the same role. */
export interface Seat {
  placeholder: Placeholder;
  ordinal: number;
}

/**
 * The placeholder each top-level element of a slide belongs to. Among the elements of a role, one
 * that sits on a placeholder of the role belongs to it; the others take the placeholders left, in
 * order. An element beyond the placeholders of its role belongs to none, and neither does an
 * element inside a group, whose frame is not in slide coordinates.
 */
export function seatsOf(elements: readonly Element[], layout: Layout): Map<string, Seat> {
  const seats = new Map<string, Seat>();
  const placeholders = byRole(layout.placeholders);
  for (const [role, group] of byRole(elements)) {
    const free = (placeholders.get(role) ?? []).map((placeholder, ordinal): Seat => ({
      placeholder,
      ordinal,
    }));
    const waiting: Element[] = [];
    for (const element of group) {
      const at = free.findIndex((seat) => sitsOn(element, seat.placeholder));
      const [seat] = at < 0 ? [] : free.splice(at, 1);
      if (seat) seats.set(element.id, seat);
      else waiting.push(element);
    }
    for (const element of waiting) {
      const seat = free.shift();
      if (seat) seats.set(element.id, seat);
    }
  }
  return seats;
}

/** The placeholder an element leaves and the one it goes to. */
export interface Move {
  from: Placeholder;
  to: Placeholder;
}

/**
 * Where the elements of a slide go when it moves from one layout to another: to the placeholder
 * of the same role, at the same place among those of the role. An element whose role has no such
 * placeholder in the new layout is not listed, and stays as it is.
 */
export function movesOf(slide: Slide, from: Layout, to: Layout): Map<string, Move> {
  const targets = byRole(to.placeholders);
  const moves = new Map<string, Move>();
  for (const [elementId, seat] of seatsOf(slide.elements, from)) {
    const target = targets.get(seat.placeholder.role)?.[seat.ordinal];
    if (target) moves.set(elementId, { from: seat.placeholder, to: target });
  }
  return moves;
}

/**
 * What an element takes from its new placeholder, as an `element.update` patch. It follows the
 * layout in what it had from the old placeholder: the frame, the vertical alignment, the
 * colour the placeholder gives its text, and the alignment and text style of each paragraph. A value set by hand differs from the old
 * placeholder's, and stays (SPEC 5.5: an element with explicit values stays as it is).
 *
 * With the deck's direction, a paragraph that reads against the deck follows too: its alignment
 * was turned when it was seated (`seatAlign`: an English line in a Hebrew deck is `end` on a
 * `start` placeholder), so it is the old placeholder's, and it takes the new one's turned the
 * same way.
 *
 * A centred seat does not say which way a paragraph was seated: turned and plain are one word
 * there. A paragraph that comes from one goes to the side the new placeholder means, as it would
 * if a slide were made with it: an English name under a centred quote goes to the right of a
 * Hebrew deck, with the lines around it. So a paragraph that was seated on the layout's side
 * gets its alignment back when a switch takes it through a centred seat and back. One that
 * read against the deck with the placeholder's alignment as it is (a line typed into the
 * placeholder, which stands on the far side) comes back on the layout's side.
 */
export function followPatch(
  element: Element,
  { from, to }: Move,
  deckDir?: Direction,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (sitsOn(element, from)) {
    // A height of its own (see `sitsOn`) is the element's, like every value set by hand: it
    // goes along, and switching back finds it.
    const own = element.frame.h !== from.frame.h;
    const frame = own ? { ...to.frame, h: element.frame.h } : { ...to.frame };
    if (!sameFrame(element.frame, frame)) patch.frame = frame;
  }
  if (element.type !== 'text') return patch;

  const vAlign = to.vAlign ?? 'top';
  if (element.vAlign === (from.vAlign ?? 'top') && element.vAlign !== vAlign) patch.vAlign = vAlign;

  // The colour a card of the old layout gave the text goes with that card; `null` takes it off.
  if (equalJson(element.color, from.color) && !equalJson(from.color, to.color)) {
    patch.color = to.color ? { ...to.color } : null;
  }

  const fromAlign = from.align ?? 'start';
  const toAlign = to.align ?? 'start';
  let changed = false;
  const paragraphs = element.content.paragraphs.map((paragraph) => {
    const next = { ...paragraph };
    let align = paragraph.align;
    if (paragraph.align === fromAlign) {
      align = deckDir && fromAlign === 'center' ? seatAlign(toAlign, paragraph, deckDir) : toAlign;
    } else if (deckDir && paragraph.align === seatAlign(fromAlign, paragraph, deckDir)) {
      align = seatAlign(toAlign, paragraph, deckDir);
    }
    if (align !== paragraph.align) {
      next.align = align;
      changed = true;
    }
    if (paragraph.styleRef === from.styleRef && to.styleRef !== from.styleRef) {
      if (to.styleRef) next.styleRef = to.styleRef;
      else delete next.styleRef;
      changed = true;
    }
    return next;
  });
  if (changed) patch.content = { paragraphs };
  return patch;
}

/**
 * The seats of a layout that elements of a slide already stand on without having come to them
 * from a seat of their own: text the layout the slide leaves had no seat for, which stayed
 * where a layout before it had put it. Such an element is not moved, and it is on the seat all
 * the same: the seat counts as filled, and its text takes the colour the seat gives.
 */
export function arrivalsOf(slide: Slide, from: Layout, to: Layout): Map<string, Placeholder> {
  const moves = movesOf(slide, from, to);
  const taken = new Set([...moves.values()].map((move) => move.to.id));
  const arrivals = new Map<string, Placeholder>();
  for (const element of slide.elements) {
    if (!element.role || moves.has(element.id)) continue;
    const seat = to.placeholders.find(
      (placeholder) =>
        placeholder.role === element.role &&
        !taken.has(placeholder.id) &&
        sitsOn(element, placeholder),
    );
    if (!seat) continue;
    taken.add(seat.id);
    arrivals.set(element.id, seat);
  }
  return arrivals;
}

/**
 * What an element that does not move takes or gives up of the colour a seat gives its text.
 * One that stands on a seat of the new layout takes that seat's. One the new layout has no seat
 * for stays where it is, and the field the old layout drew under it does not: the colour that
 * field gave its text goes with the field.
 */
function colourPatch(
  element: Element,
  left: Placeholder | undefined,
  arrived: Placeholder | undefined,
): Record<string, unknown> {
  if (element.type !== 'text') return {};
  if (arrived) {
    return equalJson(element.color, arrived.color)
      ? {}
      : { color: arrived.color ? { ...arrived.color } : null };
  }
  return left?.color && equalJson(element.color, left.color) ? { color: null } : {};
}

/**
 * The `element.update`s that take a slide's elements from one layout to another. `deckDir` is
 * the direction of the deck both layouts are drawn for (see `followPatch`).
 */
export function relayout(
  slide: Slide,
  from: Layout,
  to: Layout,
  deckDir?: Direction,
): CommandOf<'element.update'>[] {
  const moves = movesOf(slide, from, to);
  const seats = seatsOf(slide.elements, from);
  const arrivals = arrivalsOf(slide, from, to);
  const commands: CommandOf<'element.update'>[] = [];
  for (const element of slide.elements) {
    const move = moves.get(element.id);
    const patch = move
      ? followPatch(element, move, deckDir)
      : colourPatch(element, seats.get(element.id)?.placeholder, arrivals.get(element.id));
    if (Object.keys(patch).length > 0) {
      commands.push({ type: 'element.update', slideId: slide.id, elementId: element.id, patch });
    }
  }
  return commands;
}

/**
 * A slide without a layout taking one for the first time: the layout of its archetype
 * (`Slide.archetype`, which a slide written as HTML carries), and each element on the
 * placeholder of its role.
 *
 * Such a slide was designed as a whole, so a layout is taken only when it has a seat for
 * everything on the slide: every top-level element has a role, and the layout has a placeholder
 * for each. A slide with anything else on it (a card behind its text, a drawing) would keep
 * those where they were while its text moved away from them, so it is left as it is and only
 * follows the theme. Undefined when no layout takes the slide.
 */
export function adoptLayout(
  slide: Slide,
  candidates: readonly Layout[],
  deckDir: Direction,
): { layout: Layout; updates: CommandOf<'element.update'>[] } | undefined {
  if (slide.archetype === undefined) return undefined;
  const wanted = roleCounts(slide.elements);
  const seated = [...wanted.values()].reduce((sum, count) => sum + count, 0);
  if (seated !== slide.elements.length) return undefined;
  const layout = candidates.find((candidate) => {
    if (candidate.archetype !== slide.archetype) return false;
    const seats = roleCounts(candidate.placeholders);
    return [...wanted].every(([role, count]) => count <= (seats.get(role) ?? 0));
  });
  if (!layout) return undefined;

  const seats = byRole(layout.placeholders);
  const taken = new Map<PlaceholderRole, number>();
  const updates: CommandOf<'element.update'>[] = [];
  for (const element of slide.elements) {
    const role = element.role!;
    const ordinal = taken.get(role) ?? 0;
    taken.set(role, ordinal + 1);
    const to = seats.get(role)![ordinal]!;
    // There is no placeholder the element came from, so it takes everything the new one gives.
    const patch: Record<string, unknown> = {};
    if (!sameFrame(element.frame, to.frame)) patch.frame = { ...to.frame };
    if (element.type === 'text') {
      const vAlign = to.vAlign ?? 'top';
      if (element.vAlign !== vAlign) patch.vAlign = vAlign;
      if (!equalJson(element.color, to.color)) patch.color = to.color ? { ...to.color } : null;
      const paragraphs = element.content.paragraphs.map((paragraph) => {
        const next = { ...paragraph, align: seatAlign(to.align ?? 'start', paragraph, deckDir) };
        if (to.styleRef) next.styleRef = to.styleRef;
        else delete next.styleRef;
        return next;
      });
      if (JSON.stringify(paragraphs) !== JSON.stringify(element.content.paragraphs)) {
        patch.content = { paragraphs };
      }
    }
    if (Object.keys(patch).length > 0) {
      updates.push({ type: 'element.update', slideId: slide.id, elementId: element.id, patch });
    }
  }
  return { layout, updates };
}

function roleCounts(items: readonly { role?: PlaceholderRole }[]): Map<PlaceholderRole, number> {
  return new Map([...byRole(items)].map(([role, group]) => [role, group.length]));
}

/**
 * The layout a slide moves to. The one with the id of its present layout, when there is one: it
 * is the same layout in a new version. Otherwise a layout of the same archetype, and among
 * several of them the one with a placeholder for most of the slide's elements, then the one whose
 * placeholders are closest to the present layout's, then the first. Undefined when no layout has
 * the archetype.
 */
export function matchLayout(
  slide: Slide,
  from: Layout,
  candidates: readonly Layout[],
): Layout | undefined {
  const sameId = candidates.find((layout) => layout.id === from.id);
  if (sameId) return sameId;
  const options = candidates.filter((layout) => layout.archetype === from.archetype);
  if (options.length < 2) return options[0];

  const wanted = roleCounts(slide.elements);
  const present = roleCounts(from.placeholders);
  let best: { layout: Layout; placed: number; distance: number } | undefined;
  for (const layout of options) {
    const counts = roleCounts(layout.placeholders);
    let placed = 0;
    for (const [role, count] of wanted) placed += Math.min(count, counts.get(role) ?? 0);
    let distance = 0;
    for (const role of new Set([...present.keys(), ...counts.keys()])) {
      distance += Math.abs((present.get(role) ?? 0) - (counts.get(role) ?? 0));
    }
    if (!best || placed > best.placed || (placed === best.placed && distance < best.distance)) {
      best = { layout, placed, distance };
    }
  }
  return best?.layout;
}
