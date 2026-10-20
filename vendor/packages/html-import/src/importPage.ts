/**
 * The page side of HTML import (SPEC 13.2, WG9-T15, T16): an imported file running in a frame,
 * and what the agent can ask of it. The agent explores and decides; this executes and measures.
 * Nothing here knows a presentation format: it outlines whatever DOM is there, runs the
 * JavaScript it is given, takes pictures, and hands the element the agent points at to the
 * conversion engine.
 *
 * The file is loaded from a `blob:` URL of its bytes, in a frame of the page this runs in, so
 * the engine reads its DOM directly and the pictures the guard compares are pictures of this
 * page. The file's scripts run. That makes the file's code a neighbour of this code: the page
 * must be one the file can do no harm from (in the app: the import window).
 */
import type { AssetMeta, Deck, Slide } from '@slidr/model';
import { settle } from '@slidr/renderer';
import { convertSubtree, type GuardReport } from './engine';
import type { ConversionHost } from './host';
import { drawnOver, nameOf, notPainted } from './drawnOver';
import { composedChildNodes, composedChildren, viewportOffset } from './measure';
import { createSourceFonts, type AppFontFace } from './sourceFonts';
import { clearMarks, markMotion, recordMotion, type MotionRecorder } from './motion';

/** Which element: a CSS selector (open shadow roots are searched too), or JavaScript for it. */
export interface ImportTarget {
  selector?: string;
  js?: string;
}

export interface ImportViewport {
  width: number;
  height: number;
}

export interface ImportCaptureRequest extends ImportTarget {
  /** JavaScript that brings the slide into the state it is captured in. */
  before?: string;
  /** How long to wait after `before`, for transitions. */
  waitMs?: number;
  /** What the engine needs of the deck: its theme, size and language, and no slide. */
  deck: Deck;
  /** Element ids that are taken in the deck. */
  takenIds: readonly string[];
}

/** One captured slide, as the page reports it. Data for whoever receives it, not yet trusted. */
export interface ImportCapture {
  slide: Slide;
  /** The assets the slide uses, and the fonts the file brought. */
  assets: AssetMeta[];
  editability: number;
  textEditability: number;
  notes: string[];
  guard: Pick<GuardReport, 'faithful' | 'exact' | 'rounds' | 'wholeSlide' | 'diffPixels'>;
  /**
   * The size of the captured element on the page, in CSS px, and the scale the page shows it
   * through: its size on the page over the size it is laid out at.
   */
  source: { width: number; height: number; scale: number };
  ms: number;
}

export interface ImportPicture {
  png: Blob;
  width: number;
  height: number;
}

export interface ImportPageOptions {
  /** The bytes of the file, as they are on disk. */
  source(): Promise<ArrayBuffer>;
  host: ConversionHost;
  /** The app's own fonts, which a file may name without carrying them. */
  appFonts?: readonly AppFontFace[];
  /** Where the frame goes. Default: the page's body. It sits at the page's top-left corner. */
  parent?: HTMLElement;
}

export interface ImportPage {
  /** Loads the file anew, at the current viewport. Every other call loads it first if needed. */
  load(): Promise<void>;
  /** Page facts and an outline of the DOM, as text for the agent. */
  inspect(request: ImportTarget & { depth?: number; maxNodes?: number }): Promise<string>;
  /** Runs the body of an async function in the page and returns its result as JSON text. */
  evaluate(code: string): Promise<string>;
  screenshot(request: ImportTarget & { maxWidth?: number }): Promise<ImportPicture>;
  setViewport(size: ImportViewport): Promise<string>;
  capture(request: ImportCaptureRequest): Promise<ImportCapture>;
  /**
   * The addresses the page's content policy refused to load so far, oldest first: what the
   * browser itself reports for the file's document and the frames in it. Empty where the
   * page that holds the file has no such policy.
   */
  refused(): string[];
  dispose(): void;
}

