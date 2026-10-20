/**
 * Reading computed CSS values (SPEC 11.5, 13.1). Everything here takes the strings
 * `getComputedStyle` hands back and nothing else: no DOM, so the mapping is tested in Node.
 * A value these functions cannot read is not guessed at: the caller keeps it verbatim in a
 * `css` field or leaves the region as HTML (SPEC 5.9).
 */
import type { Fill, Shadow } from '@slidr/model';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A length in px as a number; anything else (`auto`, `normal`, `50%`) is 0. */
export function px(value: string | undefined): number {
  if (!value || !value.endsWith('px')) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Rounds to hundredths of a pixel: enough for layout, and keeps the stored numbers short. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Splits at the given separator, outside parentheses and strings. */
export function splitTopLevel(value: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (depth === 0 && ch === separator) {
      if (current.trim() || separator === ',') parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() || (separator === ',' && parts.length > 0)) parts.push(current.trim());
  return parts;
}

/**
 * A computed colour: `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)` or `color(srgb 0.1 0.2 0.3 / 0.5)`.
 * Other colour spaces come back undefined; the caller keeps the string as it is.
 */
export function parseColor(value: string): Rgba | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const wide = h.length <= 4 ? Array.from(h, (c) => c + c).join('') : h;
    if (wide.length !== 6 && wide.length !== 8) return undefined;
    const n = (i: number) => parseInt(wide.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: wide.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return undefined;
    const channel = (s: string) => (s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s));
    const alpha = parts[3];
    return {
      r: channel(parts[0]!),
      g: channel(parts[1]!),
      b: channel(parts[2]!),
      a:
        alpha === undefined ? 1 : alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha),
    };
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(v);
  if (srgb) {
    const parts = srgb[1]!.split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return undefined;
    return {
      r: parseFloat(parts[0]!) * 255,
      g: parseFloat(parts[1]!) * 255,
      b: parseFloat(parts[2]!) * 255,
      a: parts[3] === undefined ? 1 : parseFloat(parts[3]),
    };
  }
  return undefined;
}

/** Opacity of a computed colour. A colour that cannot be read is taken as opaque. */
export function alphaOf(value: string): number {
  if (!value) return 0;
  return parseColor(value)?.a ?? 1;
}

export function toHex({ r, g, b }: Rgba): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Multiplies every px length in a CSS value: "0px 8px 24px rgb(0, 0, 0)" at 1.5 -> "0px 12px 36px ...". */
export function scalePx(value: string, k: number): string {
  if (k === 1) return value;
  return value.replace(/(-?\d*\.?\d+)px/g, (_, n: string) => `${round(parseFloat(n) * k)}px`);
}

export interface BoxShadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

/** The layers of a computed `box-shadow`, top first: "rgba(0, 0, 0, 0.3) 0px 12px 32px 0px inset". */
export function parseBoxShadow(value: string): BoxShadow[] | undefined {
  if (!value || value === 'none') return [];
  const layers: BoxShadow[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    const parts = splitTopLevel(layer, ' ');
    const inset = parts.includes('inset');
    const lengths = parts.filter((p) => /^-?[\d.]+px$/.test(p)).map(parseFloat);
    const color = parts.find((p) => p !== 'inset' && !/^-?[\d.]+px$/.test(p));
    if (lengths.length < 2 || !color) return undefined;
    layers.push({
      inset,
      x: lengths[0]!,
      y: lengths[1]!,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color,
    });
  }
  return layers;
}

/**
 * A model shadow that draws what a CSS box shadow draws. The renderer draws a shadow without
 * spread as `drop-shadow`, whose blur is a standard deviation, twice as soft as the same
 * number in `box-shadow` (measured: at half the blur the two pictures differ by at most 2/255).
 */
export function shadowFromBox(shadow: BoxShadow, color: Shadow['color'], k: number): Shadow {
  return {
    x: round(shadow.x * k),
    y: round(shadow.y * k),
    blur: round((shadow.spread ? shadow.blur : shadow.blur / 2) * k),
    ...(shadow.spread ? { spread: round(shadow.spread * k) } : {}),
    color,
  };
}

/** A 2D matrix as `[a, b, c, d, e, f]`; undefined for `none` and for 3D transforms. */
export function parseMatrix(transform: string): number[] | undefined {
  const m = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (!m) return undefined;
  const values = m[1]!.split(',').map(Number);
  return values.length === 6 && values.every(Number.isFinite) ? values : undefined;
}

