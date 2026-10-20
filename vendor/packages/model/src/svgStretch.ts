import type { GroupElement, SvgElement, SvgStretch } from './schema';

export interface StretchSegment {
  from: number;
  length: number;
  at: number;
  size: number;
}

/** A piecewise linear axis, shared by the drawing and the editable text on top of it. */
function stretchAxis(length: number, size: number, bands: SvgStretch['x'], scale: number) {
  const flexible = bands.reduce((sum, [a, b]) => sum + b - a, 0);
  const grow = Math.max(0.0001, (size - (length - flexible) * scale) / flexible);
  const segments: StretchSegment[] = [];
  let source = 0;
  let target = 0;
  const add = (end: number, ratio: number) => {
    if (end <= source) return;
    const span = end - source;
    const last = segments.at(-1);
    if (last && Math.abs(last.size / last.length - ratio) < 1e-9) {
      last.length += span;
      last.size += span * ratio;
    } else {
      segments.push({ from: source, length: span, at: target, size: span * ratio });
    }
    target += span * ratio;
    source = end;
  };
  for (const [start, end] of bands) {
    add(start, scale);
    add(end, grow);
  }
  add(length, scale);
  return {
    segments,
    map: (value: number) => {
      const part = segments.find((one) => value <= one.from + one.length) ?? segments.at(-1)!;
      return part.at + ((value - part.from) * part.size) / part.length;
    },
    unmap: (value: number) => {
      const part = segments.find((one) => value <= one.at + one.size) ?? segments.at(-1)!;
      return part.from + ((value - part.at) * part.length) / part.size;
    },
  };
}

/**
 * Corners retain their authored scale. Only below the space the fixed artwork needs does it
 * shrink uniformly; a small part of each flexible band remains, so mapping stays reversible.
 */
export function svgStretchLayout(stretch: SvgStretch, size: { w: number; h: number }) {
  const { viewBox, x, y } = stretch;
  const minimum = (length: number, bands: SvgStretch['x']) =>
    length - 0.9 * bands.reduce((sum, [a, b]) => sum + b - a, 0);
  const scale = Math.max(
    0.0001,
    Math.min(stretch.scale, size.w / minimum(viewBox.w, x), size.h / minimum(viewBox.h, y)),
  );
  return {
    scale,
    x: stretchAxis(viewBox.w, size.w, x, scale),
    y: stretchAxis(viewBox.h, size.h, y, scale),
  };
}

/** The plate of a label remains a normal, independently editable SVG inside its group. */
export function textBackground(
  group: GroupElement,
): (SvgElement & { stretch: SvgStretch }) | undefined {
  if (
    !group.children.some((child) => child.type === 'text') ||
    group.children.some((child) => child.type === 'image' || child.type === 'group')
  )
    return undefined;
  return group.children.find(
    (child): child is SvgElement & { stretch: SvgStretch } =>
      child.type === 'svg' && child.rotation === 0 && Boolean(child.stretch),
  );
}
