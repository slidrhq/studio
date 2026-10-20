import type { CommandOf } from '../commands';
import { allElementIds, walkElements } from '../queries';
import type { AssetMeta, Deck, Element, Layout, Point, Slide } from '../schema';
import { cloneElement, copySlide, deckIdSource } from './duplicate';
import { ancestorsOf, copyJson, idSource, slideOrThrow } from './shared';

/*
 * Copy and paste (ARR-05, FLM-02) in two halves, because a clipboard sits between them: what is
 * taken from a slide or a deck is plain data that outlives the deck it came from, and pasting
 * turns such data into commands for whatever deck is open then.
 */

/**
 * Copies of elements as a clipboard holds them: out of their groups, with frames relative to the
 * slide (a rotation of an enclosing group is not applied), in z-order. Ids are kept as they are;
 * `pasteElements` gives new ones. An element inside another one that is taken is not taken
 * twice, and ids that are not on the slide are skipped.
 */
export function detachElements(slide: Slide, elementIds: readonly string[]): Element[] {
  const wanted = new Set(elementIds);
  const detached: Element[] = [];
  for (const element of walkElements(slide.elements)) {
    if (!wanted.has(element.id)) continue;
    const ancestors = ancestorsOf(slide.elements, element.id) ?? [];
    if (ancestors.some((group) => wanted.has(group.id))) continue;
    const copy = copyJson(element);
    for (const group of ancestors) {
      copy.frame.x += group.frame.x;
      copy.frame.y += group.frame.y;
    }
    detached.push(copy);
  }
  return detached;
}

export interface PasteElementsOptions {
  /** Moves every pasted element by this much, in slide pixels. Default: no move. */
  offset?: Point;
  random?: () => number;
}

/**
 * `element.add` commands that put elements from a clipboard on a slide: at the top level, on
 * top, in the order given, each with new ids throughout. The elements may come from another
 * deck. Animation steps do not travel with elements.
 */
export function pasteElements(
  deck: Deck,
  slideId: string,
  elements: readonly Element[],
  options: PasteElementsOptions = {},
): CommandOf<'element.add'>[] {
  slideOrThrow(deck, slideId);
  const offset = options.offset ?? { x: 0, y: 0 };
  const fresh = idSource(allElementIds(deck), options.random);
  return elements.map((element) => {
    const copy = cloneElement(element, () => fresh('e'));
    copy.frame = { ...copy.frame, x: copy.frame.x + offset.x, y: copy.frame.y + offset.y };
    return { type: 'element.add', slideId, element: copy };
  });
}

export interface PasteSlidesOptions {
  /** Position of the first copy in the deck; the others follow it. Default: at the end. */
  index?: number;
  /** The layouts the slides use, for a deck that does not have them. */
  layouts?: readonly Layout[];
  random?: () => number;
}

/**
 * Commands that add copies of slides, from this deck or from another, as one block: a
 * `slide.add` for each, with new ids for the slide, its elements and its animation steps (see
 * `duplicateSlide`). A layout the deck lacks is added first when it is given in `layouts`;
 * otherwise the slide lets go of it and keeps its content.
 */
export function pasteSlides(
  deck: Deck,
  slides: readonly Slide[],
  options: PasteSlidesOptions = {},
): (CommandOf<'layout.add'> | CommandOf<'slide.add'>)[] {
  const fresh = deckIdSource(deck, options.random);
  const known = new Set(deck.layouts.map((layout) => layout.id));
  const first = Math.min(options.index ?? deck.slides.length, deck.slides.length);

  const layouts: CommandOf<'layout.add'>[] = [];
  const added = slides.map((source, i): CommandOf<'slide.add'> => {
    const slide = copySlide(source, fresh, options.random);
    if (slide.layoutId !== undefined && !known.has(slide.layoutId)) {
      const layout = options.layouts?.find((l) => l.id === slide.layoutId);
      if (layout) {
        layouts.push({ type: 'layout.add', layout: copyJson(layout) });
        known.add(layout.id);
      } else {
        delete slide.layoutId;
      }
    }
    return { type: 'slide.add', slide, index: first + i };
  });
  return [...layouts, ...added];
}

/**
 * The asset table entries a part of the deck refers to: the elements or slides about to be
 * copied. As in `referencedAssetIds`, an asset counts when its id appears anywhere in the data,
 * free HTML and CSS included. Fonts are used by family name, so they are not found this way.
 */
export function assetsUsedBy(deck: Deck, part: unknown): AssetMeta[] {
  const haystack = JSON.stringify(part) ?? '';
  return Object.values(deck.assets).filter((asset) => haystack.includes(asset.id));
}
