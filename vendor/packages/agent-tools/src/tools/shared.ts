import { allElementIds, newId, type Deck } from '@slidr/model';
import { z } from 'zod';
import { getSlide } from '../lookup';

/** Documents a field whose type is a shared model schema, without copying that schema. */
export function about<S extends z.ZodType>(schema: S, description: string) {
  return z.lazy(() => schema).describe(description);
}

/** Where a new slide goes: right after a slide, first with null, or `fallback` when absent. */
export function afterSlide(fallback: string) {
  return z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(`Put it right after this slide; null puts it first. Default: ${fallback}.`);
}

/** Index in the full slide list for "after this slide" (null: first; undefined: `fallback`). */
export function indexAfter(
  deck: Deck,
  afterSlideId: string | null | undefined,
  fallback: number,
): number {
  if (afterSlideId === undefined) return fallback;
  if (afterSlideId === null) return 0;
  return deck.slides.indexOf(getSlide(deck, afterSlideId)) + 1;
}

/** A new element id that no element of the deck uses. */
export function freshElementId(deck: Deck): string {
  const taken = allElementIds(deck);
  return newId('e', (id) => taken.has(id));
}
