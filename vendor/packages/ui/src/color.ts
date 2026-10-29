/*
 * Colour maths for the colour picker (WG3-T06). A picker works in every colour, not in the tokens,
 * so this is the one file of the design system that writes colour values; `designRules.test.ts`
 * exempts it by name.
 */

/** Channels 0..255, alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Hue 0..360, saturation and value 0..1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function hsvToRgb({ h, s, v }: Hsv, a = 1): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return { r: f(5), g: f(3), b: f(1), a };
}

/** A grey has no hue of its own: it keeps `fallbackHue`, so the picker does not jump to red. */
export function rgbToHsv({ r, g, b }: Rgba, fallbackHue = 0): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = fallbackHue;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, with or without the `#`. */
export function parseHex(text: string): Rgba | undefined {
  const n = text.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(n)) return undefined;
  const full = n.length <= 4 ? [...n].map((c) => c + c).join('') : n;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: full.length === 8 ? Math.round((channel(6) / 255) * 100) / 100 : 1,
  };
}

/** `#rrggbb`, or `#rrggbbaa` when the colour is translucent. Lower case. */
export function toHex({ r, g, b, a }: Rgba, withAlpha = a < 1): string {
  const hex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${withAlpha ? hex(a * 255) : ''}`;
}

/** The fully saturated colour of a hue. */
export function hueHex(h: number): string {
  return toHex(hsvToRgb({ h, s: 1, v: 1 }));
}

/** The track of the hue slider. */
export const HUE_TRACK = `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map(hueHex).join(', ')})`;

/** The saturation and value square of a hue: white to the hue across, down to black. */
export function areaBackground(h: number): string {
  return `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueHex(h)}`;
}

/** The checkerboard that shows through a translucent colour, in the tones of the UI theme. */
const CHECKER =
  'repeating-conic-gradient(var(--color-ui-line-strong) 0 25%, transparent 0 50%) 0 0 / 8px 8px';

/** The track of the alpha slider: the colour fading in over the checkerboard. */
export function alphaTrack(rgb: Rgba): string {
  return `linear-gradient(to right, transparent, ${toHex({ ...rgb, a: 1 })}), ${CHECKER}`;
}

/** A swatch of any CSS colour; a translucent one shows the checkerboard through it. */
export function swatchBackground(color: string): string {
  return `linear-gradient(${color}, ${color}), ${CHECKER}`;
}

/** The swatch of "no colour": a diagonal stroke. */
export const NONE_SWATCH =
  'linear-gradient(to top right, transparent calc(50% - 1px), var(--color-ui-danger-fg) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px))';

export function sameRgba(a: Rgba, b: Rgba): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.005;
}