/**
 * The scale of a transform that only scales evenly and moves: 1 for `none`, undefined for
 * anything that rotates, skews, stretches or leaves the plane.
 */
export function uniformScale(transform: string): number | undefined {
  if (!transform || transform === 'none') return 1;
  const m = parseMatrix(transform);
  if (!m) return undefined;
  const [a, b, c, d] = m as [number, number, number, number];
  if (Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4 || Math.abs(a - d) > 1e-3 || a <= 0) {
    return undefined;
  }
  return a;
}

/** Rotation (degrees, clockwise) and even scale of a transform that does only those and moves. */
export function rotationAndScale(
  transform: string,
): { rotation: number; scale: number } | undefined {
  const m = parseMatrix(transform);
  if (!m) return undefined;
  const [a, b, c, d] = m as [number, number, number, number];
  const scale = Math.hypot(a, b);
  if (scale < 1e-6) return undefined;
  // A rotation with an even scale is [s cos, s sin, -s sin, s cos].
  if (Math.abs(a - d) > 1e-3 * scale || Math.abs(b + c) > 1e-3 * scale) return undefined;
  return { rotation: round((Math.atan2(b, a) * 180) / Math.PI), scale };
}

export type CornerRadius =
  | { kind: 'none' }
  /** The same circular radius on every corner, in px. */
  | { kind: 'px'; value: number }
  /** Half of each side on every corner: an ellipse. */
  | { kind: 'ellipse' }
  /** Anything else; `value` is a `border-radius` value. */
  | { kind: 'css'; value: string };

/** The four computed corner radii (top-left, top-right, bottom-right, bottom-left). */
export function cornerRadius(
  corners: readonly [string, string, string, string],
  box: { w: number; h: number },
): CornerRadius {
  if (corners.every((c) => c === '0px' || c === '0%')) return { kind: 'none' };
  const first = corners[0];
  if (corners.every((c) => c === first)) {
    if (/^[\d.]+px$/.test(first)) {
      // CSS shrinks radii that do not fit: a pill's 999px is half its shorter side.
      return { kind: 'px', value: Math.min(parseFloat(first), box.w / 2, box.h / 2) };
    }
    if (first === '50%') return { kind: 'ellipse' };
  }
  // "a b" in one corner is an elliptical corner: horizontal radii, then vertical ones.
  const pairs = corners.map((c) => splitTopLevel(c, ' '));
  const horizontal = pairs.map((p) => p[0]).join(' ');
  const vertical = pairs.map((p) => p[1] ?? p[0]).join(' ');
  return {
    kind: 'css',
    value: horizontal === vertical ? horizontal : `${horizontal} / ${vertical}`,
  };
}

type Stops = Extract<Fill, { kind: 'linear' }>['stops'];
export type ColorReader = (css: string) => Stops[number]['color'] | undefined;

/**
 * The stops of a gradient as fractions. `length` turns a px position into a fraction; without
 * it (radial, conic) px positions cannot be read. Stops without a position are spread evenly
 * between their neighbours, as CSS does. Colour hints and double positions are not read.
 */
function parseStops(
  parts: readonly string[],
  color: ColorReader,
  position: (value: string) => number | undefined,
): Stops | undefined {
  const stops: { color: Stops[number]['color']; at: number | undefined }[] = [];
  for (const part of parts) {
    const tokens = splitTopLevel(part, ' ');
    if (tokens.length < 1 || tokens.length > 2) return undefined;
    const c = color(tokens[0]!);
    if (!c) return undefined;
    const at = tokens[1] === undefined ? undefined : position(tokens[1]);
    if (tokens[1] !== undefined && at === undefined) return undefined;
    stops.push({ color: c, at });
  }
  if (stops.length < 2) return undefined;
  stops[0]!.at ??= 0;
  stops[stops.length - 1]!.at ??= 1;
  // A position before an earlier one is clamped up to it.
  let floor = 0;
  for (const stop of stops) {
    if (stop.at !== undefined) {
      stop.at = Math.max(stop.at, floor);
      floor = stop.at;
    }
  }
  for (let i = 0; i < stops.length; i++) {
    if (stops[i]!.at !== undefined) continue;
    let next = i;
    while (stops[next]!.at === undefined) next++;
    const from = stops[i - 1]!.at!;
    const to = stops[next]!.at!;
    for (let j = i; j < next; j++)
      stops[j]!.at = from + ((to - from) * (j - i + 1)) / (next - i + 1);
    i = next;
  }
  if (stops.some((s) => s.at! < 0 || s.at! > 1)) return undefined;
  return stops.map((s) => ({ color: s.color, at: Math.round(s.at! * 10000) / 10000 }));
}

