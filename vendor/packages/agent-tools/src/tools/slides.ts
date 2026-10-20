import { Archetype, Background, duplicateSlide, Transition } from '@slidr/model';
import { transitionTypes } from '@slidr/runtime/names';
import { z } from 'zod';
import { getSlide } from '../lookup';
import { markdownToRichText } from '../markdown';
import { DeckApiError, defineTool } from '../tool';
import { checkTransitionType } from './content';
import { about, afterSlide, indexAfter } from './shared';

export const slideUpdate = defineTool({
  name: 'slide_update',
  description:
    'Changes fields of a slide. Each given field replaces the old value whole; null removes it. Changing layoutId only links the slide to another layout: it does not move content. Returns the ids changed and, when lint runs, findings for the slide.',
  input: z.strictObject({
    slideId: z.string().min(1),
    name: z.string().min(1).nullable().optional(),
    layoutId: z.string().min(1).nullable().optional().describe('An id from deck_get_theme.'),
    archetype: Archetype.nullable()
      .optional()
      .describe('What kind of slide this is, for a slide without a layout.'),
    background: about(
      Background.nullable(),
      'Overrides the theme background; null goes back to it.',
    ).optional(),
    notes: z
      .string()
      .nullable()
      .optional()
      .describe('Speaker notes, in the Markdown of text_set; null removes them.'),
    transition: about(
      Transition.nullable(),
      `The transition into this slide. type: ${transitionTypes.join(', ')}.`,
    ).optional(),
    hidden: z.boolean().optional().describe('Hidden slides are skipped when presenting.'),
    css: z
      .string()
      .nullable()
      .optional()
      .describe('Slide-level stylesheet kept as is (@keyframes, @font-face, ...).'),
  }),
  scopes: ['deck', 'slide'],
  writes: true,
  run({ slideId, notes, ...fields }, ctx) {
    const slide = getSlide(ctx.deck, slideId);
    // The same check as in `animation_set`: an unknown type would play as a plain fade.
    if (fields.transition) checkTransitionType(fields.transition.type);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) patch[key] = value;
    if (notes !== undefined) {
      patch.notes =
        notes === null
          ? null
          : markdownToRichText(notes, { deckDir: ctx.deck.meta.dir, previous: slide.notes });
    }
    if (Object.keys(patch).length === 0) {
      throw new DeckApiError('invalid_input', 'Nothing to change: give at least one field.');
    }
    ctx.write([{ type: 'slide.update', slideId, patch }]);
    return {};
  },
});

export const slideDelete = defineTool({
  name: 'slide_delete',
  description: 'Deletes slides with everything on them. Returns the ids removed.',
  input: z.strictObject({ slideIds: z.array(z.string().min(1)).min(1) }),
  scopes: ['deck'],
  writes: true,
  run({ slideIds }, ctx) {
    for (const id of slideIds) getSlide(ctx.deck, id);
    ctx.write([{ type: 'slide.remove', slideIds }]);
    return {};
  },
});

export const slideDuplicate = defineTool({
  name: 'slide_duplicate',
  description:
    'Copies a slide, by default right after the original. The copy gets new ids for itself, its elements and its animation steps. Returns `slideId` of the copy and all ids created.',
  input: z.strictObject({
    slideId: z.string().min(1),
    afterSlideId: afterSlide('right after the original'),
  }),
  scopes: ['deck'],
  writes: true,
  run({ slideId, afterSlideId }, ctx) {
    const source = getSlide(ctx.deck, slideId);
    const index = indexAfter(ctx.deck, afterSlideId, ctx.deck.slides.indexOf(source) + 1);
    const command = duplicateSlide(ctx.deck, slideId, { index });
    ctx.write([command]);
    return { data: { slideId: command.slide.id } };
  },
});

export const slidesReorder = defineTool({
  name: 'slides_reorder',
  description:
    'Moves slides to just after another slide (or to the start with null). Moved slides keep their order among themselves. Returns the new order of slide ids.',
  input: z.strictObject({
    slideIds: z.array(z.string().min(1)).min(1),
    afterSlideId: z
      .string()
      .min(1)
      .nullable()
      .describe('The slide to put them after, which must not be one of them; null: the start.'),
  }),
  scopes: ['deck'],
  writes: true,
  run({ slideIds, afterSlideId }, ctx) {
    for (const id of slideIds) getSlide(ctx.deck, id);
    const moving = new Set(slideIds);
    let toIndex = 0;
    if (afterSlideId !== null) {
      getSlide(ctx.deck, afterSlideId);
      if (moving.has(afterSlideId)) {
        throw new DeckApiError('invalid_input', 'afterSlideId cannot be one of the moved slides.');
      }
      toIndex =
        ctx.deck.slides.filter((s) => !moving.has(s.id)).findIndex((s) => s.id === afterSlideId) +
        1;
    }
    ctx.write([{ type: 'slide.move', slideIds, toIndex }]);
    return { data: { order: ctx.deck.slides.map((s) => s.id) } };
  },
});
