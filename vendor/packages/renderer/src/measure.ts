/**
 * What a rendered slide measures, for code that judges a slide by how it really came out: design
 * lint (LNT-02) reads text overflow, where the glyphs are, the sizes they are drawn at and the
 * colours under them from here, not from the model. Everything is in slide pixels, whatever the
 * scale of the container the slide sits in.
 *
 * The types repeat, on purpose, what `@slidr/lint` declares as its input: this package depends
 * on the model alone (SPEC 14.2), and so does lint. The app passes one to the other, and
 * TypeScript checks there that they still fit.
 */
import type { Frame } from '@slidr/model';

/** A colour as drawn: red, green and blue, 0..255. */
export type Rgb = readonly [number, number, number];

/** The text of one colour and size inside an element. */
export interface TextSpanMeasure {
  color: Rgb;
  /** Opacity of the glyphs, 0..1: the colour's alpha times the opacity of the element. */
  alpha: number;
  /** Font size as drawn: after `shrink`, and after an `html` element's scaling. */
  fontSize: number;
  /**
   * Colours under the glyphs, sampled across the text with the text itself left out. Empty when
   * what is under the text could not be read (see `paintBackdrop`).
   */
  backdrop: Rgb[];
}

export interface TextMeasure {
  /** The box around the glyphs as drawn on the slide, after rotation. */
  ink: Frame;
  /** How far the text runs past the inside of its box; 0 where it fits. */
  overflow: { x: number; y: number };
  /** The scale `autoFit: shrink` settled on; 1 when the text is at its own size. */
  scale: number;
  spans: TextSpanMeasure[];
}

export interface ElementMeasure {
  /** The box the element covers on the slide: rotated, inside its groups, at its real height. */
  box: Frame;
  /**
   * Present when the element shows text: a text box, a shape with text, a table, `html`, and a
   * chart, whose labels, legend and titles are text it draws itself.
   */
  text?: TextMeasure;
}

export interface SlideMeasurements {
  /** By element id. Hidden elements are not rendered and so are absent. */
  elements: Record<string, ElementMeasure>;
}

type Rectangle = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
type ToSlide = (rect: Rectangle) => Frame;

function overlaps(a: Frame, b: Frame): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// ---------------------------------------------------------------------------------------------
// Colours

let probe: CanvasRenderingContext2D | null | undefined;
const parsedColors = new Map<string, readonly [number, number, number, number]>();

/** A computed CSS colour as numbers. Anything but plain `rgb()` is drawn on a pixel and read back. */
function parseColor(css: string): readonly [number, number, number, number] {
  const plain = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (plain) return [Number(plain[1]), Number(plain[2]), Number(plain[3]), 1];
  let rgba = parsedColors.get(css);
  if (!rgba) {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!probe) return [0, 0, 0, 0];
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
    rgba = [r, g, b, a / 255];
    parsedColors.set(css, rgba);
  }
  return rgba;
}

// ---------------------------------------------------------------------------------------------
// The backdrop: the slide without its glyphs, as pixels

/** Canvas pixels per slide pixel. Colours are sampled, not looked at, so a quarter is plenty. */
const BACKDROP_SCALE = 0.25;
/** Longest side of the copy of an image that goes into the backdrop. */
const SMALL_IMAGE = 256;

interface Backdrop {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Parts of the slide whose pixels are not in the picture: text over them is not judged. */
  blind: Frame[];
}

const smallImages = new Map<string, Promise<string | undefined>>();

/**
 * A small copy of an image as a data URL, kept per URL: assets are content-addressed, so a URL
 * always shows the same picture. Undefined when the pixels cannot be read: the image failed to
 * load, or it comes from another origin that does not allow it.
 */
function smallImage(url: string): Promise<string | undefined> {
  let small = smallImages.get(url);
  if (!small) {
    small = shrinkImage(url).catch(() => undefined);
    smallImages.set(url, small);
    // A failure may pass (a file still being written): try again next time.
    void small.then((result) => result === undefined && smallImages.delete(url));
  }
  return small;
}