const SIDES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

/** The angle of `to <side>` or `to <corner>` in a box, in CSS degrees (0 is up, clockwise). */
function directionAngle(
  words: readonly string[],
  box: { w: number; h: number },
): number | undefined {
  if (words.length === 1) return SIDES[words[0]!];
  if (words.length !== 2) return undefined;
  const vertical = words.find((w) => w === 'top' || w === 'bottom');
  const horizontal = words.find((w) => w === 'left' || w === 'right');
  if (!vertical || !horizontal) return undefined;
  // The line points at the corner so that the 50% line runs through the two other corners.
  const toTopRight = (Math.atan2(box.h, box.w) * 180) / Math.PI;
  if (vertical === 'top') return horizontal === 'right' ? toTopRight : 360 - toTopRight;
  return horizontal === 'right' ? 180 - toTopRight : 180 + toTopRight;
}

function percent(value: string): number | undefined {
  return /^-?[\d.]+%$/.test(value) ? parseFloat(value) / 100 : undefined;
}

function centerOf(words: readonly string[]): { x: number; y: number } | undefined {
  if (words.length !== 2) return undefined;
  const x = percent(words[0]!);
  const y = percent(words[1]!);
  return x === undefined || y === undefined ? undefined : { x, y };
}

/**
 * One computed gradient as a model fill, when the model can say the same thing: a linear
 * gradient with an angle or a direction, a radial one of the default shape (an ellipse to the
 * farthest corner), a conic one. Undefined otherwise; the caller keeps the CSS.
 */
export function parseGradient(
  value: string,
  box: { w: number; h: number },
  color: ColorReader,
): Fill | undefined {
  const m = /^(linear|radial|conic)-gradient\((.*)\)$/s.exec(value.trim());
  if (!m) return undefined;
  const kind = m[1] as 'linear' | 'radial' | 'conic';
  const parts = splitTopLevel(m[2]!, ',');
  const head = splitTopLevel(parts[0] ?? '', ' ');
  const headIsStop = color(head[0] ?? '') !== undefined;

  if (kind === 'linear') {
    let angle = 180;
    if (!headIsStop) {
      const first = head[0] ?? '';
      const found = first === 'to' ? directionAngle(head.slice(1), box) : angleDegrees(parts[0]!);
      if (found === undefined) return undefined;
      angle = found;
    }
    const rad = (angle * Math.PI) / 180;
    const length = Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad));
    const stops = parseStops(headIsStop ? parts : parts.slice(1), color, (v) =>
      v.endsWith('px') && length > 0 ? parseFloat(v) / length : percent(v),
    );
    return stops ? { kind: 'linear', angle: Math.round(angle * 100) / 100, stops } : undefined;
  }

  if (kind === 'radial') {
    let center: { x: number; y: number } | undefined;
    if (!headIsStop) {
      // Only "at <x>% <y>%", with or without the default shape words.
      const words = head.filter((w) => w !== 'ellipse' && w !== 'farthest-corner');
      if (words[0] !== 'at') return undefined;
      center = centerOf(words.slice(1));
      if (!center) return undefined;
    }
    const stops = parseStops(headIsStop ? parts : parts.slice(1), color, percent);
    if (!stops) return undefined;
    const centred = !center || (center.x === 0.5 && center.y === 0.5);
    return { kind: 'radial', stops, ...(centred ? {} : { center }) };
  }

  let angle = 0;
  let center: { x: number; y: number } | undefined;
  if (!headIsStop) {
    let rest = head;
    if (rest[0] === 'from') {
      const found = angleDegrees(rest[1] ?? '');
      if (found === undefined) return undefined;
      angle = found;
      rest = rest.slice(2);
    }
    if (rest[0] === 'at') {
      center = centerOf(rest.slice(1));
      if (!center) return undefined;
    } else if (rest.length > 0) return undefined;
  }
  const stops = parseStops(headIsStop ? parts : parts.slice(1), color, (v) => {
    const degrees = angleDegrees(v);
    return degrees === undefined ? percent(v) : degrees / 360;
  });
  if (!stops) return undefined;
  const centred = !center || (center.x === 0.5 && center.y === 0.5);
  return { kind: 'conic', angle, stops, ...(centred ? {} : { center }) };
}

