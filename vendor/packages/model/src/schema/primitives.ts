import { z } from 'zod';

/** Logical slide size. Fixed for now (SPEC A2); kept as data so other sizes stay possible. */
export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

export const Id = z.string().min(1);
export const AssetId = z.string().min(1);

export const Direction = z.enum(['rtl', 'ltr']);
export type Direction = z.infer<typeof Direction>;

/** Colours a theme defines. An element that uses a token follows the theme (SPEC 5.1). */
export const ColorToken = z.enum([
  'bg',
  'surface',
  'text',
  'muted',
  'primary',
  'secondary',
  'accent',
]);
export type ColorToken = z.infer<typeof ColorToken>;

const Alpha = z.number().min(0).max(1);

/**
 * A theme token or an explicit CSS colour. The explicit form takes any CSS colour syntax, not
 * only hex: imported content keeps whatever the source used (SPEC 5.9).
 */
export const Color = z.union([
  z.strictObject({ token: ColorToken, alpha: Alpha.optional() }),
  z.strictObject({ value: z.string().min(1), alpha: Alpha.optional() }),
]);
export type Color = z.infer<typeof Color>;

export const Point = z.strictObject({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

/** Position and size in slide pixels, before rotation. */
export const Frame = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export type Frame = z.infer<typeof Frame>;

export const Insets = z.strictObject({
  top: z.number().nonnegative(),
  right: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
  left: z.number().nonnegative(),
});
export type Insets = z.infer<typeof Insets>;

const GradientStop = z.strictObject({ color: Color, at: z.number().min(0).max(1) });
const Stops = z.array(GradientStop).min(2);
/** Position inside the box, 0..1 on each axis. */
const Center = z.strictObject({ x: z.number(), y: z.number() });

export const Fill = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('solid'), color: Color }),
  z.strictObject({ kind: z.literal('linear'), angle: z.number(), stops: Stops }),
  z.strictObject({ kind: z.literal('radial'), stops: Stops, center: Center.optional() }),
  z.strictObject({
    kind: z.literal('conic'),
    angle: z.number(),
    stops: Stops,
    center: Center.optional(),
  }),
  z.strictObject({
    kind: z.literal('image'),
    assetId: AssetId,
    fit: z.enum(['cover', 'contain', 'fill', 'tile']),
    opacity: Alpha.optional(),
  }),
  // Anything CSS can paint that the kinds above cannot describe, kept verbatim (SPEC 5.9).
  z.strictObject({ kind: z.literal('css'), value: z.string().min(1) }),
]);
export type Fill = z.infer<typeof Fill>;

export const Background = z.strictObject({
  fill: Fill,
  /** Drawn over the fill, usually to keep text readable on a photo. */
  overlay: Fill.optional(),
  /** For image fills: blur radius in slide pixels. */
  blur: z.number().nonnegative().optional(),
  /** For image fills: 0 = untouched, 1 = black. */
  dim: Alpha.optional(),
});
export type Background = z.infer<typeof Background>;

export const Shadow = z.strictObject({
  x: z.number(),
  y: z.number(),
  blur: z.number().nonnegative(),
  spread: z.number().optional(),
  color: Color,
});
export type Shadow = z.infer<typeof Shadow>;

export const Stroke = z.strictObject({
  color: Color,
  width: z.number().nonnegative(),
  dash: z.enum(['solid', 'dashed', 'dotted']).optional(),
  cap: z.enum(['butt', 'round', 'square']).optional(),
  join: z.enum(['miter', 'round', 'bevel']).optional(),
});
export type Stroke = z.infer<typeof Stroke>;

/** CSS properties the model has no field for, applied as they are (SPEC 5.9, RND-07). */
export const CssPassthrough = z.record(z.string().min(1), z.string());
export type CssPassthrough = z.infer<typeof CssPassthrough>;
