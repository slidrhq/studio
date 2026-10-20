import {
  plainText,
  type Command,
  type Element,
  type Paragraph,
  type RichText,
  type Run,
  type TextStyle,
  type Theme,
} from '@slidr/model';

/**
 * Words as a reader counts them, in any script: runs of characters between spaces that hold a
 * letter or a digit. An API name with a Hebrew prefix and a URL are one word each; a lone dash
 * or bullet is none.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** The text a free HTML block shows, roughly: its markup without tags, styles and scripts. */
function htmlText(markup: string): string {
  return markup
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

/** The rich text of an element that is read as running text: a text box or a shape with text. */
export function proseOf(element: Element): RichText | undefined {
  if (element.type === 'text') return element.content;
  if (element.type === 'shape') return element.content;
  return undefined;
}

/**
 * Words of an element's running text. A table is data, not prose, and is not counted; the text
 * of an `html` element is.
 */
export function wordsIn(element: Element): number {
  if (element.type === 'html') return countWords(htmlText(element.markup));
  const prose = proseOf(element);
  return prose ? countWords(plainText(prose)) : 0;
}

/** List items of an element, at any level, that have text. */
export function bulletsIn(element: Element): number {
  const prose = proseOf(element);
  if (!prose) return 0;
  return prose.paragraphs.filter((p) => p.list && p.runs.some((run) => run.text.trim() !== ''))
    .length;
}

/** A `text.set` for the text of a text box or of a shape. */
export function setText(slideId: string, elementId: string, content: RichText): Command {
  return { type: 'text.set', slideId, elementId, content };
}

/**
 * A copy of a rich text with every run that holds text passed through `change`; undefined when
 * no run came back different. The runs that did not change keep their identity.
 */
export function mapRuns(
  content: RichText,
  change: (run: Run, paragraph: Paragraph) => Run,
): RichText | undefined {
  let changed = false;
  const paragraphs = content.paragraphs.map((paragraph) => {
    const runs = paragraph.runs.map((run) => {
      const next = run.text === '' ? run : change(run, paragraph);
      if (next !== run) changed = true;
      return next;
    });
    return runs.some((run, i) => run !== paragraph.runs[i]) ? { ...paragraph, runs } : paragraph;
  });
  return changed ? { paragraphs } : undefined;
}

/** The text style a paragraph is set in: its own, or body, as the renderer has it. */
export function styleOf(theme: Theme, paragraph: Paragraph): TextStyle {
  return theme.textStyles[paragraph.styleRef ?? 'body'];
}

/** Letters of the scripts written right to left. */
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const LETTER = /\p{L}/u;

/** How many letters of a text are written right to left, and how many left to right. */
export function letterCount(text: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    if (RTL_LETTER.test(char)) rtl++;
    else ltr++;
  }
  return { rtl, ltr };
}

/**
 * The direction a paragraph is laid out in, as the renderer decides it: its own, and for `auto`
 * that of its first letter, or the deck's when it has none.
 */
export function drawnDirection(
  dir: Paragraph['dir'],
  text: string,
  fallback: 'rtl' | 'ltr',
): 'rtl' | 'ltr' {
  if (dir !== 'auto') return dir;
  for (const char of text) {
    if (LETTER.test(char)) return RTL_LETTER.test(char) ? 'rtl' : 'ltr';
  }
  return fallback;
}