async function shrinkImage(url: string): Promise<string | undefined> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longest) return undefined;
  const k = Math.min(1, SMALL_IMAGE / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * k));
  const g = canvas.getContext('2d');
  if (!g) return undefined;
  g.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.8);
}

function pairs<E extends Element>(a: ParentNode, b: ParentNode, selector: string): [E, E][] {
  const copies = b.querySelectorAll<E>(selector);
  return Array.from(a.querySelectorAll<E>(selector), (el, i) => [el, copies[i] as E]);
}

/**
 * Glyphs out, everything else stays: fills, highlights, borders, and icons drawn in
 * `currentColor`. Text drawn in SVG (the labels of a chart) is painted by `fill`, not by the
 * text fill colour, and goes out by that.
 */
const NO_GLYPHS =
  '*{-webkit-text-fill-color:transparent!important;-webkit-text-stroke:0 transparent!important;' +
  'text-shadow:none!important;text-decoration-line:none!important}' +
  'svg text,svg tspan{fill:transparent!important;stroke:transparent!important}';

/** Characters XML 1.0 does not allow; one of them in a text would make the whole picture fail. */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const CSS_URL = /url\("((?:[^"\\]|\\.)*)"\)/g;

let surface: HTMLCanvasElement | undefined;

/**
 * Paints the slide without its text, small, and returns the pixels: what is under every text at
 * once, images and gradients included, as the browser itself draws them. The way there is a copy
 * of the slide's DOM inside an SVG `foreignObject`, loaded as an image and drawn on a canvas. It
 * needs no capture window and no round trip to Rust, and stays in the webview.
 *
 * An SVG image loads nothing from outside itself, so every picture goes in as a small data URL.
 * What cannot go in is listed as `blind`: `html` elements (a shadow root is not copied, a frame
 * cannot be read), video, a canvas (its copy is empty), and images whose pixels the page may not
 * read. Undefined when the picture could not be made at all.
 */
async function paintBackdrop(root: HTMLElement, toSlide: ToSlide): Promise<Backdrop | undefined> {
  const copy = root.cloneNode(true) as HTMLElement;
  const blind: Frame[] = [];
  const rectOf = (el: Element) => toSlide(el.getBoundingClientRect());

  for (const [el, twin] of pairs(root, copy, 'iframe, video, canvas, [data-slidr-html]')) {
    blind.push(rectOf(el));
    if (twin.matches('iframe, video')) twin.remove();
  }
  copy.querySelector('style[data-slidr-fonts]')?.remove();
  // Paired now, while the copy still has the shape of the slide (see below).
  const pictures = pairs(root, copy, '[data-slidr-svg]');

  await Promise.all(
    pairs<HTMLImageElement>(root, copy, 'img').map(async ([img, twin]) => {
      const url = img.currentSrc || img.src;
      const small = url ? await smallImage(url) : undefined;
      twin.removeAttribute('alt');
      if (small) twin.setAttribute('src', small);
      else {
        twin.removeAttribute('src');
        blind.push(rectOf(img));
      }
    }),
  );
  await Promise.all(
    pairs<HTMLElement>(root, copy, '[style*="url("]').map(async ([el, twin]) => {
      const value = el.style.backgroundImage;
      const urls = Array.from(value.matchAll(CSS_URL), (m) => m[1] ?? '');
      const smalls = await Promise.all(urls.map((u) => smallImage(u.replace(/\\(.)/g, '$1'))));
      if (smalls.includes(undefined)) blind.push(rectOf(el));
      let i = 0;
      twin.style.backgroundImage = value.replace(CSS_URL, () => {
        const small = smalls[i++];
        return small ? `url("${small}")` : 'none';
      });
    }),
  );

  // The picture of an `svg` element is in a shadow root too, but it is plain SVG, which the
  // copy can hold itself. Last, so that the pairs above were made between trees of one shape.
  // A stylesheet of the picture would style the whole copy from there, so it is held to its
  // own picture.
  pictures.forEach(([el, twin], i) => {
    if (!el.shadowRoot) return;
    twin.setAttribute('data-slidr-svg', String(i));
    twin.append(...Array.from(el.shadowRoot.childNodes, (node) => node.cloneNode(true)));
    for (const sheet of Array.from(twin.querySelectorAll('style'))) {
      sheet.textContent = `@scope ([data-slidr-svg="${i}"]) {\n${sheet.textContent ?? ''}\n}`;
    }
  });

  const style = document.createElement('style');
  style.textContent = NO_GLYPHS;
  copy.prepend(style);

  const { offsetWidth: w, offsetHeight: h } = root;
  const width = Math.round(w * BACKDROP_SCALE);
  const height = Math.round(h * BACKDROP_SCALE);
  try {
    const xhtml = new XMLSerializer().serializeToString(copy).replace(NOT_XML, '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    surface ??= document.createElement('canvas');
    surface.width = width;
    surface.height = height;
    const g = surface.getContext('2d', { willReadFrequently: true });
    if (!g) return undefined;
    // A slide with no background fill shows the page behind it; white stands in for it.
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, width, height);
    g.drawImage(image, 0, 0, width, height);
    return { pixels: g.getImageData(0, 0, width, height).data, width, height, blind };
  } catch {
    return undefined;
  }
}

