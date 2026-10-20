import { plainText, slideArchetype, walkElements, type Element, type Slide } from '@slidr/model';
import { z } from 'zod';
import { getElement, getSlide, slideNumber } from '../lookup';
import { defineTool } from '../tool';

const ALL = ['deck', 'slide', 'object'] as const;

/**
 * The text an element holds: a text box's, and what is written on a shape (a title on a band).
 * A shape with nothing written on it is a drawing, and holds none.
 */
function textIn(element: Element): string | undefined {
  if (element.type === 'text') return plainText(element.content).slice(0, 120);
  if (element.type !== 'shape' || !element.content) return undefined;
  const text = plainText(element.content);
  return text.trim() ? text.slice(0, 120) : undefined;
}

function slideTitle(slide: Slide): string | undefined {
  let first: string | undefined;
  for (const element of walkElements(slide.elements)) {
    const text = textIn(element);
    if (text === undefined) continue;
    if (element.role === 'title') return text;
    first ??= text;
  }
  return first;
}

/** How many elements a slide has, the ones inside its groups and the groups themselves too. */
function elementCount(slide: Slide): number {
  let count = 0;
  for (const _ of walkElements(slide.elements)) count++;
  return count;
}

export const deckGetOutline = defineTool({
  name: 'deck_get_outline',
  description:
    'The structure of the deck: title, language, direction, theme name, and for each slide its number (1 = first, as the user counts), id, name, title text, layout and archetype, number of elements (those inside groups too), and whether it is hidden.',
  input: z.strictObject({}),
  scopes: ALL,
  writes: false,
  run(_input, { deck }) {
    return {
      data: {
        title: deck.meta.title,
        lang: deck.meta.lang,
        dir: deck.meta.dir,
        theme: deck.theme.name,
        slideCount: deck.slides.length,
        slides: deck.slides.map((slide, i) => {
          const archetype = slideArchetype(deck, slide);
          return {
            number: i + 1,
            id: slide.id,
            ...(slide.name ? { name: slide.name } : {}),
            ...(slideTitle(slide) ? { title: slideTitle(slide) } : {}),
            ...(slide.layoutId ? { layoutId: slide.layoutId } : {}),
            ...(archetype ? { archetype } : {}),
            elements: elementCount(slide),
            ...(slide.hidden ? { hidden: true } : {}),
          };
        }),
      },
    };
  },
});

export const deckGetTheme = defineTool({
  name: 'deck_get_theme',
  description:
    'The full theme (colour tokens, font pairs, text styles, radius, shadow, backgrounds) and the layouts: id, name, archetype and placeholders (role and frame). With the template library running, also the templates that template_apply accepts.',
  input: z.strictObject({}),
  scopes: ALL,
  writes: false,
  async run(_input, { deck, services }) {
    const templates = services.templates ? await services.templates.list() : undefined;
    return {
      data: {
        theme: deck.theme,
        layouts: deck.layouts.map((layout) => ({
          id: layout.id,
          name: layout.name,
          archetype: layout.archetype,
          placeholders: layout.placeholders.map((p) => ({
            id: p.id,
            role: p.role,
            frame: p.frame,
            ...(p.styleRef ? { styleRef: p.styleRef } : {}),
          })),
        })),
        ...(templates ? { templates } : {}),
      },
    };
  },
});

export const slideGet = defineTool({
  name: 'slide_get',
  description:
    'The full model of one slide: background, elements (array order is z-order, last on top; frames in slide pixels on 1920x1080; group children relative to the group), animation timeline, transition, notes, CSS. Also its number in the deck.',
  input: z.strictObject({ slideId: z.string().min(1) }),
  scopes: ALL,
  writes: false,
  run({ slideId }, { deck }) {
    return { data: { number: slideNumber(deck, slideId), slide: getSlide(deck, slideId) } };
  },
});

export const elementGet = defineTool({
  name: 'element_get',
  description:
    'The full model of one element, with the id of its slide and, when it is inside a group, of the group. Element ids are unique in the deck, so slideId is optional.',
  input: z.strictObject({
    elementId: z.string().min(1),
    slideId: z.string().min(1).optional(),
  }),
  scopes: ALL,
  writes: false,
  run({ elementId, slideId }, { deck }) {
    const found = getElement(deck, elementId, slideId);
    return {
      data: {
        slideId: found.slide.id,
        ...(found.parent ? { parentId: found.parent.id } : {}),
        element: found.element,
      },
    };
  },
});

export const selectionGet = defineTool({
  name: 'selection_get',
  description:
    'What the user is looking at: the current slide (id, number, name), the selected slides, the selected elements (id, type, name, role), the element whose text is being edited, if any, and the text selected in it (`textSelection`, as text_replace counts it).',
  input: z.strictObject({}),
  scopes: ALL,
  writes: false,
  requires: 'ui',
  run(_input, { deck, services }) {
    const selection = services.ui!.selection();
    const current = deck.slides.find((s) => s.id === selection.currentSlideId);
    const elements = current
      ? [...walkElements(current.elements)].filter((e) =>
          selection.selectedElementIds.includes(e.id),
        )
      : [];
    return {
      data: {
        currentSlide: current
          ? {
              id: current.id,
              number: slideNumber(deck, current.id),
              ...(current.name ? { name: current.name } : {}),
            }
          : null,
        selectedSlideIds: selection.selectedSlideIds,
        selectedElements: elements.map((e) => ({
          id: e.id,
          type: e.type,
          ...(e.name ? { name: e.name } : {}),
          ...(e.role ? { role: e.role } : {}),
        })),
        editingElementId: selection.editingElementId,
        textSelection: selection.textSelection ?? null,
      },
    };
  },
});
