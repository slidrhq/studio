/**
 * Render and measure (SPEC 11.5, 13.1): walks a rendered subtree and turns what the browser
 * reports into model elements. It decides by computed styles and measured boxes, never by tag
 * names or class names of a format (IMP-04): a table is whatever computes to `display: table`,
 * a list item whatever computes to `list-item`, text whatever has glyph boxes.
 *
 * The walk only proposes. The fidelity guard renders the proposal and puts back as HTML
 * whatever looks different from the source (SPEC 5.9).
 */
import {
  Archetype,
  ChartElement,
  createElement,
  mapCssColors,
  PlaceholderRole,
  themeColorCss,
  type Accent,
  type Background,
  type Deck,
  type Element as ModelElement,
  type Fill,
  type Frame,
  type ListInfo,
  type Shadow,
  type Stroke,
} from '@slidr/model';
import {
  alphaOf,
  cornerRadius,
  parseBoxShadow,
  parseColor,
  parseGradient,
  px,
  rotationAndScale,
  round,
  scalePx,
  shadowFromBox,
  splitTopLevel,
  uniformScale,
  type Line,
} from './css';
import { parseAnim, type Anim } from './anim';
import type { ConversionHost, Rect } from './host';
import { BLANK_IMAGE_ATTRIBUTE, type CopyStrategy } from './htmlCopy';
import {
  charRects,
  clippedAway,
  comparePaintOrder,
  composedChildNodes,
  composedChildren,
  composedParent,
  contentRect,
  isElement,
  isInside,
  isSvg,
  isText,
  linkAround,
  neverRendered,
  ownPaint,
  pseudoKind,
  snapRect,
  styleOf,
  subtreeHidden,
  textLines,
  visibleChars,
  zKeyOf,
  type Paint,
  type ZKey,
  zKeyIn,
} from './measure';
import { readTable } from './table';
import {
  firstPartStyled,
  firstText,
  hasAnyText,
  hasOwnText,
  isPureInline,
  lineHeightPx,
  readListMarker,
  readTextBlock,
  resetsListCount,
  type TextTheme,
} from './text';

/** Whether a fill hides everything under it. */
export function opaqueFill(fill: Fill): boolean {
  const solid = (c: { alpha?: number }) => c.alpha === undefined || c.alpha >= 1;
  if (fill.kind === 'solid') return solid(fill.color);
  if (fill.kind === 'linear' || fill.kind === 'radial' || fill.kind === 'conic') {
    return fill.stops.every((s) => solid(s.color));
  }
  return false;
}

/** One proposed element and the part of the source it stands for. */
export interface Item {
  element: ModelElement;
  node: Element;
  /**
   * What of the node the element stands for: everything in it, only its own box (its content
   * is other items), or one run of text directly in it.
   */
  covers: 'subtree' | 'box' | 'text';
  /** The part of the source picture the element owns, in viewport px of the source document. */
  region: Rect;
  /** Where the lines of a text sit, in slide px. Absent when they cannot be compared. */
  lines?: Line[];
  /**
   * Where each character of the text sits, in slide px and in the order of the text: given for
   * text with a part in a direction of its own, which the model's runs cannot say. Whether it
   * reads the same without it is measured (`charactersMoved`).
   */
  characters?: Line[];
  /** Strips of the source picture not compared: list markers, which the renderer draws its own way. */
  ignored?: Rect[];
  /** The element's look is the app's, not the source's (a placeholder, a chart): not compared. */
  exempt?: boolean;
  /** Drawn through a scale nested in the source: its pixels carry raster noise (ADR-005). */
  scaled: boolean;
  /** Content items the element stands for, and their characters (editability). */
  units: number;
  chars: number;
  z: ZKey;
  emitted: number;
  /** Opacity of everything above the node. */
  inheritedOpacity: number;
  /** Screen px per CSS px of the node's parent. */
  parentScale: number;
  /** For `html` elements: how the copy is made, and why the region is HTML. */
  copy?: CopyStrategy;
  reason?: string;
  /** What the element enters with (`data-anim`), and the group it enters in. */
  anim?: Anim;
  /** The element stands for this pseudo-element of the node, not for the node's own box. */
  pseudo?: '::before' | '::after';
}

export interface Space {
  root: Element;
  /** The root's box in viewport px of its document. */
  rootRect: DOMRect;
  /** Screen px per CSS px of the root: a root shown through a scale is not 1. */
  viewScale: number;
  /** Slide px per CSS px of the root. */
  k: number;
  /** Where the root's top-left corner goes on the slide. */
  offX: number;
  offY: number;
}

export interface Proposal {
  space: Space;
  /** In paint order: the last is on top. */
  items: Item[];
  background?: Background;
  archetype?: Archetype;
  notes: string[];
  /** Names of `@keyframes` that elements kept as regular ones still animate with. */
  keyframes: Set<string>;
  /** Work that needs the host: storing the images the walk found. */
  pending: (() => Promise<void>)[];
}

export interface WalkOptions {
  deck: Deck;
  host: ConversionHost;
  text: TextTheme;
  /** Hands out element ids that are free in the deck. */
  nextId(): string;
  /** Stores the image at a URL as an asset, once, and returns its id. */
  storeImage(url: string): Promise<string | undefined>;
  /** Slide px per CSS px of the root, and where its corner goes. Default: fitted and centred. */
  placement?: { k: number; x: number; y: number };
  /**
   * The attribute that says how an element enters. Default `data-anim`, the agent's own; an
   * imported page is read by the marks the import put on it (`ANIM_MARK`).
   */
  animAttribute?: string;
}

/** Elements the model has no equivalent for: they stay HTML whatever they contain. */
const OPAQUE_TAGS = new Set([
  'canvas',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'input',
  'select',
  'textarea',
  'button',
  'math',
  'progress',
  'meter',
  'details',
]);

/** Non-inherited properties that change how a box looks and have no field in the model. */
const BOX_PASSTHROUGH: readonly (readonly [string, readonly string[]])[] = [
  ['filter', ['none']],
  ['mix-blend-mode', ['normal']],
  ['clip-path', ['none']],
  ['mask-image', ['none', '']],
  ['backdrop-filter', ['none', '']],
];

interface Inherited {
  opacity: number;
  z: ZKey;
  /** The scale of the transforms between the root and the element's parent. */
  scale: number;
  anim?: Anim;
  /** `data-role` of an ancestor that made no element of its own: its content takes the role. */
  role?: PlaceholderRole;
  /** The part of the page the boxes that clip their overflow leave visible. */
  clip?: Edges;
  /** The marker of a list item above that waits for the text of the item's first line. */
  marker?: Hanging;
}

/**
 * The marker of a list item that is not a block of text itself (it holds a nested list, or
 * its text is in a paragraph of its own). The browser hangs it beside the item's first line,
 * so the text that holds that line draws it, when that line starts where the item's content
 * does. Nothing compares a marker with the source's (the renderer draws its own), so one that
 * finds no such text is not guessed at: the item stays html.
 */
