import type { CSSProperties } from 'react';

/** `clip-path` -> `clipPath`, `-webkit-text-stroke` -> `WebkitTextStroke`; custom properties stay. */
export function cssPropertyName(name: string): string {
  if (name.startsWith('--')) return name;
  // React spells the Microsoft prefix in lower case: msTransform, not MsTransform.
  const bare = name.startsWith('-ms-') ? name.slice(1) : name;
  return bare.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The `css` field of an element as a React style (SPEC 5.9, RND-07). `!important` is dropped:
 * an inline style cannot carry it, and it already wins over every stylesheet rule without it.
 */
export function passthroughStyle(css: Record<string, string> | undefined): CSSProperties {
  if (!css) return {};
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(css)) {
    style[cssPropertyName(name.trim())] = value.replace(/\s*!important\s*$/i, '');
  }
  return style;
}

/**
 * At-rules that give a name to something for the whole document (an animation, a font family, a
 * registered property): they cannot be scoped to a slide, and a slide needs them. By the name of
 * the rule's interface, which is the same in every engine.
 */
const NAMING_RULES = new Set([
  'CSSKeyframesRule',
  'CSSFontFaceRule',
  'CSSPropertyRule',
  'CSSCounterStyleRule',
  'CSSFontFeatureValuesRule',
  'CSSFontPaletteValuesRule',
]);

/** The rules of a stylesheet as the browser itself reads it; none when it cannot be read. */
function readRules(css: string): CSSRule[] {
  try {
    // A sheet made this way takes no `@import`: a slide's CSS brings in nothing from outside it.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return Array.from(sheet.cssRules);
  } catch {
    return [];
  }
}

/**
 * The `css` of a slide, held to that slide (RND-07): its rules apply only inside the slide's
 * root, so a slide restyles neither the editor around it nor another slide on the same page (the
 * Stage and the Filmstrip).
 *
 * The CSS is read by the browser's own parser and written out again rule by rule, never cut up
 * as text: each rule comes back whole and closed, so nothing a deck writes (a stray `}`, an open
 * string or comment) ends the scope early and leaves the rest of it loose in the page.
 *
 * - Every rule goes inside `@scope (<the slide's root>)`, and so does any at-rule this function
 *   does not know: what is not known to need the whole document does not get it.
 * - Rules that define a name (`@keyframes`, `@font-face`, `@property`, ...) are global by nature.
 *   They go into a cascade layer, where a name the page itself defines outside any layer wins
 *   over the slide's: a slide cannot replace an animation, a font or a registered property of the
 *   editor. Two slides that define one name differently still collide with each other.
 */
export function scopeSlideCss(css: string, rootSelector: string): string {
  const namespaces: string[] = [];
  const names: string[] = [];
  const local: string[] = [];
  for (const rule of readRules(css)) {
    const kind = rule.constructor.name;
    // `@namespace` only says how this sheet's own selectors are read, and must come first.
    if (kind === 'CSSNamespaceRule') namespaces.push(rule.cssText);
    else (NAMING_RULES.has(kind) ? names : local).push(rule.cssText);
  }
  const parts = [...namespaces];
  if (names.length) parts.push(`@layer {\n${names.join('\n')}\n}`);
  if (local.length) parts.push(`@scope (${rootSelector}) {\n${local.join('\n')}\n}`);
  return parts.join('\n');
}

/** A line break, or any other control character: each of them ends a CSS string where it stands. */
// eslint-disable-next-line no-control-regex
const ENDS_STRING = /[\x00-\x1f\x7f]/g;

/**
 * A CSS string literal that stays one whatever the text holds: a quote and a backslash are
 * escaped, and so is every character that would end the string early (a line break, a form feed)
 * and let the rest of the text be read as CSS.
 */
export function cssString(value: string): string {
  return `"${value
    .replace(/["\\]/g, '\\$&')
    .replace(ENDS_STRING, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`;
}

/** `url("...")` for a URL that may contain quotes or spaces. */
export function cssUrl(url: string): string {
  return `url(${cssString(url)})`;
}

/** Rounds away floating-point noise, so styles and snapshots stay stable. */
export function num(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
