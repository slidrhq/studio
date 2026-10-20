import type { Frame } from '@slidr/model';
import { moveElement, pullIn } from '../arrange';
import {
  contentArea,
  describeBox,
  describeExcess,
  excess,
  fitsIn,
  isOutside,
  slideArea,
} from '../geometry';
import type { Item, Problem, Rule, SlideContext } from '../rule';

/**
 * What of an element has to stay on the slide: the glyphs of anything with text, the whole box
 * of a table or a chart. Images, shapes, lines, icons and video may run past the edge: that is
 * a full bleed, which the guidelines encourage (SPEC 9.1).
 *
 * A table is as tall as its rows, which grow to hold their text (ADR-033): a table whose frame
 * is on the slide can still run off the bottom of it.
 */
function mustStayOn({ element, measure }: Item): { what: string; box: Frame } | undefined {
  if (element.type === 'table') {
    const grown = measure.text?.overflow.y ?? 0;
    return { what: 'The table', box: { ...measure.box, h: measure.box.h + grown } };
  }
  if (element.type === 'chart') return { what: 'The chart', box: measure.box };
  return measure.text ? { what: 'The text', box: measure.text.ink } : undefined;
}

/** The fix of L02 and L03: the element moved until `box` is inside `area`, where it can be. */
function movedInto(ctx: SlideContext, item: Item, box: Frame, area: Frame): Pick<Problem, 'fix'> {
  const move = pullIn(box, area);
  const fix = move && moveElement(ctx, item, move);
  return fix ? { fix } : {};
}

/** L02: an element that leaves the slide, unless it is a visual that bleeds on purpose. */
export const L02: Rule = {
  id: 'L02',
  severity: 'error',
  agent: true,
  check(ctx) {
    const { deck, items } = ctx;
    const slide = slideArea(deck);
    const problems: Problem[] = [];
    for (const item of items) {
      const { element, measure } = item;
      if (isOutside(measure.box, slide)) {
        problems.push({
          elementIds: [element.id],
          message: `The ${element.type} is entirely outside the slide (it is at ${describeBox(measure.box)}; the slide is ${slide.w}x${slide.h}), so nothing of it shows. Move it onto the slide or delete it.`,
          ...movedInto(ctx, item, measure.box, slide),
        });
        continue;
      }
      const must = mustStayOn(item);
      if (must && !fitsIn(must.box, slide)) {
        problems.push({
          elementIds: [element.id],
          message: `${must.what} reaches ${describeExcess(excess(must.box, slide))} of the slide (it is at ${describeBox(must.box)}; the slide is ${slide.w}x${slide.h}) and is cut off there. Move or resize it so all of it is on the slide.`,
          ...movedInto(ctx, item, must.box, slide),
        });
      }
    }
    return problems;
  },
};

/**
 * L03: text in the safe margins. Text that leaves the slide altogether is L02's, and the text
 * a chart draws is the user's to hear of, not the agent's (see `chart.ts`).
 */
export const L03: Rule = {
  id: 'L03',
  severity: 'warning',
  agent: true,
  check(ctx) {
    const { deck, items } = ctx;
    const slide = slideArea(deck);
    const safe = contentArea(deck);
    const problems: Problem[] = [];
    for (const item of items) {
      const { element, measure } = item;
      const ink = measure.text?.ink;
      if (element.type === 'chart' || !ink || !fitsIn(ink, slide) || fitsIn(ink, safe)) continue;
      problems.push({
        elementIds: [element.id],
        message: `The text reaches ${describeExcess(excess(ink, safe))} of the safe area (the text is at ${describeBox(ink)}; the safe area is ${describeBox(safe)}). Only backgrounds, images and decoration may go into the margins: move or resize the text.`,
        ...movedInto(ctx, item, ink, safe),
      });
    }
    return problems;
  },
};