const DEFAULT_VIEWPORT: ImportViewport = { width: 1920, height: 1080 };
const MIN_VIEWPORT: ImportViewport = { width: 320, height: 240 };
const MAX_VIEWPORT: ImportViewport = { width: 3840, height: 2160 };
/** A file that has not fired `load` by now is worked on as it is. */
const LOAD_TIMEOUT_MS = 20_000;
/** The page counts as quiet when nothing in it changed for this long. */
const QUIET_MS = 400;
const QUIET_LIMIT_MS = 8_000;
const EVAL_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 20_000;
const MAX_STRING_CHARS = 2_000;
const MAX_ITEMS = 200;
const FRAMES_FALLBACK_MS = 250;
const MAX_REFUSED = 200;
const MAX_REFUSED_CHARS = 300;

/** A report of the browser about a request its content policy refused. */
interface PolicyReport {
  body?: { blockedURL?: unknown } | null;
}
interface PolicyObserver {
  observe(): void;
  takeRecords(): PolicyReport[];
  disconnect(): void;
}
type PolicyObserverClass = new (
  callback: () => void,
  options: { types: string[]; buffered: boolean },
) => PolicyObserver;

/**
 * What the browser refused in a window and the frames in it. It keeps its reports for an
 * observer that asks later (`buffered`), so a request made by the file's first script is
 * here too, and the file has no way to take one back.
 */
function refusedIn(view: Window, out: Set<string>): void {
  const Observer = (view as unknown as { ReportingObserver?: PolicyObserverClass })
    .ReportingObserver;
  if (Observer) {
    const observer = new Observer(() => undefined, { types: ['csp-violation'], buffered: true });
    observer.observe();
    for (const report of observer.takeRecords()) {
      const address = report.body?.blockedURL;
      // Inline code and `eval` are reported by a word, not by an address.
      if (typeof address === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
        out.add(address.slice(0, MAX_REFUSED_CHARS));
      }
    }
    observer.disconnect();
  }
  for (let i = 0; i < view.frames.length; i++) {
    try {
      const inner = view.frames[i];
      // A frame of another origin throws here; it has reports of its own nobody can read.
      if (inner?.document) refusedIn(inner, out);
    } catch {
      continue;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function twoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    setTimeout(resolve, FRAMES_FALLBACK_MS);
  });
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Math.round(value)));

/** `tag#id.class.class`, the way the outline and results name an element. */
function describe(el: Element): string {
  let name = el.localName;
  if (el.id) name += `#${el.id}`;
  const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean);
  if (classes.length > 0)
    name += `.${classes.slice(0, 4).join('.')}${classes.length > 4 ? '…' : ''}`;
  return name;
}

/**
 * What was thrown, as text. An error of the file's own page is not an `Error` of this page, so
 * it is read by its fields.
 */
function thrown(error: unknown): string {
  const failed = error as { name?: unknown; message?: unknown } | null;
  return typeof failed?.message === 'string' && failed.message
    ? `${typeof failed.name === 'string' ? failed.name : 'Error'}: ${failed.message}`
    : String(error);
}

/** The first element a selector matches, in the document or in an open shadow tree under it. */
function deepQuery(root: Document | ShadowRoot, selector: string): Element | null {
  const found = root.querySelector(selector);
  if (found) return found;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!el.shadowRoot) continue;
    const inside = deepQuery(el.shadowRoot, selector);
    if (inside) return inside;
  }
  return null;
}

