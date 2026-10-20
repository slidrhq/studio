import type { Direction, Paragraph } from '@slidr/model';

const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const LETTER = /\p{L}/u;

/**
 * The direction a paragraph reads in: its own, and for `auto` that of its first letter, as the
 * renderer finds it. Text without a letter (a figure, an empty line) reads in the deck's.
 */
export function readingDirection(paragraph: Paragraph, deckDir: Direction): Direction {
  if (paragraph.dir !== 'auto') return paragraph.dir;
  for (const run of paragraph.runs) {
    for (const char of run.text) {
      if (LETTER.test(char)) return RTL_LETTER.test(char) ? 'rtl' : 'ltr';
    }
  }
  return deckDir;
}

/**
 * The direction text is laid out in when the app sets it, as `text_set` and the samples of the
 * templates do and as the design check judges it (L15): the deck's, unless the text has letters
 * and none of them is of that direction. A Hebrew sentence that opens with an English term is
 * still a Hebrew sentence; "ACME Corp." in a Hebrew deck is not, and laid out right to left its
 * full stop would stand before the "A".
 */
export function textDirection(text: string, deckDir: Direction): Direction {
  let rtl = false;
  let ltr = false;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    if (RTL_LETTER.test(char)) rtl = true;
    else ltr = true;
  }
  if (deckDir === 'rtl') return ltr && !rtl ? 'ltr' : 'rtl';
  return rtl && !ltr ? 'rtl' : 'ltr';
}

/**
 * The alignment that puts a paragraph on the side a placeholder means. A layout says `start`
 * and `end` for the deck's direction, and a paragraph's alignment is counted in its own: an
 * English line in a Hebrew deck is `end` where the layout says `start`, so that it sits on the
 * right with the Hebrew lines around it.
 */
export function seatAlign(
  align: Paragraph['align'],
  paragraph: Paragraph,
  deckDir: Direction,
): Paragraph['align'] {
  if (readingDirection(paragraph, deckDir) === deckDir) return align;
  return align === 'start' ? 'end' : align === 'end' ? 'start' : align;
}
