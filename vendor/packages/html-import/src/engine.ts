/**
 * One conversion from start to end (SPEC 5.9, ADR-005, ADR-017): measure a rendered subtree,
 * propose elements, then render the proposal with the real renderer and compare it with the
 * source. What looks different goes back to being an `html` element of the original subtree,
 * so the slide that comes out looks like the source whatever the conversion managed.
 *
 * "Like for like": the converted slide is drawn in the units of the source (CSS `zoom`, no
 * transform) at the same place on the same page, and both pictures are taken the same way.
 * Line wrapping is checked by geometry on the layout at 1920.
 */
import {
  createElement,
  createSlide,
  Element as ElementSchema,
  newId,
  Slide as SlideSchema,
  type AnimationStep,
  type AssetMeta,
  type Background,
  type Deck,
  type Element as ModelElement,
  type Slide,
} from '@slidr/model';
import { renderSlideOffscreen, themeVariables } from '@slidr/renderer';
import { ANIM_MARK, timelineOf, type Entering } from './anim';
import {
  compose,
  elementsOf,
  keyOf,
  settle,
  unchanged,
  type Composition,
  type Part,
} from './compose';
import { charactersMoved, compareLines, round, wrapsDifferently, type Line } from './css';
import { htmlItem, opaqueFill, propose, type Item, type Proposal } from './convert';
import type { ConversionHost, Rect } from './host';
import { BASE_STYLE_ATTRIBUTE, copySubtree, disposeCopyBaseline } from './htmlCopy';
import {
  charRects,
  composedParent,
  isElement,
  isInside,
  styleOf,
  textLines,
  viewportOffset,
} from './measure';
import {
  attribute,
  clusters,
  differingBlocks,
  differingPixels,
  downsample,
  uniformColor,
  type Box,
  type Picture,
} from './pixels';
import { readThemeUse } from './themeUse';
import { snapColor, themeValues } from './tokens';

export interface ConvertOptions {
  deck: Deck;
  host: ConversionHost;
  /**
   * The source is a document of its own (an imported file), not one the engine built to stand
   * in for a slide: nothing of the deck's theme is assumed to reach it.
   */
  foreign: boolean;
  /**
   * What lies behind the root. `slide`: the slide the elements are for, which the caller drew
   * under the source with `mountSlide`; the result then gets no background from behind.
   * `page`: whatever the page shows there (ancestor backgrounds, a separate background
   * layer), which is captured.
   */
  behind: 'slide' | 'page';
  /** With `behind: 'slide'`: what that slide draws when it has no elements. Default: the theme's. */
  base?: { background?: Background; layoutId?: string };
  /** Slide px per CSS px of the root, and where its corner goes. Default: fitted and centred. */
  placement?: { k: number; x: number; y: number };
  /** Ids that are taken besides those in the deck. */
  takenIds?: ReadonlySet<string>;
  /**
   * False when the caller keeps the fonts the source brought as assets of the deck (HTML
   * import, SPEC 5.7): their `@font-face` rules then stay out of the slide's `css`.
   */
  fontFaces?: boolean;
  /**
   * Stylesheet text the caller gives the slide itself: the faces of a font the deck keeps as
   * an asset that the asset's one record cannot say (`createSourceFonts`).
   */
  css?: string;
  /**
   * False leaves the slide as the list the guard settled, one element for each thing the page
   * draws, without putting it together (`Conversion.compose`).
   */
  compose?: boolean;
  /**
   * A forced conversion (HTM-05): text with styling the model has no field for is proposed as a
   * text element without it, where otherwise it would stay html. The caller judges the
   * proposal and tells the differences instead of guarding it.
   */
  lossy?: boolean;
}

export interface Fallback {
  /** Why the region is HTML. */
  reason: string;
  /** How the copy was made. */
  copy: 'markup' | 'computed';
  /** The whole subtree, or only the element's own box. */
  deep: boolean;
}

export interface GuardReport {
  /** The converted slide looks like the source. */
  faithful: boolean;
  rounds: number;
  /** Differing pixels of the last comparison, at half resolution, text included. */
  diffPixels: number;
  /** The comparison was exact; false when the source is shown through a scale (ADR-005). */
  exact: boolean;
  /** What the guard put back as HTML. */
  fallbacks: Fallback[];
  /** The whole slide is one HTML element. */
  wholeSlide: boolean;
}

export interface Verdict {
  faithful: boolean;
  /** Items that look different, and why. */
  bad: { item: Item; why: string }[];
  /** Differences no item owns, in viewport px of the source document. */
  loose: { pixels: number; box: Rect }[];
  diffPixels: number;
}

export interface ConversionResult {
  slide: Slide;
  /** Assets the conversion stored. */
  assets: AssetMeta[];
  /** Share of the content items that became regular elements, 0..1. */
  editability: number;
  /** Share of the visible characters that are in text elements, 0..1. */
  textEditability: number;
  notes: string[];
  guard: GuardReport;
  /** Milliseconds from the start of the measurement to the end of the guard. */
  ms: number;
}

/** A conversion in progress. Tests drive the steps one by one; `run` does them all. */
export interface Conversion {
  readonly proposal: Proposal;
  /**
   * Renders the proposal once and says what looks different. It moves text boxes to where
   * their lines belong first; `fit: false` judges the proposal exactly as it stands.
   */
  judge(options?: { fit?: boolean }): Promise<Verdict>;
  /** Judges and replaces what differs with HTML, until the slide matches or nothing is left to try. */
  guard(): Promise<GuardReport>;
  /**
   * Puts the guarded proposal together the way a slide is built by hand (ADR-073): texts that
   * follow one another in one box, a text in the middle of a box as the text of a shape, a box
   * and what lies on it as a group. The result is judged as the guard judges, and what does
   * not look the same is left as it was. Returns the report of the slide as it now stands.
   */
  compose(report: GuardReport): Promise<GuardReport>;
  /** The slide as the proposal stands. */
  result(report: GuardReport): ConversionResult;
  dispose(): void;
}

const MAX_ROUNDS = 6;
/** An element is different when more than this share of the pixels it owns differ. */
const BAD_SHARE = 0.004;
const BAD_MIN_PIXELS = 6;
/**
 * Text is held in place by its line geometry; its pixels say whether it is drawn the same
 * (colour, decoration, shadow), which changes every glyph. A box placed to a hundredth of a
 * pixel still lets a few glyph edges fall on the other side of a rounding: measured, up to
 * 0.4% of the box on correct conversions. A table is mostly text, placed by its columns.
 */
const BAD_TEXT_SHARE = 0.01;
/**
 * A short text has few pixels, and one glyph that fell on the other side of a pixel is more
 * than 1% of them. Up to this share, a text whose lines sit right is asked about again on the
 * coarse picture: a glyph a pixel over is gone there, another weight, colour or font is not.
 */