/** A value from the page as JSON the agent can read: elements by name, long things cut. */
function toPlain(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}… (${value.length} characters)`
      : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '[function]';
  const object = value as Record<string, unknown> & { nodeType?: number };
  if (object.nodeType === 1) return `<${describe(value as Element)}>`;
  if (typeof object.nodeType === 'number') {
    return `[${(value as Node).nodeName}] ${((value as Node).textContent ?? '').slice(0, 80)}`;
  }
  if (seen.has(object)) return '[circular]';
  if (depth > 6) return '[…]';
  seen.add(object);
  const list =
    Array.isArray(value) ||
    (typeof object.length === 'number' && typeof object.item === 'function') ||
    Object.prototype.toString.call(value) === '[object Set]';
  if (list) {
    const items = Array.from(value as Iterable<unknown>);
    const plain = items.slice(0, MAX_ITEMS).map((item) => toPlain(item, depth + 1, seen));
    if (items.length > MAX_ITEMS) plain.push(`… ${items.length - MAX_ITEMS} more`);
    return plain;
  }
  // The kind by its tag: a value of the file's page is not an instance of this page's classes.
  const kind = Object.prototype.toString.call(value);
  if (kind === '[object Map]') {
    return toPlain(Object.fromEntries(value as Map<unknown, unknown>), depth, seen);
  }
  // An error the code caught and handed back reads as it would had it been thrown. Its name
  // and its message are not among the keys an object lists.
  if (kind === '[object Error]' || kind === '[object DOMException]') return thrown(value);
  // As JSON has it: a date is its text, an address its text, a rectangle its numbers.
  if (typeof object.toJSON === 'function') {
    let said: unknown;
    try {
      said = (object.toJSON as () => unknown)();
    } catch {
      said = undefined;
    }
    if (said !== null && said !== undefined && said !== value) {
      return toPlain(said, depth + 1, seen);
    }
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key in object) {
    if (count++ >= MAX_ITEMS) {
      out['…'] = 'more keys';
      break;
    }
    try {
      out[key] = toPlain(object[key], depth + 1, seen);
    } catch {
      out[key] = '[unreadable]';
    }
  }
  // An object with no key to list (a pattern, a number in a wrapper, a promise nobody awaited)
  // would read as `{}`, which tells the agent nothing: it is what it says of itself instead.
  if (count === 0) {
    try {
      const write = (object as { toString?: unknown }).toString;
      const said = typeof write === 'function' ? (write as () => unknown).call(value) : undefined;
      if (typeof said === 'string' && said !== '[object Object]') {
        return toPlain(said, depth + 1, seen);
      }
    } catch {
      // An object that cannot be written out is an empty one to JSON too.
    }
  }
  return out;
}

function resultText(value: unknown): string {
  if (value === undefined) return 'undefined';
  const text = JSON.stringify(toPlain(value, 0, new WeakSet())) ?? 'undefined';
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}… (cut: ${text.length} characters in all; return less)`
    : text;
}

/** An outline of a subtree, a line per element: what the agent finds its way by. */
function outline(root: Element, maxDepth: number, maxNodes: number): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (el: Element, depth: number) => {
    if (count >= maxNodes) return;
    count++;
    const view = el.ownerDocument.defaultView;
    const cs = view?.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const kids = composedChildren(el);
    const flags: string[] = [];
    if (cs?.display === 'none') flags.push('display:none');
    else if (cs?.visibility === 'hidden') flags.push('visibility:hidden');
    else if (cs && Number.parseFloat(cs.opacity) === 0) flags.push('opacity:0');
    if (el.shadowRoot) flags.push('shadow-root');
    if (cs?.position === 'fixed' || cs?.position === 'absolute') flags.push(cs.position);
    if (cs && cs.transform !== 'none') flags.push('transformed');
    if (cs?.overflowY === 'auto' || cs?.overflowY === 'scroll') flags.push('scrolls');
    if (el.localName === 'iframe') flags.push('frame');
    let own = '';
    for (const node of composedChildNodes(el)) if (node.nodeType === 3) own += node.nodeValue;
    own = own.replace(/\s+/g, ' ').trim();
    const indent = '  '.repeat(depth);
    lines.push(
      `${indent}${describe(el)} [${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}]` +
        (kids.length > 0 ? ` children:${kids.length}` : '') +
        (flags.length > 0 ? ` (${flags.join(', ')})` : '') +
        (own ? ` "${own.slice(0, 50)}${own.length > 50 ? '…' : ''}"` : ''),
    );
    if (depth >= maxDepth) {
      if (kids.length > 0) {
        lines.push(`${indent}  … ${el.querySelectorAll('*').length} descendants not shown`);
      }
      return;
    }
    // A long run of siblings is cut: the agent can ask for the subtree.
    kids.slice(0, 40).forEach((kid) => walk(kid, depth + 1));
    if (kids.length > 40) lines.push(`${indent}  … ${kids.length - 40} more siblings`);
  };
  walk(root, 0);
  if (count >= maxNodes) lines.push(`… outline cut at ${maxNodes} elements; ask for a subtree`);
  return lines.join('\n');
}

