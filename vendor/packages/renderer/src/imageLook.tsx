import type { ColorToken, ImageElement, Theme } from '@slidr/model';
import type { ReactNode } from 'react';
import { num } from './css';

/*
 * How a picture is drawn over what its file holds (IMG-06, IMG-07): the element's own
 * adjustments, and one ready-made look. Everything here is a filter on the `<img>`; the file is
 * never touched, so the original is always there to go back to (IMG-12).
 */

/** A ready-made look: a chain of CSS filters, and a shift of the colour temperature. */
interface Look {
  css: string;
  /** -1..1, warmer above 0: added to the element's own temperature. */
  temperature?: number;
}

/**
 * The ready-made looks, by the name `filterPreset` holds. A name that is not here draws nothing:
 * a deck written by a later version still opens.
 */
const LOOKS = {
  mono: { css: 'grayscale(1)' },
  noir: { css: 'grayscale(1) contrast(1.35) brightness(0.95)' },
  sepia: { css: 'sepia(0.85)' },
  warm: { css: 'saturate(1.15)', temperature: 0.5 },
  cool: { css: 'saturate(0.95)', temperature: -0.5 },
  vivid: { css: 'saturate(1.45) contrast(1.08)' },
  fade: { css: 'contrast(0.82) brightness(1.1) saturate(0.8)' },
  dramatic: { css: 'contrast(1.3) saturate(0.85) brightness(0.92)' },
} as const satisfies Record<string, Look>;

export type ImageFilterName = keyof typeof LOOKS;

/** The names of the ready-made looks, in the order a picker shows them. */
export const imageFilterNames = Object.keys(LOOKS) as ImageFilterName[];

const TOKENS: readonly ColorToken[] = [
  'bg',
  'surface',
  'text',
  'muted',
  'primary',
  'secondary',
  'accent',
];

/**
 * The `filterPreset` of a duotone in two of the theme's colours. The picture is drawn in the two:
 * its dark parts in the darker one, its light parts in the lighter, whichever way they are named.
 * The colours are tokens, so the picture follows the theme.
 */
export function duotonePreset(a: ColorToken, b: ColorToken): string {
  return `duotone:${a}:${b}`;
}

/** The two tokens of a duotone preset, or undefined for any other preset. */
export function duotoneTokens(preset: string | undefined): [ColorToken, ColorToken] | undefined {
  const match = /^duotone:([a-z]+):([a-z]+)$/.exec(preset ?? '');
  if (!match) return undefined;
  const [a, b] = [match[1], match[2]] as [ColorToken, ColorToken];
  return TOKENS.includes(a) && TOKENS.includes(b) ? [a, b] : undefined;
}

type Rgb = [number, number, number];

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour as red, green and blue of 0..1: the browser paints it and the pixel is read. */
function paintedRgb(value: string): Rgb | undefined {
  if (typeof document === 'undefined') return undefined;
  if (probe === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext?.('2d', { willReadFrequently: true }) ?? null;
  }
  if (!probe) return undefined;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
  return a === 0 ? undefined : [r / 255, g / 255, b / 255];
}

/** A theme colour as red, green and blue of 0..1. Hex is read directly; anything else is painted. */
export function colorRgb(value: string): Rgb {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim())?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) {
    return [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16) / 255) as Rgb;
  }
  if (hex && (hex.length === 6 || hex.length === 8)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
  }
  return paintedRgb(value) ?? [0, 0, 0];
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Draws a picture in two colours: its brightness, mapped from the dark colour to the light one.
 * An SVG filter, since it leaves the picture's transparency alone, which blending layers of
 * colour over the picture would not.
 */
function DuotoneFilter({ id, dark, light }: { id: string; dark: Rgb; light: Rgb }) {
  const table = (channel: 0 | 1 | 2) => `${num(dark[channel], 4)} ${num(light[channel], 4)}`;
  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix
          type="matrix"
          values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0"
        />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={table(0)} />
          <feFuncG type="table" tableValues={table(1)} />
          <feFuncB type="table" tableValues={table(2)} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

/** CSS has no filter for colour temperature; an SVG colour matrix warms or cools the picture. */
function TemperatureFilter({ id, t }: { id: string; t: number }) {
  const r = num(1 + 0.25 * t, 3);
  const b = num(1 - 0.25 * t, 3);
  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={`${r} 0 0 0 0 0 1 0 0 0 0 0 ${b} 0 0 0 0 0 1 0`} />
      </filter>
    </svg>
  );
}

export interface ImageLook {
  /** The `filter` of the `<img>`; undefined when the picture is drawn as its file holds it. */
  filter: string | undefined;
  /** SVG filters the `filter` refers to, to draw beside the `<img>`. */
  defs: ReactNode;
}

/**
 * The filter of a picture: its ready-made look first, then its own adjustments (IMG-06).
 * brightness, contrast and saturation are multipliers (1 = untouched), hue is in degrees, blur
 * in slide pixels, grayscale 0..1, and temperature -1..1 (warmer above 0). `id` gives ids for the
 * SVG filters that are unique on the page.
 */
export function imageLook(
  image: Pick<ImageElement, 'adjust' | 'filterPreset'>,
  theme: Theme,
  id: (suffix: string) => string,
): ImageLook {
  const { adjust, filterPreset } = image;
  const parts: string[] = [];
  const defs: ReactNode[] = [];

  const duotone = duotoneTokens(filterPreset);
  const look: Look | undefined =
    filterPreset && filterPreset in LOOKS ? LOOKS[filterPreset as ImageFilterName] : undefined;
  if (duotone) {
    const [a, b] = duotone.map((token) => colorRgb(theme.colors[token])) as [Rgb, Rgb];
    const [dark, light] = luminance(a) <= luminance(b) ? [a, b] : [b, a];
    const duotoneId = id('duotone');
    defs.push(<DuotoneFilter key="duotone" id={duotoneId} dark={dark} light={light} />);
    parts.push(`url(#${duotoneId})`);
  }

  const temperature = Math.max(
    -1,
    Math.min(1, (look?.temperature ?? 0) + (adjust?.temperature ?? 0)),
  );
  if (temperature) {
    const temperatureId = id('temperature');
    defs.push(<TemperatureFilter key="temperature" id={temperatureId} t={temperature} />);
    parts.push(`url(#${temperatureId})`);
  }
  if (look) parts.push(look.css);
  if (adjust) {
    if (adjust.brightness !== undefined && adjust.brightness !== 1)
      parts.push(`brightness(${adjust.brightness})`);
    if (adjust.contrast !== undefined && adjust.contrast !== 1)
      parts.push(`contrast(${adjust.contrast})`);
    if (adjust.saturation !== undefined && adjust.saturation !== 1)
      parts.push(`saturate(${adjust.saturation})`);
    if (adjust.hue) parts.push(`hue-rotate(${adjust.hue}deg)`);
    if (adjust.grayscale) parts.push(`grayscale(${adjust.grayscale})`);
    if (adjust.blur) parts.push(`blur(${adjust.blur}px)`);
  }
  return { filter: parts.length ? parts.join(' ') : undefined, defs: defs.length ? defs : null };
}
