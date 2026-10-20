import {
  findElementInDeck,
  locateElement,
  type Deck,
  type Element,
  type GroupElement,
  type Slide,
} from '@slidr/model';
import { DeckApiError } from './tool';

/** CMD-07: ids come from what the agent read earlier, and the user may have deleted them since. */
export function getSlide(deck: Deck, slideId: string): Slide {
  const slide = deck.slides.find((s) => s.id === slideId);
  if (!slide) {
    throw new DeckApiError(
      'not_found',
      `Slide "${slideId}" does not exist. It may have been deleted; deck_get_outline lists the slides.`,
    );
  }
  return slide;
}

export interface Found {
  slide: Slide;
  element: Element;
  parent?: GroupElement;
  /** Position among its siblings, in z-order. */
  index: number;
}

/**
 * Finds an element by id, on `slideId` when given. Element ids are unique across the deck, so
 * the slide is optional.
 */
export function getElement(deck: Deck, elementId: string, slideId?: string): Found {
  if (slideId !== undefined) {
    const slide = getSlide(deck, slideId);
    const location = locateElement(slide.elements, elementId);
    if (location) return { slide, ...location };
    const elsewhere = findElementInDeck(deck, elementId);
    if (elsewhere) {
      throw new DeckApiError(
        'not_found',
        `Element "${elementId}" is on slide "${elsewhere.slide.id}", not on slide "${slideId}".`,
      );
    }
  } else {
    for (const slide of deck.slides) {
      const location = locateElement(slide.elements, elementId);
      if (location) return { slide, ...location };
    }
  }
  throw new DeckApiError(
    'not_found',
    `Element "${elementId}" does not exist. It may have been deleted; slide_get lists the elements of a slide.`,
  );
}

/** The elements, which must all be on one slide; that slide is returned with them. */
export function getElementsOnOneSlide(
  deck: Deck,
  elementIds: readonly string[],
  slideId?: string,
): { slide: Slide; found: Found[] } {
  if (elementIds.length === 0) throw new DeckApiError('invalid_input', 'elementIds is empty.');
  const first = getElement(deck, elementIds[0]!, slideId);
  const found = elementIds.map((id) => getElement(deck, id, first.slide.id));
  return { slide: first.slide, found };
}

/** 1 for the first slide: the number the user sees in the filmstrip. */
export function slideNumber(deck: Deck, slideId: string): number {
  return deck.slides.findIndex((s) => s.id === slideId) + 1;
}
