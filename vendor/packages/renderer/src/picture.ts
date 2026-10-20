import { animatesLink } from './sanitize';

/**
 * What an `svg` element may hold: a picture, and nothing but one (SEC-06, ADR-057 decision 7).
 * A picture draws. It does not run, it does not show a document of another kind, it does not
 * link anywhere, and it names nothing outside itself: a reference stays inside the markup (a
 * fragment, `#id`) or carries its picture with it (a raster image as `data:`).
 *
 * The same rules hold wherever such markup comes from. An SVG file is cleaned by them when it is
 * imported (`apps/desktop/src/objects/svgImport.ts`), and every `svg` element is cleaned by them
 * again when it is drawn (`prepareSvg`): the markup of an element is also written by the agent,
 * and arrives as it is in a deck somebody else made. Since an exported file is written from
 * what was drawn, a file never holds an address a picture brought with it.
 */

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Elements of SVG that draw nothing of a picture: code, other documents, media. */
const NOT_DRAWN = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'handler',
  'listener',
]);

/** The elements whose reference may be a picture carried as data. */
const HOLDS_IMAGE = new Set(['image', 'feimage']);

const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i;

/** A fragment of the same markup. */
const isFragment = (target: string): boolean => target.trim().startsWith('#');

/** A reference that stays inside the markup: a fragment, or a raster picture carried as data. */
export function isLocalReference(target: string): boolean {
  return isFragment(target) || RASTER_DATA.test(target.trim());
}

/**
 * CSS as a browser reads its names: escapes resolved (`\75rl(` is `url(`), in lower case.
 * Comments and strings are left in: a name found inside one is taken for the real thing, which
 * errs on the side of dropping.
 */
function readAsCss(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([\s\S])/gi, (_all, hex?: string, char?: string) => {
      if (hex === undefined) return char === '\n' ? '' : (char ?? '');
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .toLowerCase();
}

/** CSS functions that take an address in a form this file does not read: dropped as they are. */
const OTHER_FETCHES = /(?:image-set|image|cross-fade|src)\(/;

/**
 * Whether a CSS value, a whole declaration list or a whole stylesheet names anything outside
 * the markup it is in: a `url()` that is not local, an `@import`, or one of the functions that
 * take an address as a plain string.
 */
export function reachesOutside(css: string): boolean {
  const text = readAsCss(css);
  if (OTHER_FETCHES.test(text) || text.includes('@import')) return true;
  for (let at = text.indexOf('url('); at !== -1; at = text.indexOf('url(', at + 4)) {
    const rest = text.slice(at + 4).trimStart();
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : undefined;
    // Only the start of the address decides, so where exactly it ends does not matter.
    const target = quote ? rest.slice(1) : rest;
    if (!isLocalReference(target)) return true;
  }
  return false;
}

/**
 * A stylesheet of a picture without what reaches outside it, written out again from the rules
 * the browser itself read (which is also where an `@import` goes: a sheet made this way takes
 * none). Empty when nothing of it can be kept.
 */
export function pictureCss(css: string): string {
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    // No way to read it as a browser does: kept only if nothing in its text looks outside.
    return reachesOutside(css) ? '' : css;
  }
  const clean = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const { style, cssRules } = rule as Partial<CSSStyleRule>;
      if (style) {
        for (const property of Array.from(style)) {
          if (reachesOutside(style.getPropertyValue(property))) style.removeProperty(property);
        }
      }
      if (cssRules) clean(cssRules);
    }
  };
  clean(sheet.cssRules);
  // A rule that still names an address (in a descriptor the list of its declarations does not
  // show) goes whole.
  return Array.from(sheet.cssRules, (rule) => rule.cssText)
    .filter((text) => !reachesOutside(text))
    .join('\n');
}

function cleanInlineStyle(el: Element): void {
  const style = (el as Partial<SVGElement>).style;
  if (style) {
    for (const property of Array.from(style)) {
      if (reachesOutside(style.getPropertyValue(property))) style.removeProperty(property);
    }
  }
  // What the attribute still says after that, read as text: nothing of it may look outside.
  if (reachesOutside(el.getAttribute('style') ?? '')) el.removeAttribute('style');
}

function cleanAttributes(el: Element): void {
  const tag = el.localName.toLowerCase();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const local = attr.localName.toLowerCase();
    // `xml:base` moves every relative address under it somewhere else.
    if (name.startsWith('on') || name === 'xml:base') el.removeAttributeNode(attr);
    else if (local === 'href' || local === 'src') {
      const inside = HOLDS_IMAGE.has(tag) ? isLocalReference(attr.value) : isFragment(attr.value);
      if (!inside) el.removeAttributeNode(attr);
    } else if (name === 'style') cleanInlineStyle(el);
    // Every other attribute may be CSS (`fill`, `mask`, `clip-path`, `cursor`, the values of an
    // animation), and none has a use for an address outside.
    else if (reachesOutside(attr.value)) el.removeAttributeNode(attr);
  }
}

/**
 * Cleans the tree of a picture in place, from its `<svg>` root down. What is left is SVG that
 * draws: no element of another kind of markup, nothing that runs or embeds, no link, no
 * reference to anything outside the tree, in an attribute or in a stylesheet.
 */
export function cleanPicture(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    // Gone with an element above it.
    if (el !== root && !root.contains(el)) continue;
    const tag = el.localName.toLowerCase();
    if (el !== root) {
      if (el.namespaceURI !== SVG_NAMESPACE || NOT_DRAWN.has(tag) || animatesLink(el)) {
        el.remove();
        continue;
      }
      // A link in a picture would take the window it is shown in elsewhere. What it holds stays.
      if (tag === 'a') {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      if (tag === 'style') {
        const css = pictureCss(el.textContent ?? '');
        if (!css) {
          el.remove();
          continue;
        }
        el.textContent = css;
      }
    }
    cleanAttributes(el);
  }
}