/** Most samples kept for one span: enough for a share of a tenth to mean something. */
const MAX_SAMPLES = 96;

/** Colours of the backdrop on a grid over each rectangle, a point about every 24 slide pixels. */
function sampleBackdrop(backdrop: Backdrop, rects: readonly Frame[]): Rgb[] {
  const samples: Rgb[] = [];
  for (const rect of rects) {
    const nx = Math.max(1, Math.min(12, Math.round(rect.w / 24)));
    const ny = Math.max(1, Math.min(3, Math.round(rect.h / 24)));
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = Math.floor((rect.x + ((i + 0.5) * rect.w) / nx) * BACKDROP_SCALE);
        const y = Math.floor((rect.y + ((j + 0.5) * rect.h) / ny) * BACKDROP_SCALE);
        if (x < 0 || y < 0 || x >= backdrop.width || y >= backdrop.height) continue;
        const at = (y * backdrop.width + x) * 4;
        const [r = 0, g = 0, b = 0] = backdrop.pixels.subarray(at, at + 3);
        samples.push([r, g, b]);
      }
    }
  }
  if (samples.length <= MAX_SAMPLES) return samples;
  const step = samples.length / MAX_SAMPLES;
  return Array.from({ length: MAX_SAMPLES }, (_, i) => samples[Math.floor(i * step)] as Rgb);
}

// ---------------------------------------------------------------------------------------------
// Text

/** Where the text of an element lives in the renderer's markup. */
function textRoot(node: HTMLElement): Element | ShadowRoot | null | undefined {
  switch (node.dataset.elementType) {
    case 'text':
    case 'shape':
      return node.querySelector('[data-slidr-text]');
    case 'table':
      return node.querySelector('table');
    case 'html':
      // Free HTML without scripts. With scripts it is a sandboxed frame, which cannot be read.
      return node.querySelector('[data-slidr-html="shadow"]')?.shadowRoot;
    case 'chart':
      // Drawn as SVG in the slide's own DOM (ADR-048): its labels are text nodes like any other.
      return node.querySelector('[data-slidr-chart-box] svg');
    default:
      return undefined;
  }
}

function opacityOf(node: HTMLElement, root: HTMLElement): number {
  let opacity = 1;
  for (let el: HTMLElement | null = node; el && el !== root; el = el.parentElement) {
    const own = parseFloat(getComputedStyle(el).opacity);
    if (!Number.isNaN(own)) opacity *= own;
  }
  return opacity;
}

