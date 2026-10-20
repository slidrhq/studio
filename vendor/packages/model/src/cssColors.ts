import type { ColorToken } from './schema';

/*
 * The colours inside a CSS value the model keeps verbatim (a `css` fill, SPEC 5.9). A gradient
 * the model has no shape for is stored as the CSS that paints it, and its colours are part of
 * that text: no field of the model holds them, so no token does either. Whatever reads or
 * changes the colours of a deck (a template switch, the design check) reaches them through here.
 */

/** A colour as numbers: red, green and blue 0..255, alpha 0..1. */
export interface CssRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A colour written the way a browser computes one, or a theme writes one: hex, `rgb()`,
 * `rgba()` and `color(srgb ...)`. Undefined for anything else (a name, another colour space, a
 * `var()`), which is left as it is written.
 */
export function parseCssColor(text: string): CssRgba | undefined {
  const v = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const wide = hex.length <= 4 ? Array.from(hex, (c) => c + c).join('') : hex;
    if (wide.length !== 6 && wide.length !== 8) return undefined;
    const n = (at: number) => parseInt(wide.slice(at, at + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: wide.length === 8 ? n(6) / 255 : 1 };
  }
  const share = (s: string | undefined) =>
    s === undefined ? 1 : s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  const rgb = /^rgba?\(([^()]+)\)$/.exec(v)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean);
    const channel = (s: string) => (s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s));
    const [r, g, b] = parts.slice(0, 3).map(channel);
    return numbers(r, g, b, share(parts[3]));
  }
  const srgb = /^color\(srgb\s+([^()]+)\)$/.exec(v)?.[1];
  if (srgb) {
    const parts = srgb.split(/[\s/]+/).filter(Boolean);
    const [r, g, b] = parts.slice(0, 3).map((s) => share(s) * 255);
    return numbers(r, g, b, share(parts[3]));
  }
  return undefined;
}

function numbers(r?: number, g?: number, b?: number, a?: number): CssRgba | undefined {
  if (r === undefined || g === undefined || b === undefined || a === undefined) return undefined;
  return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a } : undefined;
}

/** Every colour `parseCssColor` reads, and `url(...)`, which is skipped whole. */
const LITERAL = /url\([^)]*\)|#[0-9a-f]{3,8}\b|rgba?\([^()]*\)|color\(srgb\s[^()]*\)/gi;

/**
 * A CSS value with its colours rewritten: `map` is asked about each colour written as a value
 * and answers with the CSS that takes its place, or with undefined to leave it. The rest of the
 * text is kept to the letter.
 */
export function mapCssColors(
  value: string,
  map: (color: CssRgba, text: string) => string | undefined,
): string {
  return value.replace(LITERAL, (text) => {
    const color = parseCssColor(text);
    return (color && map(color, text)) ?? text;
  });
}

/**
 * A colour of the theme as CSS: the variable the renderer sets on every slide root (RND-08), so
 * what is written with it follows the theme. The same text the renderer writes for a token.
 */
export function themeColorCss(token: ColorToken, alpha = 1): string {
  const base = `var(--color-${token})`;
  if (alpha >= 1) return base;
  if (alpha <= 0) return 'transparent';
  return `color-mix(in srgb, ${base} ${Math.round(alpha * 10000) / 100}%, transparent)`;
}
