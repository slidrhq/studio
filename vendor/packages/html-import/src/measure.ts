/**
 * Reading a rendered DOM (SPEC 13.1): what is shown, where the browser put it, and in which
 * order it is painted. Nothing here looks at tag names of a presentation format or at class
 * names (IMP-04); the only names used are those HTML itself gives meaning to.
 *
 * The elements measured usually live in another document (the sandbox frame), so nothing here
 * uses `instanceof`: a node of another document is not an instance of this window's classes.
 */
import { alphaOf, groupLines, px, uniformScale, type Line } from './css';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

export function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

export function isSvg(el: Element): boolean {
  return el.namespaceURI === SVG_NS;
}

export function styleOf(el: Element, pseudo?: string): CSSStyleDeclaration {
  return el.ownerDocument.defaultView!.getComputedStyle(el, pseudo);
}

/** Children in the tree as it is rendered: shadow roots are entered and slots resolved. */
export function composedChildNodes(el: Element): Node[] {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  if (el.localName === 'slot') {
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    if (assigned.length > 0) return assigned;
  }
  return Array.from(el.childNodes);
}

export function composedChildren(el: Element): Element[] {
  return composedChildNodes(el).filter(isElement);
}

/** The parent in the rendered tree: a shadow root's host for the root's children. */
export function composedParent(node: Node): Element | undefined {
  if ((node as Element).assignedSlot) return (node as Element).assignedSlot!;
  const parent = node.parentNode;
  if (!parent) return undefined;
  if (parent.nodeType === 11) return (parent as ShadowRoot).host ?? undefined;
  return isElement(parent) ? parent : undefined;
}

/** Whether `node` is `container` or sits inside it in the rendered tree. */
export function isInside(node: Node, container: Element): boolean {
  for (let n: Node | undefined = node; n; n = composedParent(n)) if (n === container) return true;
  return false;
}

/**
 * Where a click on the element leads: the address of the link it is, or sits in (`<a href>`,
 * as HTML means it), as the source wrote it. A picture cannot show a link, so the guard cannot
 * miss one: whatever stands for the element carries it.
 */
export function linkAround(el: Element): string | undefined {
  for (let n: Element | undefined = el; n; n = composedParent(n)) {
    const href = n.localName === 'a' ? n.getAttribute('href')?.trim() : undefined;
    if (href) return href;
  }
  return undefined;
}

/** Elements that never draw anything themselves. */
const NOT_RENDERED = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'head',
  'title',
  'meta',
  'link',
  'base',
]);

export function neverRendered(el: Element): boolean {
  return NOT_RENDERED.has(el.localName);
}

/** Nothing of the element or of anything inside it is shown. */
export function subtreeHidden(cs: CSSStyleDeclaration): boolean {
  return (
    cs.display === 'none' ||
    parseFloat(cs.opacity) === 0 ||
    cs.getPropertyValue('content-visibility') === 'hidden'
  );
}

/**
 * Content kept for assistive technology and never shown: clipped down to a pixel or two
 * (the usual "screen reader only" recipe), whichever property does the clipping.
 */
export function clippedAway(cs: CSSStyleDeclaration, rect: DOMRect): boolean {
  const clips =
    cs.overflowX !== 'visible' ||
    cs.overflowY !== 'visible' ||
    (cs.clip !== '' && cs.clip !== 'auto');
  if (clips && (rect.width <= 2 || rect.height <= 2)) return true;
  return /^inset\(\s*(50%|100%)/.test(cs.clipPath);
}

export interface Paint {
  any: boolean;
  background: boolean;
  border: boolean;
  shadow: boolean;
  borders: { width: number; style: string; color: string }[];
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

/** What the element's own box draws, apart from its content. */
export function ownPaint(cs: CSSStyleDeclaration): Paint {
  const borders = SIDES.map((side) => ({
    width: px(cs[`border${side}Width`]),
    style: cs[`border${side}Style`],
    color: cs[`border${side}Color`],
  }));
  const border = borders.some(
    (b) => b.width > 0 && b.style !== 'none' && b.style !== 'hidden' && alphaOf(b.color) > 0,
  );
  const background = alphaOf(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none';
  const shadow = cs.boxShadow !== 'none';
  const outline = cs.outlineStyle !== 'none' && px(cs.outlineWidth) > 0;
  const backdrop = cs.backdropFilter !== '' && cs.backdropFilter !== 'none';
  return {
    any: border || background || shadow || outline || backdrop,
    background,
    border,
    shadow,
    borders,
  };
}

/**
 * A pseudo-element that shows something: `text` when it is plain inline text the text model
 * can hold as a run, `box` when it paints or is positioned: a box no node stands for.
 */
export function pseudoKind(el: Element, which: '::before' | '::after'): 'text' | 'box' | undefined {
  const cs = styleOf(el, which);
  const content = cs.content;
  if (!content || content === 'none' || content === 'normal' || cs.display === 'none')
    return undefined;
  const literal = /^"((?:[^"\\]|\\.)*)"$/.test(content);
  const plain = literal && cs.display === 'inline' && cs.position === 'static' && !ownPaint(cs).any;
  if (plain) return content === '""' ? undefined : 'text';
  return 'box';
}

