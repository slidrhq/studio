import { z } from 'zod';
import { Color } from './primitives';

/** Text styles a theme defines; a paragraph points at one with `styleRef` (SPEC 5.4, 5.5). */
export const TextStyleRef = z.enum(['display', 'title', 'heading', 'body', 'caption']);
export type TextStyleRef = z.infer<typeof TextStyleRef>;

export const Marks = z.strictObject({
  font: z.string().min(1).optional(),
  /** Slide pixels: 32 means 32px on the 1920x1080 slide. */
  size: z.number().positive().optional(),
  weight: z.number().int().min(1).max(1000).optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: Color.optional(),
  highlight: Color.optional(),
  letterSpacing: z.number().optional(),
  script: z.enum(['sup', 'sub']).optional(),
  case: z.enum(['upper', 'lower']).optional(),
  link: z.string().min(1).optional(),
});
export type Marks = z.infer<typeof Marks>;

export const Run = z.strictObject({
  text: z.string(),
  marks: Marks.optional(),
});
export type Run = z.infer<typeof Run>;

export const ListInfo = z.strictObject({
  kind: z.enum(['bullet', 'number']),
  level: z.number().int().min(0).max(8),
  glyph: z.string().min(1).optional(),
  color: Color.optional(),
  /**
   * How a numbered item writes its number, as PowerPoint's numbering styles: `1.`, `1)`, `I.`,
   * `A.`, `a)`, `a.`, `i.`, `א.`. Without it the style follows the level (`1.`, `a.`, `i.`).
   */
  format: z
    .enum([
      'decimal',
      'decimal-paren',
      'upper-roman',
      'upper-alpha',
      'lower-alpha-paren',
      'lower-alpha',
      'lower-roman',
      'hebrew',
    ])
    .optional(),
  /** The number a numbered list counts from, at the item that begins a level. */
  start: z.number().int().min(1).max(9999).optional(),
  /** The marker's size, in percent of the text's. */
  size: z.number().int().min(25).max(400).optional(),
});
export type ListInfo = z.infer<typeof ListInfo>;
export type ListFormat = NonNullable<ListInfo['format']>;

export const Paragraph = z.strictObject({
  dir: z.enum(['rtl', 'ltr', 'auto']),
  /** `start` / `end`, never left / right, so that flipping direction keeps working. */
  align: z.enum(['start', 'center', 'end', 'justify']),
  /** Multiplier of the font size. */
  lineHeight: z.number().positive().optional(),
  spaceBefore: z.number().nonnegative().optional(),
  spaceAfter: z.number().nonnegative().optional(),
  indent: z.number().optional(),
  list: ListInfo.optional(),
  styleRef: TextStyleRef.optional(),
  runs: z.array(Run),
});
export type Paragraph = z.infer<typeof Paragraph>;

export const RichText = z.strictObject({
  paragraphs: z.array(Paragraph),
});
export type RichText = z.infer<typeof RichText>;
