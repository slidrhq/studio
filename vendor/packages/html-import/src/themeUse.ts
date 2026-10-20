/**
 * Which colours of a rendered document really come from the theme (SPEC 11.5). A computed
 * colour says what it is, not where it came from: white text is `rgb(255, 255, 255)` whether
 * the HTML wrote `var(--color-bg)` or `#fff`, and only the first should follow a template
 * change. So the theme's variables are set to colours nothing else uses, for a moment, and
 * what changes with them is what uses them.
 */
import type { ColorToken } from '@slidr/model';
import { parseColor } from './css';
import { styleOf } from './measure';
import { TOKEN_ORDER } from './tokens';

export interface ThemeUse {
  /** Whether a computed property of an element (or of one of its pseudo-elements) takes the token. */
  uses(node: Element, property: string, token: ColorToken, pseudo?: string): boolean;
}

/** Properties that can hold a colour of the model: fills, outlines, shadows, text, SVG paints. */
const PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'box-shadow',
  'fill',
  'stroke',
];
const PSEUDOS = ['::before', '::after', '::marker'];
const PSEUDO_PROPERTIES = ['color', 'background-color'];

/** Colours a page is not going to use by accident, one per token. */
const marker = (index: number) => ({ r: 251 - index, g: 3 + index, b: 119 + 2 * index });

const COLOR = /rgba?\([^)]*\)|color\(srgb[^)]*\)/g;

/**
 * Reads the use of the theme's colour variables under `root`. The variables are those the
 * renderer puts on a slide root (`--color-<token>`); the document's root element carries them.
 * Transitions must be off in the document, or the colours read would be on their way.
 */
export function readThemeUse(root: Element): ThemeUse {
  const doc = root.ownerDocument;
  const holder = doc.documentElement;
  const before = TOKEN_ORDER.map((token) => holder.style.getPropertyValue(`--color-${token}`));
  TOKEN_ORDER.forEach((token, i) => {
    const m = marker(i);
    holder.style.setProperty(`--color-${token}`, `rgb(${m.r}, ${m.g}, ${m.b})`);
  });
  const seen = new Map<Element, Record<string, string>>();
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const values: Record<string, string> = {};
    const cs = styleOf(el);
    for (const property of PROPERTIES) values[property] = cs.getPropertyValue(property);
    for (const pseudo of PSEUDOS) {
      const ps = styleOf(el, pseudo);
      for (const property of PSEUDO_PROPERTIES)
        values[pseudo + property] = ps.getPropertyValue(property);
    }
    seen.set(el, values);
  }
  TOKEN_ORDER.forEach((token, i) => {
    if (before[i]) holder.style.setProperty(`--color-${token}`, before[i]);
    else holder.style.removeProperty(`--color-${token}`);
  });
  if (holder.getAttribute('style') === '') holder.removeAttribute('style');

  return {
    uses(node, property, token, pseudo = '') {
      const value = seen.get(node)?.[pseudo + property];
      if (!value) return false;
      const m = marker(TOKEN_ORDER.indexOf(token));
      for (const match of value.matchAll(COLOR)) {
        const c = parseColor(match[0]);
        if (c && Math.abs(c.r - m.r) < 1 && Math.abs(c.g - m.g) < 1 && Math.abs(c.b - m.b) < 1) {
          return true;
        }
      }
      return false;
    },
  };
}
