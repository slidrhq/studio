import { svgStretchLayout, type SvgStretch } from '@slidr/model';

const NS = 'http://www.w3.org/2000/svg';

/**
 * Draw one cleaned SVG through masked sections. Only the designated strips stretch; details
 * outside them retain their proportions. The drawing is stored once, and each section refers
 * to it. These ordinary SVG nodes also work in an offline export.
 */
export function stretchSvg(
  fragment: DocumentFragment,
  stretch: SvgStretch,
  size: { w: number; h: number },
): DocumentFragment {
  const original = fragment.querySelector('svg');
  if (!original || size.w <= 0 || size.h <= 0) return fragment;
  const { x, y } = svgStretchLayout(stretch, size);
  const doc = fragment.ownerDocument;
  const node = (name: string, attrs: Record<string, string | number> = {}) => {
    const element = doc.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  };
  const root = node('svg', {
    width: '100%',
    height: '100%',
    viewBox: `0 0 ${size.w} ${size.h}`,
    preserveAspectRatio: 'none',
    'data-stretch-background': '',
  });
  root.style.display = 'block';
  let id = 'slidr-stretch-source';
  while (original.querySelector(`[id^="${id}"]`) || original.id.startsWith(id)) id += '-';
  const source = node('g', { id });
  original.setAttribute('width', String(stretch.viewBox.w));
  original.setAttribute('height', String(stretch.viewBox.h));
  source.append(original);
  const defs = node('defs');
  defs.append(source);
  root.append(defs);
  let index = 0;
  for (const row of y.segments) {
    for (const col of x.segments) {
      const clipId = `${id}-clip-${index++}`;
      const clip = node('mask', {
        id: clipId,
        maskUnits: 'userSpaceOnUse',
        maskContentUnits: 'userSpaceOnUse',
        x: 0,
        y: 0,
        width: size.w,
        height: size.h,
        'mask-type': 'alpha',
      });
      // Adjacent strips must share a hard boundary even at fractional zoom. Antialiasing
      // each section separately leaves hairline seams through an otherwise solid plate.
      clip.append(
        node('rect', {
          x: col.at,
          y: row.at,
          width: col.size,
          height: row.size,
          fill: 'white',
          'shape-rendering': 'crispEdges',
        }),
      );
      defs.append(clip);
      const sx = col.size / col.length;
      const sy = row.size / row.length;
      const part = node('g', { mask: `url(#${clipId})` });
      part.append(
        node('use', {
          href: `#${id}`,
          transform: `translate(${col.at - col.from * sx} ${row.at - row.from * sy}) scale(${sx} ${sy})`,
        }),
      );
      root.append(part);
    }
  }
  fragment.replaceChildren(root);
  return fragment;
}