interface Hanging {
  list: ListInfo;
  /** The first text the item shows. */
  first: Text | null;
  /** Where the item's content starts on the side the marker hangs on, in viewport px. */
  start: number;
  rtl: boolean;
  taken: boolean;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(r: Edges, bounds: Edges): boolean {
  return !(
    r.right <= bounds.left ||
    r.left >= bounds.right ||
    r.bottom <= bounds.top ||
    r.top >= bounds.bottom
  );
}

function within(r: Edges, bounds: Edges): boolean {
  return (
    r.left >= bounds.left - 0.5 &&
    r.top >= bounds.top - 0.5 &&
    r.right <= bounds.right + 0.5 &&
    r.bottom <= bounds.bottom + 0.5
  );
}

/** How an element is emitted: its place in paint order and what it takes from above. */
interface State {
  z: ZKey;
  opacity: number;
  anim?: Inherited['anim'];
  role?: PlaceholderRole;
}

function intersects(r: DOMRect, bounds: DOMRect): boolean {
  return !(
    r.right < bounds.left ||
    r.left > bounds.right ||
    r.bottom < bounds.top ||
    r.top > bounds.bottom
  );
}

function toRect(r: { left: number; top: number; width: number; height: number }): Rect {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Whether a list item shows a number or a letter, which depends on where it stands. */
function readsAsNumbered(item: Element): boolean {
  const type = styleOf(item).listStyleType;
  return type !== 'none' && !/^(disc|circle|square|")/.test(type);
}

/** Counts the content under an element: text blocks, pictures and painted boxes. */
export function countContent(el: Element): { units: number; chars: number } {
  let units = 0;
  const visit = (node: Element) => {
    if (neverRendered(node)) return;
    const cs = styleOf(node);
    if (subtreeHidden(cs)) return;
    if (isSvg(node) || OPAQUE_TAGS.has(node.localName) || node.localName === 'img') {
      units++;
      return;
    }
    if (ownPaint(cs).any) units++;
    if (hasAnyText(node) && isPureInline(node)) {
      units++;
      return;
    }
    for (const child of composedChildren(node)) visit(child);
  };
  visit(el);
  return { units: Math.max(1, units), chars: visibleChars(el) };
}

/**
 * Measures the subtree under `root` and proposes elements for it. Synchronous: the DOM is
 * read in one pass and nothing is changed. What needs the host (storing images) is queued in
 * `pending`.
 */
export function propose(root: Element, options: WalkOptions): Proposal {
  const { deck, text } = options;
  const rootRect = root.getBoundingClientRect();
  const rootCs = styleOf(root);
  const html = root as HTMLElement;
  const logicalW = (!isSvg(root) && html.offsetWidth) || rootRect.width;
  const logicalH = (!isSvg(root) && html.offsetHeight) || rootRect.height;
  // Scale factors stay exact: rounding 0.9021 to 0.9 moves a whole slide by 4px (ADR-005).
  const viewScale = rootRect.width / logicalW;
  const k = options.placement?.k ?? Math.min(deck.size.w / logicalW, deck.size.h / logicalH);
  // Centred on the slide, a whole number of the source's own pixels in from the edge. Half a
  // source pixel there (a page 1265px wide beside a scrollbar gives one) would put every box
  // of the converted slide between two pixels when it is shown at the source's size, and the
  // browser would round its text to the other side.
  const centred = (room: number) => Math.round(room / 2 / k) * k;
  const space: Space = {
    root,
    rootRect,
    viewScale,
    k,
    offX: options.placement?.x ?? centred(deck.size.w - logicalW * k),
    offY: options.placement?.y ?? centred(deck.size.h - logicalH * k),
  };
  const fillsSlide =
    Math.abs(space.offX) < 0.5 &&
    Math.abs(space.offY) < 0.5 &&
    Math.abs(logicalW * k - deck.size.w) < 0.5 &&
    Math.abs(logicalH * k - deck.size.h) < 0.5;
  const proposal: Proposal = { space, items: [], notes: [], keyframes: new Set(), pending: [] };
  const { items, notes } = proposal;

  // Rectangles come from the browser already transformed; lengths read from computed styles
  // (font sizes, borders, radii) do not. Inside a scaled subtree they need the extra factor.
  let kl = k; // CSS px of the element being walked -> slide px
  let vl = viewScale; // CSS px of the element being walked -> screen px
  let visit = 0;
  let emitted = 0;
  let groups = 0;
  const animAttribute = options.animAttribute ?? 'data-anim';
  /** What an element enters with: its own attribute, or what it inherits. */
  const animOf = (el: Element, inherited: Anim | undefined): Anim | undefined => {
    const parsed = parseAnim(el.getAttribute(animAttribute), animAttribute);
    if (!parsed) return inherited;
    for (const note of parsed.notes) if (!notes.includes(note)) notes.push(note);
    if ('none' in parsed) return undefined;
    for (const name of parsed.keyframes) proposal.keyframes.add(name);
    return parsed.steps.length > 0 ? { steps: parsed.steps, group: groups++ } : inherited;
  };

  const toFrame = (r: { left: number; top: number; width: number; height: number }): Frame => ({
    x: round(((r.left - rootRect.left) / viewScale) * k + space.offX),
    y: round(((r.top - rootRect.top) / viewScale) * k + space.offY),
    w: round((r.width / viewScale) * k),
    h: round((r.height / viewScale) * k),
  });
  const toSlideLines = (lines: Line[]): Line[] =>
    lines.map((l) => ({
      left: ((l.left - rootRect.left) / viewScale) * k + space.offX,
      right: ((l.right - rootRect.left) / viewScale) * k + space.offX,
      top: ((l.top - rootRect.top) / viewScale) * k + space.offY,
      bottom: ((l.bottom - rootRect.top) / viewScale) * k + space.offY,
      ...(l.base === undefined
        ? {}
        : { base: ((l.base - rootRect.top) / viewScale) * k + space.offY }),
    }));
  const scaled = () => Math.abs(kl / k - 1) > 1e-6;
  const color: TextTheme['color'] = (css, node, property, pseudo) =>
    text.color(css, node, property, pseudo);

  const roleOf = (el: Element): PlaceholderRole | undefined => {
    const role = el.getAttribute('data-role')?.trim();
    if (!role) return undefined;
    const parsed = PlaceholderRole.safeParse(role);
    if (parsed.success) return parsed.data;
    const note = `data-role="${role}" is not a role; roles are ${PlaceholderRole.options.join(', ')}.`;
    if (!notes.includes(note)) notes.push(note);
    return undefined;
  };
  /** `data-name` and `data-role`, for the element that holds the node's content. */
  const label = (
    el: Element,
    inherited?: PlaceholderRole,
  ): { name?: string; role?: PlaceholderRole } => {
    const name = el.getAttribute('data-name')?.trim();
    const role = roleOf(el) ?? inherited;
    return { ...(name ? { name } : {}), ...(role ? { role } : {}) };
  };

  const emit = (
    element: ModelElement,
    node: Element,
    covers: Item['covers'],
    region: Rect,
    state: State,
    extra: Partial<Item> = {},
  ): Item => {
    const item: Item = {
      element,
      node,
      covers,
      region,
      scaled: scaled(),
      units: 1,
      chars: 0,
      z: state.z,
      emitted: emitted++,
      inheritedOpacity: state.opacity,
      // The node's own transform is not part of its parent's scale.
      parentScale: vl / (uniformScale(styleOf(node).transform) ?? 1),
      ...(state.anim ? { anim: state.anim } : {}),
      ...extra,
    };
    // Text carries a link on its runs (`readTextBlock`); everything else on the element.
    const link = element.type === 'text' ? undefined : linkAround(node);
    if (link) element.link = { kind: 'url', target: link };
    items.push(item);
    return item;
  };

  // ------------------------------------------------------------------------------- box looks

  /** What a box draws that only `css` can say, and whether its transform fits the model. */
  const boxEffects = (cs: CSSStyleDeclaration) => {
    const css: Record<string, string> = {};
    for (const [property, initial] of BOX_PASSTHROUGH) {
      const value = cs.getPropertyValue(property);
      if (value && !initial.includes(value)) css[property] = scalePx(value, kl);
    }
    if (css['mask-image']) {
      for (const property of ['mask-size', 'mask-position', 'mask-repeat', 'mask-mode']) {
        css[property] = scalePx(cs.getPropertyValue(property), kl);
      }
    }
    if (cs.outlineStyle !== 'none' && px(cs.outlineWidth) > 0) {
      css.outline = `${round(px(cs.outlineWidth) * kl)}px ${cs.outlineStyle} ${cs.outlineColor}`;
      if (px(cs.outlineOffset) !== 0)
        css['outline-offset'] = `${round(px(cs.outlineOffset) * kl)}px`;
    }
    if (cs.animationName !== 'none') {
      // In a foreign page, an animation that ends has ended: the guard finishes it before it
      // measures, and what an imported slide keeps is the state it ended in (ADR-005). Kept as
      // `css` it would hold a whole group back as HTML for something that no longer moves.
      // One that never ends is what the element looks like, and stays.
      const endless = splitTopLevel(cs.animationIterationCount, ',').some(
        (count) => count.trim() === 'infinite',
      );
      if (text.link || endless) {
        css.animation = cs.animation;
        for (const name of splitTopLevel(cs.animationName, ',')) proposal.keyframes.add(name);
      }
    }
    let rotation = 0;
    let transform: 'none' | 'scale' | 'rotate' | 'other' = 'none';
    if (cs.transform !== 'none') {
      if (uniformScale(cs.transform) !== undefined) transform = 'scale';
      else {
        // A turn the model's `rotation` can say; a turn that also scales is left to HTML.
        const found = rotationAndScale(cs.transform);
        const plain = found !== undefined && Math.abs(found.scale - 1) < 1e-3;
        transform = plain ? 'rotate' : 'other';
        rotation = plain ? found.rotation : 0;
      }
    }
    return { css, transform, rotation };
  };

  /** The frame of a rotated box: the unrotated box around the centre of what it covers. */
  const rotatedFrame = (el: Element, cs: CSSStyleDeclaration, r: DOMRect): Frame => {
    const size = el as HTMLElement;
    const w = (size.offsetWidth || px(cs.width)) * vl;
    const h = (size.offsetHeight || px(cs.height)) * vl;
    return toFrame({
      left: r.left + r.width / 2 - w / 2,
      top: r.top + r.height / 2 - h / 2,
      width: w,
      height: h,
    });
  };

  /** A box shadow as the model's shadow, when one outer layer on an opaque shape is all it is. */
  const shadowOf = (
    el: Element,
    cs: CSSStyleDeclaration,
    opaque: boolean,
    boxed: boolean,
  ): { shadow?: Shadow; css?: string; inset: boolean } => {
    const layers = parseBoxShadow(cs.boxShadow);
    if (!layers) return { css: scalePx(cs.boxShadow, kl), inset: /\binset\b/.test(cs.boxShadow) };
    if (layers.length === 0) return { inset: false };
    const inset = layers.some((l) => l.inset);
    const only = layers[0]!;
    // `drop-shadow` follows what is painted, so it equals a box shadow only under an opaque
    // box; a shadow with spread is drawn as `box-shadow`, which follows the box's own radius.
    if (layers.length === 1 && !inset && (only.spread ? boxed : opaque)) {
      return { shadow: shadowFromBox(only, color(only.color, el, 'box-shadow'), kl), inset };
    }
    return { css: scalePx(cs.boxShadow, kl), inset };
  };

  /** The background of a box as a fill; `unsupported` when only the original markup can draw it. */
  const fillOf = (
    el: Element,
    cs: CSSStyleDeclaration,
    box: { w: number; h: number },
  ): { fill: Fill; image?: string } | 'unsupported' => {
    const hasColor = alphaOf(cs.backgroundColor) > 0;
    if (cs.backgroundImage === 'none') {
      return {
        fill: hasColor
          ? { kind: 'solid', color: color(cs.backgroundColor, el, 'background-color') }
          : { kind: 'none' },
      };
    }
    if (cs.backgroundBlendMode.split(',').some((m) => m.trim() !== 'normal')) return 'unsupported';
    if (cs.backgroundAttachment.includes('fixed')) return 'unsupported';
    const bordered = ownPaint(cs).border;
    if (bordered && !/^border-box(, border-box)*$/.test(cs.backgroundClip)) return 'unsupported';
    const layers = splitTopLevel(cs.backgroundImage, ',');
    const plain =
      layers.length === 1 &&
      !hasColor &&
      (cs.backgroundSize === 'auto' || cs.backgroundSize === '100% 100%') &&
      cs.backgroundPosition === '0% 0%' &&
      (!bordered || cs.backgroundOrigin === 'border-box');
    if (plain) {
      const gradient = parseGradient(layers[0]!, box, (css) =>
        parseColor(css) ? color(css, el, 'background-image') : undefined,
      );
      if (gradient) return { fill: gradient };
    }
    const url = /^url\((["']?)(.*)\1\)$/.exec(layers[0]!)?.[2];
    if (url !== undefined) {
      // A picture that simply covers the box is an image fill; anything finer stays HTML,
      // since a `css` fill cannot point at an asset.
      const fit =
        cs.backgroundSize === 'cover' || cs.backgroundSize === 'contain'
          ? cs.backgroundSize
          : cs.backgroundSize === '100% 100%'
            ? 'fill'
            : undefined;
      const centred = cs.backgroundPosition === '50% 50%' || fit === 'fill';
      // A picture that covers the whole box shows one copy of itself whether or not it may
      // repeat; one that is fitted inside the box repeats in the room it leaves.
      const once = cs.backgroundRepeat === 'no-repeat' || fit === 'cover' || fit === 'fill';
      if (layers.length === 1 && !hasColor && fit && centred && once) {
        const known = el.getAttribute('data-asset');
        if (known && deck.assets[known]) return { fill: { kind: 'image', assetId: known, fit } };
        return { fill: { kind: 'image', assetId: '', fit }, image: url };
      }
      return 'unsupported';
    }
    if (layers.some((l) => l.includes('url('))) return 'unsupported';
    // Gradients the model has no shape for, and stacks of them: the CSS itself, as a fill.
    const sizes = splitTopLevel(cs.backgroundSize, ',');
    const positions = splitTopLevel(cs.backgroundPosition, ',');
    const repeats = splitTopLevel(cs.backgroundRepeat, ',');
    // The browser computed the colours: a glow of `var(--color-primary)` is numbers by now, and
    // kept so it would stay in this theme's colour on any other. A colour the source took from
    // the theme is written as the theme's variable again, as a model fill gets a token.
    const themed = (css: string, property: string) =>
      mapCssColors(css, (_, text) => {
        const read = color(text, el, property);
        return 'token' in read ? themeColorCss(read.token, read.alpha ?? 1) : undefined;
      });
    const value = layers
      .map((layer, i) => {
        const position = positions[i % positions.length]!;
        const size = sizes[i % sizes.length]!;
        const repeat = repeats[i % repeats.length]!;
        return `${themed(layer, 'background-image')} ${position} / ${size} ${repeat}`;
      })
      .join(', ');
    const ground = hasColor ? themed(cs.backgroundColor, 'background-color') : undefined;
    return {
      fill: { kind: 'css', value: scalePx(ground ? `${value}, ${ground}` : value, kl) },
    };
  };

  /**
   * A painted box as a shape; undefined when the box needs its own markup to look right.
   * `clipRadius`: the corners something around the box cuts it to, when it has none itself.
   */
  const shapeFor = (
    el: Element,
    cs: CSSStyleDeclaration,
    paint: Paint,
    r: DOMRect,
    clipRadius = 0,
  ) => {
    const effects = boxEffects(cs);
    if (effects.transform === 'other') return undefined;
    const rect = snapRect(r, Math.abs(vl - 1) > 1e-6);
    const box = { w: r.width / vl, h: r.height / vl };
    const filled = fillOf(el, cs, box);
    if (filled === 'unsupported') return undefined;
    const css: Record<string, string> = { ...effects.css };
    let preset = 'rect';
    let radius: number | undefined;
    const corners = cornerRadius(
      [
        cs.borderTopLeftRadius,
        cs.borderTopRightRadius,
        cs.borderBottomRightRadius,
        cs.borderBottomLeftRadius,
      ],
      box,
    );
    if (corners.kind === 'px') radius = round(corners.value * kl);
    else if (corners.kind === 'none' && clipRadius > 0) radius = round(clipRadius * kl);
    else if (corners.kind === 'ellipse') preset = 'ellipse';
    else if (corners.kind === 'css') {
      css['border-radius'] = scalePx(corners.value, kl);
      css.overflow = 'hidden';
    }

    let stroke: Stroke | undefined;
    let accent: Accent | undefined;
    if (paint.border) {
      const sides = (['top', 'right', 'bottom', 'left'] as const).map((side, i) => ({
        side,
        ...paint.borders[i]!,
      }));
      const drawn = (b: Paint['borders'][number]) =>
        b.width > 0 && b.style !== 'none' && b.style !== 'hidden' && alphaOf(b.color) > 0;
      const alike = (a: Paint['borders'][number], b: Paint['borders'][number]) =>
        drawn(a) ? a.width === b.width && a.style === b.style && a.color === b.color : !drawn(b);
      const dash = { solid: undefined, dashed: 'dashed', dotted: 'dotted' } as const;
      const outline = (b: (typeof sides)[number]): Stroke | undefined => {
        if (!drawn(b)) return undefined;
        const kind = dash[b.style as keyof typeof dash];
        return {
          color: color(b.color, el, `border-${b.side}-color`),
          width: round(b.width * kl),
          ...(kind ? { dash: kind } : {}),
        };
      };
      const top = sides[0]!;
      // One side that is not like the three others, which are alike: the outline, and in its
      // place on that side an accent, as a card's coloured edge is written (ADR-073).
      const odd = sides.filter((s) => sides.filter((o) => o !== s && alike(o, s)).length === 0);
      const rest = sides.filter((s) => s !== odd[0]);
      if (sides.every((s) => alike(s, top)) && top.style in dash) {
        stroke = outline(top);
      } else if (
        odd.length === 1 &&
        corners.kind !== 'css' &&
        odd[0]!.style === 'solid' &&
        drawn(odd[0]!) &&
        rest.every((s) => alike(s, rest[0]!)) &&
        (!drawn(rest[0]!) || rest[0]!.style in dash)
      ) {
        stroke = outline(rest[0]!);
        accent = {
          side: odd[0]!.side,
          size: round(odd[0]!.width * kl),
          fill: { kind: 'solid', color: color(odd[0]!.color, el, `border-${odd[0]!.side}-color`) },
          corners: 'follow',
        };
      } else {
        // The model has one outline for the whole box; borders by side are CSS on the box.
        for (const b of sides) {
          if (b.width > 0 && b.style !== 'none' && b.style !== 'hidden') {
            css[`border-${b.side}`] = `${round(b.width * kl)}px ${b.style} ${b.color}`;
          }
        }
      }
    }

    const boxed = preset === 'rect' && corners.kind !== 'css';
    const shadow = shadowOf(el, cs, opaqueFill(filled.fill), boxed);
    // An inset shadow is painted over the background; the renderer's fill layer would hide it.
    if (shadow.inset && filled.fill.kind !== 'none') return undefined;
    if (shadow.css) {
      css['box-shadow'] = shadow.css;
      if (preset === 'ellipse') css['border-radius'] = '50%';
    }
    const effectsField = {
      ...(shadow.shadow ? { shadow: shadow.shadow } : {}),
      ...(radius ? { radius } : {}),
    };
    const element = createElement.shape({
      id: options.nextId(),
      frame: effects.transform === 'rotate' ? rotatedFrame(el, cs, r) : toFrame(rect),
      geometry: { kind: 'preset', preset },
      fill: filled.fill,
      ...(stroke ? { stroke } : {}),
      ...(accent ? { accent } : {}),
      ...(effects.rotation ? { rotation: effects.rotation } : {}),
      ...(Object.keys(effectsField).length > 0 ? { effects: effectsField } : {}),
      ...(Object.keys(css).length > 0 ? { css } : {}),
    });
    if (filled.image) {
      const url = filled.image;
      proposal.pending.push(async () => {
        const id = await options.storeImage(url);
        if (id && element.fill.kind === 'image') element.fill = { ...element.fill, assetId: id };
        else notes.push(`A background image could not be read (${url.slice(0, 80)}).`);
      });
    }
    return { element, region: toRect(rect) };
  };

  /** The room a shadow takes around a box, so that its pixels count as the box's. */
  const shadowReach = (cs: CSSStyleDeclaration): number => {
    const layers = parseBoxShadow(cs.boxShadow) ?? [];
    return layers
      .filter((l) => !l.inset)
      .reduce((m, l) => Math.max(m, Math.abs(l.x) + Math.abs(l.y) + l.blur + l.spread + 2), 0);
  };

  const grow = (rect: Rect, by: number): Rect => ({
    x: rect.x - by,
    y: rect.y - by,
    w: rect.w + 2 * by,
    h: rect.h + 2 * by,
  });

  // ----------------------------------------------------------------------------------- kinds

  const htmlFor = (el: Element, deep: boolean, reason: string, state: State): Item => {
    const r = el.getBoundingClientRect();
    const counted = deep ? countContent(el) : { units: 1, chars: 0 };
    const element = createElement.html({
      id: options.nextId(),
      frame: toFrame(r),
      markup: '',
      ...(deep ? label(el, state.role) : {}),
    });
    return emit(
      element,
      el,
      deep ? 'subtree' : 'box',
      grow(toRect(r), shadowReach(styleOf(el)) * vl),
      state,
      {
        copy: 'markup',
        reason,
        units: counted.units,
        chars: counted.chars,
      },
    );
  };

  const imageFor = (
    el: HTMLImageElement,
    cs: CSSStyleDeclaration,
    r: DOMRect,
    state: State,
  ): Item | undefined => {
    const effects = boxEffects(cs);
    if (effects.transform === 'other') return undefined;
    const prompt = el.getAttribute('data-image-prompt')?.trim();
    const assetRef = el.getAttribute('data-asset')?.trim();
    const loaded = el.naturalWidth > 0 && !el.hasAttribute(BLANK_IMAGE_ATTRIBUTE);
    const fit = cs.objectFit === 'cover' || cs.objectFit === 'contain' ? cs.objectFit : 'fill';
    if (loaded && cs.objectFit !== fit) return undefined;
    const rect = snapRect(contentRect(el, cs, vl), Math.abs(vl - 1) > 1e-6);
    const box = { w: rect.width / vl, h: rect.height / vl };
    const css: Record<string, string> = { ...effects.css };

    // Where the picture sits in its box, when not in the middle: a crop of the original.
    let crop: { x: number; y: number; w: number; h: number } | undefined;
    if (loaded && fit !== 'fill' && cs.objectPosition !== '50% 50%') {
      const [ox, oy] = splitTopLevel(cs.objectPosition, ' ');
      if (fit !== 'cover' || !ox?.endsWith('%') || !oy?.endsWith('%')) return undefined;
      const s = Math.max(box.w / el.naturalWidth, box.h / el.naturalHeight);
      const w = box.w / s / el.naturalWidth;
      const h = box.h / s / el.naturalHeight;
      crop = { x: (1 - w) * (parseFloat(ox) / 100), y: (1 - h) * (parseFloat(oy) / 100), w, h };
    }

    const border = ownPaint(cs).borders[0]!;
    const bordered = ownPaint(cs).border;
    const corners = cornerRadius(
      [
        cs.borderTopLeftRadius,
        cs.borderTopRightRadius,
        cs.borderBottomRightRadius,
        cs.borderBottomLeftRadius,
      ],
      { w: r.width / vl, h: r.height / vl },
    );
    let radius: number | undefined;
    let mask: { kind: 'ellipse' } | undefined;
    if (corners.kind === 'px')
      radius = Math.max(0, round((corners.value - (bordered ? border.width : 0)) * kl));
    else if (corners.kind === 'ellipse') mask = { kind: 'ellipse' };
    else if (corners.kind === 'css') {
      css['border-radius'] = scalePx(corners.value, kl);
      css.overflow = 'hidden';
    }
    // A border lies outside the picture; the frame is the picture, so the border is drawn as
    // a ring around it, and every shadow starts that much further out.
    const layers = parseBoxShadow(cs.boxShadow);
    let shadow: Shadow | undefined;
    if (bordered || !layers) {
      const rings = bordered ? [`0 0 0 ${round(border.width * kl)}px ${border.color}`] : [];
      for (const l of layers ?? []) {
        if (l.inset) continue;
        rings.push(
          `${round(l.x * kl)}px ${round(l.y * kl)}px ${round(l.blur * kl)}px ${round((l.spread + border.width) * kl)}px ${l.color}`,
        );
      }
      if (!layers) rings.push(scalePx(cs.boxShadow, kl));
      if (rings.length > 0) css['box-shadow'] = rings.join(', ');
      if (mask) css['border-radius'] = '50%';
    } else {
      const outer = layers.filter((l) => !l.inset);
      if (outer.length === 1 && (outer[0]!.spread ? !mask : true)) {
        shadow = shadowFromBox(outer[0]!, color(outer[0]!.color, el, 'box-shadow'), kl);
      } else if (outer.length > 0) {
        css['box-shadow'] = scalePx(cs.boxShadow, kl);
        if (mask) css['border-radius'] = '50%';
      }
    }

    const alt = el.getAttribute('alt')?.trim();
    const effectsField = { ...(shadow ? { shadow } : {}), ...(radius ? { radius } : {}) };
    const element = createElement.image({
      id: options.nextId(),
      frame: effects.transform === 'rotate' ? rotatedFrame(el, cs, r) : toFrame(rect),
      fit,
      ...(crop ? { crop } : {}),
      ...(mask ? { mask } : {}),
      ...(prompt ? { prompt } : {}),
      ...(alt ? { alt } : {}),
      ...(effects.rotation ? { rotation: effects.rotation } : {}),
      ...(Object.keys(effectsField).length > 0 ? { effects: effectsField } : {}),
      ...(Object.keys(css).length > 0 ? { css } : {}),
      ...label(el, state.role),
    });
    let exempt = false;
    if (assetRef && deck.assets[assetRef]) element.assetId = assetRef;
    else if (assetRef) notes.push(`data-asset="${assetRef}" is not an asset of the deck.`);
    else if (loaded) {
      const url = el.currentSrc || el.src;
      proposal.pending.push(async () => {
        const id = await options.storeImage(url);
        if (id) element.assetId = id;
        else notes.push(`An image could not be read (${url.slice(0, 80)}).`);
      });
    } else {
      const src = el.getAttribute('src');
      if (src && !prompt) {
        notes.push(
          `An image did not load (${src.slice(0, 80)}); external files are blocked. Use data-asset or data-image-prompt.`,
        );
      }
    }
    // An image that waits for its picture shows the app's placeholder, not the source.
    if (!element.assetId && !loaded) exempt = true;
    return emit(
      element,
      el,
      'subtree',
      grow(toRect(snapRect(r, false)), shadowReach(cs) * vl),
      state,
      {
        exempt,
      },
    );
  };

  const svgFor = (
    el: Element,
    cs: CSSStyleDeclaration,
    r: DOMRect,
    state: State,
  ): Item | undefined => {
    const effects = boxEffects(cs);
    if (effects.transform === 'other' || effects.transform === 'rotate') return undefined;
    if (ownPaint(cs).any) return undefined;
    const id = options.nextId();
    const markup = svgMarkup(el, r.width / vl, r.height / vl, id);
    if (!markup) return undefined;
    const tint = markup.usesCurrentColor
      ? { currentColor: color(cs.color, el, 'color') }
      : undefined;
    // An icon placed with `data-icon` is named after it.
    const icon = el.parentElement?.getAttribute('data-icon')?.trim();
    const named = label(el, state.role);
    const element = createElement.svg({
      id,
      frame: toFrame(contentRect(el, cs, vl)),
      markup: markup.markup,
      ...(tint ? { colorOverrides: tint } : {}),
      ...(Object.keys(effects.css).length > 0 ? { css: effects.css } : {}),
      ...(icon && !named.name ? { name: icon } : {}),
      ...named,
    });
    return emit(element, el, 'subtree', toRect(r), state);
  };

  const chartFor = (el: Element, r: DOMRect, state: State): Item | undefined => {
    let data: unknown;
    try {
      data = JSON.parse(el.getAttribute('data-chart') ?? '');
    } catch {
      notes.push('data-chart is not valid JSON; the element was kept as HTML.');
      return undefined;
    }
    const given = (typeof data === 'object' && data !== null ? data : {}) as Record<
      string,
      unknown
    >;
    const candidate = createElement.chart({
      id: options.nextId(),
      frame: toFrame(snapRect(r, Math.abs(vl - 1) > 1e-6)),
      chartType: given.chartType as ChartElement['chartType'],
      data: given.data as ChartElement['data'],
      ...label(el, state.role),
    });
    // Options given in part are completed by the defaults.
    if (typeof given.options === 'object' && given.options !== null) {
      candidate.options = {
        ...candidate.options,
        ...(given.options as Partial<ChartElement['options']>),
      };
    }
    const parsed = ChartElement.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      notes.push(
        `data-chart does not describe a chart (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}); expected {"chartType", "data": {"categories", "series": [{"name", "values"}]}, "options"?}. The element was kept as HTML.`,
      );
      return undefined;
    }
    return emit(parsed.data, el, 'subtree', toRect(r), state, { exempt: true });
  };

  /** Text directly in an element or one of its text nodes, as a text box. */
  const textFor = (
    el: Element,
    cs: CSSStyleDeclaration,
    state: State,
    textNode?: Text,
    hanging?: Hanging,
  ): Item | 'unsupported' | undefined => {
    const source = textNode ?? el;
    const lines = textLines(source);
    if (lines.length === 0) return undefined;
    let marker = textNode ? undefined : readListMarker(el, cs, text);
    if (marker === 'unsupported') return 'unsupported';
    // The marker of an item above, when this is the text of its first line.
    if (
      !marker &&
      hanging?.first &&
      !hanging.taken &&
      (textNode ? textNode === hanging.first : isInside(hanging.first, el))
    ) {
      const edge = hanging.rtl ? lines[0]!.right : lines[0]!.left;
      if (Math.abs(edge - hanging.start) <= 1.5 * vl) {
        marker = hanging.list;
        hanging.taken = true;
      }
    }
    // A first letter or first line the page styles apart is a part of the text no run stands for.
    if (!text.lossy && firstPartStyled(el, source)) return 'unsupported';
    const effects = textNode
      ? { css: {}, transform: 'none' as const, rotation: 0 }
      : boxEffects(cs);
    if (effects.transform === 'other') return 'unsupported';

    const first = lines[0]!;
    const last = lines[lines.length - 1]!;
    const pitch =
      lines.length > 1 ? ((last.top - first.top) / (lines.length - 1) / vl) * kl : undefined;
    const block = readTextBlock(
      textNode ? wrapTextNode(textNode) : el,
      el,
      cs,
      kl,
      pitch,
      marker,
      text,
    );
    if ('unsupported' in block)
      return block.unsupported === 'no visible text' ? undefined : 'unsupported';
    // Text with a part in a direction of its own is text only as long as the guard can see
    // that it reads the same; turned text and generated text have no boxes to compare.
    const comparable = !block.generated && !effects.rotation;
    if (block.ownDirection && !comparable && !text.lossy) return 'unsupported';

    const bounds = {
      left: Math.min(...lines.map((l) => l.left)),
      right: Math.max(...lines.map((l) => l.right)),
      top: first.top,
      bottom: last.bottom,
    };
    // The renderer starts a line box at the top of the frame; the glyphs sit half the leading
    // lower. The guard corrects what is left of the difference from a measured render.
    const glyphs = first.bottom - first.top;
    const lineHeight = lineHeightPx(cs);
    const half = lineHeight === undefined ? 0 : (lineHeight * vl - glyphs) / 2;
    const top = bounds.top - half;
    const height = bounds.bottom - bounds.top + 2 * half;
    // A block lays its lines out in its content box; text that a flex or grid container, or
    // an inline box, places is measured by its glyphs.
    const flows =
      !textNode && /^(block|list-item|flow-root|table-cell|inline-block)$/.test(cs.display);
    let rect: { left: number; top: number; width: number; height: number };
    if (flows) {
      const content = contentRect(el, cs, vl);
      rect = { left: content.left, top, width: content.width, height };
      // A box narrower than its text (overflowing, or a `nowrap` line) is measured by the text.
      if (bounds.right - bounds.left > content.width + 0.5) {
        rect.left = Math.min(content.left, bounds.left);
        rect.width = bounds.right - rect.left;
      }
    } else {
      rect = { left: bounds.left, top, width: bounds.right - bounds.left + 0.02, height };
    }
    let frame = toFrame(rect);
    let padding: { top: number; right: number; bottom: number; left: number } | undefined;
    if (effects.rotation) {
      // Turned glyph boxes say nothing about the layout: the frame is the element's own box,
      // and its padding keeps the text where it was inside it.
      frame = rotatedFrame(el, cs, el.getBoundingClientRect());
      const side = (a: string, b: string) => round((px(a) + px(b)) * kl);
      const inside = {
        top: side(cs.paddingTop, cs.borderTopWidth),
        right: side(cs.paddingRight, cs.borderRightWidth),
        bottom: side(cs.paddingBottom, cs.borderBottomWidth),
        left: side(cs.paddingLeft, cs.borderLeftWidth),
      };
      if (Object.values(inside).some((n) => n > 0)) padding = inside;
    }
    const paragraph = block.paragraph;
    if (!flows && lines.length === 1) paragraph.align = 'start';
    if (paragraph.list) {
      // The renderer indents a list item by its level and hangs the marker in the indent.
      const indent = round((paragraph.list.level * 1.5 + 1.25) * block.styleSize);
      frame.w = round(frame.w + indent);
      if (paragraph.dir !== 'rtl') frame.x = round(frame.x - indent);
    }
    const css = { ...block.css, ...effects.css };
    const element = createElement.text({
      id: options.nextId(),
      frame,
      content: { paragraphs: [paragraph] },
      // A single line never wraps: a box measured to the glyphs would otherwise break it.
      ...(lines.length === 1 ? { wrap: false } : {}),
      ...(padding ? { padding } : {}),
      ...(effects.rotation ? { rotation: effects.rotation } : {}),
      ...(Object.keys(css).length > 0 ? { css } : {}),
      ...(textNode ? (state.role ? { role: state.role } : {}) : label(el, state.role)),
    });
    const region = grow(
      {
        x: bounds.left,
        y: bounds.top,
        w: bounds.right - bounds.left,
        h: bounds.bottom - bounds.top,
      },
      3,
    );
    // The marker hangs on the start side of the first line. The renderer draws its own.
    const reach = block.maxSize * 2.5 * (vl / kl);
    const ignored = paragraph.list
      ? [
          {
            x: paragraph.dir === 'rtl' ? bounds.right + 1 : bounds.left - 1 - reach,
            y: first.top - 4,
            w: reach,
            h: first.bottom - first.top + 8,
          },
        ]
      : undefined;
    return emit(element, el, textNode ? 'text' : 'subtree', region, state, {
      chars: block.chars,
      ...(comparable ? { lines: toSlideLines(lines) } : {}),
      ...(comparable && block.ownDirection ? { characters: toSlideLines(charRects(source)) } : {}),
      ...(ignored ? { ignored } : {}),
    });
  };

  /** A lone text node read as if it were the content of an element of its own. */
  const wrapTextNode = (node: Text): Element => {
    const holder = node.ownerDocument.createElement('span');
    holder.textContent = node.data;
    return holder;
  };

  /** The box inside the element's borders: what `overflow` clips to. */
  const paddingBox = (cs: CSSStyleDeclaration, r: DOMRect): Edges => ({
    left: r.left + px(cs.borderLeftWidth) * vl,
    top: r.top + px(cs.borderTopWidth) * vl,
    right: r.right - px(cs.borderRightWidth) * vl,
    bottom: r.bottom - px(cs.borderBottomWidth) * vl,
  });

  /**
   * A box that hides what sticks out of it, and has something that is cut by it: partly in
   * and partly out, or drawn into a rounded corner. What lies wholly outside is simply not
   * shown, and the walk skips it.
   */
  const clipsContent = (el: Element, cs: CSSStyleDeclaration, r: DOMRect): boolean => {
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') return false;
    const box = paddingBox(cs, r);
    // A box that clips at the edges of the slide clips what the slide itself clips.
    if (fillsSlide && within(rootRect, box)) return false;
    const cut = (b: Edges) =>
      b.right > b.left && b.bottom > b.top && overlaps(b, box) && !within(b, box);
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    if (hasOwnText(el) && cut(range.getBoundingClientRect())) return true;
    const radius = Math.max(
      px(cs.borderTopLeftRadius),
      px(cs.borderTopRightRadius),
      px(cs.borderBottomRightRadius),
      px(cs.borderBottomLeftRadius),
    );
    const reach = radius * vl * 0.3;
    for (const inner of Array.from(el.querySelectorAll('*'))) {
      if (neverRendered(inner)) continue;
      const style = styleOf(inner);
      if (subtreeHidden(style) || style.visibility !== 'visible') continue;
      const draws =
        ownPaint(style).any || inner.localName === 'img' || isSvg(inner) || hasOwnText(inner);
      if (!draws) continue;
      const b = inner.getBoundingClientRect();
      if (cut(b)) return true;
      if (reach > 0 && overlaps(b, box)) {
        // Something drawn in a rounded corner is cut by it.
        const nearX = b.left < r.left + reach || b.right > r.right - reach;
        const nearY = b.top < r.top + reach || b.bottom > r.bottom - reach;
        if (nearX && nearY) return true;
      }
    }
    return false;
  };

  /**
   * The box of a pseudo-element by its used offsets and size, for the one kind that can be told
   * without measuring: empty, absolutely positioned in its own element, and not transformed.
   * `nothing`: it has no area, and no shadow of it could show.
   */
  const pseudoRect = (
    cs: CSSStyleDeclaration,
    r: DOMRect,
    pcs: CSSStyleDeclaration,
  ): DOMRect | 'nothing' | undefined => {
    if (pcs.content !== '""' || pcs.position !== 'absolute' || pcs.transform !== 'none') {
      return undefined;
    }
    // The offsets count from the element only when it is what the pseudo-element is placed in.
    if (cs.position === 'static' && cs.transform === 'none') return undefined;
    if (cs.display === 'inline') return undefined;
    const used = (value: string) => (/^-?[\d.]+px$/.test(value) ? parseFloat(value) : NaN);
    const outer = pcs.boxSizing === 'border-box' ? 0 : 1;
    const w =
      used(pcs.width) +
      outer *
        (px(pcs.paddingLeft) +
          px(pcs.paddingRight) +
          px(pcs.borderLeftWidth) +
          px(pcs.borderRightWidth));
    const h =
      used(pcs.height) +
      outer *
        (px(pcs.paddingTop) +
          px(pcs.paddingBottom) +
          px(pcs.borderTopWidth) +
          px(pcs.borderBottomWidth));
    const left = used(pcs.left) + px(pcs.marginLeft);
    const top = used(pcs.top) + px(pcs.marginTop);
    if (![w, h, left, top].every(Number.isFinite)) return undefined;
    const bare = pcs.boxShadow === 'none' && pcs.outlineStyle === 'none';
    if (w <= 0 || h <= 0) return bare ? 'nothing' : undefined;
    const box = paddingBox(cs, r);
    return new DOMRect(box.left + left * vl, box.top + top * vl, w * vl, h * vl);
  };

  /**
   * A pseudo-element that is a stripe along one whole side of its element, inside the borders,
   * with a fill and nothing else: the accent of the element's shape (ADR-073). `content`: where
   * the element's own content is, which must keep clear of it, since a shape draws its accent
   * under what is on it. A rounded element has to clip, or the stripe would show past its
   * corners, which an accent never does.
   */
  const bandOf = (
    el: Element,
    cs: CSSStyleDeclaration,
    r: DOMRect,
    pcs: CSSStyleDeclaration,
    content: () => DOMRect[],
  ): Accent | undefined => {
    const rect = pseudoRect(cs, r, pcs);
    if (!rect || rect === 'nothing') return undefined;
    const box = paddingBox(cs, r);
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.5 * vl;
    const flush = {
      top: near(rect.top, box.top),
      right: near(rect.right, box.right),
      bottom: near(rect.bottom, box.bottom),
      left: near(rect.left, box.left),
    };
    const opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' } as const;
    const away = (Object.keys(flush) as (keyof typeof flush)[]).filter((side) => !flush[side]);
    if (away.length !== 1) return undefined;
    const side = opposite[away[0]!];
    const paint = ownPaint(pcs);
    const plain =
      paint.background &&
      !paint.border &&
      !paint.shadow &&
      pcs.outlineStyle === 'none' &&
      parseFloat(pcs.opacity) === 1 &&
      pcs.animationName === 'none' &&
      !(Number(pcs.zIndex) < 0) &&
      BOX_PASSTHROUGH.every(([property, initial]) => {
        const value = pcs.getPropertyValue(property);
        return !value || initial.includes(value);
      }) &&
      [
        pcs.borderTopLeftRadius,
        pcs.borderTopRightRadius,
        pcs.borderBottomRightRadius,
        pcs.borderBottomLeftRadius,
      ].every((radius) => splitTopLevel(radius, ' ').every((part) => parseFloat(part) === 0));
    if (!plain) return undefined;
    const rounded = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ].some((radius) => splitTopLevel(radius, ' ').some((part) => parseFloat(part) > 0));
    if (rounded && (cs.overflowX === 'visible' || cs.overflowY === 'visible')) return undefined;
    if (content().some((b) => b.width > 0 && b.height > 0 && overlaps(b, rect))) return undefined;
    const across = side === 'top' || side === 'bottom';
    const filled = fillOf(el, pcs, { w: rect.width / vl, h: rect.height / vl });
    if (filled === 'unsupported' || filled.image || filled.fill.kind === 'none') return undefined;
    return {
      side,
      size: round(((across ? rect.height : rect.width) / vl) * kl),
      fill: filled.fill,
    };
  };

  /**
   * Where a pseudo-element's box is (`pseudoRect`), as a shape of its own can stand for it.
   * `radius`: the corners the element cuts it to. `nothing`: it has no area, or lies wholly
   * outside what its element clips to, and no shadow of it could show.
   */
  const pseudoPlace = (
    cs: CSSStyleDeclaration,
    r: DOMRect,
    pcs: CSSStyleDeclaration,
  ): { rect: DOMRect; radius: number } | 'nothing' | undefined => {
    const rect = pseudoRect(cs, r, pcs);
    if (!rect || rect === 'nothing') return rect;
    const bare = pcs.boxShadow === 'none' && pcs.outlineStyle === 'none';
    const box = paddingBox(cs, r);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') return { rect, radius: 0 };
    // An element that clips cuts its pseudo-element too: at its edges, and at its corners.
    if (bare && cs.overflowX !== 'visible' && cs.overflowY !== 'visible' && !overlaps(rect, box)) {
      return 'nothing';
    }
    if (!within(rect, box)) return undefined;
    const corners = cornerRadius(
      [
        cs.borderTopLeftRadius,
        cs.borderTopRightRadius,
        cs.borderBottomRightRadius,
        cs.borderBottomLeftRadius,
      ],
      { w: r.width / vl, h: r.height / vl },
    );
    if (corners.kind === 'none') return { rect, radius: 0 };
    const borders = [
      cs.borderTopWidth,
      cs.borderRightWidth,
      cs.borderBottomWidth,
      cs.borderLeftWidth,
    ].map(px);
    if (corners.kind === 'px' && within(box, rect)) {
      // It fills the box inside the borders: cut to the same corners, less the border. Where
      // one side is thicker (an accent), the corners beside it are a little tighter than one
      // radius says: by the thinnest border, which is the most of the two it keeps.
      return { rect, radius: Math.max(0, corners.value - Math.min(...borders)) };
    }
    // Anywhere else it is whole only when it keeps out of the corners.
    const reach = corners.kind === 'px' ? corners.value * vl : Math.min(r.width, r.height) / 2;
    const nearX = rect.left < r.left + reach || rect.right > r.right - reach;
    const nearY = rect.top < r.top + reach || rect.bottom > r.bottom - reach;
    return nearX && nearY ? undefined : { rect, radius: 0 };
  };

  // ------------------------------------------------------------------------------- the walk

  const walk = (el: Element, inherited: Inherited, isRoot: boolean): void => {
    if (neverRendered(el)) return;
    const cs = isRoot ? rootCs : styleOf(el);
    if (!isRoot && subtreeHidden(cs)) return;
    // A uniformly scaled element scales everything in it, itself included.
    const local = isRoot ? 1 : inherited.scale * (uniformScale(cs.transform) ?? 1);
    const saved = [kl, vl] as const;
    kl = k * local;
    vl = viewScale * local;
    try {
      walkBody(el, cs, { ...inherited, scale: local }, isRoot);
    } finally {
      [kl, vl] = saved;
    }
  };

  const walkBody = (
    el: Element,
    cs: CSSStyleDeclaration,
    inherited: Inherited,
    isRoot: boolean,
  ): void => {
    const tag = el.localName;
    const r = el.getBoundingClientRect();
    const boxless = cs.display === 'contents';
    if (!isRoot && !boxless) {
      if (clippedAway(cs, r)) return;
      if ((r.width === 0 || r.height === 0) && cs.overflowX !== 'visible') return;
      // Entirely outside the slide, or outside a box that clips it: not part of the picture.
      if ((r.width > 0 || r.height > 0) && !intersects(r, rootRect)) return;
      if (inherited.clip && r.width > 0 && r.height > 0 && !overlaps(r, inherited.clip)) return;
    }
    const z = isRoot ? { path: [], seq: visit++ } : zKeyOf(el, cs, inherited.z, visit++);
    const opacity = isRoot ? 1 : inherited.opacity * parseFloat(cs.opacity);
    const anim = animOf(el, inherited.anim);
    // `own`: the element as one thing, under its ancestors' opacity. `inner`: what is in it.
    const role = roleOf(el) ?? inherited.role;
    const own: State = { z, opacity: inherited.opacity, anim, role };
    const inner: State = { z, opacity, anim, role };
    const shown = cs.visibility === 'visible';
    const clips = !boxless && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
    const box = clips ? paddingBox(cs, r) : undefined;
    const clip =
      box && inherited.clip
        ? {
            left: Math.max(box.left, inherited.clip.left),
            top: Math.max(box.top, inherited.clip.top),
            right: Math.min(box.right, inherited.clip.right),
            bottom: Math.min(box.bottom, inherited.clip.bottom),
          }
        : (box ?? inherited.clip);
    // Set further down, for a list item that is not a block of text itself.
    let hanging: Hanging | undefined;
    const down = () => {
      const marker = hanging ?? inherited.marker;
      for (const child of composedChildren(el)) {
        walk(
          child,
          {
            ...inherited,
            opacity,
            z,
            anim,
            role,
            ...(clip ? { clip } : {}),
            ...(marker ? { marker } : {}),
          },
          false,
        );
      }
    };
    const leaf = (item: Item | undefined): boolean => {
      if (!item) return false;
      item.element.opacity = round(opacity);
      return true;
    };

    if (!shown) return down();
    if (el.hasAttribute('data-keep-html') && !isRoot) {
      htmlFor(el, true, 'data-keep-html', own);
      return;
    }
    if (el.hasAttribute('data-chart') && !isRoot) {
      if (!leaf(chartFor(el, r, inner))) htmlFor(el, true, 'data-chart that is not a chart', own);
      return;
    }

    if (isSvg(el)) {
      if (tag !== 'svg') return;
      if (!leaf(svgFor(el, cs, r, inner))) htmlFor(el, true, 'an SVG the model cannot hold', own);
      return;
    }
    if (tag === 'img') {
      if (!leaf(imageFor(el as HTMLImageElement, cs, r, inner))) {
        htmlFor(el, true, 'an image placed in a way the model has no field for', own);
      }
      return;
    }
    if (OPAQUE_TAGS.has(tag)) {
      htmlFor(el, true, `<${tag}>`, own);
      return;
    }

    const paint: Paint = boxless
      ? { any: false, background: false, border: false, shadow: false, borders: [] }
      : ownPaint(cs);
    // A background clipped to the text is part of how the text looks, not a box.
    const textFill =
      (cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip) === 'text';
    const painted = paint.any && !(textFill && !paint.border && !paint.shadow);
    // A pseudo-element that shows nothing as the page stands (one that waits outside its
    // element for a hover, or sweeps across it now and then) is not there.
    const pseudos = boxless
      ? []
      : (['::before', '::after'] as const).filter((which) => {
          if (pseudoKind(el, which) !== 'box') return false;
          const pcs = styleOf(el, which);
          if (pseudoPlace(cs, r, pcs) !== 'nothing') return true;
          const note =
            'A pseudo-element that shows nothing while the page is still was left out, and its animation with it.';
          if (pcs.animationName !== 'none' && !notes.includes(note)) notes.push(note);
          return false;
        });
    const children = composedChildren(el).filter(
      (c) => !neverRendered(c) && styleOf(c).display !== 'none',
    );
    const textBlock =
      !boxless &&
      hasAnyText(el) &&
      isPureInline(el) &&
      (hasOwnText(el) || children.every((c) => styleOf(c).display === 'inline'));
    const empty = !hasAnyText(el) && children.length === 0;

    if (!isRoot) {
      // Effects that apply to a subtree as one picture. One element can carry them itself;
      // several elements cannot share them, so such a subtree stays HTML.
      const effects = boxEffects(cs);
      const single = pseudos.length === 0 && (empty || (textBlock && !painted));
      const effect =
        effects.transform === 'other'
          ? 'a transform'
          : effects.transform === 'rotate' && !single
            ? 'a rotated group'
            : Object.keys(effects.css).some((p) => p !== 'outline' && p !== 'outline-offset') &&
                !single
              ? `${Object.keys(effects.css)[0]} on a group`
              : undefined;
      if (effect) {
        htmlFor(el, true, effect, own);
        return;
      }
      if (clipsContent(el, cs, r)) {
        htmlFor(el, true, 'content clipped by its box', own);
        return;
      }
      // A list the page counts in a way of its own keeps its numbers only as a whole: its
      // items are numbered by the browser, by rules a number written beside each cannot follow.
      if (
        resetsListCount(cs) &&
        children.some((c) => styleOf(c).display === 'list-item' && readsAsNumbered(c))
      ) {
        htmlFor(el, true, 'a list whose count the page resets', own);
        return;
      }
      // A table is what lays its children out as rows. An element with another `display` whose
      // children are rows (a `table` set to `block` so that it can scroll) gets a table box from
      // the browser, without a name, and is read the same way.
      const rows = children.some((c) =>
        /^table-(row|row-group|header-group|footer-group)$/.test(styleOf(c).display),
      );
      if (/^(table|inline-table)$/.test(cs.display) || rows) {
        const table = readTable(el, {
          deck,
          text,
          kl,
          vl,
          toFrame,
          nextId: () => options.nextId(),
        });
        if (table) {
          const counted = countContent(el);
          emit(
            { ...table, ...label(el, inherited.role), opacity: round(opacity) },
            el,
            'subtree',
            toRect(r),
            inner,
            counted,
          );
        } else htmlFor(el, true, 'a table the model cannot hold', own);
        return;
      }
    }

    // What this element has put into the proposal so far, should it turn out to need its own
    // markup after all.
    const mark = { items: items.length, pending: proposal.pending.length };
    const whole = (reason: string) => {
      items.length = mark.items;
      proposal.pending.length = mark.pending;
      htmlFor(el, true, reason, own);
    };
    if (!isRoot && !textBlock && !boxless && cs.display === 'list-item') {
      const list = readListMarker(el, cs, text);
      if (list === 'unsupported') return whole('a list marker the model cannot show');
      if (list) {
        const content = contentRect(el, cs, vl);
        const rtl = cs.direction === 'rtl';
        hanging = {
          list,
          first: firstText(el),
          start: rtl ? content.left + content.width : content.left,
          rtl,
          taken: false,
        };
      }
    }

    // A pseudo-element the browser placed by its own offsets is a shape at that place, in its
    // own turn in paint order. Any other has no box to measure: the element's own box stays
    // HTML, and what is in it is still converted.
    const queued = proposal.pending.length;
    /** Where the element's own content is: what a pseudo-element may lie over. */
    const contentBoxes = () =>
      [
        ...children.filter((c) => styleOf(c).position === 'static'),
        ...(hasOwnText(el) ? [el] : []),
      ].map((node) => {
        if (node !== el) return node.getBoundingClientRect();
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect();
      });
    // One that is a stripe along a side of the box is the accent of the box's shape; the others
    // are drawn apart.
    let band: { which: '::before' | '::after'; accent: Accent } | undefined;
    for (const which of pseudos) {
      const accent = band ? undefined : bandOf(el, cs, r, styleOf(el, which), contentBoxes);
      if (accent) band = { which, accent };
    }
    const apart = pseudos.filter((which) => which !== band?.which);
    const places = apart.map((which) => {
      const place = pseudoPlace(cs, r, styleOf(el, which));
      return place === 'nothing' ? undefined : place;
    });
    const placed = places.every((place) => place)
      ? apart.map((which, i) => {
          const pcs = styleOf(el, which);
          const shape = shapeFor(el, pcs, ownPaint(pcs), places[i]!.rect, places[i]!.radius);
          return shape ? { which, pcs, shape } : undefined;
        })
      : [undefined];
    const pseudoBox = apart.length > 0 && placed.some((p) => !p);
    if (pseudoBox) {
      proposal.pending.length = queued;
      // One that is drawn over what the element holds cannot be left under it with the box.
      const content = contentBoxes();
      const over = apart.some((which, i) => {
        const place = places[i];
        return (
          place !== undefined &&
          !(Number(styleOf(el, which).zIndex) < 0) &&
          content.some((b) => b.width > 0 && b.height > 0 && overlaps(b, place.rect))
        );
      });
      if (over && !isRoot) {
        htmlFor(el, true, 'a pseudo-element drawn over the content', own);
        return;
      }
    }
    const pseudoShape = (which: '::before' | '::after') => {
      const found = pseudoBox ? undefined : placed.find((p) => p?.which === which);
      if (!found) return;
      const { pcs, shape } = found;
      // Not counted as content: nothing counts a pseudo-element when it stays HTML either.
      const item = emit(
        shape.element,
        el,
        'box',
        grow(shape.region, shadowReach(pcs) * vl),
        { z: zKeyIn(pcs, cs.display, z, visit++), opacity, ...(anim ? { anim } : {}) },
        { pseudo: which, units: 0 },
      );
      item.element.opacity = round(opacity * parseFloat(pcs.opacity));
    };

    const both = textBlock && (painted || pseudoBox || Boolean(band));
    if (painted || pseudoBox || band) {
      const before = proposal.pending.length;
      let shape = pseudoBox ? undefined : shapeFor(el, cs, paint, r);
      if (shape && band) {
        // A shape has one accent, and its stripe lies inside one outline: a box that already
        // has a side of its own, or borders by side, draws its pseudo-element itself.
        const sided =
          shape.element.accent !== undefined ||
          Object.keys(shape.element.css ?? {}).some((property) => property.startsWith('border-'));
        if (sided) {
          proposal.pending.length = before;
          shape = undefined;
        } else shape.element.accent = band.accent;
      }
      if (shape) {
        // The name is for what holds the content: the text when the node is a text block.
        const name = both ? undefined : label(el).name;
        if (name) shape.element.name = name;
        const item = emit(
          shape.element,
          el,
          'box',
          grow(shape.region, shadowReach(cs) * vl),
          inner,
        );
        item.element.opacity = round(opacity);
      } else {
        htmlFor(
          el,
          false,
          pseudoBox || band ? 'a pseudo-element' : 'a box the model cannot draw',
          own,
        );
      }
    }

    pseudoShape('::before');
    if (textBlock) {
      const item = textFor(el, cs, inner, undefined, inherited.marker);
      if (item === 'unsupported') {
        // What was emitted above stands for the node's paint; the text needs the whole node.
        for (let i = items.length - 1; i >= 0; i--) if (items[i]!.node === el) items.splice(i, 1);
        htmlFor(el, true, 'text the model cannot hold', own);
        return;
      }
      if (item) item.element.opacity = round(opacity);
      pseudoShape('::after');
      return;
    }

    // A container that mixes its own text with other content: each stretch of text is a box.
    if (hasOwnText(el)) {
      for (const child of composedChildNodes(el)) {
        if (!isText(child) || child.data.trim() === '') continue;
        const item = textFor(el, cs, inner, child, hanging ?? inherited.marker);
        // Text the model cannot hold is not left out: it is the element's to show, whole.
        if (item === 'unsupported' && !isRoot) return whole('text the model cannot hold');
        if (item && item !== 'unsupported') item.element.opacity = round(opacity);
      }
    }
    down();
    // A marker nothing took would be gone without a word: the item shows it itself.
    if (hanging && !hanging.taken) {
      return whole('a list item whose marker has no first line of text to hang beside');
    }
    pseudoShape('::after');
  };

  const archetype = (
    isElement(root) ? [root, ...Array.from(root.querySelectorAll('[data-archetype]'))] : []
  )
    .map((el) => el.getAttribute('data-archetype')?.trim())
    .find((value) => value);
  if (archetype) {
    const parsed = Archetype.safeParse(archetype);
    if (parsed.success) proposal.archetype = parsed.data;
    else
      notes.push(
        `data-archetype="${archetype}" is not an archetype; they are ${Archetype.options.join(', ')}.`,
      );
  }

  walk(root, { opacity: 1, z: { path: [], seq: 0 }, scale: 1 }, true);
  items.sort((a, b) =>
    comparePaintOrder({ ...a, box: a.covers === 'box' }, { ...b, box: b.covers === 'box' }),
  );
  takeBackground(proposal, deck);
  return proposal;
}

/**
 * A box that fills the slide and lies under everything is the slide's background, and a
 * second one over it its overlay: the model has a field for exactly that.
 */
function takeBackground(proposal: Proposal, deck: Deck): void {
  const { items } = proposal;
  const fillOfCover = (item: Item | undefined): Fill | undefined => {
    if (!item || item.element.type !== 'shape' || item.covers !== 'box') return undefined;
    const e = item.element;
    const f = e.frame;
    const full =
      Math.abs(f.x) < 0.5 &&
      Math.abs(f.y) < 0.5 &&
      Math.abs(f.w - deck.size.w) < 0.5 &&
      Math.abs(f.h - deck.size.h) < 0.5;
    const plain =
      e.geometry.kind === 'preset' &&
      e.geometry.preset === 'rect' &&
      e.fill.kind !== 'none' &&
      !e.stroke &&
      !e.effects &&
      !e.css &&
      e.opacity === 1 &&
      !e.rotation &&
      !e.name &&
      !e.role &&
      !e.link &&
      !item.anim;
    return full && plain ? e.fill : undefined;
  };
  const fill = fillOfCover(items[0]);
  if (!fill) return;
  items.shift();
  proposal.background = { fill };
  const overlay = fillOfCover(items[0]);
  if (overlay) {
    items.shift();
    proposal.background.overlay = overlay;
  }
}

/**
 * An `html` element for a node, made outside the walk: what the fidelity guard puts in place
 * of elements that looked different. Scale and opacity are read from the node's ancestors.
 */
export function htmlItem(
  space: Space,
  el: Element,
  deep: boolean,
  reason: string,
  nextId: () => string,
): Item {
  let scale = space.viewScale;
  let opacity = 1;
  if (el !== space.root) {
    for (let p = composedParent(el); p; p = composedParent(p)) {
      if (p === space.root) break;
      const cs = styleOf(p);
      scale *= uniformScale(cs.transform) ?? 1;
      opacity *= parseFloat(cs.opacity);
    }
  }
  const r = el.getBoundingClientRect();
  const { rootRect, viewScale, k } = space;
  const counted = deep ? countContent(el) : { units: 1, chars: 0 };
  const link = linkAround(el);
  return {
    element: createElement.html({
      id: nextId(),
      frame: {
        x: round(((r.left - rootRect.left) / viewScale) * k + space.offX),
        y: round(((r.top - rootRect.top) / viewScale) * k + space.offY),
        w: round((r.width / viewScale) * k),
        h: round((r.height / viewScale) * k),
      },
      markup: '',
      opacity: round(opacity),
      ...(link ? { link: { kind: 'url', target: link } } : {}),
    }),
    node: el,
    covers: deep ? 'subtree' : 'box',
    region: { x: r.left, y: r.top, w: r.width, h: r.height },
    scaled: Math.abs(scale / viewScale - 1) > 1e-6,
    units: counted.units,
    chars: counted.chars,
    z: { path: [], seq: 0 },
    emitted: 0,
    inheritedOpacity: opacity,
    parentScale: scale,
    copy: 'markup',
    reason,
  };
}

// ---------------------------------------------------------------------------------------------
// Inline SVG.

/** Presentation properties a stylesheet may set on SVG content; a copy must carry them itself. */
const SVG_PROPERTIES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'stop-color',
  'stop-opacity',
  'clip-rule',
  'paint-order',
  'vector-effect',
  'visibility',
  'display',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
] as const;

const PAINT_PROPERTIES = new Set(['fill', 'stroke', 'stop-color']);

/**
 * Stand-alone markup of an inline SVG: the original nodes, with what the page's stylesheets
 * gave them written on each node. A paint that was written as `currentColor` stays
 * `currentColor`, so the element can follow the theme through `colorOverrides`. Ids get a
 * prefix: inline SVGs share the document, and two icons with a clip path "a" would otherwise
 * use each other's.
 */
function svgMarkup(
  svg: Element,
  width: number,
  height: number,
  prefix: string,
): { markup: string; usesCurrentColor: boolean } | undefined {
  // References to things outside the SVG (a sprite sheet elsewhere in the page) do not travel.
  for (const use of Array.from(svg.querySelectorAll('use'))) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    const target = href.startsWith('#')
      ? Array.from(svg.querySelectorAll('[id]')).find((n) => n.id === href.slice(1))
      : undefined;
    if (!target) return undefined;
  }
  if (svg.querySelector('foreignObject, script, image')) return undefined;
  const clone = svg.cloneNode(true) as Element;
  const sources = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];
  const authored = (node: Element, property: string) =>
    (
      (node as SVGElement).style?.getPropertyValue(property) ||
      node.getAttribute(property) ||
      ''
    ).trim();
  /** Whether the nearest node that sets the paint sets it to the text colour. */
  const followsText = (node: Element, property: string, cs: CSSStyleDeclaration): boolean => {
    for (let n: Element | null = node; n; n = n === svg ? null : n.parentElement) {
      const value = authored(n, property);
      if (value) return /^currentcolor$/i.test(value) && cs.getPropertyValue(property) === cs.color;
    }
    return false;
  };
  let usesCurrentColor = false;
  sources.forEach((source, i) => {
    const copy = copies[i] as SVGElement;
    if (copy.localName === 'style') return;
    const cs = styleOf(source);
    if (i === 0) copy.removeAttribute('style');
    for (const property of SVG_PROPERTIES) {
      // The root's own box is the element's frame; these belong to the frame, not to the drawing.
      if (
        i === 0 &&
        (property === 'display' || property === 'opacity' || property === 'visibility')
      )
        continue;
      const value = cs.getPropertyValue(property);
      if (!value) continue;
      if (PAINT_PROPERTIES.has(property) && followsText(source, property, cs)) {
        usesCurrentColor = true;
        copy.style.setProperty(property, 'currentColor');
      } else copy.style.setProperty(property, value);
    }
    copy.removeAttribute('class');
  });
  for (const style of Array.from(clone.querySelectorAll('style'))) style.remove();

  const ids = copies.map((c) => c.getAttribute('id')).filter((id): id is string => Boolean(id));
  if (ids.length > 0) {
    const renamed = new Map(ids.map((id) => [id, `${prefix}-${id}`]));
    const reference = (value: string) =>
      value
        .replace(/url\((["']?)#([^)"']+)\1\)/g, (whole, _q: string, id: string) =>
          renamed.has(id) ? `url(#${renamed.get(id)!})` : whole,
        )
        .replace(/^#(.+)$/, (whole, id: string) =>
          renamed.has(id) ? `#${renamed.get(id)!}` : whole,
        );
    for (const copy of copies) {
      for (const attr of Array.from(copy.attributes)) {
        if (attr.name === 'id') copy.setAttribute('id', renamed.get(attr.value) ?? attr.value);
        else if (attr.value.includes('#')) copy.setAttribute(attr.name, reference(attr.value));
      }
    }
  }
  if (!clone.hasAttribute('viewBox'))
    clone.setAttribute('viewBox', `0 0 ${round(width)} ${round(height)}`);
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  if (!clone.hasAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return { markup: clone.outerHTML, usesCurrentColor };
}