const GLYPH_SHIFT_SHARE = 0.04;
/** A box is wrong all over when more than this share of its own pixels differ, of at least this many. */
const WRONG_ALL_OVER_SHARE = 0.5;
const WRONG_ALL_OVER_MIN_PIXELS = 400;
/** Pictures are compared at half resolution: edge noise of boxes and glyphs averages out. */
const FINE = 2;
/** Elements drawn through a scale are judged on a coarser picture, which raster noise does not reach. */
const COARSE = 4;
const COARSE_SHARE = 0.02;
const COARSE_MIN_PIXELS = 4;
/** Text through a scale: measured 2.6-3.9% of coarse pixels on correct conversions (ADR-005). */
const SCALED_TEXT_SHARE = 0.1;
const NOISE_THRESHOLD = 0.1;
/** Without a scale the two pictures go through the same raster path and compare strictly. */
const STRICT_THRESHOLD = 0.03;
const CLUSTER_CELL = 12;
const CLUSTER_MIN_PIXELS = 12;
/**
 * A difference that sits in one place of a text, a table or an HTML copy with text in it: a
 * word in another colour, a line drawn over it, a title that took its neighbour's look. The
 * shares above cannot see it, since they grow with the element: in a paragraph of three lines
 * 1% is a whole word, and in an HTML copy of a card it is the card's title. So the average
 * colour of blocks is compared too (`differingBlocks`), at two sizes of block, in px of the
 * page; each threshold is a little over 1 / size, which a glyph that moved by a pixel cannot
 * reach. Measured on the engine's fixtures and on the four files written for the import set
 * (229 textual items, zoomed pages among them): no block differs on a conversion that is
 * right, and 7 to 65 blocks on the bug hunt's cases at 40px text.
 */
const LOCAL_BLOCKS = [
  { size: 8, threshold: 0.14 },
  { size: 16, threshold: 0.07 },
] as const;
const LOCAL_MIN_BLOCKS = 2;
/** A text box sits right when its lines are within this many pixels of the source's. */
const SETTLED = 0.04;
/** How far past the middle of a pixel a baseline is pushed to land on the source's row, in source px. */
const ROW_NUDGE = 0.03;
/** On the source's pixel row, a baseline this far from the source's draws the same glyphs. */
const ROW_SETTLED = 0.1;
/** An opacity that changes no pixel by more than a level and makes the browser draw text in grey. */
const SAME_ANTIALIASING = '0.999';
/** How often a text box is moved to where its lines belong before it counts as different. */
const MAX_TEXT_FITS = 5;
/** How often the composed slide is laid out to put its joined texts where they were (ADR-073). */
const MAX_COMPOSE_FITS = 4;

/** An element whose text is laid out in lines that can be measured: a text box, a shape with text. */
function holdsLines(element: ModelElement): boolean {
  return element.type === 'text' || (element.type === 'shape' && element.content !== undefined);
}

/** What is judged as text is: by where its lines sit, and with the slack glyph edges need. */
function textual(item: Item): boolean {
  const element = item.element;
  return (
    element.type === 'text' ||
    element.type === 'table' ||
    (element.type === 'html' && item.chars > 0) ||
    (element.type === 'shape' && element.content !== undefined)
  );
}

/** How long a page that is given no frames is waited for (as in the renderer's `settle`). */
const FRAMES_FALLBACK_MS = 250;

/**
 * Two frames, after which what was just changed has been drawn. A window that is minimized or
 * hidden gets no frames, so a timer stands in for them: a conversion must not wait for the user
 * to bring the window back.
 */
function twoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    setTimeout(resolve, FRAMES_FALLBACK_MS);
  });
}

/**
 * Whether the browser is likely to draw the element on a layer of its own: something on it or
 * above it in the source asks for one (a 3D context, a perspective, `will-change`, a filter, a
 * transform that is more than a move by whole pixels). The compositor places such a layer, and
 * the text on it, a fraction of a pixel away from where plain layout would put the same text,
 * so two pictures of it never agree pixel for pixel however right the conversion is. Such
 * content is judged the way content shown through a scale is (ADR-005): on a coarser picture.
 */
function layered(el: Element): boolean {
  for (let node: Element | undefined = el; node; node = composedParent(node)) {
    if (asksForLayer(node)) return true;
  }
  return false;
}

/** How many elements of a subtree are looked at for one that asks for a layer. */
const MAX_LAYER_SEARCH = 4000;

function asksForLayer(node: Element): boolean {
  const cs = styleOf(node);
  if (
    cs.perspective !== 'none' ||
    cs.transformStyle === 'preserve-3d' ||
    cs.backfaceVisibility === 'hidden' ||
    /transform|opacity|filter|contents/.test(cs.willChange) ||
    (cs.filter !== 'none' && cs.filter !== '') ||
    (cs.backdropFilter !== 'none' && cs.backdropFilter !== '')
  ) {
    return true;
  }
  if (cs.transform === 'none') return false;
  const m = new DOMMatrix(cs.transform);
  const whole = (v: number) => Math.abs(v - Math.round(v)) < 0.01;
  return !(m.is2D && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && whole(m.e) && whole(m.f));
}

async function decode(blob: Blob): Promise<Picture> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas to read a picture with.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Finite animations jump to their end; endless ones stop at their start. Both sides of a
 * comparison get the same. A document does not list the animations inside shadow trees
 * (where `html` elements are drawn), so those are asked for tree by tree.
 */
export function freezeAnimations(doc: Document): void {
  const trees: (Document | ShadowRoot)[] = [doc];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (el.shadowRoot) trees.push(el.shadowRoot);
  }
  for (const animation of trees.flatMap((tree) => tree.getAnimations())) {
    try {
      if (animation.effect?.getComputedTiming().endTime === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      } else animation.finish();
    } catch {
      animation.pause();
    }
  }
}

/** The `@keyframes` rules of the document with the given names, as stylesheet text. */
function keyframesText(doc: Document, names: ReadonlySet<string>): string {
  if (names.size === 0) return '';
  const found = new Map<string, string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule.constructor.name === 'CSSKeyframesRule') {
        const name = (rule as CSSKeyframesRule).name;
        if (names.has(name)) found.set(name, rule.cssText);
      } else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read.
    }
  }
  return Array.from(found.values()).join('\n');
}

export interface Placement {
  /** Where the source root's top-left corner is on the page. */
  origin: { x: number; y: number };
  /** Screen px per CSS px of the root, slide px per CSS px of the root, and the root's place on the slide. */
  viewScale: number;
  k: number;
  offX: number;
  offY: number;
}

export interface MountedSlide {
  /** The slide root, 1920x1080 in its own pixels. */
  root: HTMLElement;
  /**
   * Shows the slide the way the source is shown: in the source's own CSS px (`zoom`, not a
   * transform) and behind the source's own scale, so that both rasterise alike.
   */
  likeSource(): void;
  dispose(): void;
}

/**
 * Draws a slide on the page so that the part of it the source root stands for lies exactly
 * over the root. Until `likeSource` is called a zoomed slide is laid out at 1920 and not
 * painted, which is the layout that line wrapping is checked on (ADR-005).
 */
