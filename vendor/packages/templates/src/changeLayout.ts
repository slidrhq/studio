import {
  findSlide,
  layoutObjects,
  plainText,
  slideFromLayout,
  takenIds,
  walkElements,
  type Command,
  type Deck,
  type Element,
  type Layout,
  type Placeholder,
  type PlaceholderRole,
} from '@slidr/model';
import { layoutCopies } from './objects';
import { arrivalsOf, movesOf, relayout, seatsOf, sitsOn } from './relayout';

/**
 * The commands that move an existing slide to another layout of its deck (SLD-02), with its
 * content mapped by role. A list given to `CommandBus.batch` is one undo step.
 *
 * - A slide nobody has written on (no elements, or only the empty ones its layout gave it, still
 *   on their seats) becomes what "new slide" would have made of the new layout.
 * - A slide that sits on a layout: its elements follow their placeholders to the new layout's,
 *   by role and place among the role (`relayout`), and what the user moved by hand stays. An
 *   element that is still an empty placeholder of the old layout goes when the new layout has
 *   no seat for it, and every seat of the new layout that nothing fills gets an empty element,
 *   on top of the others: without one there would be nowhere to type.
 * - A slide without a layout that holds content (drawn by hand, or written as HTML): each
 *   element that names a role goes to the seat of that role, the first to the first; everything
 *   else stays where it is, over what the layout draws. Such a slide was designed as a whole, so
 *   nothing is added to it: no placeholder, and none of the layout's objects.
 *
 * On a slide that had a layout, the copies of the old layout's objects (`Layout.objects`) go
 * with it, moved or restyled, and the new layout's come in under everything else, as its
 * decorations are drawn (`layoutCopies`).
 * Nothing that holds content is deleted: a copy the user wrote in stays.
 */
export function changeLayout(
  deck: Deck,
  slideId: string,
  layoutId: string,
  options: { random?: () => number } = {},
): Command[] {
  const slide = findSlide(deck, slideId);
  const to = deck.layouts.find((layout) => layout.id === layoutId);
  if (!slide || !to || slide.layoutId === to.id) return [];
  const onto: Command = { type: 'slide.update', slideId, patch: { layoutId: to.id } };
  const add = (element: Element, index?: number): Command => ({
    type: 'element.add',
    slideId,
    element,
    ...(index === undefined ? {} : { index }),
  });
  const remove = (elements: readonly Element[]): Command[] =>
    elements.length === 0
      ? []
      : [{ type: 'element.remove', slideId, elementIds: elements.map((element) => element.id) }];
  /** What "new slide" makes of the layout's placeholders, each element with its seat. */
  const made = slideFromLayout(deck, to.id, options).slide.elements;
  const fresh = seated(to, made.slice(to.objects?.length ?? 0));
  /** The new layout's objects, named after this slide, at its bottom in the layout's order. */
  const objects = (leaving: readonly Element[]): Command[] => {
    const taken = takenIds(deck);
    for (const element of walkElements(leaving)) taken.delete(element.id);
    for (const element of walkElements(made)) taken.add(element.id);
    return layoutObjects(to, slideId, taken, options.random).map((element, index) =>
      add(element, index),
    );
  };

  const from = deck.layouts.find((layout) => layout.id === slide.layoutId);
  const seats = from ? seatsOf(slide.elements, from) : new Map<string, never>();
  const theirs = layoutCopies(slide, from);
  /** The layout's: a copy of its objects, or an element on its seat that holds nothing. */
  const untouched = (element: Element) => {
    if (theirs.has(element.id)) return true;
    const seat = seats.get(element.id);
    return seat !== undefined && sitsOn(element, seat.placeholder) && holdsNothing(element);
  };

  if (slide.elements.every(untouched)) {
    return [
      ...remove(slide.elements),
      onto,
      ...objects(slide.elements),
      ...fresh.map(({ element }) => add(element)),
    ];
  }

  if (from) {
    const moves = movesOf(slide, from, to);
    const left = slide.elements.filter((element) => untouched(element) && !moves.has(element.id));
    // A seat is filled by what moves to it, and by what already stands on it.
    const filled = new Set([
      ...[...moves.values()].map((move) => move.to.id),
      ...[...arrivalsOf(slide, from, to).values()].map((seat) => seat.id),
    ]);
    return [
      ...relayout(slide, from, to, deck.meta.dir),
      ...remove(left),
      onto,
      ...objects(left),
      ...fresh.filter(({ seat }) => !filled.has(seat.id)).map(({ element }) => add(element)),
    ];
  }

  const taken = new Map<PlaceholderRole, number>();
  const moved: Command[] = [];
  for (const element of slide.elements) {
    if (!element.role) continue;
    const nth = taken.get(element.role) ?? 0;
    taken.set(element.role, nth + 1);
    const seat = to.placeholders.filter((p) => p.role === element.role)[nth];
    if (seat) moved.push(seatOn(slideId, element, seat));
  }
  return [...moved, onto];
}

/**
 * The elements "new slide" makes of a layout's placeholders, each with the placeholder it came
 * from. They are in the order of the placeholders, and some placeholders give none
 * (`slideFromLayout`).
 */
function seated(
  layout: Layout,
  elements: readonly Element[],
): { seat: Placeholder; element: Element }[] {
  const pairs: { seat: Placeholder; element: Element }[] = [];
  let next = 0;
  for (const seat of layout.placeholders) {
    const element = elements[next];
    if (element?.role !== seat.role) continue;
    next++;
    pairs.push({ seat, element });
  }
  return pairs;
}

/** Whether an element is as empty as the one a placeholder starts with. */
function holdsNothing(element: Element): boolean {
  switch (element.type) {
    case 'text':
      return plainText(element.content).trim() === '';
    case 'image':
      return element.assetId === undefined && element.prompt === undefined;
    case 'chart':
      return element.data.categories.length === 0 && element.data.series.length === 0;
    case 'table':
      return element.cells.every((row) =>
        row.every((cell) => plainText(cell.content).trim() === ''),
      );
    default:
      return false;
  }
}

/** An element on a seat: the seat's frame, and for text the colour the seat gives it. */
function seatOn(slideId: string, element: Element, seat: Placeholder): Command {
  return {
    type: 'element.update',
    slideId,
    elementId: element.id,
    patch: {
      frame: { ...seat.frame },
      ...(element.type === 'text' && seat.color ? { color: { ...seat.color } } : {}),
    },
  };
}
