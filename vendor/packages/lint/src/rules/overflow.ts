import { updateElement, type Command } from '@slidr/model';
import { contentArea, intersection, SLACK, slideArea } from '../geometry';
import type { Item, Rule, SlideContext } from '../rule';

function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function describe({ element, measure }: Item): string | undefined {
  const text = measure.text;
  if (!text) return undefined;
  const x = Math.round(text.overflow.x);
  const y = Math.round(text.overflow.y);
  const tall = text.overflow.y > SLACK;
  const wide = text.overflow.x > SLACK;
  if (!tall && !wide) return undefined;
  const { w, h } = element.frame;

  if (element.type === 'table') {
    return `The table is ${y}px taller than its frame (frame.h is ${h}): its rows grew to hold their text. Make the frame taller, shorten the cell text, or use a smaller text size.`;
  }
  if (element.type === 'shape') {
    const by = tall ? `${y}px taller` : `${x}px wider`;
    return `The text inside the shape is ${by} than the shape (frame is ${w}x${h}). Shorten the text, enlarge the shape, or use a smaller text size.`;
  }
  if (element.type !== 'text') return undefined;
  if (!tall) {
    const fix =
      element.wrap === false
        ? 'wrap is off, so each paragraph stays on one line. Widen the frame, shorten the text, or set wrap to true.'
        : 'Widen the frame or shorten the text.';
    return `The text is ${x}px wider than its box (frame.w is ${w}): ${fix}`;
  }
  const fix =
    element.autoFit === 'shrink'
      ? `autoFit "shrink" already scaled it to ${percent(text.scale)}, the smallest it goes. Shorten the text or enlarge the frame.`
      : 'Shorten the text, make the frame taller, or set autoFit to "shrink".';
  return `The text is ${y}px taller than its box (frame.h is ${h}). ${fix}`;
}

/**
 * The fix the table of SPEC 9.2 names: a larger box where there is room for one, a smaller text
 * where there is not. Room: the taller box stays inside the safe area (inside the slide, for a
 * shape and a table) and reaches no other text.
 */
function fixOf(ctx: SlideContext, item: Item): Command[] | undefined {
  const { element, measure } = item;
  const text = measure.text;
  if (!text) return undefined;
  const tall = text.overflow.y > SLACK;
  const grown = { ...element.frame, h: Math.ceil(element.frame.h + text.overflow.y) };
  const grow = () => [updateElement(ctx.slide.id, element.id, { frame: grown })];
  const reach = { ...measure.box, h: measure.box.h + text.overflow.y };
  const within = (area: { y: number; h: number }) => reach.y + reach.h <= area.y + area.h + SLACK;

  if (element.type === 'table') return tall ? grow() : undefined;
  if (element.type === 'shape') return tall && within(slideArea(ctx.deck)) ? grow() : undefined;
  if (element.type !== 'text') return undefined;
  if (!tall) {
    return element.wrap === false
      ? [updateElement(ctx.slide.id, element.id, { wrap: null })]
      : undefined;
  }
  if (element.autoFit === 'shrink') return undefined;
  const meets = ctx.items.some(
    (other) => other !== item && other.measure.text && intersection(reach, other.measure.text.ink),
  );
  return within(contentArea(ctx.deck)) && !meets && element.rotation === 0
    ? grow()
    : [updateElement(ctx.slide.id, element.id, { autoFit: 'shrink' })];
}

/** L01: text that does not fit the box it is in, measured on the rendered slide. */
export const L01: Rule = {
  id: 'L01',
  severity: 'error',
  agent: true,
  check(ctx) {
    return ctx.items.flatMap((item) => {
      const message = describe(item);
      if (!message) return [];
      const fix = fixOf(ctx, item);
      return [{ elementIds: [item.element.id], message, ...(fix ? { fix } : {}) }];
    });
  },
};
