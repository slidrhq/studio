import type { Rule } from '../rule';
import { bulletsIn, wordsIn } from '../text';

/** More than this is too much to read on one slide (SPEC 9.2). */
export const MAX_WORDS = 60;
export const MAX_BULLETS = 6;

/** L13: too much text on the slide, in words or in bullets. Table cells are not counted. */
export const L13: Rule = {
  id: 'L13',
  severity: 'warning',
  agent: true,
  check({ items }) {
    const counts = items
      .map(({ element }) => ({
        id: element.id,
        words: wordsIn(element),
        bullets: bulletsIn(element),
      }))
      .filter((count) => count.words > 0);
    const words = counts.reduce((sum, count) => sum + count.words, 0);
    const bullets = counts.reduce((sum, count) => sum + count.bullets, 0);
    const over = [
      ...(words > MAX_WORDS ? [`${words} words (the limit is ${MAX_WORDS})`] : []),
      ...(bullets > MAX_BULLETS ? [`${bullets} bullets (the limit is ${MAX_BULLETS})`] : []),
    ];
    if (over.length === 0) return [];
    return [
      {
        // The heaviest first: that is where to cut.
        elementIds: counts.sort((a, b) => b.words - a.words).map((count) => count.id),
        message: `The slide has ${over.join(' and ')}. Split it into two slides, or turn part of the text into a visual.`,
      },
    ];
  },
};
