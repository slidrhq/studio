import { z } from 'zod';
import { hasElementId, walkElements } from '../queries';
import { AnimationStep, Archetype, Background, Id, RichText, Slide, Transition } from '../schema';
import {
  applyFields,
  baseDeck,
  checkTimeline,
  clampIndex,
  CommandError,
  defineCommand,
  ListIndex,
  moveToIndex,
  requireSlide,
} from './core';

export const slideAdd = defineCommand(
  z.strictObject({ type: z.literal('slide.add'), slide: Slide, index: ListIndex.optional() }),
  (deck, { slide, index }, touched) => {
    const before = baseDeck(deck);
    if (before.slides.some((s) => s.id === slide.id)) {
      throw new CommandError('conflict', `Slide "${slide.id}" already exists.`);
    }
    if (slide.layoutId && !before.layouts.some((l) => l.id === slide.layoutId)) {
      throw new CommandError('not_found', `Layout "${slide.layoutId}" does not exist.`);
    }
    const own = new Set<string>();
    for (const element of walkElements(slide.elements)) {
      if (own.has(element.id) || hasElementId(before, element.id)) {
        throw new CommandError('conflict', `Element id "${element.id}" is already in use.`);
      }
      own.add(element.id);
    }
    checkTimeline(slide.timeline, own);

    deck.slides.splice(clampIndex(index, deck.slides.length), 0, slide);
    touched.slideOrder = true;
    for (const element of slide.elements) touched.tree(slide.id, element);
    touched.slide(slide.id);
  },
);

export const slideRemove = defineCommand(
  z.strictObject({ type: z.literal('slide.remove'), slideIds: z.array(Id).min(1) }),
  (deck, { slideIds }, touched) => {
    const ids = new Set(slideIds);
    for (const id of ids) {
      const slide = requireSlide(deck, id);
      for (const element of slide.elements) touched.tree(id, element);
      touched.slide(id);
    }
    deck.slides = deck.slides.filter((s) => !ids.has(s.id));
    touched.slideOrder = true;
  },
);

/**
 * Moves slides to `toIndex`, counted in the list without them. They keep the order they had
 * in the deck.
 */
export const slideMove = defineCommand(
  z.strictObject({
    type: z.literal('slide.move'),
    slideIds: z.array(Id).min(1),
    toIndex: ListIndex,
  }),
  (deck, { slideIds, toIndex }, touched) => {
    for (const id of slideIds) requireSlide(deck, id);
    const moved = moveToIndex(deck.slides, new Set(slideIds), toIndex);
    if (!moved) return;
    deck.slides = moved;
    touched.slideOrder = true;
  },
);

export const slideUpdate = defineCommand(
  z.strictObject({
    type: z.literal('slide.update'),
    slideId: Id,
    /** A value replaces the field; `null` removes it. */
    patch: z
      .strictObject({
        name: z.string().min(1).nullable(),
        layoutId: Id.nullable(),
        archetype: Archetype.nullable(),
        background: Background.nullable(),
        notes: RichText.nullable(),
        transition: Transition.nullable(),
        hidden: z.boolean().nullable(),
        css: z.string().nullable(),
      })
      .partial(),
  }),
  (deck, { slideId, patch }, touched) => {
    const slide = requireSlide(deck, slideId);
    if (patch.layoutId && !deck.layouts.some((l) => l.id === patch.layoutId)) {
      throw new CommandError('not_found', `Layout "${patch.layoutId}" does not exist.`);
    }
    applyFields(slide, patch);
    touched.slide(slideId);
  },
);

/** Replaces the whole animation timeline of a slide. */
export const slideSetTimeline = defineCommand(
  z.strictObject({
    type: z.literal('slide.setTimeline'),
    slideId: Id,
    timeline: z.array(AnimationStep),
  }),
  (deck, { slideId, timeline }, touched) => {
    const slide = requireSlide(deck, slideId);
    const ids = new Set<string>();
    for (const element of walkElements(slide.elements)) ids.add(element.id);
    checkTimeline(timeline, ids);
    slide.timeline = timeline;
    touched.slide(slideId);
  },
);
