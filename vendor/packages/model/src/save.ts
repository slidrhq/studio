import { referencedAssetIds } from './queries';
import type { Deck } from './schema';

/**
 * The deck as it goes into the file: stamped with the save time, and without assets that
 * nothing uses any more. The deck in memory keeps them, so that undo can bring a reference
 * back after the save (SPEC 5.7).
 */
export function prepareForSave(deck: Deck, now: Date = new Date()): Deck {
  const used = referencedAssetIds(deck);
  const assets = Object.fromEntries(Object.entries(deck.assets).filter(([id]) => used.has(id)));
  return { ...deck, meta: { ...deck.meta, updatedAt: now.toISOString() }, assets };
}
