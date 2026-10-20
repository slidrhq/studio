import { z } from 'zod';
import type { Element } from '../schema';
import {
  assetAdd,
  assetRemove,
  deckSetMeta,
  layoutAdd,
  layoutRemove,
  layoutUpdate,
  themeReplace,
  themeUpdate,
} from './deck';
import {
  elementAdd,
  elementGroup,
  elementRemove,
  elementReorder,
  elementReplace,
  elementUngroup,
  elementUpdate,
  textSet,
} from './element';
import { slideAdd, slideMove, slideRemove, slideSetTimeline, slideUpdate } from './slide';

export * from './core';

/**
 * The closed set of commands (CMD-01). The UI and the agent change the deck through these and
 * through nothing else; adding one is a contract change (docs/adr/ADR-007).
 */
export const commandDefs = {
  'deck.setMeta': deckSetMeta,
  'theme.update': themeUpdate,
  'theme.replace': themeReplace,
  'layout.add': layoutAdd,
  'layout.update': layoutUpdate,
  'layout.remove': layoutRemove,
  'asset.add': assetAdd,
  'asset.remove': assetRemove,
  'slide.add': slideAdd,
  'slide.remove': slideRemove,
  'slide.move': slideMove,
  'slide.update': slideUpdate,
  'slide.setTimeline': slideSetTimeline,
  'element.add': elementAdd,
  'element.remove': elementRemove,
  'element.replace': elementReplace,
  'element.update': elementUpdate,
  'element.reorder': elementReorder,
  'element.group': elementGroup,
  'element.ungroup': elementUngroup,
  'text.set': textSet,
} as const;

export const Command = z.discriminatedUnion('type', [
  deckSetMeta.schema,
  themeUpdate.schema,
  themeReplace.schema,
  layoutAdd.schema,
  layoutUpdate.schema,
  layoutRemove.schema,
  assetAdd.schema,
  assetRemove.schema,
  slideAdd.schema,
  slideRemove.schema,
  slideMove.schema,
  slideUpdate.schema,
  slideSetTimeline.schema,
  elementAdd.schema,
  elementRemove.schema,
  elementReplace.schema,
  elementUpdate.schema,
  elementReorder.schema,
  elementGroup.schema,
  elementUngroup.schema,
  textSet.schema,
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

type PatchOf<T> = T extends unknown
  ? {
      [K in Exclude<keyof T, 'id' | 'type' | 'children'>]?:
        T[K] | (undefined extends T[K] ? null : never);
    }
  : never;

/** The fields `element.update` accepts, typed per element type. `null` removes a field. */
export type ElementPatch = PatchOf<Element>;

/** Builds an `element.update` command with a typed patch. */
export function updateElement(
  slideId: string,
  elementId: string,
  patch: ElementPatch,
): CommandOf<'element.update'> {
  return { type: 'element.update', slideId, elementId, patch };
}
