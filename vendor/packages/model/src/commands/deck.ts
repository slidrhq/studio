import { current, isDraft } from 'immer';
import { z } from 'zod';
import { isAssetFileName, referencedAssetIds } from '../queries';
import {
  Archetype,
  AssetMeta,
  Background,
  Direction,
  Element,
  FontPair,
  Id,
  Layout,
  Placeholder,
  Shadow,
  TextStyle,
  TextStyleRef,
  Theme,
} from '../schema';
import { applyFields, clampIndex, CommandError, defineCommand, ListIndex } from './core';

export const deckSetMeta = defineCommand(
  z.strictObject({
    type: z.literal('deck.setMeta'),
    patch: z
      .strictObject({
        title: z.string(),
        lang: z.string().min(1),
        dir: Direction,
        imageStyle: z.string().nullable(),
      })
      .partial(),
  }),
  (deck, { patch }, touched) => {
    applyFields(deck.meta, patch);
    touched.meta = true;
  },
);

const ThemeColors = Theme.shape.colors;

export const themeUpdate = defineCommand(
  z.strictObject({
    type: z.literal('theme.update'),
    /** `colors`, `fonts` and `textStyles` are merged key by key; the other fields are replaced. */
    patch: z
      .strictObject({
        name: z.string().min(1),
        colors: ThemeColors.partial(),
        fonts: z.strictObject({ heading: FontPair, body: FontPair }).partial(),
        textStyles: z.partialRecord(TextStyleRef, TextStyle),
        radius: z.number().nonnegative(),
        shadow: Shadow,
        background: Background,
        backgroundVariants: z.array(Background),
      })
      .partial(),
  }),
  (deck, { patch }, touched) => {
    const { colors, fonts, textStyles, ...rest } = patch;
    applyFields(deck.theme, rest);
    if (colors) applyFields(deck.theme.colors, colors);
    if (fonts) applyFields(deck.theme.fonts, fonts);
    if (textStyles) applyFields(deck.theme.textStyles, textStyles);
    touched.theme = true;
  },
);

export const themeReplace = defineCommand(
  z.strictObject({ type: z.literal('theme.replace'), theme: Theme }),
  (deck, { theme }, touched) => {
    deck.theme = theme;
    touched.theme = true;
  },
);

export const layoutAdd = defineCommand(
  z.strictObject({ type: z.literal('layout.add'), layout: Layout, index: ListIndex.optional() }),
  (deck, { layout, index }, touched) => {
    if (deck.layouts.some((l) => l.id === layout.id)) {
      throw new CommandError('conflict', `Layout "${layout.id}" already exists.`);
    }
    deck.layouts.splice(clampIndex(index, deck.layouts.length), 0, layout);
    touched.layouts.add(layout.id);
  },
);

export const layoutUpdate = defineCommand(
  z.strictObject({
    type: z.literal('layout.update'),
    layoutId: Id,
    patch: z
      .strictObject({
        name: z.string().min(1),
        archetype: Archetype,
        background: Background.nullable(),
        placeholders: z.array(Placeholder),
        decorations: z.array(Element),
        objects: z.array(Element),
      })
      .partial(),
  }),
  (deck, { layoutId, patch }, touched) => {
    const layout = deck.layouts.find((l) => l.id === layoutId);
    if (!layout) throw new CommandError('not_found', `Layout "${layoutId}" does not exist.`);
    applyFields(layout, patch);
    touched.layouts.add(layoutId);
  },
);

/** Slides that used the layout keep their content and lose the link to it. */
export const layoutRemove = defineCommand(
  z.strictObject({ type: z.literal('layout.remove'), layoutId: Id }),
  (deck, { layoutId }, touched) => {
    const index = deck.layouts.findIndex((l) => l.id === layoutId);
    if (index < 0) throw new CommandError('not_found', `Layout "${layoutId}" does not exist.`);
    deck.layouts.splice(index, 1);
    for (const slide of deck.slides) {
      if (slide.layoutId !== layoutId) continue;
      delete slide.layoutId;
      touched.slide(slide.id);
    }
    touched.layouts.add(layoutId);
  },
);

/**
 * Registers an asset the storage layer has already stored. The same content is added once.
 *
 * `file` is the name of that file inside `assets/`. A path or an address is refused here, where
 * whoever sent it can read why: the deck would hold a picture that is never drawn, and that no
 * save can put in the file (`isAssetFileName`; the storage layer judges by the same rule).
 */
export const assetAdd = defineCommand(
  z.strictObject({ type: z.literal('asset.add'), asset: AssetMeta }),
  (deck, { asset }, touched) => {
    if (!isAssetFileName(asset.file)) {
      throw new CommandError(
        'invalid_payload',
        `asset.add: "file" must be the name of a file stored in the deck's assets folder, not a path or an address: ${JSON.stringify(asset.file)}. The command registers a file that is already there; it does not fetch or copy one.`,
      );
    }
    if (deck.assets[asset.id]) return;
    deck.assets[asset.id] = asset;
    touched.assets.add(asset.id);
  },
);

/**
 * Takes assets out of the deck's table (ADR-069). An asset the deck still uses is refused, and
 * the command with it: an image, a clip, a fill or a poster, an id inside free HTML or CSS, and
 * every font, which is used by its family's name (`referencedAssetIds`). So nothing on a slide is
 * left pointing at a file the deck no longer lists. The file stays where the storage put it, so
 * undo brings the asset back whole, and an asset nothing lists is not saved with the deck.
 */
export const assetRemove = defineCommand(
  z.strictObject({ type: z.literal('asset.remove'), assetIds: z.array(Id).min(1) }),
  (deck, { assetIds }, touched) => {
    const used = referencedAssetIds(isDraft(deck) ? current(deck) : deck);
    for (const id of assetIds) {
      if (!deck.assets[id]) throw new CommandError('not_found', `Asset "${id}" does not exist.`);
      if (used.has(id)) {
        throw new CommandError(
          'invalid_state',
          `Asset "${id}" is still used by the deck; remove what uses it first.`,
        );
      }
    }
    for (const id of assetIds) {
      delete deck.assets[id];
      touched.assets.add(id);
    }
  },
);
