import type { Command } from '@slidr/model';
import type { Item, Rule, SlideContext } from '../rule';
import { mapRuns, proseOf, setText, styleOf } from '../text';

/** The smallest text that reads from the back of a room, in slide pixels (SPEC 9.1). */
export const MIN_FONT_SIZE = 24;

/** One decimal: a size scaled by `shrink` is rarely whole. */
export function px(size: number): string {
  return `${Math.round(size * 10) / 10}px`;
}

/** The smallest size an element's text is drawn at; undefined when it shows none. */
export function smallestText({ measure }: Item): number | undefined {
  const spans = measure.text?.spans ?? [];
  return spans.length ? Math.min(...spans.map((span) => span.fontSize)) : undefined;
}

export const tooSmall = (size: number) => Math.round(size * 10) / 10 < MIN_FONT_SIZE;

/**
 * The fix: every run that is set smaller than the minimum is set at the minimum. Only where the
 * model says the size (a mark, or the style of the paragraph); text that `shrink` scaled down,
 * or that free HTML draws, has no such fix. Superscript and subscript stay as they are.
 */
function fixOf(ctx: SlideContext, { element, measure }: Item): Command[] | undefined {
  const prose = proseOf(element);
  if (!prose || (measure.text?.scale ?? 1) < 1) return undefined;
  const content = mapRuns(prose, (run, paragraph) => {
    const size = run.marks?.size ?? styleOf(ctx.deck.theme, paragraph).size;
    if (run.marks?.script || size >= MIN_FONT_SIZE) return run;
    return { ...run, marks: { ...run.marks, size: MIN_FONT_SIZE } };
  });
  return content ? [setText(ctx.slide.id, element.id, content)] : undefined;
}

/**
 * L04: text drawn smaller than 24px, after `shrink` and after an `html` element's scaling. The
 * text of a chart is judged by the user's rule of the same number (see `chart.ts`).
 */
export const L04: Rule = {
  id: 'L04',
  severity: 'warning',
  agent: true,
  check(ctx) {
    return ctx.items.flatMap((item) => {
      const { element, measure } = item;
      const smallest = smallestText(item);
      if (element.type === 'chart' || smallest === undefined || !tooSmall(smallest)) return [];
      const scale = measure.text?.scale ?? 1;
      const advice =
        scale < 1
          ? `autoFit "shrink" scaled the text to ${Math.round(scale * 100)}% to fit its box: shorten the text or enlarge the frame.`
          : `Make it ${MIN_FONT_SIZE}px or larger.`;
      const fix = fixOf(ctx, item);
      return [
        {
          elementIds: [element.id],
          message: `The smallest text here is drawn at ${px(smallest)}; the minimum readable size is ${MIN_FONT_SIZE}px. ${advice}`,
          ...(fix ? { fix } : {}),
        },
      ];
    });
  },
};
