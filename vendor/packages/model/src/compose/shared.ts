import { CommandError } from '../commands';
import { newId, type IdPrefix } from '../ids';
import type { Deck, Element, GroupElement, Slide } from '../schema';

/** Ids that do not clash with `taken`; each id handed out is added to it. */
export function idSource(taken: Set<string>, random?: () => number): (prefix: IdPrefix) => string {
  return (prefix) => {
    const id = newId(prefix, (candidate) => taken.has(candidate), random);
    taken.add(id);
    return id;
  };
}

export function slideOrThrow(deck: Deck, slideId: string): Slide {
  const slide = deck.slides.find((s) => s.id === slideId);
  if (!slide) {
    throw new CommandError(
      'not_found',
      `Slide "${slideId}" does not exist. It may have been deleted.`,
    );
  }
  return slide;
}

/** The groups that contain an element, outermost first; undefined when it is not on the slide. */
export function ancestorsOf(
  elements: readonly Element[],
  elementId: string,
  path: GroupElement[] = [],
): GroupElement[] | undefined {
  for (const element of elements) {
    if (element.id === elementId) return path;
    if (element.type === 'group') {
      const inside = ancestorsOf(element.children, elementId, [...path, element]);
      if (inside) return inside;
    }
  }
  return undefined;
}

/** A deep copy of plain JSON data: the deck is frozen, and commands carry their own objects. */
export function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
