import {
  alignElements,
  distributeElements,
  Element,
  groupElements,
  reorderElements,
  type Command,
} from '@slidr/model';
import { z } from 'zod';
import { getElement, getElementsOnOneSlide, getSlide } from '../lookup';
import { DeckApiError, defineTool } from '../tool';
import { about } from './shared';

const Id = z.string().min(1);

export const elementAdd = defineTool({
  name: 'element_add',
  description:
    'Adds one element (a group may hold more) to a slide. Prefer slide_create_from_html for new slides and text_set for text. Returns `elementId` and all ids created.',
  input: z.strictObject({
    slideId: Id,
    element: about(
      Element,
      'The complete element JSON, as element_get returns it. Give it a new id that is not used in the deck: "e_" and 8 lowercase letters or digits. Use rotation 0 and opacity 1 unless you mean otherwise. Frames are in slide pixels on 1920x1080.',
    ),
    parentId: Id.optional().describe(
      'Adds the element inside this group; its frame is then relative to the group.',
    ),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Position in z-order among its siblings, 0 = bottom. Default: on top.'),
  }),
  scopes: ['deck', 'slide'],
  writes: true,
  run({ slideId, element, parentId, index }, ctx) {
    getSlide(ctx.deck, slideId);
    if (parentId !== undefined) getElement(ctx.deck, parentId, slideId);
    ctx.write([
      {
        type: 'element.add',
        slideId,
        element,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(index !== undefined ? { index } : {}),
      },
    ]);
    return { data: { elementId: element.id } };
  },
});

export const elementUpdate = defineTool({
  name: 'element_update',
  description:
    'Changes fields of one element, keeping its id, animation and everything not named. Use it for small edits instead of re-creating content. Returns the ids changed.',
  input: z.strictObject({
    elementId: Id,
    slideId: Id.optional(),
    patch: z
      .record(z.string(), z.unknown())
      .describe(
        'Fields to change, named as in the element JSON. Each replaces the field whole and null removes an optional field, except `frame`, which may be partial ({"x": 100} moves only x). id, type and children cannot change.',
      ),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: true,
  run({ elementId, slideId, patch }, ctx) {
    const { slide, element } = getElement(ctx.deck, elementId, slideId);
    if (Object.keys(patch).length === 0) {
      throw new DeckApiError('invalid_input', 'patch is empty: name at least one field.');
    }
    const frame: unknown = patch.frame;
    const merged =
      frame && typeof frame === 'object'
        ? { ...patch, frame: { ...element.frame, ...frame } }
        : patch;
    ctx.write([{ type: 'element.update', slideId: slide.id, elementId, patch: merged }]);
    return {};
  },
});

export const elementDelete = defineTool({
  name: 'element_delete',
  description:
    'Deletes elements, with their animation steps; a group left empty goes too. The elements may be on different slides. Returns the ids removed.',
  input: z.strictObject({ elementIds: z.array(Id).min(1), slideId: Id.optional() }),
  scopes: ['deck', 'slide'],
  writes: true,
  run({ elementIds, slideId }, ctx) {
    const bySlide = new Map<string, string[]>();
    for (const id of elementIds) {
      const { slide } = getElement(ctx.deck, id, slideId);
      bySlide.set(slide.id, [...(bySlide.get(slide.id) ?? []), id]);
    }
    ctx.write(
      [...bySlide].map(([id, ids]) => ({ type: 'element.remove', slideId: id, elementIds: ids })),
    );
    return {};
  },
});

const ACTIONS = [
  'align',
  'distribute',
  'front',
  'back',
  'forward',
  'backward',
  'group',
  'ungroup',
] as const;

export const elementsArrange = defineTool({
  name: 'elements_arrange',
  description:
    'Arranges elements of one slide that share a parent: align, distribute (equal gaps), change z-order (front, back, forward, backward), group, or ungroup. Alignment uses the box each element covers on screen, in slide coordinates (left is left in any direction). Returns the ids changed, and `groupId` after a group.',
  input: z.strictObject({
    action: z.enum(ACTIONS),
    elementIds: z.array(Id).min(1).describe('The elements; for ungroup, the groups to dissolve.'),
    slideId: Id.optional(),
    edge: z
      .enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])
      .optional()
      .describe('For align: the edge or centre line to line up.'),
    axis: z.enum(['horizontal', 'vertical']).optional().describe('For distribute.'),
    relativeTo: z
      .enum(['selection', 'slide'])
      .optional()
      .describe(
        'For align and distribute: the bounds of the elements themselves (default; a single element aligns to the slide) or the slide.',
      ),
    name: z.string().min(1).optional().describe('For group: a name for the new group.'),
  }),
  scopes: ['deck', 'slide'],
  writes: true,
  run({ action, elementIds, slideId, edge, axis, relativeTo, name }, ctx) {
    const { slide } = getElementsOnOneSlide(ctx.deck, elementIds, slideId);
    let commands: Command[];
    let data: Record<string, unknown> | undefined;
    switch (action) {
      case 'align':
        if (!edge) throw new DeckApiError('invalid_input', 'align needs `edge`.');
        commands = alignElements(slide, elementIds, edge, relativeTo);
        break;
      case 'distribute':
        if (!axis) throw new DeckApiError('invalid_input', 'distribute needs `axis`.');
        commands = distributeElements(slide, elementIds, axis, relativeTo);
        break;
      case 'group': {
        const command = groupElements(ctx.deck, slide.id, elementIds, name ? { name } : {});
        commands = [command];
        data = { groupId: command.groupId };
        break;
      }
      case 'ungroup':
        commands = elementIds.map((groupId) => ({
          type: 'element.ungroup',
          slideId: slide.id,
          groupId,
        }));
        break;
      default:
        commands = reorderElements(slide, elementIds, action);
    }
    if (commands.length > 0) ctx.write(commands);
    return data ? { data } : {};
  },
});