/** The text of a literal `content` value. */
export function pseudoText(cs: CSSStyleDeclaration): string {
  return cs.content.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * Whether the element starts a stacking context, and where it sits among its siblings in one.
 * z-index orders siblings inside the same stacking context only, so paint order is a path of
 * such positions from the root down, not one global number (ADR-005).
 */
export interface ZKey {
  /**
   * `[z-index, positioned, visit number, forms a stacking context]` of each positioned or
   * context-forming ancestor, the element itself included.
   */
  path: (readonly [number, number, number, number])[];
  seq: number;
}

export function zKeyOf(el: Element, cs: CSSStyleDeclaration, inherited: ZKey, seq: number): ZKey {
  const parent = composedParent(el);
  return zKeyIn(cs, parent ? styleOf(parent).display : '', inherited, seq);
}

/** The same for a box that is not a node of its own: a pseudo-element, in its element. */
export function zKeyIn(
  cs: CSSStyleDeclaration,
  parentDisplay: string,
  inherited: ZKey,
  seq: number,
): ZKey {
  const positioned = cs.position !== 'static';
  const zApplies = positioned || /flex|grid/.test(parentDisplay);
  const context =
    (zApplies && cs.zIndex !== 'auto') ||
    cs.position === 'fixed' ||
    cs.position === 'sticky' ||
    parseFloat(cs.opacity) < 1 ||
    cs.transform !== 'none' ||
    cs.filter !== 'none' ||
    cs.perspective !== 'none' ||
    cs.isolation === 'isolate' ||
    cs.mixBlendMode !== 'normal' ||
    cs.clipPath !== 'none' ||
    (cs.backdropFilter !== '' && cs.backdropFilter !== 'none') ||
    /transform|opacity/.test(cs.willChange) ||
    /paint|strict|content/.test(cs.contain);
  if (!context && !positioned) return { path: inherited.path, seq };
  const z = zApplies && cs.zIndex !== 'auto' ? Number(cs.zIndex) || 0 : 0;
  return { path: [...inherited.path, [z, positioned ? 1 : 0, seq, context ? 1 : 0]], seq };
}

/**
 * Sorts by CSS paint order: lower z-index first, then positioned over not, then tree order.
 * `box` marks an element's own background and borders: those of an element that forms a
 * stacking context are painted before everything in it, its negative z-index children too.
 */
export function comparePaintOrder(
  a: { z: ZKey; emitted: number; box?: boolean },
  b: { z: ZKey; emitted: number; box?: boolean },
): number {
  const A = a.z.path;
  const B = b.z.path;
  /** How an item stands among the participants of the context its path ends in. */
  const own = (item: { z: ZKey; box?: boolean }, path: ZKey['path']) => {
    const last = path[path.length - 1];
    const first = item.box && last && last[2] === item.z.seq && last[3] === 1;
    // Otherwise content that is not inside a further participant paints like z 0, not positioned.
    return [first ? -Infinity : 0, 0, item.z.seq] as const;
  };
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? own(a, A);
    const y = B[i] ?? own(b, B);
    if (A[i] && B[i] && x[2] === y[2]) continue;
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] - y[1];
    return x[2] - y[2];
  }
  return a.emitted - b.emitted;
}

/** The scale of the element's own transform, when that is all the transform does. */
export function ownScale(cs: CSSStyleDeclaration): number | undefined {
  return uniformScale(cs.transform);
}

/**
 * Where the browser actually paints a box. Outside transforms it snaps box edges to whole
 * pixels; a converted box at the unsnapped place would be drawn half a pixel off (ADR-005).
 */
export function snapRect(
  r: { left: number; top: number; width: number; height: number },
  scaled: boolean,
) {
  if (scaled) return { left: r.left, top: r.top, width: r.width, height: r.height };
  const left = Math.round(r.left);
  const top = Math.round(r.top);
  return {
    left,
    top,
    width: Math.round(r.left + r.width) - left,
    height: Math.round(r.top + r.height) - top,
  };
}

/** The box inside the element's border and padding. `scale` turns its CSS px into screen px. */
export function contentRect(el: Element, cs: CSSStyleDeclaration, scale: number) {
  const r = el.getBoundingClientRect();
  const l = (px(cs.borderLeftWidth) + px(cs.paddingLeft)) * scale;
  const t = (px(cs.borderTopWidth) + px(cs.paddingTop)) * scale;
  const rr = (px(cs.borderRightWidth) + px(cs.paddingRight)) * scale;
  const b = (px(cs.borderBottomWidth) + px(cs.paddingBottom)) * scale;
  return {
    left: r.left + l,
    top: r.top + t,
    width: Math.max(0, r.width - l - rr),
    height: Math.max(0, r.height - t - b),
  };
}

