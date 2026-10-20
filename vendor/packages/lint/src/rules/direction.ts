import { plainText, type Paragraph } from '@slidr/model';
import type { Problem, Rule } from '../rule';
import { drawnDirection, letterCount, proseOf, setText } from '../text';

/**
 * The direction a paragraph reads in, in a deck of a given direction: the deck's, unless the
 * text has letters and none of them is of that direction. It is the rule the app sets text by
 * (`text_set`, the templates' samples). Counting letters would not do: a Hebrew sentence about
 * software holds more Latin letters than Hebrew ones, and is a Hebrew sentence still. Undefined
 * for text without letters, which reads as a figure in either.
 */
export function readingDirection(text: string, deck: 'rtl' | 'ltr'): 'rtl' | 'ltr' | undefined {
  const { rtl, ltr } = letterCount(text);
  if (rtl + ltr === 0) return undefined;
  if (deck === 'rtl') return rtl > 0 ? 'rtl' : 'ltr';
  return ltr > 0 ? 'ltr' : 'rtl';
}

const NAME = { rtl: 'right to left', ltr: 'left to right' } as const;

/**
 * Text that begins with something that is not a letter (a figure, a bracket), or ends with
 * punctuation. A figure at the end stays with the word before it ("Q1", "31%").
 */
const LOOSE_END = /^[^\p{L}\s]|[^\p{L}\p{N}\s%]$/u;

/**
 * Whether a paragraph laid out against its text is drawn any differently for it. Letters of one
 * script keep their order in either direction, so a bare word or phrase ("Q1", "API Gateway" in
 * a Hebrew deck) looks the same and is left alone. What moves is whatever has no direction of
 * its own at an end of the text (the full stop, a leading figure), and the parts of a text that
 * holds both scripts.
 */
function drawnWrong(text: string): boolean {
  const { rtl, ltr } = letterCount(text);
  return (rtl > 0 && ltr > 0) || LOOSE_END.test(text.trim());
}

const OTHER_SIDE = { start: 'end', end: 'start' } as const;

/**
 * The paragraph in the direction it reads in. A direction that was stated put the text on a
 * side of its box, and the text stays there: `start` and `end` trade places. A paragraph that
 * followed its first letter had no side of its own, and takes the deck's.
 */
function turned(paragraph: Paragraph, reads: 'rtl' | 'ltr'): Paragraph {
  const side = paragraph.align === 'start' || paragraph.align === 'end' ? paragraph.align : null;
  return {
    ...paragraph,
    dir: reads,
    ...(paragraph.dir !== 'auto' && side ? { align: OTHER_SIDE[side] } : {}),
  };
}

/**
 * L15: a paragraph laid out against the direction of its own text, where that shows. A Hebrew
 * sentence that opens with an English term is still a Hebrew sentence; set to follow its first
 * letter, it is laid out left to right, and its punctuation and its numbers land on the wrong
 * side. The fix states the direction on the paragraph, and keeps the text on the side it was
 * put on. Text boxes and text in shapes; cells of a table take their sides from the table.
 */
export const L15: Rule = {
  id: 'L15',
  severity: 'warning',
  agent: false,
  check({ deck, slide, items }) {
    const problems: Problem[] = [];
    for (const { element } of items) {
      const prose = proseOf(element);
      if (!prose) continue;
      const wrong = new Map<Paragraph, 'rtl' | 'ltr'>();
      for (const paragraph of prose.paragraphs) {
        const text = plainText({ paragraphs: [paragraph] });
        const reads = readingDirection(text, deck.meta.dir);
        const drawn = drawnDirection(paragraph.dir, text, deck.meta.dir);
        if (reads && drawn !== reads && drawnWrong(text)) {
          wrong.set(paragraph, reads);
        }
      }
      if (wrong.size === 0) continue;
      const [first, reads] = [...wrong][0]!;
      const sample = plainText({ paragraphs: [first] }).slice(0, 40);
      const content = {
        paragraphs: prose.paragraphs.map((p) => (wrong.has(p) ? turned(p, wrong.get(p)!) : p)),
      };
      problems.push({
        elementIds: [element.id],
        message: `${wrong.size === 1 ? 'A paragraph' : `${wrong.size} paragraphs`} here ${wrong.size === 1 ? 'is' : 'are'} laid out ${NAME[reads === 'rtl' ? 'ltr' : 'rtl']} while the text reads ${NAME[reads]} ("${sample}"). Set the direction of the paragraph to "${reads}".`,
        fix: [setText(slide.id, element.id, content)],
      });
    }
    return problems;
  },
};