function angleDegrees(value: string): number | undefined {
  const m = /^(-?[\d.]+)(deg|rad|turn|grad)$/.exec(value.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  const unit = m[2];
  return unit === 'deg'
    ? n
    : unit === 'rad'
      ? (n * 180) / Math.PI
      : unit === 'turn'
        ? n * 360
        : n * 0.9;
}

/** The family names of a computed `font-family`, without quotes, lower case. */
export function fontFamilies(value: string): string[] {
  return splitTopLevel(value, ',')
    .map((f) => f.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);

export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.toLowerCase());
}

/** Whether two computed `font-family` lists name the same families in the same order. */
export function sameFamilies(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f.toLowerCase() === b[i]!.toLowerCase());
}

/**
 * White space as `white-space: normal` shows it: runs of spaces, tabs and line feeds become
 * one space, and spaces at the start and end of a line (a forced break or the block's edge)
 * disappear. The renderer lays text out with `pre-wrap`, which would show them all.
 * `breaks[i]` says that part `i` is a forced line break.
 */
export function collapseWhitespace(parts: readonly string[], breaks: readonly boolean[]): string[] {
  const out = [...parts];
  let afterSpace = true;
  for (let i = 0; i < out.length; i++) {
    if (breaks[i]) {
      afterSpace = true;
      continue;
    }
    let text = out[i]!.replace(/[ \t\n\r\f]+/g, ' ');
    if (afterSpace && text.startsWith(' ')) text = text.slice(1);
    if (text.length > 0) afterSpace = text.endsWith(' ');
    out[i] = text;
  }
  // The space before a forced break, and at the very end, is not shown either.
  const trimBefore = (end: number) => {
    for (let j = end - 1; j >= 0 && !breaks[j]; j--) {
      if (out[j] === '') continue;
      out[j] = out[j]!.replace(/ $/, '');
      return;
    }
  };
  for (let i = 0; i < out.length; i++) if (breaks[i]) trimBefore(i);
  trimBefore(out.length);
  return out;
}

export interface Line {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /**
   * Where the baseline is, when the font the box was laid out in is known. Text of two fonts
   * on one line shares a baseline, and neither the tops of its boxes nor their bottoms.
   */
  base?: number;
}

/**
 * Groups the boxes of pieces of text into lines: boxes whose vertical middle falls inside a
 * line belong to it. Lines come back top to bottom.
 */
export function groupLines(rects: readonly Line[]): Line[] {
  const lines: Line[] = [];
  const sorted = [...rects]
    .filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5)
    .sort((p, q) => p.top - q.top || p.left - q.left);
  for (const r of sorted) {
    const middle = (r.top + r.bottom) / 2;
    const line = lines.find((l) => middle > l.top && middle < l.bottom);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      if (line.base === undefined && r.base !== undefined) line.base = r.base;
    } else {
      lines.push({ ...r });
    }
  }
  return lines.sort((p, q) => p.top - q.top);
}

/**
 * Whether a text breaks into the same lines in the converted slide: as many lines, each as
 * wide. Checked on the layout at 1920, whatever size the source was written at (ADR-005).
 */
export function wrapsDifferently(
  source: readonly Line[],
  converted: readonly Line[],
): string | undefined {
  if (source.length !== converted.length) {
    return `wraps differently (${source.length} lines in the source, ${converted.length} converted)`;
  }
  for (let i = 0; i < source.length; i++) {
    const wide = source[i]!.right - source[i]!.left;
    const off = Math.abs(converted[i]!.right - converted[i]!.left - wide);
    if (off > Math.max(1.5, 0.004 * wide)) {
      return `line ${i + 1} is ${off.toFixed(1)}px wider or narrower`;
    }
  }
  return undefined;
}

/**
 * Whether the characters of a text sit elsewhere along their lines than the source's, one by
 * one, in the order of the text. The boxes of whole lines cannot show that: a part the source
 * laid out in a direction of its own (`C++`, a range of hours, a price in a Hebrew sentence)
 * fills the same stretch of the line whichever way round it is drawn. A character that only
 * moved with its line, or by the rounding of a glyph, is within the tolerance; one that
 * changed places with a neighbour is at least a neighbour's width away.
 */
export function charactersMoved(source: readonly Line[], converted: readonly Line[]): boolean {
  if (source.length !== converted.length) return true;
  return source.some((s, i) => {
    const c = converted[i]!;
    const tolerance = Math.max(2.5, 0.4 * (s.right - s.left));
    return Math.abs(c.left - s.left) > tolerance || Math.abs(c.right - s.right) > tolerance;
  });
}

