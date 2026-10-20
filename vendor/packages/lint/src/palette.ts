import type { Color, ColorToken, Theme } from '@slidr/model';
import type { Rgb } from './measure';

/** The colour tokens of a theme, in the order a fix prefers them for text. */
export const TOKENS: readonly ColorToken[] = [
  'text',
  'bg',
  'surface',
  'muted',
  'primary',
  'secondary',
  'accent',
];

/**
 * A colour written as hex, as numbers. The model keeps any CSS colour (SPEC 5.9); the rules
 * that compare colours read hex, which is what themes and the conversion write, and leave the
 * rest unjudged.
 */
export function parseHex(css: string): Rgb | undefined {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(css.trim())?.[1];
  if (!hex) return undefined;
  const digits = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as unknown as Rgb;
}

export function tokenRgb(theme: Theme, token: ColorToken): Rgb | undefined {
  return parseHex(theme.colors[token]);
}

/** A colour of the model as numbers, without its alpha; undefined when it is not hex. */
export function colorRgb(theme: Theme, color: Color): Rgb | undefined {
  return 'token' in color ? tokenRgb(theme, color.token) : parseHex(color.value);
}

/** How far apart two colours are, as a distance in the RGB cube (0..441). */
export function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Black, white and the greys between them: no hue of their own, so every template has them. */
export function isNeutral([r, g, b]: Rgb): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

/** The token of the theme nearest to a colour, and how far it is. */
export function nearestToken(
  theme: Theme,
  rgb: Rgb,
): { token: ColorToken; distance: number } | undefined {
  let best: { token: ColorToken; distance: number } | undefined;
  for (const token of TOKENS) {
    const of = tokenRgb(theme, token);
    if (!of) continue;
    const d = distance(rgb, of);
    if (!best || d < best.distance) best = { token, distance: d };
  }
  return best;
}