const RESOURCE_ATTRIBUTES: readonly (readonly [string, string])[] = [
  ['img', 'src'],
  ['script', 'src'],
  ['link[rel~="stylesheet"]', 'href'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['source', 'src'],
  ['iframe', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
];

/**
 * References to files beside the imported one. Only the file itself was taken, and the page
 * has no address to resolve them against, so they were never asked for: the list of refused
 * requests does not have them.
 */
function unreachableReferences(doc: Document): string[] {
  const found = new Set<string>();
  for (const [selector, attribute] of RESOURCE_ATTRIBUTES) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const value = el.getAttribute(attribute)?.trim();
      if (
        !value ||
        /^(data:|blob:|about:|javascript:|#|[a-z][a-z0-9+.-]*:\/\/|\/\/)/i.test(value)
      ) {
        continue;
      }
      found.add(value.slice(0, 200));
    }
  }
  return Array.from(found);
}

/** Facts about the page as it is now, for the agent. */
function pageFacts(doc: Document, viewport: ImportViewport): Record<string, unknown> {
  const view = doc.defaultView;
  const sheets: string[] = [];
  let rules = 0;
  let fontFaces = 0;
  let keyframes = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      rules += sheet.cssRules.length;
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.constructor.name === 'CSSFontFaceRule') fontFaces++;
        if (rule.constructor.name === 'CSSKeyframesRule') keyframes++;
      }
      sheets.push(
        `${sheet.href ? sheet.href.slice(0, 80) : '<style>'} (${sheet.cssRules.length} rules)`,
      );
    } catch {
      sheets.push(`${sheet.href ?? '<style>'} (not readable)`);
    }
  }
  const root = doc.documentElement;
  const rootStyle = view?.getComputedStyle(root);
  const variables: string[] = [];
  if (rootStyle) {
    for (const name of Array.from(rootStyle)) {
      if (name.startsWith('--')) {
        variables.push(`${name}: ${rootStyle.getPropertyValue(name).trim().slice(0, 60)}`);
      }
    }
  }
  const loaded = new Set<string>();
  for (const face of Array.from(doc.fonts)) {
    if (face.status === 'loaded') loaded.add(`${face.family} ${face.weight} ${face.style}`);
  }
  const body = doc.body as HTMLElement | null;
  const unreachable = unreachableReferences(doc);
  return {
    title: doc.title,
    lang: root.getAttribute('lang'),
    dir: body && view ? view.getComputedStyle(body).direction : null,
    viewport: `${viewport.width}x${viewport.height}`,
    scrollSize: `${root.scrollWidth}x${root.scrollHeight}`,
    scrolledTo: view ? `${Math.round(view.scrollX)},${Math.round(view.scrollY)}` : null,
    elements: doc.querySelectorAll('*').length,
    scripts: doc.scripts.length,
    frames: doc.querySelectorAll('iframe').length,
    canvases: doc.querySelectorAll('canvas').length,
    stylesheets: sheets.slice(0, 20),
    cssRules: rules,
    fontFaceRules: fontFaces,
    keyframesRules: keyframes,
    fontsLoaded: Array.from(loaded).slice(0, 30),
    rootCssVariables: variables.slice(0, 60),
    runningAnimations: doc.getAnimations().filter((a) => a.playState === 'running').length,
    ...(unreachable.length > 0
      ? { filesBesideTheSourceThatDidNotLoad: unreachable.slice(0, 40) }
      : {}),
  };
}

async function scaleDown(blob: Blob, maxWidth: number): Promise<ImportPicture> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  if (scale === 1) {
    bitmap.close();
    return { png: blob, width, height };
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas to scale a picture with.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { png: await canvas.convertToBlob({ type: 'image/png' }), width, height };
}