export type LineVerdict =
  /** The lines sit where the source's do; `dx`, `dy` is what is left, a fraction of a pixel. */
  | { kind: 'same'; dx: number; dy: number }
  /** Every line is off by the same amount: the box can be moved to match. */
  | { kind: 'shifted'; dx: number; dy: number }
  /** The lines are spaced differently: `ratio` is source pitch over converted pitch. */
  | { kind: 'pitch'; ratio: number }
  | { kind: 'different'; why: string };

/**
 * Compares where the lines of a text sit in the source and in the converted slide (ADR-005:
 * wrapping is checked by geometry, which raster noise cannot disturb). Measured on correct
 * conversions, lines land within half a pixel; the tolerance is 1.5px, and a little more
 * along long lines.
 */
export function compareLines(
  source: readonly Line[],
  converted: readonly Line[],
  /**
   * Report a different spacing of the lines even where every line is still within the
   * tolerance: a text of two lines whose second sits a pixel low passes the geometry and
   * fails the pixels, and the spacing is something the caller can put right.
   */
  exactPitch = false,
): LineVerdict {
  if (source.length !== converted.length) {
    return {
      kind: 'different',
      why: `wraps differently (${source.length} lines in the source, ${converted.length} converted)`,
    };
  }
  if (source.length === 0) return { kind: 'same', dx: 0, dy: 0 };
  const tolY = 1.5;
  const tolX = (line: Line) => Math.max(1.5, 0.004 * (line.right - line.left));
  const off = source.map((s, i) => {
    const c = converted[i]!;
    // Where both baselines are known they say how far down the line is: a line the source
    // drew in one box and the converted slide in the boxes of two fonts differs in top and
    // bottom without being anywhere else.
    const down = s.base !== undefined && c.base !== undefined ? c.base - s.base : undefined;
    return {
      left: c.left - s.left,
      right: c.right - s.right,
      top: down ?? c.top - s.top,
      bottom: down ?? c.bottom - s.bottom,
    };
  });
  const within = off.every(
    (d, i) =>
      Math.max(Math.abs(d.left), Math.abs(d.right)) <= tolX(source[i]!) &&
      Math.max(Math.abs(d.top), Math.abs(d.bottom)) <= tolY,
  );
  const first = off[0]!;
  // Glyphs hang on the baseline, about four fifths down their box. Through a nested scale the
  // boxes of the two sides differ in height by a fraction, and it is the baselines that must meet.
  const baseline = first.top + 0.8 * (first.bottom - first.top);
  const pitch = (): LineVerdict | undefined => {
    if (source.length < 2) return undefined;
    const last = source.length - 1;
    const based = [...source, ...converted].every((line) => line.base !== undefined);
    const at = (line: Line) => (based ? line.base! : line.top);
    const sourcePitch = (at(source[last]!) - at(source[0]!)) / last;
    const convertedPitch = (at(converted[last]!) - at(converted[0]!)) / last;
    const sameAcross = off.every(
      (d, i) =>
        Math.max(Math.abs(d.left - first.left), Math.abs(d.right - first.left)) <= tolX(source[i]!),
    );
    return sameAcross && convertedPitch > 0 && Math.abs(sourcePitch - convertedPitch) > 0.05
      ? { kind: 'pitch', ratio: sourcePitch / convertedPitch }
      : undefined;
  };
  const spaced = exactPitch ? pitch() : undefined;
  if (spaced) return spaced;
  if (within) return { kind: 'same', dx: first.left, dy: baseline };

  // The same widths and heights everywhere, only somewhere else: a shift.
  const rigid = off.every(
    (d, i) =>
      Math.abs(d.left - first.left) <= tolX(source[i]!) &&
      Math.abs(d.right - first.left) <= tolX(source[i]!) &&
      Math.abs(d.top - first.top) <= tolY &&
      Math.abs(d.bottom - first.top) <= tolY,
  );
  if (rigid) return { kind: 'shifted', dx: first.left, dy: baseline };

  const otherPitch = pitch();
  if (otherPitch) return otherPitch;
  const worst = off.reduce(
    (m, d, i) => {
      const dx = Math.max(Math.abs(d.left), Math.abs(d.right));
      const dy = Math.max(Math.abs(d.top), Math.abs(d.bottom));
      return dx + dy > m.dx + m.dy ? { i, dx, dy } : m;
    },
    { i: 0, dx: 0, dy: 0 },
  );
  return {
    kind: 'different',
    why: `line ${worst.i + 1} is off by ${worst.dx.toFixed(1)}px across, ${worst.dy.toFixed(1)}px down`,
  };
}