export async function mountSlide(
  deck: Deck,
  slide: Slide,
  host: ConversionHost,
  place: Placement,
  /** Where in the page's stacking the slide goes. Default: over everything. */
  layer: { parent: HTMLElement; zIndex: number } = { parent: document.body, zIndex: 2147483647 },
): Promise<MountedSlide> {
  const zoomed = Math.abs(place.viewScale - 1) > 1e-6 || Math.abs(place.k - 1) > 1e-6;
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;z-index:${layer.zIndex};pointer-events:none`;
  if (zoomed) wrapper.style.visibility = 'hidden';
  const scaler = document.createElement('div');
  scaler.style.cssText = `position:absolute;left:${place.origin.x}px;top:${place.origin.y}px;transform-origin:0 0`;
  const zoomer = document.createElement('div');
  zoomer.style.cssText = `position:absolute;left:${zoomed ? 0 : -place.offX}px;top:${zoomed ? 0 : -place.offY}px`;
  scaler.append(zoomer);
  wrapper.append(scaler);
  layer.parent.append(wrapper);
  let offscreen;
  try {
    offscreen = await renderSlideOffscreen(
      { deck, slide, mode: 'thumbnail', resolveAsset: host.resolveAsset },
      { parent: zoomer, hidden: false },
    );
  } catch (error) {
    wrapper.remove();
    throw error;
  }
  offscreen.container.style.position = 'absolute';
  const mounted = offscreen;
  return {
    root: mounted.root,
    likeSource() {
      if (!zoomed) return;
      zoomer.style.zoom = String(1 / place.k);
      zoomer.style.left = `${-place.offX}px`;
      zoomer.style.top = `${-place.offY}px`;
      if (Math.abs(place.viewScale - 1) > 1e-6)
        scaler.style.transform = `scale(${place.viewScale})`;
      wrapper.style.visibility = '';
    },
    dispose() {
      mounted.dispose();
      wrapper.remove();
    },
  };
}

/**
 * The `@font-face` rules the source brought itself and really drew text with, as stylesheet
 * text for the slide (SPEC 5.9). The faces the engine gave the sandbox are the deck's own and
 * are left out. A face that did not load (a blocked URL) drew nothing and is left out too.
 */
function fontFaceText(doc: Document): string {
  const loaded = new Set<string>();
  for (const face of Array.from(doc.fonts)) {
    if (face.status === 'loaded') loaded.add(face.family.replace(/^["']|["']$/g, '').toLowerCase());
  }
  const rules: string[] = [];
  const visit = (list: CSSRuleList, base: string) => {
    for (const rule of Array.from(list)) {
      if (rule.constructor.name === 'CSSFontFaceRule') {
        const family = (rule as CSSFontFaceRule).style
          .getPropertyValue('font-family')
          .replace(/^["']|["']$/g, '')
          .toLowerCase();
        if (!loaded.has(family)) continue;
        rules.push(
          rule.cssText.replace(/url\((["']?)(.*?)\1\)/g, (whole, _q: string, url: string) => {
            try {
              return `url("${new URL(url, base).href}")`;
            } catch {
              return whole;
            }
          }),
        );
      } else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules, base);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode;
    if (owner && isElement(owner) && owner.hasAttribute(BASE_STYLE_ATTRIBUTE)) continue;
    try {
      visit(sheet.cssRules, sheet.href ?? doc.baseURI);
    } catch {
      // A sheet from another origin cannot be read.
    }
  }
  return rules.join('\n');
}

/**
 * Starts a conversion of the subtree under `root`, which is rendered and settled: its fonts
 * and images are loaded. The root may be in another document (the sandbox frame, or the page
 * of an import session); that document must be visible on the page the engine runs in, where
 * the pictures are taken.
 */
export async function startConversion(root: Element, options: ConvertOptions): Promise<Conversion> {
  const { deck, host } = options;
  const started = performance.now();
  const doc = root.ownerDocument;
  const taken = new Set<string>(options.takenIds);
  for (const slide of deck.slides) {
    const visit = (elements: readonly ModelElement[]) => {
      for (const e of elements) {
        taken.add(e.id);
        if (e.type === 'group') visit(e.children);
      }
    };
    visit(slide.elements);
  }
  const nextId = () => {
    const id = newId('e', (candidate) => taken.has(candidate));
    taken.add(id);
    return id;
  };

  // The theme as this browser computes it, read off a probe that carries its variables.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
  for (const [name, value] of Object.entries(themeVariables(deck.theme, deck.meta.lang)))
    probe.style.setProperty(name, value);
  document.body.append(probe);
  const values = themeValues(
    deck.theme,
    (css) => {
      probe.style.color = '';
      probe.style.color = css;
      return getComputedStyle(probe).color;
    },
    (css) => {
      probe.style.fontFamily = css;
      return getComputedStyle(probe).fontFamily;
    },
  );
  probe.remove();

  const stored = new Map<string, AssetMeta>();
  const byUrl = new Map<string, Promise<string | undefined>>();
  const storeBlob = async (blob: Blob, name?: string): Promise<string> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const asset = await host.storeAsset(bytes, {
      mime: blob.type || 'application/octet-stream',
      ...(name ? { name } : {}),
    });
    if (!deck.assets[asset.id]) stored.set(asset.id, asset);
    return asset.id;
  };
  const storeImage = (url: string): Promise<string | undefined> => {
    let pending = byUrl.get(url);
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetch(url);
          if (!response.ok) return undefined;
          return await storeBlob(await response.blob());
        } catch {
          return undefined;
        }
      })();
      byUrl.set(url, pending);
    }
    return pending;
  };

  freezeAnimations(doc);
  // A foreign document has no theme variables: every colour in it is just a colour.
  const use = options.foreign ? undefined : readThemeUse(root);
  const proposal = propose(root, {
    deck,
    host,
    text: {
      theme: deck.theme,
      values,
      link: !options.foreign,
      color: (css, node, property, pseudo) =>
        snapColor(css, values, (token) => use?.uses(node, property, token, pseudo) ?? false),
      ...(options.lossy ? { lossy: true } : {}),
    },
    nextId,
    storeImage,
    ...(options.placement ? { placement: options.placement } : {}),
    // An imported page's own `data-anim` means whatever that page made it mean.
    animAttribute: options.foreign ? ANIM_MARK : 'data-anim',
  });
  const { space, notes } = proposal;
  for (const work of proposal.pending) await work();
  // An image fill whose picture could not be stored has nothing to show.
  for (const item of proposal.items) {
    const e = item.element;
    if (e.type === 'shape' && e.fill.kind === 'image' && e.fill.assetId === '')
      e.fill = { kind: 'none' };
  }

  // Where the root is on the page the pictures are taken of, cut on whole pixels. A root that
  // was scrolled to sits up to a pixel above or left of the page's edge (scrolling stops on
  // whole pixels, a section starts where it starts); the picture begins at the edge.
  const offset = viewportOffset(doc);
  const origin = { x: space.rootRect.left + offset.x, y: space.rootRect.top + offset.y };
  const corner = { x: Math.max(0, Math.floor(origin.x)), y: Math.max(0, Math.floor(origin.y)) };
  const clip = {
    ...corner,
    width: Math.ceil(origin.x + space.rootRect.width) - corner.x,
    height: Math.ceil(origin.y + space.rootRect.height) - corner.y,
  };
  const take = async () => decode(await host.capture(clip));
  const fullSlide =
    Math.abs(space.offX) < 0.5 &&
    Math.abs(space.offY) < 0.5 &&
    Math.abs((space.rootRect.width / space.viewScale) * space.k - deck.size.w) < 0.5 &&
    Math.abs((space.rootRect.height / space.viewScale) * space.k - deck.size.h) < 0.5;

  if (options.behind === 'page') {
    // Opacity, not visibility: a child with `visibility: visible` stays visible under a hidden
    // parent, and the picture of what is "behind" would then show the slide's own content.
    const html = root as HTMLElement;
    const before = html.getAttribute('style');
    html.style.setProperty('transition', 'none', 'important');
    html.style.setProperty('opacity', '0', 'important');
    await twoFrames();
    const blob = await host.capture(clip);
    // Back as it was, in two steps: the opacity returns while transitions are still off, and
    // only then the element's own style. An element that fades in with a transition (many
    // decks show a slide that way) would otherwise fade in again, and the picture of the
    // source would be taken halfway through.
    html.style.removeProperty('opacity');
    void styleOf(html).opacity;
    if (before === null) html.removeAttribute('style');
    else html.setAttribute('style', before);
    freezeAnimations(doc);
    await twoFrames();
    const flat = uniformColor(await decode(blob));
    if (flat) {
      const under = {
        kind: 'solid',
        color: { value: `rgb(${flat.r}, ${flat.g}, ${flat.b})` },
      } as const;
      // The root's own fill, when it became the background, lies over what is behind it.
      proposal.background = proposal.background
        ? { fill: under, overlay: proposal.background.fill }
        : { fill: under };
    } else {
      // Not one colour: kept as a picture. Faithful, though not an editable gradient.
      const assetId = await storeBlob(blob, 'backdrop');
      const fill = { kind: 'image', assetId, fit: 'fill' } as const;
      if (fullSlide) {
        proposal.background = proposal.background
          ? { fill, overlay: proposal.background.fill }
          : { fill };
      } else {
        const r = space.rootRect;
        const picture: Item = {
          element: createElement.image({
            id: nextId(),
            frame: {
              x: round(space.offX),
              y: round(space.offY),
              w: round((r.width / space.viewScale) * space.k),
              h: round((r.height / space.viewScale) * space.k),
            },
            assetId,
            fit: 'fill',
            name: 'backdrop',
          }),
          node: root,
          covers: 'box',
          region: { x: r.left, y: r.top, w: r.width, h: r.height },
          exempt: true,
          scaled: false,
          units: 0,
          chars: 0,
          z: { path: [], seq: -1 },
          emitted: -1,
          inheritedOpacity: 1,
          parentScale: space.viewScale,
        };
        proposal.items.unshift(picture);
      }
    }
  }

  const fallbacks: Fallback[] = [];
  const fillHtml = async (item: Item) => {
    if (item.element.type !== 'html') return;
    const copy = await copySubtree(item.node, item.copy ?? 'markup', {
      deep: item.covers === 'subtree',
      parentScale: item.parentScale,
      foreign: options.foreign,
      storeImage,
    });
    item.element.markup = copy.markup;
    if (copy.styles) item.element.styles = copy.styles;
    else delete item.element.styles;
    item.element.natural = { w: round(copy.natural.w), h: round(copy.natural.h) };
    for (const lost of copy.lossy) {
      const note = `HTML kept for ${item.reason ?? 'a region'} lost ${lost}.`;
      if (!notes.includes(note)) notes.push(note);
    }
  };
  for (const item of proposal.items) await fillHtml(item);

  const sourcePicture = await take();
  // The same anti-aliasing on both sides. A browser draws text with coloured sub-pixels where
  // it sits on an opaque layer of its page, and in grey where the layer is see-through, moved
  // by a transform or under an effect: it depends on how a page happens to be composited, not
  // on how it looks. Text the source drew in grey (a deck that keeps its slides on transparent
  // layers over a separate background gets that) would be drawn with coloured edges on the
  // converted slide: every glyph "different", and nothing wrong. Which the source did cannot
  // be asked, so it is tried: a text that fails on its pixels alone is drawn once more under
  // an opacity a hair below 1, which makes the browser draw it in grey and changes no pixel
  // by more than a level, and is judged again.
  const grey = new Set<Item>();
  const triedGrey = new Set<Item>();
  // One page pixel per picture pixel is asked for; a host that gives more is scaled to.
  const density = sourcePicture.width / clip.width;

  const slideId = newId('s', (candidate) => deck.slides.some((s) => s.id === candidate));
  const fonts = options.fontFaces === false ? '' : fontFaceText(doc);
  /** The proposal as it nests, once it was put together (`composed`); flat until then. */
  let nested: Part[] | undefined;
  const assemble = (): Slide => {
    const entering: Entering[] = [];
    const steps = new Set<string>();
    const parts: Part[] = nested ?? proposal.items.map((item) => ({ item }));
    /** The `data-anim` everything in a part enters with, when it is one. */
    const entrance = (part: Part): Item['anim'] => {
      const inner = part.group?.parts.map(entrance) ?? [];
      const own = part.item.anim;
      return own && inner.every((a) => a?.group === own.group) ? own : undefined;
    };
    const enter = (part: Part) => {
      const anim = entrance(part);
      if (!anim) {
        // What is in it enters each in its own way, or not at all.
        if (part.item.anim) enter({ item: part.item });
        part.group?.parts.forEach(enter);
        return;
      }
      // A group whose every part enters with one `data-anim` enters as the one thing it is.
      entering.push({ elementId: part.group?.id ?? part.item.element.id, anim });
    };
    parts.forEach(enter);
    const timeline: AnimationStep[] = timelineOf(entering, () => {
      const id = newId('a', (candidate) => steps.has(candidate));
      steps.add(id);
      return id;
    });
    const css = [options.css, fonts, keyframesText(doc, proposal.keyframes)]
      .filter(Boolean)
      .join('\n');
    const background = proposal.background ?? options.base?.background;
    return createSlide({
      id: slideId,
      elements: elementsOf(parts),
      timeline,
      ...(background ? { background } : {}),
      ...(options.base?.layoutId && !proposal.background
        ? { layoutId: options.base.layoutId }
        : {}),
      ...(proposal.archetype ? { archetype: proposal.archetype } : {}),
      ...(css ? { css } : {}),
    });
  };

  // The deck the proposal is rendered in: the stored assets are already part of it.
  const renderDeck = (): Deck => ({
    ...deck,
    assets: { ...deck.assets, ...Object.fromEntries(stored) },
  });

  const fits = new Map<Item, number>();
  const rootScaled = Math.abs(space.viewScale - 1) > 1e-6;
  // Asked once per item: the answer is about the source, which the guard does not change.
  const layer = new Map<Item, boolean>();
  const onLayer = (item: Item): boolean => {
    let known = layer.get(item);
    if (known === undefined) {
      known =
        options.foreign &&
        (layered(item.node) ||
          // An HTML copy of a subtree holds whatever is on a layer inside it.
          (item.element.type === 'html' &&
            item.covers === 'subtree' &&
            Array.from(item.node.querySelectorAll('*'))
              .slice(0, MAX_LAYER_SEARCH)
              .some(asksForLayer)));
      layer.set(item, known);
    }
    return known;
  };
  const zoomed = rootScaled || Math.abs(space.k - 1) > 1e-6;

  // A root that sits on a fraction of a pixel (a section of a scrolled page, a stage centred in
  // an odd width) hands the fraction down: the browser rounds every box and every baseline in
  // it from where it really is. The slide's own root would drop it, since a box that contains
  // its paint starts on a whole pixel. So the slide is put on the whole pixel, and what is on
  // it is drawn the fraction further in, as the source's content is.
  const whole = { x: Math.round(origin.x), y: Math.round(origin.y) };
  const lead = {
    x: ((origin.x - whole.x) / space.viewScale) * space.k,
    y: ((origin.y - whole.y) / space.viewScale) * space.k,
  };
  const led = (slide: Slide): Slide =>
    lead.x === 0 && lead.y === 0
      ? slide
      : {
          ...slide,
          elements: slide.elements.map((element) => ({
            ...element,
            frame: { ...element.frame, x: element.frame.x + lead.x, y: element.frame.y + lead.y },
          })),
        };

  const place: Placement = {
    origin: whole,
    viewScale: space.viewScale,
    k: space.k,
    offX: space.offX,
    offY: space.offY,
  };

  interface Rendered {
    /** The lines of each text on the layout at 1920, and as shown like the source, in slide px. */
    real: Map<Item, Line[]>;
    shown: Map<Item, Line[]>;
    /** Where the characters sit, of the texts whose order has to be compared, in slide px. */
    characters: Map<Item, Line[]>;
    picture?: Picture;
    moved: boolean;
  }

  /**
   * Renders the proposal over the source and measures its text. Text boxes whose lines sit
   * elsewhere are moved (`fit`), and then nothing is pictured: the caller renders again.
   */
  const render = async (fit: boolean): Promise<Rendered> => {
    const mounted = await mountSlide(renderDeck(), led(assemble()), host, place);
    try {
      for (const item of proposal.items) {
        if (item.element.opacity !== 1 || !grey.has(item)) continue;
        const dom = mounted.root.querySelector<HTMLElement>(
          `[data-element-id="${item.element.id}"]`,
        );
        if (dom) dom.style.opacity = SAME_ANTIALIASING;
      }
      freezeAnimations(document);
      const measure = (): Map<Item, Line[]> => {
        const at = mounted.root.getBoundingClientRect();
        const scale = at.width / deck.size.w;
        const lines = new Map<Item, Line[]>();
        for (const item of proposal.items) {
          if (!item.lines || !holdsLines(item.element)) continue;
          const dom = mounted.root.querySelector(`[data-element-id="${item.element.id}"]`);
          if (!dom) continue;
          lines.set(
            item,
            textLines(dom, (el) => el.hasAttribute('data-slidr-marker')).map((l) => ({
              left: (l.left - at.left) / scale - lead.x,
              right: (l.right - at.left) / scale - lead.x,
              top: (l.top - at.top) / scale - lead.y,
              bottom: (l.bottom - at.top) / scale - lead.y,
              ...(l.base === undefined ? {} : { base: (l.base - at.top) / scale - lead.y }),
            })),
          );
        }
        return lines;
      };
      // Wrapping is read off the layout at 1920. Where the lines sit is read off the slide as
      // it is shown for the comparison: fonts round their metrics by size, so a line of 42px
      // text and the same line of 28px text zoomed by 1.5 sit a fraction of a pixel apart, and
      // it is the second that is pictured.
      const real = measure();
      // The order of the characters is a matter of layout too, and is read off the same one.
      const characters = new Map<Item, Line[]>();
      for (const item of proposal.items) {
        if (!item.characters) continue;
        const dom = mounted.root.querySelector(`[data-element-id="${item.element.id}"]`);
        if (!dom) continue;
        const at = mounted.root.getBoundingClientRect();
        const scale = at.width / deck.size.w;
        characters.set(
          item,
          charRects(dom, (el) => el.hasAttribute('data-slidr-marker')).map((c) => ({
            left: (c.left - at.left) / scale - lead.x,
            right: (c.right - at.left) / scale - lead.x,
            top: (c.top - at.top) / scale - lead.y,
            bottom: (c.bottom - at.top) / scale - lead.y,
          })),
        );
      }
      // What the source drew through a scale of its own is drawn on a layer of its own here
      // too, so that text is anti-aliased the same way on both sides.
      for (const item of proposal.items) {
        if (!item.scaled) continue;
        const dom = mounted.root.querySelector<HTMLElement>(
          `[data-element-id="${item.element.id}"]`,
        );
        if (dom) dom.style.willChange = 'transform';
      }
      mounted.likeSource();
      // An HTML element is laid out at its natural size and brought to its frame by a
      // transform; shown like the source, the slide around it is zoomed back down by the same
      // factor. The two do not cancel in the browser: under a zoom a hairline stays a whole
      // device pixel wide, so the 1px rules of a table come out half as thick again and every
      // row a fraction taller. For the comparison the element takes the zoom in place of the
      // transform, and lays out in the source's own px, as the source did.
      if (Math.abs(space.k - 1) > 1e-6) {
        for (const item of proposal.items) {
          const e = item.element;
          if (e.type !== 'html' || !e.natural) continue;
          const own = e.frame.w / e.natural.w;
          if (Math.abs(own - space.k) > 1e-3 * space.k) continue;
          const content = mounted.root.querySelector<HTMLElement>(
            `[data-element-id="${e.id}"] [data-slidr-html]`,
          );
          if (!content) continue;
          content.style.transform = 'none';
          content.style.zoom = String(space.k);
        }
      }
      const shown = zoomed ? measure() : real;
      let moved = false;
      for (const item of proposal.items) {
        const measured = shown.get(item);
        const tries = fits.get(item) ?? 0;
        if (
          !fit ||
          !measured ||
          !item.lines ||
          item.element.type !== 'text' ||
          tries >= MAX_TEXT_FITS
        ) {
          continue;
        }
        const verdict = compareLines(item.lines, measured, true);
        // Glyphs are drawn on whole pixel rows, so a box a fraction of a pixel off can draw
        // its text a whole row off: the box is moved until its lines sit exactly.
        // Where the baselines are known it is the row itself that is asked about. A baseline a
        // hair past the middle of a pixel puts the glyphs on the next row, however close the
        // box is: such a box is pushed just past the source's side, and stays there.
        const [sourceRow, row] =
          verdict.kind === 'same'
            ? [item.lines[0]?.base, measured[0]?.base].map((base) =>
                base === undefined ? undefined : pixelRow(base),
              )
            : [];
        const known = sourceRow !== undefined && row !== undefined;
        const settled =
          verdict.kind === 'same' &&
          (known
            ? sourceRow === row &&
              Math.abs(verdict.dx) <= SETTLED &&
              Math.abs(verdict.dy) <= ROW_SETTLED
            : Math.abs(verdict.dx) + Math.abs(verdict.dy) <= SETTLED);
        const past =
          verdict.kind === 'same' && known && sourceRow !== row && Math.abs(verdict.dy) <= SETTLED
            ? (sourceRow < row ? ROW_NUDGE : -ROW_NUDGE) * space.k
            : 0;
        const off = verdict.kind === 'same' && !settled;
        if (verdict.kind === 'shifted' || off) {
          item.element.frame = {
            ...item.element.frame,
            x: round(item.element.frame.x - verdict.dx),
            y: round(item.element.frame.y - verdict.dy - past),
          };
          fits.set(item, tries + 1);
          moved = true;
        } else if (verdict.kind === 'pitch') {
          const paragraph = item.element.content.paragraphs[0];
          if (!paragraph) continue;
          const style = deck.theme.textStyles[paragraph.styleRef ?? 'body'];
          const current = paragraph.lineHeight ?? style.lineHeight;
          paragraph.lineHeight = Math.round(current * verdict.ratio * 10000) / 10000;
          fits.set(item, tries + 1);
          moved = true;
        }
      }
      if (moved) return { real, shown, characters, moved };
      await twoFrames();
      return { real, shown, characters, picture: await take(), moved };
    } finally {
      mounted.dispose();
    }
  };

  /** The row of the comparison picture a height on the slide falls on. */
  const pixelRow = (y: number): number =>
    Math.round((((y - space.offY) / space.k) * space.viewScale + origin.y) * density);

  /** A rectangle of the source document in pixels of the comparison picture at a resolution. */
  const toPicture = (rect: Rect, factor: number): Box => ({
    x: ((rect.x + offset.x - clip.x) * density) / factor,
    y: ((rect.y + offset.y - clip.y) * density) / factor,
    w: (rect.w * density) / factor,
    h: (rect.h * density) / factor,
  });

  /** What one rendering of the proposal looks like next to the source. */
  const assess = (rendered: Rendered, picture: Picture): Verdict => {
    const items = proposal.items;
    // Text under a shape that lets it show through (a sheen over a card) is still the text's
    // to answer for: it is judged as text is, and drawn again in grey when that is the
    // difference. Owned by the shape, a row of glyphs a shade off would cost the whole card.
    const showsThrough = items.map(
      ({ element }) =>
        element.type === 'shape' && (element.opacity < 1 || !opaqueFill(element.fill)),
    );
    const texts = items.map(textual);
    const leaves = (above: number, under: number) => showsThrough[above]! && texts[under]!;

    /** Why a text does not sit as the source's does, read off the geometry of its lines. */
    const misplaced = items.map((item) => {
      const real = rendered.real.get(item);
      const shown = rendered.shown.get(item);
      if (item.exempt || !item.lines || !real || !shown) return undefined;
      const wraps = wrapsDifferently(item.lines, real);
      if (wraps) return wraps;
      const verdict = compareLines(item.lines, shown);
      if (verdict.kind === 'different') return verdict.why;
      if (verdict.kind !== 'same') return 'its lines sit elsewhere';
      // Lines that sit right can still hold their characters in another order: asked of the
      // texts the walk could not vouch for.
      const drawn = rendered.characters.get(item);
      return item.characters && drawn && charactersMoved(item.characters, drawn)
        ? 'reads in another order (a part of it is laid out in a direction of its own)'
        : undefined;
    });
    // A text that wraps or sits differently draws its glyphs over its neighbours. Until it is
    // put right, the pixels around it are not held against what lies under or beside it: the
    // next round judges them. Held against them, one label in the wrong font costs its card.
    const toSource = (line: Line): Rect => ({
      x: ((line.left - space.offX) / space.k) * space.viewScale + space.rootRect.left,
      y: ((line.top - space.offY) / space.k) * space.viewScale + space.rootRect.top,
      w: ((line.right - line.left) / space.k) * space.viewScale,
      h: ((line.bottom - line.top) / space.k) * space.viewScale,
    });
    const SPILL = 4;
    const spill = items.flatMap((item, index) => {
      if (!misplaced[index]) return [];
      const boxes = [item.region, ...(rendered.shown.get(item) ?? []).map(toSource)];
      const left = Math.min(...boxes.map((b) => b.x)) - SPILL;
      const top = Math.min(...boxes.map((b) => b.y)) - SPILL;
      const right = Math.max(...boxes.map((b) => b.x + b.w)) + SPILL;
      const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + SPILL;
      return [{ x: left, y: top, w: right - left, h: bottom - top }];
    });
    const sized = new Map<number, [Picture, Picture]>();
    const both = (factor: number): [Picture, Picture] => {
      let pair = sized.get(factor);
      if (!pair) {
        pair = [downsample(sourcePicture, factor), downsample(picture, factor)];
        sized.set(factor, pair);
      }
      return pair;
    };
    const at = (factor: number, threshold: number) => {
      const [a, b] = both(factor);
      const mask = differingPixels(a, b, threshold);
      const width = Math.min(a.width, b.width);
      const height = Math.min(a.height, b.height);
      const ignored = [
        ...items.flatMap((item) => [
          ...(item.exempt ? [toPicture(item.region, factor)] : []),
          ...(item.ignored ?? []).map((r) => toPicture(r, factor)),
        ]),
        ...spill.map((r) => toPicture(r, factor)),
      ];
      const owned = attribute(
        mask,
        width,
        height,
        items.map((item) => toPicture(item.region, factor)),
        ignored,
        leaves,
      );
      return { mask, width, height, ...owned };
    };
    const fine = at(FINE, NOISE_THRESHOLD);
    const strict = at(FINE, STRICT_THRESHOLD);
    const coarse = at(COARSE, NOISE_THRESHOLD);
    // For what holds text: the blocks whose average colour differs, by who owns them.
    const blocks = LOCAL_BLOCKS.map(({ size, threshold }) => ({
      size,
      differing: differingBlocks(
        ...both(FINE),
        strict.owner,
        items.length,
        Math.max(2, Math.round((size * density) / FINE)),
        threshold,
      ),
    }));

    // Without a scale in the way the two pictures are the same picture, so a difference that
    // is small next to a large element still counts when it sits in one place: a corner that
    // lost its radius, a border that moved.
    const dense = clusters(strict.all, strict.width, CLUSTER_CELL, strict.owner).filter(
      (c) => c.pixels >= CLUSTER_MIN_PIXELS,
    );

    // A box that is wrong all over (one that lost its background) changes every pixel of
    // whatever is drawn on it. What lies on such a box is not judged in this round: the box is
    // put right first, and the next round sees the rest as it is. Judged now, a card's text
    // would be taken away for the card's fault.
    const wrongAllOver = items.map(
      (item, index) =>
        !item.exempt &&
        item.element.type !== 'text' &&
        strict.owned[index]! >= WRONG_ALL_OVER_MIN_PIXELS &&
        strict.differing[index]! > WRONG_ALL_OVER_SHARE * strict.owned[index]!,
    );
    const inside = (a: Rect, b: Rect) =>
      a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
    const onWrongBox = (index: number) =>
      items.some(
        (under, at) => at < index && wrongAllOver[at] && inside(items[index]!.region, under.region),
      );

    const bad: Verdict['bad'] = [];
    items.forEach((item, index) => {
      if (item.exempt) return;
      let why = misplaced[index];
      const type = item.element.type;
      if (why) {
        // wraps or sits elsewhere
      } else if (onWrongBox(index)) {
        // judged in the next round
      } else if (item.scaled || rootScaled || onLayer(item)) {
        // The source drew this through a scale the model cannot repeat step for step, so its
        // pixels carry raster noise: judged on the coarse picture.
        if (type === 'html' || textual(item)) {
          // A table is mostly text, and so is an HTML copy that holds any.
          const share = textual(item) ? SCALED_TEXT_SHARE : COARSE_SHARE;
          if (
            coarse.differing[index]! > Math.max(COARSE_MIN_PIXELS, share * coarse.owned[index]!)
          ) {
            why = `looks different (${coarse.differing[index]} of ${coarse.owned[index]} coarse pixels)`;
          }
        } else if (
          fine.differing[index]! > Math.max(BAD_MIN_PIXELS, BAD_SHARE * fine.owned[index]!)
        ) {
          why = `looks different (${fine.differing[index]} of ${fine.owned[index]} pixels)`;
        }
      } else {
        // An HTML copy that holds text is judged as text is. It is the source's own markup
        // drawn again, a frame's rounding away from where it was, and glyphs that sit on the
        // edge of a pixel then fall on its other side: measured on a real deck, up to 1% of
        // the region. Held to the stricter rule, such a copy is widened, round after round,
        // until the whole slide is one HTML element that differs by exactly the same pixels.
        const text = textual(item);
        const least = text ? 2 * BAD_MIN_PIXELS : BAD_MIN_PIXELS;
        const share = text ? BAD_TEXT_SHARE : BAD_SHARE;
        const local = text ? undefined : dense.find((c) => c.owner === index);
        const differing = strict.differing[index]!;
        const owned = strict.owned[index]!;
        const glyphShift =
          text &&
          differing <= GLYPH_SHIFT_SHARE * owned &&
          coarse.differing[index]! <=
            Math.max(COARSE_MIN_PIXELS, COARSE_SHARE * coarse.owned[index]!);
        // The share says how much of the element differs; for what holds text, the blocks say
        // whether a part of it does, however large the element around that part is.
        const place = text
          ? blocks.find((scale) => scale.differing[index]! >= LOCAL_MIN_BLOCKS)
          : undefined;
        if (differing > Math.max(least, share * owned) && !glyphShift) {
          why = `looks different (${differing} of ${owned} pixels)`;
        } else if (local) {
          why = `looks different in one place (${local.pixels} pixels)`;
        } else if (place) {
          why = `looks different in one place (${place.differing[index]} blocks of ${place.size}px)`;
        }
      }
      if (why) bad.push({ item, why });
    });

    const judged = rootScaled ? fine : strict;
    const loose = clusters(judged.loose, judged.width, CLUSTER_CELL)
      .filter((c) => c.pixels >= CLUSTER_MIN_PIXELS)
      .map((c) => ({
        pixels: c.pixels,
        box: {
          x: (c.box.x * FINE) / density + clip.x - offset.x,
          y: (c.box.y * FINE) / density + clip.y - offset.y,
          w: (c.box.w * FINE) / density,
          h: (c.box.h * FINE) / density,
        },
      }));
    let diffPixels = 0;
    for (const v of fine.mask) diffPixels += v;
    return { faithful: bad.length === 0 && loose.length === 0, bad, loose, diffPixels };
  };

  const pictured = async (fit: boolean): Promise<{ rendered: Rendered; picture: Picture }> => {
    let rendered = await render(fit);
    // Text boxes that moved are rendered again before anything is compared.
    for (let i = 0; i < MAX_TEXT_FITS && rendered.moved; i++) rendered = await render(fit);
    if (!rendered.picture) rendered = await render(false);
    const picture = rendered.picture;
    if (!picture) throw new Error('The converted slide could not be pictured.');
    return { rendered, picture };
  };

  /** Where the lines of every text were laid out the last time the proposal was judged. */
  let drawn: Map<Item, Line[]> | undefined;
  const judge = async ({ fit = true }: { fit?: boolean } = {}): Promise<Verdict> => {
    await holdToSchema();
    const first = await pictured(fit);
    drawn = first.rendered.real;
    const verdict = assess(first.rendered, first.picture);
    if (!options.foreign) return verdict;
    // Text that sits where it should and still differs in its pixels may only be anti-aliased
    // the other way: drawn once more in grey, and kept that way where it then matches.
    const again = verdict.bad
      .filter(
        ({ item, why }) =>
          textual(item) && why.startsWith('looks different') && !triedGrey.has(item),
      )
      .map(({ item }) => item);
    if (again.length === 0) return verdict;
    for (const item of again) {
      triedGrey.add(item);
      grey.add(item);
    }
    const second = await pictured(false);
    const retried = assess(second.rendered, second.picture);
    for (const { item } of retried.bad) if (again.includes(item)) grey.delete(item);
    return retried.bad.length <= verdict.bad.length ? retried : verdict;
  };

  /** The smallest element under the root whose box holds the rectangle. */
  const containerOf = (rect: Rect): Element => {
    let best = root;
    const visit = (el: Element) => {
      for (const child of Array.from(el.shadowRoot?.children ?? el.children)) {
        const cs = styleOf(child);
        if (cs.display === 'none') continue;
        const r = child.getBoundingClientRect();
        if (
          r.left <= rect.x + 1 &&
          r.top <= rect.y + 1 &&
          r.right >= rect.x + rect.w - 1 &&
          r.bottom >= rect.y + rect.h - 1
        ) {
          best = child;
          visit(child);
          return;
        }
      }
    };
    visit(root);
    return best;
  };

  /** Puts an HTML copy of a node in place of the items that came from it. */
  const replace = async (node: Element, deep: boolean, reason: string, only?: Item) => {
    const item = htmlItem(space, node, deep, reason, nextId);
    const items = proposal.items;
    const inside = (i: Item) => (only ? i === only : isInside(i.node, node));
    const first = items.findIndex(inside);
    const taken = items.filter(inside);
    const named = taken.find((i) => i.element.name ?? i.element.role);
    if (named?.element.name) item.element.name = named.element.name;
    if (named?.element.role) item.element.role = named.element.role;
    const anim = taken.find((i) => i.anim)?.anim;
    if (anim) item.anim = anim;
    const kept = items.filter((i) => !inside(i));
    const position =
      first < 0 ? kept.length : items.slice(0, first).filter((i) => !inside(i)).length;
    kept.splice(position, 0, item);
    proposal.items = kept;
    if (node === root && deep) delete proposal.background;
    await fillHtml(item);
    fallbacks.push({ reason, copy: 'markup', deep });
    return item;
  };

  /**
   * The model's schema has the last word on what an element may be. Any valid CSS is taken
   * (ADR-017), and a computed value can be one a field does not take. Whatever the walk made of
   * it that the schema refuses goes back to HTML here, before anything is compared: no field,
   * of today or of later, can then make a conversion hand back a slide the deck refuses. Once
   * is enough: what the guard puts in afterwards is HTML, which is always a valid element.
   */
  let held = false;
  const holdToSchema = async (): Promise<void> => {
    if (held) return;
    held = true;
    if (SlideSchema.safeParse(assemble()).success) return;
    for (const item of [...proposal.items]) {
      if (!proposal.items.includes(item) || ElementSchema.safeParse(item.element).success) continue;
      const reason = `${item.element.type === 'text' ? 'text' : `a ${item.element.type}`} the model cannot hold`;
      if (item.covers === 'box') await replace(item.node, false, reason, item);
      else await replace(item.node, true, reason);
    }
    // Not an element: something of the slide itself. The whole of it, then, as it was written.
    if (!SlideSchema.safeParse(assemble()).success) {
      await replace(root, true, 'a slide the model cannot hold');
    }
  };

  /**
   * Puts the settled proposal together (`compose`): joined texts, shapes with their text,
   * groups. The composed slide is laid out until its texts sit on the lines they drew apart,
   * and then judged against the source like any other proposal; what looks different is taken
   * apart again, and if that does not help, all of it is. Undefined when nothing was put
   * together: the proposal is then as the guard left it.
   */
  const composed = async (): Promise<Verdict | undefined> => {
    const items = proposal.items;
    const lines = drawn;
    if (!lines) return undefined;
    const refused = new Set<string>();
    const kept = new Map<string, ModelElement>();
    const groupIds = new Map<Item, string>();
    const groupId = (base: Item) => {
      const id = groupIds.get(base) ?? nextId();
      groupIds.set(base, id);
      return id;
    };
    const plan = () =>
      compose(items, {
        root,
        theme: deck.theme,
        slide: deck.size,
        lines,
        groupId,
        refused,
        kept,
      });
    const take = (composition: Composition | undefined) => {
      proposal.items = composition ? composition.items : items;
      nested = composition?.parts;
    };
    /** Lays the composed slide out and holds every text that was put together to its lines. */
    const fit = async (composition: Composition): Promise<'settled' | 'moved' | 'refused'> => {
      const mounted = await mountSlide(renderDeck(), led(assemble()), host, place);
      try {
        const at = mounted.root.getBoundingClientRect();
        const scale = at.width / deck.size.w;
        let outcome: 'settled' | 'moved' | 'refused' = 'settled';
        for (const [item, how] of composition.made) {
          const dom = mounted.root.querySelector(`[data-element-id="${item.element.id}"]`);
          const now = dom
            ? textLines(dom, (el) => el.hasAttribute('data-slidr-marker')).map((l) => ({
                left: (l.left - at.left) / scale - lead.x,
                right: (l.right - at.left) / scale - lead.x,
                top: (l.top - at.top) / scale - lead.y,
                bottom: (l.bottom - at.top) / scale - lead.y,
              }))
            : [];
          const result = settle(item, how, now, deck.theme);
          const key = keyOf(how.kind, how.of);
          if (result === 'refused') {
            refused.add(key);
            kept.delete(key);
            outcome = 'refused';
          } else {
            kept.set(key, item.element);
            if (result === 'moved' && outcome === 'settled') outcome = 'moved';
          }
        }
        return outcome;
      } finally {
        mounted.dispose();
      }
    };
    /**
     * A plan whose texts were put on their lines. A text that is a fraction off is moved by
     * exactly what it was measured to be off, and is not laid out again to see that it took:
     * the judge that follows draws it and compares it. One that would not sit at all is left
     * out, and the plan is made again without it.
     */
    const settled = async (): Promise<Composition | undefined> => {
      for (let tries = 0; tries < MAX_COMPOSE_FITS; tries++) {
        const composition = plan();
        if (unchanged(composition)) return undefined;
        take(composition);
        if (composition.made.size === 0 || (await fit(composition)) !== 'refused')
          return composition;
      }
      return undefined;
    };
    const judged = async (composition: Composition): Promise<Verdict> => {
      take(composition);
      for (const item of composition.items) {
        // Text the source drew in grey is drawn in grey when it is part of something larger too.
        if (composition.made.get(item)?.of.some((member) => grey.has(member))) grey.add(item);
      }
      return judge({ fit: false });
    };

    // Judged, and once more without whatever looked different; after that it is all or nothing.
    for (let round = 0; round < 2; round++) {
      const composition = await settled();
      if (!composition) break;
      const verdict = await judged(composition);
      if (verdict.faithful) return verdict;
      const before = refused.size;
      for (const { item } of verdict.bad) {
        // What was made of several is taken apart; what only moved into a group (and so under
        // something it lay over) has its group taken apart.
        const how = composition.made.get(item);
        const group = composition.around.get(item);
        if (how) refused.add(keyOf(how.kind, how.of));
        else if (group) refused.add(group);
      }
      if (refused.size === before) break;
    }
    take(undefined);
    return undefined;
  };

  const guard = async (): Promise<GuardReport> => {
    let verdict: Verdict = { faithful: false, bad: [], loose: [], diffPixels: 0 };
    let round = 1;
    let wholeSlide = false;
    // What was already tried on a node, so that every round widens or changes the approach.
    const tried = new Map<Element, Set<string>>();
    const attempt = (node: Element, what: string): boolean => {
      const seen = tried.get(node) ?? new Set();
      tried.set(node, seen);
      if (seen.has(what)) return false;
      seen.add(what);
      return true;
    };
    for (; round <= MAX_ROUNDS; round++) {
      verdict = await judge();
      if (verdict.faithful || round === MAX_ROUNDS) break;

      if (round >= MAX_ROUNDS - 2 && !wholeSlide) {
        // Last resort: the whole slide as one HTML element.
        await replace(root, true, 'the slide could not be matched element by element');
        wholeSlide = true;
        continue;
      }
      if (wholeSlide) {
        const whole = proposal.items.find((i) => i.node === root && i.element.type === 'html');
        if (!whole || whole.copy === 'computed') break;
        whole.copy = 'computed';
        await fillHtml(whole);
        fallbacks.push({ reason: whole.reason ?? '', copy: 'computed', deep: true });
        continue;
      }

      for (const { item, why } of verdict.bad) {
        if (!proposal.items.includes(item)) continue;
        const type = item.element.type;
        if (
          type === 'html' &&
          item.copy === 'markup' &&
          attempt(item.node, `computed:${item.covers}`)
        ) {
          // The original markup did not look the same outside its document: say everything inline.
          item.copy = 'computed';
          await fillHtml(item);
          fallbacks.push({
            reason: item.reason ?? why,
            copy: 'computed',
            deep: item.covers === 'subtree',
          });
        } else if (type === 'html') {
          // A copy that still differs: widen to what contains it.
          const parent = item.node === root ? root : (composedParent(item.node) ?? root);
          await replace(parent, true, `${item.reason ?? 'html'}: ${why}`);
        } else if (
          item.covers === 'box' &&
          proposal.items.some((i) => i.node === item.node && i.pseudo)
        ) {
          // The element's own markup draws its pseudo-elements with its box: once one of
          // them is not right as a shape, it is the whole element or nothing.
          const what = item.pseudo ? 'a pseudo-element' : 'a box';
          await replace(item.node, true, `${what} that ${why}`);
        } else if (item.covers === 'box' && attempt(item.node, 'box')) {
          await replace(item.node, false, `a box that ${why}`, item);
        } else {
          await replace(item.node, true, `${type} that ${why}`);
        }
      }
      for (const { box, pixels } of verdict.loose) {
        const container = containerOf(box);
        const reason = `a difference no element explains (${pixels} pixels)`;
        if (attempt(container, 'loose')) await replace(container, true, reason);
        else
          await replace(
            container === root ? root : (composedParent(container) ?? root),
            true,
            reason,
          );
      }
    }
    return {
      faithful: verdict.faithful,
      rounds: Math.min(round, MAX_ROUNDS),
      diffPixels: verdict.diffPixels,
      exact: !rootScaled && !proposal.items.some((i) => i.scaled || onLayer(i)),
      fallbacks,
      wholeSlide,
    };
  };

  const put = async (report: GuardReport): Promise<GuardReport> => {
    // Only a slide that is right is put together, and only one that is still in pieces.
    if (!report.faithful || report.wholeSlide || options.lossy) return report;
    const verdict = await composed();
    return verdict ? { ...report, diffPixels: verdict.diffPixels } : report;
  };

  const result = (report: GuardReport): ConversionResult => {
    let regular = 0;
    let html = 0;
    let textChars = 0;
    let htmlChars = 0;
    for (const item of proposal.items) {
      if (item.element.type === 'html') {
        html += item.units;
        htmlChars += item.chars;
      } else {
        regular += item.units;
        textChars += item.chars;
      }
    }
    const kept = proposal.items.filter((i) => i.element.type === 'html');
    const summary = [...notes];
    for (const item of kept) {
      summary.push(
        `Kept as HTML (element ${item.element.id}): ${item.reason ?? 'a region that did not convert'}.`,
      );
    }
    if (!report.faithful) {
      summary.push(
        'The slide could not be made to look exactly like the HTML; look at the render and compare.',
      );
    }
    return {
      slide: assemble(),
      assets: Array.from(stored.values()),
      editability: regular + html === 0 ? 1 : regular / (regular + html),
      textEditability: textChars + htmlChars === 0 ? 1 : textChars / (textChars + htmlChars),
      notes: summary,
      guard: report,
      ms: Math.round(performance.now() - started),
    };
  };

  return {
    proposal,
    judge,
    guard,
    compose: put,
    result,
    dispose: disposeCopyBaseline,
  };
}

/** Converts the subtree under `root`: measure, propose, guard, compose. See `startConversion`. */
export async function convertSubtree(
  root: Element,
  options: ConvertOptions,
): Promise<ConversionResult> {
  const conversion = await startConversion(root, options);
  try {
    const guarded = await conversion.guard();
    return conversion.result(
      options.compose === false ? guarded : await conversion.compose(guarded),
    );
  } finally {
    conversion.dispose();
  }
}
