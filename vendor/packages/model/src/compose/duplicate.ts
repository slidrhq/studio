import { CommandError, type CommandOf } from '../commands';
import type { IdPrefix } from '../ids';
import { allElementIds, walkElements } from '../queries';
import type { Deck, Element, Point, Slide } from '../schema';
import { ancestorsOf, copyJson, idSource, slideOrThrow } from './shared';

/**
 * A copy of an element tree in which every element, nested ones included, has a new id.
 * `nextId` gets the old id and returns the new one, so the caller can keep the mapping.
 */
export function cloneElement(element: Element, nextId: (oldId: string) => string): Element {
  const copy = copyJson(element);
  for (const inside of walkElements([copy])) inside.id = nextId(inside.id);
  return copy;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces whole-word occurrences of old ids, e.g. `[data-element-id="e_1"]` in slide CSS. */
function renameIds(text: string, ids: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of ids) {
    out = out.replace(new RegExp(`(?<![\\w-])${escapeRegExp(from)}(?![\\w-])`, 'g'), to);
  }
  return out;
}

/** The ids of a deck's slides and elements: what a new id must not be. */
export function takenIds(deck: Deck): Set<string> {
  return new Set([...deck.slides.map((s) => s.id), ...allElementIds(deck)]);
}

/** Ids for slides and elements that are free in the deck; each one handed out is taken. */
export function deckIdSource(deck: Deck, random?: () => number): (prefix: IdPrefix) => string {
  return idSource(takenIds(deck), random);
}

/**
 * A copy of a slide, from this deck or from another. The slide, its elements and its animation
 * steps get new ids; the timeline and the slide CSS are rewritten to the new element ids.
 */
export function copySlide(
  source: Slide,
  fresh: (prefix: IdPrefix) => string,
  random?: () => number,
): Slide {
  const renamed = new Map<string, string>();
  // The copies of a layout's objects are named after their slide (`layoutObjects`), and are
  // named after the copy here, so they are still its layout's.
  const own = `${source.id}_`;
  const named = [...walkElements(source.elements)].some((element) => element.id.startsWith(own));
  const slideId = named ? fresh('s') : undefined;
  const elements = source.elements.map((element) =>
    cloneElement(element, (oldId) => {
      const id =
        slideId && oldId.startsWith(own) ? `${slideId}_${oldId.slice(own.length)}` : fresh('e');
      renamed.set(oldId, id);
      return id;
    }),
  );
  const stepIds = idSource(new Set(source.timeline.map((step) => step.id)), random);
  const slide: Slide = {
    ...copyJson(source),
    id: slideId ?? fresh('s'),
    elements,
    timeline: source.timeline.map((step) => ({
      ...copyJson(step),
      id: stepIds('a'),
      elementId: renamed.get(step.elementId) ?? step.elementId,
    })),
  };
  if (slide.css !== undefined) slide.css = renameIds(slide.css, renamed);
  return slide;
}

export interface DuplicateSlideOptions {
  /** Position of the copy in the deck. Default: right after the original. */
  index?: number;
  random?: () => number;
}

/**
 * A `slide.add` with a copy of a slide. The slide, its elements and its animation steps get
 * new ids; the timeline and the slide CSS are rewritten to the new element ids. The name is
 * kept.
 */
export function duplicateSlide(
  deck: Deck,
  slideId: string,
  options: DuplicateSlideOptions = {},
): CommandOf<'slide.add'> {
  const source = slideOrThrow(deck, slideId);
  const slide = copySlide(source, deckIdSource(deck, options.random), options.random);
  return { type: 'slide.add', slide, index: options.index ?? deck.slides.indexOf(source) + 1 };
}

export interface DuplicateElementsOptions {
  /** Where the copies go. Default: the slide of the originals. */
  toSlideId?: string;
  /** Moves every copy by this much, in slide pixels. Default: no move. */
  offset?: Point;
  random?: () => number;
}

/**
 * `element.add` commands that copy elements with new ids (duplicate, copy and paste). On the
 * same slide a copy goes into the parent of its original; on another slide it goes to the top
 * level, at the original's position on the slide (a rotation of an enclosing group is not
 * applied). The copies go on top, in the order the originals had. An element inside another
 * one that is copied is not copied twice. Animation steps are not copied.
 */
export function duplicateElements(
  deck: Deck,
  slideId: string,
  elementIds: readonly string[],
  options: DuplicateElementsOptions = {},
): CommandOf<'element.add'>[] {
  const slide = slideOrThrow(deck, slideId);
  const target = options.toSlideId ? slideOrThrow(deck, options.toSlideId) : slide;
  const offset = options.offset ?? { x: 0, y: 0 };
  const fresh = idSource(allElementIds(deck), options.random);

  const wanted = new Set(elementIds);
  for (const id of wanted) {
    if (!ancestorsOf(slide.elements, id)) {
      throw new CommandError(
        'not_found',
        `Element "${id}" does not exist on slide "${slideId}". It may have been deleted.`,
      );
    }
  }

  const commands: CommandOf<'element.add'>[] = [];
  // Walk order is z-order within each parent, so the copies keep the stacking of the originals.
  for (const element of walkElements(slide.elements)) {
    if (!wanted.has(element.id)) continue;
    const ancestors = ancestorsOf(slide.elements, element.id) ?? [];
    if (ancestors.some((group) => wanted.has(group.id))) continue;

    const copy = cloneElement(element, () => fresh('e'));
    const parent = ancestors.at(-1);
    const sameSlide = target.id === slide.id;
    // On another slide the copy leaves its groups, so its frame becomes slide-relative.
    const shift = sameSlide
      ? offset
      : ancestors.reduce(
          (at, group) => ({ x: at.x + group.frame.x, y: at.y + group.frame.y }),
          offset,
        );
    copy.frame = { ...copy.frame, x: copy.frame.x + shift.x, y: copy.frame.y + shift.y };
    commands.push({
      type: 'element.add',
      slideId: target.id,
      element: copy,
      ...(sameSlide && parent ? { parentId: parent.id } : {}),
    });
  }
  return commands;
}
