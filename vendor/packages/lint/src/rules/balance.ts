import { area, intersection, slideArea } from '../geometry';
import type { Rule } from '../rule';
import { hasPhoto } from '../visual';
import { contentBoxes } from './coverage';

/** The centre of gravity may be this share of the slide's width or height away from its centre. */
export const MAX_OFFSET = 0.18;

/**
 * L08: the visual centre of gravity is far from the centre of the slide (SPEC 9.1: "the content
 * is balanced, unless the layout is asymmetric on purpose and balanced by a counter-element").
 * The centre of gravity is the centre of everything that counts as content: what was written
 * on the slide and what its layout draws, so a colour field on one side does balance text on
 * the other. Each piece weighs as the square root of its area on the slide: the eye does not
 * give a flat field ten times the weight of a block of text a tenth its size, and by area alone
 * the field would pull every slide towards itself. Information only: whether a slide leans on
 * purpose is not something a measure can tell.
 */
export const L08: Rule = {
  id: 'L08',
  severity: 'info',
  agent: false,
  check(ctx) {
    const slide = slideArea(ctx.deck);
    const own = contentBoxes(ctx, slide);
    // An empty slide is L07's; a photograph behind the slide weighs on all of it.
    if (own.length === 0 || hasPhoto(ctx.background)) return [];
    let weight = 0;
    let x = 0;
    let y = 0;
    for (const box of [...own, ...contentBoxes(ctx.layout, slide)]) {
      const shown = intersection(box, slide);
      if (!shown) continue;
      const w = Math.sqrt(area(shown));
      weight += w;
      x += w * (shown.x + shown.w / 2);
      y += w * (shown.y + shown.h / 2);
    }
    if (weight === 0) return [];
    const dx = x / weight - slide.w / 2;
    const dy = y / weight - slide.h / 2;
    const far = [
      ...(Math.abs(dx) > MAX_OFFSET * slide.w
        ? [`${Math.round(Math.abs(dx))}px to the ${dx < 0 ? 'left' : 'right'} of`]
        : []),
      ...(Math.abs(dy) > MAX_OFFSET * slide.h
        ? [`${Math.round(Math.abs(dy))}px ${dy < 0 ? 'above' : 'below'}`]
        : []),
    ];
    if (far.length === 0) return [];
    return [
      {
        elementIds: [],
        message: `The content's centre of gravity is ${far.join(' and ')} the centre of the slide (it may be up to ${Math.round(MAX_OFFSET * 100)}% of the slide away). If the slide does not lean on purpose, move the content towards the middle or balance it with an element on the other side.`,
      },
    ];
  },
};
