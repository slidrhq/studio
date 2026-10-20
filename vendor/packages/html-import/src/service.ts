/**
 * The conversion service of the Deck API (`ConversionService`, ADR-011): `slide_create_from_html`,
 * `slide_replace_from_html` and `element_convert` call it. Each call loads HTML in the sandbox
 * and hands the loaded root to the same engine HTML import will hand a captured subtree to.
 */
import type {
  ConversionDifference,
  ConversionService,
  ElementConversion,
  HtmlSlideConversion,
} from '@slidr/agent-tools';
import {
  allElementIds,
  createElement,
  createSlide,
  findSlide,
  frameCenter,
  locateElement,
  newId,
  rotateVector,
  type AssetMeta,
  type Deck,
  type Element as ModelElement,
  type HtmlElement,
  type Slide,
} from '@slidr/model';
import { renderSlideOffscreen } from '@slidr/renderer';
import {
  convertSubtree,
  mountSlide,
  startConversion,
  type ConversionResult,
  type ConvertOptions,
  type Verdict,
} from './engine';
import type { ConversionHost } from './host';
import { hasScripts, openSandbox } from './sandbox';

/** A URL scheme that names an asset by id while markup is being written out. */
const ASSET_SCHEME = 'slidr-asset:';

export interface LoadedHtml {
  /** The root of the sandbox document: what is converted. */
  root: Element;
  /** What the agent should know about how the HTML was loaded. */
  notes: string[];
  dispose(): void;
}

/**
 * Loads HTML in the sandbox, over a picture of the slide it is for. The work surface is a
 * layer at the top-left corner of the page: the pictures the guard compares are taken there.
 */
export async function loadHtml(
  html: string,
  deck: Deck,
  host: ConversionHost,
  size: { w: number; h: number },
  options: Pick<ConvertOptions, 'placement' | 'base'> = {},
): Promise<LoadedHtml> {
  const surface = document.createElement('div');
  surface.style.cssText = `position:fixed;left:0;top:0;width:${size.w}px;height:${size.h}px;overflow:hidden;z-index:2147483646;isolation:isolate;background:#fff;pointer-events:none`;
  document.body.append(surface);
  try {
    const under = await mountSlide(
      deck,
      createSlide({ id: newId('s'), ...options.base }),
      host,
      {
        origin: { x: 0, y: 0 },
        viewScale: 1,
        k: options.placement?.k ?? 1,
        offX: options.placement?.x ?? 0,
        offY: options.placement?.y ?? 0,
      },
      { parent: surface, zIndex: 0 },
    );
    under.likeSource();
    const sandbox = await openSandbox(html, { deck, host, size, parent: surface });
    sandbox.frame.style.zIndex = '1';
    return {
      root: sandbox.document.documentElement,
      notes: sandbox.notes,
      dispose() {
        sandbox.dispose();
        under.dispose();
        surface.remove();
      },
    };
  } catch (error) {
    surface.remove();
    throw error;
  }
}

/** Loads HTML in the sandbox and converts what it shows. */
export async function convertHtml(
  html: string,
  deck: Deck,
  host: ConversionHost,
  size: { w: number; h: number },
  options: Pick<ConvertOptions, 'placement' | 'base' | 'compose'> = {},
): Promise<ConversionResult & { loadNotes: string[] }> {
  const loaded = await loadHtml(html, deck, host, size, options);
  try {
    const result = await convertSubtree(loaded.root, {
      deck,
      host,
      foreign: false,
      behind: 'slide',
      ...options,
    });
    return { ...result, loadNotes: loaded.notes };
  } finally {
    loaded.dispose();
  }
}

/**
 * Loads HTML and converts what it shows without the guard's way back: everything the measuring
 * pass mapped stays a regular element, and what then looks different is told, not replaced
 * (HTM-05). Text boxes are still moved to where their lines belong, as in a guarded conversion.
 */