const baselines = new WeakMap<Document, Map<string, number | undefined>>();

/**
 * How far down the box of text in this font its baseline is: the share of the ascent in the
 * box. The box of a piece of text is the ascent and descent of the first font of the list the
 * document has, whichever font draws the letters. The browser rounds both to whole pixels at
 * the size the text is laid out at, which under a CSS zoom is not the size its style says.
 */
function baselineShare(el: Element): number | undefined {
  const doc = el.ownerDocument;
  const cs = styleOf(el);
  const zoom = (el as Element & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
  const font = `${cs.fontStyle} ${cs.fontWeight} ${px(cs.fontSize) * zoom}px ${cs.fontFamily}`;
  let known = baselines.get(doc);
  if (!known) {
    known = new Map();
    baselines.set(doc, known);
  }
  if (known.has(font)) return known.get(font);
  const ctx = doc.createElement('canvas').getContext('2d');
  let share: number | undefined;
  if (ctx) {
    ctx.font = font;
    const metrics = ctx.measureText('x');
    const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    if (height > 0) share = metrics.fontBoundingBoxAscent / height;
  }
  known.set(font, share);
  return share;
}

/**
 * The boxes of the words of the text under `node`, in viewport pixels of its document.
 * Words, not whole runs: a space where a line wraps has a box in `pre-wrap` text and none in
 * normal text, and the two must compare equal. `skip` leaves out subtrees (list markers).
 */
export function wordRects(node: Node, skip?: (el: Element) => boolean): Line[] {
  const doc = node.ownerDocument!;
  const range = doc.createRange();
  const rects: Line[] = [];
  const visit = (n: Node) => {
    if (isText(n)) {
      const words = n.data.matchAll(/\S+/g);
      const share = n.parentElement ? baselineShare(n.parentElement) : undefined;
      for (const word of words) {
        range.setStart(n, word.index);
        range.setEnd(n, word.index + word[0].length);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && r.height > 0) {
            rects.push({
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              ...(share === undefined ? {} : { base: r.top + r.height * share }),
            });
          }
        }
      }
      return;
    }
    if (!isElement(n) || neverRendered(n) || skip?.(n)) return;
    const cs = styleOf(n);
    if (subtreeHidden(cs)) return;
    for (const child of composedChildNodes(n)) visit(child);
  };
  visit(node);
  return rects;
}

/** The lines of the text under `node`. */
export function textLines(node: Node, skip?: (el: Element) => boolean): Line[] {
  return groupLines(wordRects(node, skip));
}

/**
 * The box of every character of the text under `node` that is drawn, in the order of the text
 * (white space left out, since it collapses differently in the two places a text is measured).
 * Where each character sits says in which order the browser laid the text out. Text the
 * reading of a block leaves out (hidden, of no size) has no box here either.
 */
export function charRects(node: Node, skip?: (el: Element) => boolean): Line[] {
  const doc = node.ownerDocument!;
  const range = doc.createRange();
  const rects: Line[] = [];
  const visit = (n: Node) => {
    if (isText(n)) {
      for (let at = 0; at < n.data.length;) {
        // By character, not by code unit: half of a pair has no box of its own.
        const length = (n.data.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
        if (!/^\s$/u.test(n.data.slice(at, at + length))) {
          range.setStart(n, at);
          range.setEnd(n, at + length);
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
          }
        }
        at += length;
      }
      return;
    }
    if (!isElement(n) || neverRendered(n) || skip?.(n)) return;
    const cs = styleOf(n);
    if (subtreeHidden(cs) || cs.visibility !== 'visible') return;
    for (const child of composedChildNodes(n)) visit(child);
  };
  visit(node);
  return rects;
}

/** The visible characters under an element, white space collapsed. */
export function visibleChars(el: Element): number {
  let chars = 0;
  const visit = (n: Node) => {
    if (isText(n)) {
      chars += n.data.replace(/\s+/g, ' ').trim().length;
      return;
    }
    if (!isElement(n) || neverRendered(n)) return;
    const cs = styleOf(n);
    if (subtreeHidden(cs) || cs.visibility !== 'visible') return;
    for (const child of composedChildNodes(n)) visit(child);
  };
  visit(el);
  return chars;
}

/**
 * Where a document's viewport sits in the page the engine runs in, in that page's CSS pixels:
 * the offsets of the frames between the two. Frames are taken to be unscaled.
 */
export function viewportOffset(doc: Document, page: Window = window): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let view: Window | null = doc.defaultView;
  while (view && view !== page && view.frameElement) {
    const frame = view.frameElement;
    const r = frame.getBoundingClientRect();
    x += r.left + frame.clientLeft;
    y += r.top + frame.clientTop;
    if (view.parent === view) break;
    view = view.parent;
  }
  return { x, y };
}
