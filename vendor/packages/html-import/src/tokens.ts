/**
 * Snapping measured values to the theme (SPEC 11.5): a colour equal to a theme colour becomes
 * its token, a font list equal to a theme font pair needs no font mark, and text that looks
 * like a theme text style points at it. Whatever is linked this way follows a template change.
 * No DOM here; the browser side resolves the theme's own values once (`ThemeValues`).
 */
import type { Color, ColorToken, Marks, TextStyleRef, Theme } from '@slidr/model';
import { fontFamilies, parseColor, sameFamilies, toHex, type Rgba } from './css';

/** The theme as the browser computes it: the same forms measured values come in. */
export interface ThemeValues {
  /** Each colour token as the browser resolves it. Later tokens do not shadow earlier ones. */
  colors: readonly (readonly [ColorToken, Rgba])[];
  /** The computed family lists of `var(--font-heading)` and `var(--font-body)`. */
  fonts: { heading: string[]; body: string[] };
}

/** Tokens in the order they win when two have the same colour: the more specific role first. */
export const TOKEN_ORDER: readonly ColorToken[] = [
  'primary',
  'secondary',
  'accent',
  'text',
  'muted',
  'bg',
  'surface',
];

function sameRgb(a: Rgba, b: Rgba): boolean {
  return Math.abs(a.r - b.r) < 0.5 && Math.abs(a.g - b.g) < 0.5 && Math.abs(a.b - b.b) < 0.5;
}

function withAlpha<T extends object>(color: T, alpha: number): T & { alpha?: number } {
  return alpha < 1 ? { ...color, alpha: Math.round(alpha * 1000) / 1000 } : color;
}

/**
 * A computed colour as a model colour. A theme colour, opaque or made translucent, becomes
 * its token; anything else is kept as a hex value. A colour the parser cannot read (another
 * colour space) is kept as written. `uses` narrows the match to tokens the source really took
 * the colour from: a value that only happens to equal a theme colour stays a value.
 */
export function snapColor(
  value: string,
  theme: ThemeValues,
  uses: (token: ColorToken) => boolean = () => true,
): Color {
  const rgba = parseColor(value);
  if (!rgba) return { value };
  for (const [token, themed] of theme.colors) {
    if (themed.a === 1 && sameRgb(rgba, themed) && uses(token)) return withAlpha({ token }, rgba.a);
  }
  return withAlpha({ value: toHex(rgba) }, rgba.a);
}

/** Whether a model colour and a computed colour are the same picture. */
function sameColor(model: Color, computed: Color): boolean {
  return JSON.stringify(model) === JSON.stringify(computed);
}

/** What the browser computed for a piece of text, in slide pixels. */
export interface TextLook {
  families: string[];
  /** The family to name in a font mark: the first of `families` the document can draw. */
  font?: string;
  size: number;
  weight: number;
  italic: boolean;
  color: Color;
  /** 0 for `normal`. */
  letterSpacing: number;
  case?: 'upper' | 'lower';
}

/**
 * The theme text style a block of text is closest to. One of the same size is the natural
 * match. Otherwise the largest one that is not larger than the text: the renderer lays a
 * paragraph out on the style's size, and a style larger than the text would set the line
 * height from a font the text does not use.
 */
export function chooseTextStyle(look: TextLook, theme: Theme, values: ThemeValues): TextStyleRef {
  const styles = Object.entries(theme.textStyles) as [
    TextStyleRef,
    Theme['textStyles'][TextStyleRef],
  ][];
  const score = ([, style]: (typeof styles)[number]) => {
    const sameSize = Math.abs(style.size - look.size) < 0.01;
    const fits = style.size <= look.size + 0.01;
    return (
      // A style that changes the case cannot be undone by a mark.
      (style.case && style.case !== look.case ? -5000 : 0) +
      (sameSize ? 1000 : fits ? 500 + style.size : -style.size) +
      // Between styles of one size, the one in the same font and weight.
      (sameFamilies(values.fonts[style.font], look.families) ? 0.2 : 0) +
      (style.weight === look.weight ? 0.1 : 0)
    );
  };
  return styles.reduce((best, s) => (score(s) > score(best) ? s : best))[0];
}

/**
 * The marks that turn a theme text style into the measured look: only what differs. Text that
 * matches its style gets no marks at all and follows the theme entirely. With `link` off
 * (text of a foreign document, which the theme is not about) every value is written out.
 */
export function marksOver(
  look: TextLook,
  styleRef: TextStyleRef,
  theme: Theme,
  values: ThemeValues,
  link = true,
): Marks {
  const style = theme.textStyles[styleRef];
  const marks: Marks = {};
  const font = look.font ?? look.families[0];
  if ((!link || !sameFamilies(values.fonts[style.font], look.families)) && font) marks.font = font;
  if (!link || Math.abs(style.size - look.size) >= 0.01) marks.size = look.size;
  if (!link || style.weight !== look.weight) marks.weight = look.weight;
  if (look.italic) marks.italic = true;
  if (!link || !sameColor(style.color, look.color)) marks.color = look.color;
  if (Math.abs((style.letterSpacing ?? 0) - look.letterSpacing) >= 0.01) {
    marks.letterSpacing = look.letterSpacing;
  }
  if (look.case && look.case !== style.case) marks.case = look.case;
  return marks;
}

/** The theme's colour tokens as the given resolver computes them, in snapping order. */
export function themeValues(
  theme: Theme,
  resolveColor: (css: string) => string,
  resolveFont: (css: string) => string,
): ThemeValues {
  const colors: [ColorToken, Rgba][] = [];
  for (const token of TOKEN_ORDER) {
    const rgba = parseColor(resolveColor(theme.colors[token]));
    if (rgba) colors.push([token, rgba]);
  }
  return {
    colors,
    fonts: {
      heading: fontFamilies(resolveFont('var(--font-heading)')),
      body: fontFamilies(resolveFont('var(--font-body)')),
    },
  };
}