export function createImportPage(options: ImportPageOptions): ImportPage {
  let frame: HTMLIFrameElement | null = null;
  let url: string | null = null;
  let viewport: ImportViewport = { ...DEFAULT_VIEWPORT };
  /** Every asset stored in this session, by id: later slides are drawn with them too. */
  const assets = new Map<string, AssetMeta>();
  const host: ConversionHost = {
    ...options.host,
    async storeAsset(bytes, info) {
      const asset = await options.host.storeAsset(bytes, info);
      if (!assets.has(asset.id)) assets.set(asset.id, asset);
      return assets.get(asset.id) ?? asset;
    },
  };
  const fonts = createSourceFonts({
    storeAsset: (bytes, info) => options.host.storeAsset(bytes, info),
    stored: (asset) => assets.set(asset.id, asset),
    ...(options.appFonts ? { appFonts: options.appFonts } : {}),
  });

  const page = (): { doc: Document; view: Window & typeof globalThis } => {
    const doc = frame?.contentDocument;
    const view = frame?.contentWindow as (Window & typeof globalThis) | null | undefined;
    if (!doc || !view) throw new Error('The page of the imported file is not available.');
    return { doc, view };
  };

  /** Waits until the page has stopped changing: a file may build itself after it loads. */
  async function quiet(limit = QUIET_LIMIT_MS): Promise<void> {
    const started = performance.now();
    let last = '';
    let since = performance.now();
    while (performance.now() - started < limit) {
      const doc = frame?.contentDocument;
      const signature = doc
        ? `${doc.readyState}:${doc.getElementsByTagName('*').length}:${doc.title}`
        : 'none';
      const now = performance.now();
      if (signature !== last) {
        last = signature;
        since = now;
      } else if (doc?.readyState === 'complete' && now - since >= QUIET_MS) break;
      await sleep(100);
    }
    const doc = frame?.contentDocument;
    if (!doc) return;
    await fonts.sync(doc).catch(() => undefined);
    await Promise.race([settle(doc), sleep(5_000)]);
  }

  async function load(): Promise<void> {
    frame?.remove();
    if (url) URL.revokeObjectURL(url);
    const bytes = await options.source();
    // No charset is given: the browser works the encoding out as it does for a file on disk.
    url = URL.createObjectURL(new Blob([bytes], { type: 'text/html' }));
    const made = document.createElement('iframe');
    made.setAttribute('data-slidr-import', '');
    // White behind the document, as a browser window has: a file that sets no background of
    // its own is seen on white.
    made.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;border:0;margin:0;background:#fff;color-scheme:light`;
    const loaded = new Promise<void>((resolve) => {
      made.addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
    made.src = url;
    (options.parent ?? document.body).append(made);
    frame = made;
    await loaded;
    await quiet();
  }

  async function ready(): Promise<void> {
    if (!frame) await load();
  }

  function resolve(target: ImportTarget, required: boolean): Element | undefined {
    const { doc, view } = page();
    if (target.js) {
      let value: unknown;
      try {
        let find: () => unknown;
        try {
          find = new view.Function(`return (${target.js}\n);`) as () => unknown;
        } catch {
          // Not one expression: taken as the body of a function that returns the element.
          find = new view.Function(target.js) as () => unknown;
        }
        value = find();
      } catch (error) {
        throw new Error(
          `"js" failed: ${thrown(error)}. It is one expression for the element, or statements that return it; what changes the page belongs in \`before\`.`,
          { cause: error },
        );
      }
      if (!value || (value as { nodeType?: number }).nodeType !== 1) {
        throw new Error('"js" did not evaluate to an Element.');
      }
      return value as Element;
    }
    if (target.selector) {
      let found: Element | null;
      try {
        found = deepQuery(doc, target.selector);
      } catch {
        throw new Error(`"${target.selector}" is not a valid selector.`);
      }
      if (!found) throw new Error(`No element matches the selector "${target.selector}".`);
      return found;
    }
    if (required) throw new Error('Give `selector` or `js` for the element.');
    return undefined;
  }

  async function run(code: string): Promise<unknown> {
    const { view } = page();
    let work: Promise<unknown>;
    try {
      const body = new view.Function(`return (async () => {\n${code}\n})();`);
      work = (body as () => Promise<unknown>)();
    } catch (error) {
      throw new Error(`The code does not parse: ${thrown(error)}`, { cause: error });
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`The code did not finish within ${EVAL_TIMEOUT_MS / 1000} s.`)),
        EVAL_TIMEOUT_MS,
      ),
    );
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      throw new Error(thrown(error), { cause: error });
    }
  }

  /** Where an element is on the page the pictures are taken of. */
  function onPage(el: Element): DOMRect {
    const r = el.getBoundingClientRect();
    const offset = viewportOffset(el.ownerDocument);
    return new DOMRect(r.left + offset.x, r.top + offset.y, r.width, r.height);
  }

  const inViewport = (r: DOMRect) =>
    r.left >= -0.5 &&
    r.top >= -0.5 &&
    r.right <= viewport.width + 0.5 &&
    r.bottom <= viewport.height + 0.5;

  return {
    load,

    async inspect(request) {
      await ready();
      const { doc } = page();
      const root = resolve(request, false) ?? doc.body ?? doc.documentElement;
      const facts =
        request.selector || request.js
          ? ''
          : `${JSON.stringify(pageFacts(doc, viewport), null, 1)}\n\n`;
      return `${facts}${outline(root, request.depth ?? 4, request.maxNodes ?? 160)}`;
    },

    async evaluate(code) {
      await ready();
      return resultText(await run(code));
    },

    async screenshot(request) {
      await ready();
      await twoFrames();
      const target = resolve(request, false);
      let rect = new DOMRect(0, 0, viewport.width, viewport.height);
      if (target) {
        if (!inViewport(onPage(target))) {
          target.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' });
          await twoFrames();
        }
        // What lies outside the viewport is not drawn: the picture is of what is in it.
        const r = onPage(target);
        const left = Math.max(0, r.left);
        const top = Math.max(0, r.top);
        const right = Math.min(viewport.width, r.right);
        const bottom = Math.min(viewport.height, r.bottom);
        if (right - left < 1 || bottom - top < 1) {
          throw new Error(
            `The element is not in view: it is ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)} (hidden, or not laid out).`,
          );
        }
        rect = new DOMRect(left, top, right - left, bottom - top);
      }
      const clip = {
        x: Math.floor(rect.x),
        y: Math.floor(rect.y),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      };
      return scaleDown(
        await options.host.capture(clip),
        clamp(request.maxWidth ?? 1024, 160, 1920),
      );
    },

    async setViewport(size) {
      viewport = {
        width: clamp(size.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width),
        height: clamp(size.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height),
      };
      if (!frame) await load();
      else {
        frame.style.width = `${viewport.width}px`;
        frame.style.height = `${viewport.height}px`;
        await twoFrames();
        await quiet(2_000);
      }
      const root = page().doc.documentElement;
      return `viewport ${viewport.width}x${viewport.height}; the page is ${root.scrollWidth}x${root.scrollHeight}`;
    },

    async capture(request) {
      await ready();
      // Watched from before the slide is brought into view: how it comes in is part of it.
      const recorder = recordMotion(page().doc);
      try {
        if (request.before) {
          await run(request.before);
        }
        await sleep(Math.min(5_000, Math.max(0, request.waitMs ?? 250)));
        return await captureRoot(request, recorder);
      } finally {
        recorder.stop();
        const doc = frame?.contentDocument;
        if (doc) clearMarks(doc);
      }
    },

    refused() {
      if (!frame) return [];
      // The page that holds the frame is asked too: the file can reach it, and a request it
      // makes from there is reported there. Its frames, the file's among them, come with it.
      const holder = frame.ownerDocument.defaultView;
      const found = new Set<string>();
      try {
        if (holder) refusedIn(holder, found);
      } catch {
        // A page in the middle of loading has no window to ask yet.
      }
      return Array.from(found).slice(0, MAX_REFUSED);
    },

    dispose() {
      frame?.remove();
      frame = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };

  /** The capture itself, once the slide is in view: `recorder` has watched it come in. */
  async function captureRoot(
    request: ImportCaptureRequest,
    recorder: MotionRecorder,
  ): Promise<ImportCapture> {
    {
      const root = resolve(request, true)!;
      const doc = root.ownerDocument;
      // Every motion is brought to its end here; what it did is kept for the slide.
      const laidOutW = (root as HTMLElement).offsetWidth || root.getBoundingClientRect().width;
      const laidOutH = (root as HTMLElement).offsetHeight || root.getBoundingClientRect().height;
      const k =
        laidOutW > 0 && laidOutH > 0
          ? Math.min(request.deck.size.w / laidOutW, request.deck.size.h / laidOutH)
          : 1;
      const view = doc.defaultView;
      const dir = view?.getComputedStyle(root).direction === 'rtl' ? 'rtl' : 'ltr';
      const motion = recorder.take(root, { k, dir });
      await Promise.race([settle(doc), sleep(5_000)]);

      let at = onPage(root);
      if (at.width < 1 || at.height < 1) {
        throw new Error(
          `The element has no size (${Math.round(at.width)}x${Math.round(at.height)}): it is hidden or not laid out. Bring the slide into view in \`before\`.`,
        );
      }
      // An element can have a size and still not be painted: the picture of the source would be
      // of an empty slide, and no conversion could look like it.
      const hider = notPainted(root);
      if (hider) {
        throw new Error(
          `The element is not shown: ${nameOf(hider.element)} has \`${hider.why}\`. Bring the slide into view in \`before\`, the way the deck itself shows it.`,
        );
      }
      if (!inViewport(at)) {
        root.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' });
        await twoFrames();
        at = onPage(root);
      }
      if (!inViewport(at)) {
        throw new Error(
          `The element is ${Math.round(at.width)}x${Math.round(at.height)} CSS px at ${Math.round(at.left)},${Math.round(at.top)}, and the page's viewport is ${viewport.width}x${viewport.height}: part of it lies outside the viewport and cannot be pictured. Set a viewport that holds it, or capture a smaller element.`,
        );
      }

      const over = drawnOver(root);
      if (over.length > 0) {
        const named = over.slice(0, 6).map(nameOf).join('; ');
        const more = over.length > 6 ? `; and ${over.length - 6} more` : '';
        throw new Error(
          `Drawn over the element without being part of it: ${named}${more}. A capture would not look like the page. If this is player chrome (a counter, arrows, a progress bar), hide it in \`before\`; if it belongs to the slide, capture an element that contains it.`,
        );
      }

      const laidOut = (root as HTMLElement).offsetWidth ?? 0;
      const notes = await fonts.sync(page().doc);
      await doc.fonts.ready;
      const faces = fonts.css();
      // What moved is marked on the page for the conversion, and taken off again after it.
      const unmark = markMotion(root, motion);
      let result: Awaited<ReturnType<typeof convertSubtree>>;
      try {
        result = await convertSubtree(root, {
          deck: { ...request.deck, slides: [], assets: Object.fromEntries(assets) },
          host,
          foreign: true,
          behind: 'page',
          takenIds: new Set(request.takenIds),
          fontFaces: false,
          ...(faces ? { css: faces } : {}),
        });
      } finally {
        unmark();
      }
      const slide = motion.transition
        ? { ...result.slide, transition: motion.transition }
        : result.slide;
      const written = JSON.stringify(slide);
      const { faithful, exact, rounds, wholeSlide, diffPixels } = result.guard;
      return {
        slide,
        assets: Array.from(assets.values()).filter(
          (asset) => asset.kind === 'font' || written.includes(asset.id),
        ),
        editability: result.editability,
        textEditability: result.textEditability,
        notes: [...notes, ...result.notes],
        guard: { faithful, exact, rounds, wholeSlide, diffPixels },
        source: {
          width: at.width,
          height: at.height,
          scale: laidOut > 0 ? Math.round((at.width / laidOut) * 10000) / 10000 : 1,
        },
        ms: result.ms,
      };
    }
  }
}