async function convertHtmlForced(
  html: string,
  deck: Deck,
  host: ConversionHost,
  size: { w: number; h: number },
  options: Pick<ConvertOptions, 'placement' | 'base'>,
): Promise<ConversionResult & { loadNotes: string[]; verdict: Verdict }> {
  const loaded = await loadHtml(html, deck, host, size, options);
  try {
    const conversion = await startConversion(loaded.root, {
      deck,
      host,
      foreign: false,
      behind: 'slide',
      lossy: true,
      ...options,
    });
    try {
      const verdict = await conversion.judge();
      const result = conversion.result({
        faithful: verdict.faithful,
        rounds: 1,
        diffPixels: verdict.diffPixels,
        exact: !conversion.proposal.items.some((item) => item.scaled),
        fallbacks: [],
        wholeSlide: false,
      });
      return { ...result, loadNotes: loaded.notes, verdict };
    } finally {
      conversion.dispose();
    }
  } finally {
    loaded.dispose();
  }
}

/** Variables the HTML uses in the theme's namespaces that nothing defines. */
function unknownVariables(html: string): string[] {
  const used = new Set(
    Array.from(html.matchAll(/var\(\s*(--(?:color|font)-[\w-]+)/g), (m) => m[1]!),
  );
  const known =
    /^--(color-(bg|surface|text|muted|primary|secondary|accent|chart-\d+)|font-(heading|body))$/;
  return Array.from(used).filter(
    (name) => !known.test(name) && !new RegExp(`${name}\\s*:`).test(html),
  );
}

async function htmlToSlide(
  host: ConversionHost,
  deck: Deck,
  request: { html: string; name?: string },
): Promise<HtmlSlideConversion> {
  const name = request.name ? { name: request.name } : {};
  if (hasScripts(request.html)) {
    // Scripts cannot run where the HTML is measured, so what they draw cannot be measured:
    // the slide is the HTML itself, in the renderer's sandboxed frame (RND-06).
    const parsed = new DOMParser().parseFromString(request.html, 'text/html');
    const styles = Array.from(parsed.head.querySelectorAll('style'), (s) => s.outerHTML).join('');
    const element = createElement.html({
      frame: { x: 0, y: 0, w: deck.size.w, h: deck.size.h },
      markup: styles + parsed.body.innerHTML,
      hasScripts: true,
      natural: { ...deck.size },
    });
    return {
      slide: createSlide({ ...name, elements: [element] }),
      assets: [],
      editability: 0,
      notes: [
        'The HTML has scripts, so it was kept whole as one html element that runs in a sandboxed frame. It was not converted and not compared with a render; write a slide without scripts to get editable elements.',
      ],
    };
  }
  const result = await convertHtml(request.html, deck, host, deck.size, {});
  const notes = [...result.loadNotes, ...result.notes];
  for (const variable of unknownVariables(request.html)) {
    notes.push(`var(${variable}) is not a theme variable and is not defined in the HTML.`);
  }
  return {
    slide: { ...result.slide, ...name },
    assets: result.assets,
    editability: Math.round(result.editability * 1000) / 1000,
    notes,
  };
}

/** An `html` element taken apart into regular elements, in the element's place. */
async function htmlToElements(
  host: ConversionHost,
  deck: Deck,
  slide: Slide,
  element: HtmlElement,
  force = false,
): Promise<ElementConversion> {
  if (element.hasScripts) {
    throw new Error(
      `Element "${element.id}" runs scripts, and what scripts draw cannot be measured; it stays html.`,
    );
  }
  if (element.flipH || element.flipV) {
    throw new Error(`Element "${element.id}" is mirrored; un-mirror it before converting.`);
  }
  const natural = element.natural ?? { w: element.frame.w, h: element.frame.h };
  const kx = element.frame.w / natural.w;
  const ky = element.frame.h / natural.h;
  if (Math.abs(kx - ky) > 1e-3 * kx) {
    throw new Error(
      `Element "${element.id}" is stretched unevenly (${kx.toFixed(3)} by ${ky.toFixed(3)}); text cannot follow that. Make its frame ${natural.w}:${natural.h} first.`,
    );
  }
  // Asked for outright, the conversion goes through what `data-keep-html` held back.
  const parsed = new DOMParser().parseFromString(element.markup, 'text/html');
  for (const kept of Array.from(parsed.querySelectorAll('[data-keep-html]'))) {
    kept.removeAttribute('data-keep-html');
  }
  const styles = element.styles
    ? `<style>${element.styles.replace(/<\/style/gi, '<\\/style')}</style>`
    : '';
  const html = `${styles}${parsed.body.innerHTML}`;
  const options = {
    placement: { k: kx, x: element.frame.x, y: element.frame.y },
    base: {
      ...(slide.background ? { background: slide.background } : {}),
      ...(slide.layoutId ? { layoutId: slide.layoutId } : {}),
    },
  };
  const forced = force ? await convertHtmlForced(html, deck, host, natural, options) : undefined;
  const result = forced ?? (await convertHtml(html, deck, host, natural, options));
  const notes = [...result.loadNotes, ...result.notes];
  const centre = frameCenter(element.frame);
  // What the forced conversion left looking different: by element, and the areas no element owns.
  const differences: ConversionDifference[] | undefined = forced && [
    ...forced.verdict.bad.map(({ item, why }): ConversionDifference => ({
      elementId: item.element.id,
      kind: why.startsWith('looks different') ? 'look' : 'text',
      detail: why,
    })),
    ...forced.verdict.loose.map(({ box, pixels }): ConversionDifference => ({
      kind: 'region',
      // From CSS pixels of the HTML's own document to slide pixels, as the parts were placed.
      frame: {
        x: Math.round(element.frame.x + box.x * kx),
        y: Math.round(element.frame.y + box.y * kx),
        w: Math.round(box.w * kx),
        h: Math.round(box.h * kx),
      },
      detail: `a difference no element explains (${pixels} pixels)`,
    })),
  ];
  const elements = result.slide.elements.map((made): ModelElement => {
    const out: ModelElement = {
      ...made,
      opacity: Math.round(made.opacity * element.opacity * 1000) / 1000,
    };
    if (element.rotation) {
      // The parts turn with the element: around its centre, and each around its own.
      const own = frameCenter(made.frame);
      const moved = rotateVector({ x: own.x - centre.x, y: own.y - centre.y }, element.rotation);
      out.frame = {
        ...made.frame,
        x: Math.round((centre.x + moved.x - made.frame.w / 2) * 100) / 100,
        y: Math.round((centre.y + moved.y - made.frame.h / 2) * 100) / 100,
      };
      out.rotation = made.rotation + element.rotation;
    }
    if (element.link) out.link = element.link;
    if (element.locked) out.locked = true;
    if (element.hidden) out.hidden = true;
    return out;
  });
  if (elements.length === 1 && element.name && !elements[0]!.name) elements[0]!.name = element.name;
  if (element.effects || element.css) {
    notes.push(
      'The effects and css of the html element itself were not carried over to its parts.',
    );
  }
  return {
    elements,
    assets: result.assets,
    editability: Math.round(result.editability * 1000) / 1000,
    notes,
    ...(differences ? { differences } : {}),
  };
}

/**
 * A regular element as one `html` element in the same place: the DOM the renderer draws for
 * it, written out. The box fields (frame, rotation, opacity, effects, `css`) stay fields.
 */
async function elementToHtml(
  host: ConversionHost,
  deck: Deck,
  element: ModelElement,
): Promise<ElementConversion> {
  if (element.type === 'html') throw new Error(`Element "${element.id}" is already html.`);
  if (element.type === 'chart' || element.type === 'video' || element.type === 'audio') {
    throw new Error(
      `A ${element.type} draws itself while it plays or loads; it cannot be written out as html.`,
    );
  }
  const { frame, rotation, opacity, flipH, flipV, effects, css, link, locked, hidden, name, role } =
    element;
  // Drawn alone, unrotated and opaque: those stay on the element, not in its markup.
  const bare = {
    ...element,
    frame: { ...frame, x: 0, y: 0 },
    rotation: 0,
    opacity: 1,
  } as ModelElement;
  delete bare.flipH;
  delete bare.flipV;
  delete bare.effects;
  delete bare.css;
  delete bare.hidden;
  const offscreen = await renderSlideOffscreen({
    deck,
    slide: createSlide({ id: newId('s'), elements: [bare] }),
    mode: 'thumbnail',
    // The markup names assets by id; the renderer resolves `data-asset` when it draws it.
    resolveAsset: (asset: AssetMeta) => `${ASSET_SCHEME}${asset.id}`,
  });
  let markup: string;
  try {
    const dom = offscreen.root.querySelector(`[data-element-id="${element.id}"]`);
    if (!dom) throw new Error(`Element "${element.id}" did not render.`);
    if (dom.querySelector('[data-slidr-html]')) {
      throw new Error('The element contains an html element; convert the parts separately.');
    }
    const copy = dom.cloneNode(true) as HTMLElement;
    for (const node of Array.from(copy.querySelectorAll('*'))) {
      const src = node.getAttribute('src');
      if (src?.startsWith(ASSET_SCHEME)) {
        node.setAttribute('data-asset', src.slice(ASSET_SCHEME.length));
        node.removeAttribute('src');
      }
      const styled = node as HTMLElement;
      const background = styled.style?.backgroundImage ?? '';
      const match = new RegExp(`url\\(["']?${ASSET_SCHEME}([^"')]+)["']?\\)`).exec(background);
      if (match) {
        node.setAttribute('data-asset', match[1]!);
        styled.style.removeProperty('background-image');
      }
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith('data-element-') || attr.name === 'data-name')
          node.removeAttribute(attr.name);
      }
    }
    markup = `<div style="position:relative;width:${frame.w}px;height:${frame.h}px">${copy.innerHTML}</div>`;
  } finally {
    offscreen.dispose();
  }
  const html = createElement.html({
    frame,
    rotation,
    opacity,
    markup,
    natural: { w: frame.w, h: frame.h },
    ...(flipH ? { flipH } : {}),
    ...(flipV ? { flipV } : {}),
    ...(effects ? { effects } : {}),
    ...(css ? { css } : {}),
    ...(link ? { link } : {}),
    ...(locked ? { locked } : {}),
    ...(hidden ? { hidden } : {}),
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
  });
  // Inside groups too: a card of a converted slide is a group, and its parts have ids.
  const taken = allElementIds(deck);
  html.id = newId('e', (candidate) => taken.has(candidate));
  return { elements: [html], assets: [], editability: 0, notes: [] };
}

/**
 * The conversion service over a host (ADR-017). Conversions use one region of the page to
 * take their pictures, so they run one at a time, in the order they were asked for.
 */
export function createConversionService(host: ConversionHost): ConversionService {
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const run = last.then(work, work);
    last = run.catch(() => undefined);
    return run;
  };
  return {
    htmlToSlide: (deck, request) => inTurn(() => htmlToSlide(host, deck, request)),
    convertElement: (deck, request) =>
      inTurn(() => {
        const slide = findSlide(deck, request.slideId);
        const element = slide
          ? locateElement(slide.elements, request.elementId)?.element
          : undefined;
        if (!slide || !element) {
          throw new Error(`Element "${request.elementId}" is not on slide "${request.slideId}".`);
        }
        if (request.to === 'html') return elementToHtml(host, deck, element);
        if (element.type !== 'html') {
          throw new Error(
            `Element "${element.id}" is a ${element.type}, not html; only html converts to elements.`,
          );
        }
        return htmlToElements(host, deck, slide, element, request.force);
      }),
  };
}
