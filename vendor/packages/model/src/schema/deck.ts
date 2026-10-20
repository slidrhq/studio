import { z } from 'zod';
import { AnimationStep, Transition } from './animation';
import { Element } from './elements';
import { AssetId, Background, Direction, Id, SLIDE_HEIGHT, SLIDE_WIDTH } from './primitives';
import { RichText } from './text';
import { Archetype, Layout, Theme } from './theme';

/** Bumped whenever a stored deck needs a migration to load (see ../migrations.ts). */
export const SCHEMA_VERSION = 1;

export const AssetMeta = z.strictObject({
  /** sha256 of the content: the same file is never stored twice (SPEC 5.7). */
  id: AssetId,
  /** File name inside `assets/`: `<sha256>.<ext>`. */
  file: z.string().min(1),
  mime: z.string().min(1),
  kind: z.enum(['image', 'svg', 'video', 'audio', 'font', 'other']),
  bytes: z.number().int().nonnegative(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  origin: z.enum(['upload', 'stock', 'ai', 'import']),
  name: z.string().optional(),
  attribution: z
    .strictObject({
      author: z.string().optional(),
      url: z.string().optional(),
      license: z.string().optional(),
    })
    .optional(),
  /** Where an AI image came from. */
  lineage: z
    .strictObject({
      parentAssetId: AssetId.optional(),
      prompt: z.string().optional(),
      provider: z.string().optional(),
    })
    .optional(),
  /** For fonts: how the renderer registers the face. */
  font: z
    .strictObject({
      family: z.string().min(1),
      weight: z.string().min(1),
      style: z.string().min(1),
      /** The characters the face is for, as CSS `unicode-range`; all of them when absent. */
      unicodeRange: z.string().min(1).optional(),
    })
    .optional(),
});
export type AssetMeta = z.infer<typeof AssetMeta>;

export const Slide = z.strictObject({
  id: Id,
  name: z.string().min(1).optional(),
  layoutId: Id.optional(),
  /**
   * What kind of slide this is, for a slide without a layout (one written as HTML has none).
   * A slide with a layout takes the layout's: see `slideArchetype`.
   */
  archetype: Archetype.optional(),
  /** Overrides the theme background. */
  background: Background.optional(),
  /** Array order is z-order: the last element is on top. */
  elements: z.array(Element),
  notes: RichText.optional(),
  transition: Transition.optional(),
  timeline: z.array(AnimationStep),
  hidden: z.boolean().optional(),
  /** Slide-level stylesheet kept as it is: @keyframes, @font-face, ... (SPEC 5.9). */
  css: z.string().optional(),
});
export type Slide = z.infer<typeof Slide>;

export const DeckMeta = z.strictObject({
  title: z.string(),
  lang: z.string().min(1),
  /** Direction of new content. */
  dir: Direction,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Prose description of the image style, reused in every AI image prompt. */
  imageStyle: z.string().optional(),
});
export type DeckMeta = z.infer<typeof DeckMeta>;

export const Deck = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id,
  meta: DeckMeta,
  size: z.strictObject({ w: z.literal(SLIDE_WIDTH), h: z.literal(SLIDE_HEIGHT) }),
  theme: Theme,
  layouts: z.array(Layout),
  slides: z.array(Slide),
  assets: z.record(AssetId, AssetMeta),
});
export type Deck = z.infer<typeof Deck>;
