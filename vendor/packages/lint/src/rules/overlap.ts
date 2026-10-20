import { describeBox, intersection } from '../geometry';
import type { Problem, Rule } from '../rule';
import { proseOf } from '../text';

/**
 * Texts have to cover each other by more than this on both axes. The measured box of a line of
 * text includes the leading around its glyphs, so two lines can touch without colliding.
 */
const MIN_OVERLAP = 2;

/**
 * L06: two text boxes whose text is drawn over each other. It compares where the glyphs are,
 * not the frames: frames that overlap while their text stays apart look fine.
 */
export const L06: Rule = {
  id: 'L06',
  severity: 'error',
  agent: true,
  check({ items }) {
    const texts = items.filter(({ element, measure }) => proseOf(element) && measure.text);
    const problems: Problem[] = [];
    for (const [i, a] of texts.entries()) {
      for (const b of texts.slice(i + 1)) {
        const shared = intersection(a.measure.text!.ink, b.measure.text!.ink);
        if (!shared || shared.w <= MIN_OVERLAP || shared.h <= MIN_OVERLAP) continue;
        problems.push({
          elementIds: [a.element.id, b.element.id],
          message: `The text of "${a.element.id}" and the text of "${b.element.id}" are drawn over each other in a ${Math.round(shared.w)}x${Math.round(shared.h)}px area (${describeBox(shared)}). Move or resize one of them so the texts are apart.`,
        });
      }
    }
    return problems;
  },
};
