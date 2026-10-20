import { z } from 'zod';
import { Element, PlaceholderRole } from './elements';
import { Background, Color, Frame, Id, Shadow } from './primitives';
import { TextStyleRef } from './text';

/** A font per script, so Hebrew and Latin text each get the face meant for them (SPEC 5.5). */
export const FontPair = z.strictObject({ he: z.string().min(1), latin: z.string().min(1) });
export type FontPair = z.infer<typeof FontPair>;

export const TextStyle = z.strictObject({
  font: z.enum(['heading', 'body']),
  size: z.number().positive(),
  weight: z.number().int().min(1).max(1000),
  lineHeight: z.number().positive(),
  letterSpacing: z.number().optional(),
  color: Color,
  case: z.enum(['upper', 'lower']).optional(),
});
export type TextStyle = z.infer<typeof TextStyle>;

export const Theme = z.strictObject({
  id: Id,
  name: z.string().min(1),
  colors: z.strictObject({
    bg: z.string().min(1),
    surface: z.string().min(1),
    text: z.string().min(1),
    muted: z.string().min(1),
    primary: z.string().min(1),
    secondary: z.string().min(1),
    accent: z.string().min(1),
    /** Series palette for charts. */
    chart: z.array(z.string().min(1)).min(1),
  }),
  fonts: z.strictObject({ heading: FontPair, body: FontPair }),
  textStyles: z.record(TextStyleRef, TextStyle),
  radius: z.number().nonnegative(),
  shadow: Shadow,
  background: Background,
  /** Alternatives a slide can pick: dark, accent, image, ... */
  backgroundVariants: z.array(Background),
});
export type Theme = z.infer<typeof Theme>;

/** The slide archetypes of the design guidelines (SPEC 9.1). */
export const Archetype = z.enum([
  'hero',
  'section',
  'title',
  'bigNumber',
  'quote',
  'text',
  'textImage',
  'fullImage',
  'cards',
  'timeline',
  'process',
  'comparison',
  'chart',
  'table',
  'team',
  'closing',
  'blank',
]);
export type Archetype = z.infer<typeof Archetype>;

export const Placeholder = z.strictObject({
  id: Id,
  role: PlaceholderRole,
  frame: Frame,
  styleRef: TextStyleRef.optional(),
  /**
   * The colour of the placeholder's text, in place of its text style's: for text the layout
   * seats on a field of its own (a white card on a dark slide). Without it the text has the
   * colour of its style, which reads on the grounds the theme offers.
   */
  color: Color.optional(),
  align: z.enum(['start', 'center', 'end']).optional(),
  vAlign: z.enum(['top', 'middle', 'bottom']).optional(),
});
export type Placeholder = z.infer<typeof Placeholder>;

export const Layout = z.strictObject({
  id: Id,
  name: z.string().min(1),
  archetype: Archetype,
  background: Background.optional(),
  placeholders: z.array(Placeholder),
  /** Visual elements that come with the layout and are not edited by default. */
  decorations: z.array(Element),
  /**
   * Elements a new slide of the layout starts with, under the elements of its placeholders: the
   * slide holds copies of them, so a card, a number or a drawing of the template is moved,
   * changed and deleted like anything put there by hand. The copies go with the layout when the
   * slide changes layout or template, changed or not, unless the user wrote in them.
   */
  objects: z.array(Element).optional(),
});
export type Layout = z.infer<typeof Layout>;