/** How far the text runs past the inside of its box, and the scale `shrink` gave it. */
function fitOf(node: HTMLElement, container: Element | ShadowRoot) {
  const fit = { overflow: { x: 0, y: 0 }, scale: 1 };
  if (container instanceof HTMLTableElement) {
    // Rows grow to hold their text, so the rows of a table that does not fit are taller than
    // its frame. The rows, not the table: half of a collapsed outer border lies outside them.
    const first = container.rows[0];
    const last = container.rows[container.rows.length - 1];
    if (!first || !last) return fit;
    const rows = last.offsetTop + last.offsetHeight - first.offsetTop;
    fit.overflow.y = Math.max(0, rows - node.clientHeight);
  } else if (container instanceof HTMLElement) {
    // `TextBox`: the padded box, the block that is measured, and the block that `shrink` zooms.
    const measured = container.firstElementChild as HTMLElement | null;
    if (!measured) return fit;
    const cs = getComputedStyle(container);
    const inside =
      container.clientHeight -
      (parseFloat(cs.paddingTop) || 0) -
      (parseFloat(cs.paddingBottom) || 0);
    fit.overflow.y = Math.max(0, measured.offsetHeight - inside);
    const zoomed = measured.firstElementChild as HTMLElement | null;
    fit.scale = parseFloat(zoomed?.style.zoom ?? '') || 1;
    // Each paragraph by itself: a line runs out at the end side of its own direction, and a box
    // counts as overflow only what leaves it on the end side of its own.
    for (const block of container.querySelectorAll('p, li')) {
      const past = (block.scrollWidth - block.clientWidth) * fit.scale;
      fit.overflow.x = Math.max(fit.overflow.x, past);
    }
  }
  return fit;
}

/**
 * The boxes of a text node's letters, one per line. Not the boxes of the node as a whole: text
 * boxes keep their spaces (`white-space: pre-wrap`), so the space a wrapped line ends in hangs
 * past the edge of the box, and the node's boxes take it in. For text set against the side it
 * reads from (Hebrew aligned to the left) that put the ink a space's width outside the box. So
 * each word is measured by itself, and the words of a line are joined again, the spaces between
 * them included.
 */
function lineRects(text: Node, range: Range, toSlide: ToSlide): Frame[] {
  const lines: Frame[] = [];
  for (const word of (text.nodeValue ?? '').matchAll(/\S+/g)) {
    range.setStart(text, word.index);
    range.setEnd(text, word.index + word[0].length);
    for (const rect of range.getClientRects()) {
      const box = toSlide(rect);
      if (!(box.w > 0 && box.h > 0)) continue;
      const line = lines.find((l) => Math.abs(l.y - box.y) < 0.5 && Math.abs(l.h - box.h) < 0.5);
      if (line) {
        const end = Math.max(line.x + line.w, box.x + box.w);
        line.x = Math.min(line.x, box.x);
        line.w = end - line.x;
      } else lines.push(box);
    }
  }
  return lines;
}

