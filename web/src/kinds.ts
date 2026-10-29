/**
 * What the rail offers to make, in the order of the app's own collections: ready designs,
 * templates, and the elements. Designs and templates (a template's sample in languages) are
 * made and published today; the library's upload API takes no new item of the others yet
 * (Slidr Library, `uploads/content.ts`: only their tags), so the studio says so and makes none.
 */
import {
  Frame,
  GalleryVerticalEnd,
  LayoutGrid,
  Palette,
  Shapes,
  Smile,
  Sparkles,
  Sticker,
  Type,
  type LucideIcon,
} from '@slidr/ui/icons';
import type { ChatKind } from './api';
import type { MessageKey } from './i18n';

export interface KindInfo {
  kind: ChatKind;
  icon: LucideIcon;
  /** The short word under the rail's icon. */
  caption: MessageKey;
  /** Its name in full: the tooltip, and the chip in the composer. */
  title: MessageKey;
  /** Whether the studio can make it and the library take it. */
  makeable: boolean;
}

export const KINDS: readonly KindInfo[] = [
  {
    kind: 'design',
    icon: GalleryVerticalEnd,
    caption: 'rail.design',
    title: 'rail.designTitle',
    makeable: true,
  },
  {
    kind: 'template',
    icon: Palette,
    caption: 'rail.template',
    title: 'rail.templateTitle',
    makeable: true,
  },
  {
    kind: 'cards',
    icon: LayoutGrid,
    caption: 'rail.cards',
    title: 'rail.cardsTitle',
    makeable: false,
  },
  {
    kind: 'frames',
    icon: Frame,
    caption: 'rail.frames',
    title: 'rail.framesTitle',
    makeable: false,
  },
  {
    kind: 'shapes',
    icon: Shapes,
    caption: 'rail.shapes',
    title: 'rail.shapesTitle',
    makeable: false,
  },
  {
    kind: 'graphics',
    icon: Sticker,
    caption: 'rail.graphics',
    title: 'rail.graphicsTitle',
    makeable: false,
  },
  { kind: 'emoji', icon: Smile, caption: 'rail.emoji', title: 'rail.emojiTitle', makeable: false },
  { kind: 'fonts', icon: Type, caption: 'rail.fonts', title: 'rail.fontsTitle', makeable: false },
];

/** A request in words, which the studio reads: what the composer makes with no kind chosen. */
export const AUTO: KindInfo = {
  kind: 'auto',
  icon: Sparkles,
  caption: 'rail.auto',
  title: 'rail.autoTitle',
  makeable: true,
};

export const kindInfo = (kind: ChatKind): KindInfo =>
  KINDS.find((info) => info.kind === kind) ?? AUTO;
