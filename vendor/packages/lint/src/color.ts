import type { Rgb } from './measure';

/** Relative luminance of an sRGB colour, 0 (black) to 1 (white), as WCAG defines it. */
export function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two colours: 1 (the same) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A translucent colour as it looks over a background. */
export function blend(color: Rgb, alpha: number, over: Rgb): Rgb {
  const mix = (c: number, o: number) => Math.round(c * alpha + o * (1 - alpha));
  return [mix(color[0], over[0]), mix(color[1], over[1]), mix(color[2], over[2])];
}

export function hex(color: Rgb): string {
  return `#${color.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}