function measureText(
  node: HTMLElement,
  root: HTMLElement,
  toSlide: ToSlide,
  backdrop: Backdrop | undefined,
): TextMeasure | undefined {
  const container = textRoot(node);
  if (!container) return undefined;
  const host = container instanceof ShadowRoot ? (container.host as HTMLElement) : undefined;
  // Free HTML is laid out at its natural size and scaled to the frame.
  const scale = host ? Math.abs(new DOMMatrixReadOnly(getComputedStyle(host).transform).d) : 1;
  const opacity = opacityOf(node, root);

  const spans = new Map<string, { span: TextSpanMeasure; rects: Frame[] }>();
  const blocks = new Map<Element, Frame>();
  const range = document.createRange();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!/\S/.test(text.nodeValue ?? '')) continue;
    const parent = text.parentElement ?? host;
    if (!parent || parent.closest('style, script, template')) continue;
    const rects = lineRects(text, range, toSlide);
    // Text that is not displayed has no boxes.
    if (rects.length === 0) continue;

    // A glyph's box is as tall as its font, which can be taller than its line. The line is what
    // the text takes up, so each box is cut to the paragraph it belongs to.
    const block = parent.closest('p, li');
    let lines: Frame | undefined;
    if (block) {
      lines = blocks.get(block) ?? toSlide(block.getBoundingClientRect());
      blocks.set(block, lines);
    }
    for (const rect of rects) {
      if (lines) {
        const y = Math.max(rect.y, lines.y);
        const end = Math.min(rect.y + rect.h, lines.y + lines.h);
        if (end > y) {
          rect.y = y;
          rect.h = end - y;
        }
      }
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.w);
      bottom = Math.max(bottom, rect.y + rect.h);
    }

    // A bullet or a number takes up room, but it is a sign, not text to read: its colour is often
    // the accent, and judging its contrast would fault every such list.
    if (parent.closest('[data-slidr-marker]')) continue;

    const cs = getComputedStyle(parent);
    // Text in SVG is painted by its fill; a label with none is not drawn.
    const drawn = parent instanceof SVGElement;
    if (drawn && cs.fill === 'none') continue;
    // Superscript and subscript are small by design: they count at the size of the text they sit in.
    const sized =
      (cs.verticalAlign === 'super' || cs.verticalAlign === 'sub') && parent.parentElement
        ? getComputedStyle(parent.parentElement)
        : cs;
    // Computed sizes ignore `zoom` (what `shrink` sets) and transforms.
    const fontSize = parseFloat(sized.fontSize) * (parent.currentCSSZoom ?? 1) * scale;
    const [r, g, b, a] = parseColor(drawn ? cs.fill : cs.webkitTextFillColor || cs.color);
    const alpha = a * opacity;
    const key = `${r},${g},${b},${alpha},${fontSize}`;
    let entry = spans.get(key);
    if (!entry) {
      entry = { span: { color: [r, g, b], alpha, fontSize, backdrop: [] }, rects: [] };
      spans.set(key, entry);
    }
    entry.rects.push(...rects);
  }
  if (spans.size === 0) return undefined;

  const ink = { x: left, y: top, w: right - left, h: bottom - top };
  if (backdrop && !backdrop.blind.some((area) => overlaps(area, ink))) {
    for (const entry of spans.values()) entry.span.backdrop = sampleBackdrop(backdrop, entry.rects);
  }
  return { ink, ...fitOf(node, container), spans: Array.from(spans.values(), (e) => e.span) };
}

/**
 * Measures a rendered slide: `root` is the slide root of a `SlideRenderer` that has settled
 * (`settle`, or `renderSlideOffscreen`, which waits for it). It reads the DOM and changes nothing
 * in it.
 */
export async function measureSlide(root: HTMLElement): Promise<SlideMeasurements> {
  const origin = root.getBoundingClientRect();
  // The slide may sit in a scaled container, such as the Stage.
  const k = root.offsetWidth ? origin.width / root.offsetWidth : 1;
  const toSlide: ToSlide = (rect) => ({
    x: (rect.left - origin.left) / k,
    y: (rect.top - origin.top) / k,
    w: rect.width / k,
    h: rect.height / k,
  });
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-element-id]'));
  // Only text needs to know what is under it.
  const backdrop = nodes.some((node) => textRoot(node))
    ? await paintBackdrop(root, toSlide)
    : undefined;

  const elements: Record<string, ElementMeasure> = {};
  for (const node of nodes) {
    const id = node.dataset.elementId;
    if (!id) continue;
    const box = toSlide(node.getBoundingClientRect());
    const text = measureText(node, root, toSlide, backdrop);
    elements[id] = text ? { box, text } : { box };
  }
  return { elements };
}
