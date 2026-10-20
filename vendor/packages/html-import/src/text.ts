/**
 * A rendered block of text as a model paragraph (SPEC 5.4, 11.5): runs with their marks,
 * direction, alignment, line height and list marker, all read from computed styles. What the
 * text model has no field for goes into the element's `css` when it holds for the whole
 * block, and makes the block unsuitable (it then stays HTML) when it holds for a part of it.
 */
import type { Color, ListInfo, Marks, Paragraph, Run, Theme } from '@slidr/model';
import {
  alphaOf,
  collapseWhitespace,
  fontFamilies,
  isGenericFamily,
  px,
  round,
  scalePx,
  splitTopLevel,
} from './css';
import {
  composedChildNodes,
  composedParent,
  isElement,
  isInside,
  isSvg,
  isText,
  linkAround,
  neverRendered,
  ownPaint,
  pseudoKind,
  pseudoText,
  styleOf,
  subtreeHidden,
} from './measure';
import { chooseTextStyle, marksOver, type TextLook, type ThemeValues } from './tokens';

export interface TextTheme {
  theme: Theme;
  values: ThemeValues;
  /**
   * A computed colour as a model colour: a theme token when the property of that element
   * takes it from the theme (see `readThemeUse`), the value otherwise.
   */
  color(css: string, node: Element, property: string, pseudo?: string): Color;
  /** False for a foreign document: its text is not tied to the theme's fonts and text styles. */
  link: boolean;
  /**
   * A forced conversion (HTM-05): text with styling the model has no field for becomes a text
   * element all the same, without that styling, instead of staying html.
   */
  lossy?: boolean;
}

/**
 * Inherited properties that change how text looks and have no field in the model, with the
 * value each has when nobody set it. On the element's box they reach its text by inheritance.
 */
const TEXT_PASSTHROUGH: readonly (readonly [string, readonly string[]])[] = [
  ['text-shadow', ['none']],
  ['font-stretch', ['100%', 'normal']],
  ['font-feature-settings', ['normal']],
  ['font-variation-settings', ['normal']],
  ['font-variant-numeric', ['normal']],
  ['font-variant-caps', ['normal']],
  ['font-variant-ligatures', ['normal']],
  ['font-kerning', ['auto']],
  ['word-spacing', ['0px', 'normal']],
  ['word-break', ['normal']],
  ['line-break', ['auto']],
  ['hyphens', ['manual']],
  ['text-wrap-style', ['auto', '']],
  ['text-align-last', ['auto']],
  ['tab-size', ['8']],
  ['text-rendering', ['auto']],
  ['-webkit-font-smoothing', ['auto', '']],
  ['font-optical-sizing', ['auto']],
  ['text-underline-offset', ['auto']],
  ['text-underline-position', ['auto']],
  ['text-decoration-skip-ink', ['auto']],
  ['text-emphasis-style', ['none']],
  ['font-variant-east-asian', ['normal']],
  ['font-variant-position', ['normal']],
  ['font-variant-alternates', ['normal']],
  ['font-size-adjust', ['none']],
];

/** The lines of a `text-decoration-line` a run can say: the model has a mark for each. */
const MARKED_LINES = new Set(['underline', 'line-through']);

/**
 * What a text decoration is that the model's two marks cannot say, if anything: a line they
 * have no name for (an overline), or a line drawn in a style or a thickness of its own.
 */
function decorationProblem(cs: CSSStyleDeclaration): string | undefined {
  const lines = cs.textDecorationLine.split(' ').filter((line) => line && line !== 'none');
  if (lines.length === 0) return undefined;
  if (lines.some((line) => !MARKED_LINES.has(line))) return 'a line the model has no mark for';
  if (cs.textDecorationStyle !== 'solid' || cs.textDecorationThickness !== 'auto') {
    return 'a styled text decoration';
  }
  return undefined;
}

/** The selectors of the rules that style a first letter or a first line, by tree of styles. */
const firstPartSelectors = new WeakMap<Node, string[]>();
const FIRST_PART = /::?first-(?:letter|line)\b/;

function selectorsOfFirstParts(root: Document | ShadowRoot): string[] {
  const known = firstPartSelectors.get(root);
  if (known) return known;
  const found: string[] = [];
  const view = (root.ownerDocument ?? root).defaultView;
  /** Whether a media condition holds in the window the source is shown in. */
  const holds = (condition: string): boolean => {
    try {
      return view ? view.matchMedia(condition).matches : true;
    } catch {
      return true;
    }
  };
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const kind = rule.constructor.name;
      if (kind === 'CSSStyleRule') {
        for (const selector of splitTopLevel((rule as CSSStyleRule).selectorText, ',')) {
          if (FIRST_PART.test(selector)) found.push(selector.replace(FIRST_PART, '').trim() || '*');
        }
      }
      // A rule for another window than this one styles nothing here.
      if (kind === 'CSSMediaRule' && !holds((rule as CSSMediaRule).conditionText)) continue;
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of [...Array.from(root.styleSheets), ...(root.adoptedStyleSheets ?? [])]) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read.
    }
  }
  firstPartSelectors.set(root, found);
  return found;
}

const firstTexts = new WeakMap<Element, Text | null>();

/** The first text an element shows, in the order of the tree. */
export function firstText(el: Element): Text | null {
  const known = firstTexts.get(el);
  if (known !== undefined) return known;
  let found: Text | null = null;
  for (const node of composedChildNodes(el)) {
    if (isText(node)) {
      if (node.data.trim() !== '') found = node;
    } else if (isElement(node) && !neverRendered(node) && styleOf(node).display !== 'none') {
      found = firstText(node);
    }
    if (found) break;
  }
  firstTexts.set(el, found);
  return found;
}

/**
 * Whether the page styles the first letter or the first line of the text apart
 * (`::first-letter`, `::first-line`): a part of the text that is no node, so no run can stand
 * for it, and that follows the text wherever its first line ends. The rule may sit on the
 * block or on any block around it whose first text this is. Asked of the stylesheets, which
 * say it for every property at once; most pages have no such rule, and nothing is looked at.
 *
 * @param text  the text in question: an element whose content it is, or a text node
 */
export function firstPartStyled(owner: Element, text: Element | Text): boolean {
  const root = owner.getRootNode();
  if (root.nodeType !== 9 && root.nodeType !== 11) return false;
  const selectors = selectorsOfFirstParts(root as Document | ShadowRoot);
  if (selectors.length === 0) return false;
  for (let block: Element | undefined = owner; block; block = composedParent(block)) {
    const first = firstText(block);
    if (!first || (isText(text) ? first !== text : !isInside(first, text))) return false;
    const styled = selectors.some((selector) => {
      try {
        return block.matches(selector);
      } catch {
        // A selector that cannot be asked is taken to match: html is the safe answer.
        return true;
      }
    });
    if (styled) return true;
  }
  return false;
}

/** What cannot be said per run and cannot be put on the box either. */
function unsupportedText(cs: CSSStyleDeclaration, lossy = false): string | undefined {
  if (cs.writingMode !== 'horizontal-tb') return 'vertical writing mode';
  // A forced conversion shows the whole text where the HTML cut it short.
  if (lossy) return undefined;
  if (cs.getPropertyValue('-webkit-line-clamp') !== 'none') return 'line clamp';
  if (cs.textOverflow !== 'clip' && cs.overflowX !== 'visible') return 'text-overflow';
  return undefined;
}

function passthrough(cs: CSSStyleDeclaration, scale: number): Record<string, string> {
  const css: Record<string, string> = {};
  for (const [property, initial] of TEXT_PASSTHROUGH) {
    const value = cs.getPropertyValue(property);
    if (value && !initial.includes(value)) css[property] = scalePx(value, scale);
  }
  const stroke = px(cs.getPropertyValue('-webkit-text-stroke-width'));
  if (stroke > 0) {
    css['-webkit-text-stroke'] =
      `${round(stroke * scale)}px ${cs.getPropertyValue('-webkit-text-stroke-color')}`;
  }
  return css;
}

/** Text shown through the box's background (gradient text). */
function clippedBackground(cs: CSSStyleDeclaration, scale: number): Record<string, string> {
  const clip = cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip;
  if (clip !== 'text' || cs.backgroundImage === 'none') return {};
  return {
    'background-image': scalePx(cs.backgroundImage, scale),
    'background-size': scalePx(cs.backgroundSize, scale),
    'background-position': scalePx(cs.backgroundPosition, scale),
    'background-repeat': cs.backgroundRepeat,
    '-webkit-background-clip': 'text',
    'background-clip': 'text',
    '-webkit-text-fill-color': cs.getPropertyValue('-webkit-text-fill-color'),
  };
}

interface FontProbe {
  /** The width of the text set in the font list, or undefined where nothing can measure. */
  width(font: string, text: string): number | undefined;
  available: Map<string, boolean>;
  has: Map<string, boolean>;
}

const probes = new WeakMap<Document, FontProbe>();

function probeOf(doc: Document): FontProbe {
  let probe = probes.get(doc);
  if (!probe) {
    const ctx = doc.createElement('canvas').getContext('2d');
    probe = {
      width: (font, text) => {
        if (!ctx) return undefined;
        ctx.font = font;
        return ctx.measureText(text).width;
      },
      available: new Map(),
      has: new Map(),
    };
    probes.set(doc, probe);
  }
  return probe;
}

const quoted = (name: string) => `"${name.replace(/["\\]/g, '\\$&')}"`;

/**
 * Whether the document can draw text in the family: a named family that is neither installed
 * nor loaded draws exactly like the fallback after it.
 */
function familyAvailable(name: string, doc: Document): boolean {
  if (isGenericFamily(name)) return true;
  const probe = probeOf(doc);
  const cached = probe.available.get(name);
  if (cached !== undefined) return cached;
  const sample = 'mmmmmmmmmmlli שלום 0123';
  const found =
    probe.width(`72px ${quoted(name)}, monospace`, sample) !==
      probe.width('72px monospace', sample) ||
    probe.width(`72px ${quoted(name)}, serif`, sample) !== probe.width('72px serif', sample);
  probe.available.set(name, found);
  return found;
}

/**
 * Whether the family has a glyph of its own for the character. With one, what comes after the
 * family in the list makes no difference to how the character is drawn; without one, the
 * character is as wide as whatever comes after. `face`: the style and weight asked for; the
 * faces of one family do not all hold the same letters (Segoe UI has Hebrew, its Black has not).
 */
function familyHas(name: string, char: string, face: string, doc: Document): boolean {
  if (isGenericFamily(name)) return true;
  const probe = probeOf(doc);
  const key = `${face}\n${name}\n${char}`;
  const cached = probe.has.get(key);
  if (cached !== undefined) return cached;
  const [a, b, c] = ['monospace', 'serif', 'sans-serif'].map((after) =>
    probe.width(`${face} 72px ${quoted(name)}, ${after}`, char),
  );
  const found = a === b && b === c;
  probe.has.set(key, found);
  return found;
}

/** Characters that are drawn with the one before them, whatever font has them. */
const JOINS_PREVIOUS = /^(?:\p{M}|\u200c|\u200d|\ufe0e|\ufe0f)$/u;

/**
 * The run, cut where the family that draws it changes. The browser takes each character from
 * the first family of the list that has it: Hebrew in a list that opens with a Latin-only
 * font is drawn by a later one. A font mark names one family, so each stretch gets its own.
 */
function byFamily(run: RawRun, doc: Document): RawRun[] {
  const families = run.look.families.filter((family) => familyAvailable(family, doc));
  if (families.length < 2) return [run];
  const cut: RawRun[] = [];
  const face = `${run.look.italic ? 'italic' : 'normal'} ${run.look.weight}`;
  let font: string | undefined;
  for (const char of run.text) {
    const family =
      font !== undefined && JOINS_PREVIOUS.test(char)
        ? font
        : (families.find((f) => familyHas(f, char, face, doc)) ?? font ?? families[0]!);
    const last = cut[cut.length - 1];
    if (last && family === font) last.text += char;
    else cut.push({ ...run, text: char, look: { ...run.look, font: family } });
    font = family;
  }
  return cut.length > 0 ? cut : [run];
}

/**
 * The height the style gives a line, in its own CSS px; undefined when it gives none the model
 * can hold: `normal`, which the font decides, and a height of nothing (`line-height: 0`, a
 * common way to centre a figure in a badge), where the glyphs are simply drawn around the
 * line's place. A single line sits the same under any height once its box is put where the
 * glyphs were, which the guard does by measuring.
 */
export function lineHeightPx(cs: CSSStyleDeclaration): number | undefined {
  if (cs.lineHeight === 'normal') return undefined;
  const height = px(cs.lineHeight);
  return height > 0 ? height : undefined;
}

/** How the browser shows the text of an element, in slide pixels. */
export function lookOf(
  node: Element,
  pseudo: string | undefined,
  cs: CSSStyleDeclaration,
  scale: number,
  ctx: TextTheme,
): TextLook {
  const families = fontFamilies(cs.fontFamily);
  const transform = cs.textTransform;
  return {
    families,
    font: families.find((f) => familyAvailable(f, node.ownerDocument)) ?? families[0],
    size: round(px(cs.fontSize) * scale),
    // A variable font takes any weight (450.5); the model's weight is a whole number.
    weight: Math.min(1000, Math.max(1, Math.round(Number(cs.fontWeight) || 400))),
    italic: cs.fontStyle !== 'normal',
    color: ctx.color(cs.color, node, 'color', pseudo),
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : round(px(cs.letterSpacing) * scale),
    ...(transform === 'uppercase' ? { case: 'upper' as const } : {}),
    ...(transform === 'lowercase' ? { case: 'lower' as const } : {}),
  };
}

/** The line breaks and replaced content that end a line box of their own accord. */
const INLINE_ATOMS = new Set([
  'img',
  'canvas',
  'video',
  'iframe',
  'input',
  'button',
  'select',
  'textarea',
  'picture',
  'object',
  'embed',
]);

/** True when everything under `el` is inline phrasing content the text model can hold as runs. */
export function isPureInline(el: Element): boolean {
  for (const child of composedChildNodes(el)) {
    if (!isElement(child) || neverRendered(child)) continue;
    const tag = child.localName;
    if (tag === 'br' || tag === 'wbr') continue;
    const cs = styleOf(child);
    if (cs.display === 'none') continue;
    if (cs.display !== 'inline' && cs.display !== 'contents') return false;
    if (isSvg(child) || INLINE_ATOMS.has(tag)) return false;
    const paint = ownPaint(cs);
    if (paint.border || paint.shadow || cs.backgroundImage !== 'none') return false;
    if (px(cs.paddingLeft) + px(cs.paddingRight) > 0) return false;
    if (pseudoKind(child, '::before') === 'box' || pseudoKind(child, '::after') === 'box')
      return false;
    if (child.hasAttribute('data-icon') || child.hasAttribute('data-keep-html')) return false;
    if (!isPureInline(child)) return false;
  }
  return true;
}

export function hasOwnText(el: Element): boolean {
  return composedChildNodes(el).some((n) => isText(n) && n.data.trim() !== '');
}

export function hasAnyText(el: Element): boolean {
  for (const n of composedChildNodes(el)) {
    if (isText(n) && n.data.trim() !== '') return true;
    if (isElement(n) && !neverRendered(n) && styleOf(n).display !== 'none' && hasAnyText(n))
      return true;
  }
  return false;
}

interface RawRun {
  text: string;
  br: boolean;
  look: TextLook;
  underline: boolean;
  strike: boolean;
  highlight?: Color;
  link?: string;
  script?: 'sup' | 'sub';
  /** Computed line height in the run's own CSS px; undefined for `normal`. */
  lineHeight: number | undefined;
}

/** What the walk over a block's parts carries down: marks, and whose colour a line is drawn in. */
interface Carried extends Partial<RawRun> {
  underlineColor?: string;
  strikeColor?: string;
}

export interface TextBlock {
  paragraph: Paragraph;
  /** For the element's `css` field. */
  css: Record<string, string>;
  chars: number;
  /** The text includes generated content, which has no boxes to measure. */
  generated: boolean;
  /**
   * A part of the text is laid out in a direction or an isolation of its own, which a run
   * cannot say: the model's marks have no direction. Whether the text reads the same without
   * it depends on what is in it (an English word in a Hebrew sentence does, `C++` does not),
   * so it is for the guard to measure, by where each character sits.
   */
  ownDirection: boolean;
  /** Largest font size among the runs, in slide pixels. */
  maxSize: number;
  /** The theme text style the paragraph points at. */
  styleSize: number;
}

/**
 * The part that holds all the text of a block and isolates it in a direction: the one child
 * with anything to show, at whatever depth (`<p><b><span dir="ltr">…</span></b></p>`, a `bdi`
 * around the figure of a table cell). Text that is all inside one isolate is laid out exactly
 * as a paragraph of that direction is, and a paragraph has a direction.
 */
function soleIsolate(el: Element): { part: Element; direction: 'rtl' | 'ltr' } | undefined {
  for (let scope = el; ;) {
    // Generated text stands outside whatever the scope holds.
    if (pseudoKind(scope, '::before') || pseudoKind(scope, '::after')) return undefined;
    const content = composedChildNodes(scope).filter((node) =>
      isText(node)
        ? node.data.trim() !== ''
        : isElement(node) && !neverRendered(node) && styleOf(node).display !== 'none',
    );
    const only = content.length === 1 ? content[0] : undefined;
    if (!only || !isElement(only) || only.localName === 'br') return undefined;
    const bidi = styleOf(only).unicodeBidi;
    if (bidi === 'isolate' || bidi === 'embed') {
      return { part: only, direction: styleOf(only).direction === 'rtl' ? 'rtl' : 'ltr' };
    }
    // An override or `plaintext` orders the characters themselves: not a paragraph's direction.
    if (bidi !== 'normal') return undefined;
    scope = only;
  }
}

function capitalize(text: string): string {
  return text.replace(
    /(^|[\s\-(["'])(\p{L})/gu,
    (_, before: string, letter: string) => before + letter.toUpperCase(),
  );
}

/**
 * The paragraph an element's inline content makes, or why it cannot be one.
 *
 * @param owner  the element `cs` is the style of: `el` itself, or the parent of a lone text node
 * @param scale  CSS px of the element -> slide px
 * @param pitch  measured distance between line tops in slide px, when the text has several lines
 */
export function readTextBlock(
  el: Element,
  owner: Element,
  cs: CSSStyleDeclaration,
  scale: number,
  pitch: number | undefined,
  list: ListInfo | undefined,
  ctx: TextTheme,
): TextBlock | { unsupported: string } {
  const { theme, values } = ctx;
  const unsupported =
    unsupportedText(cs, ctx.lossy) ?? (ctx.lossy ? undefined : decorationProblem(cs));
  if (unsupported) return { unsupported };
  const blockCss = passthrough(cs, scale);
  // Text that shows its box's background through its glyphs is filled with nothing on purpose.
  const clip = clippedBackground(cs, scale);
  const clipped = Object.keys(clip).length > 0;
  const blockFill = cs.getPropertyValue('-webkit-text-fill-color');
  const signature = JSON.stringify(blockCss);
  const pre = /^pre|break-spaces/.test(cs.whiteSpace) && cs.whiteSpace !== 'pre-line';
  const keepNewlines = pre || cs.whiteSpace === 'pre-line';
  const raw: RawRun[] = [];
  let problem: string | undefined;
  let generated = false;
  const sole = soleIsolate(el);
  // On the block itself an isolation changes nothing (a block is one already); an override
  // or `plaintext` decides the order of its characters.
  let ownDirection = /override|plaintext/.test(cs.unicodeBidi);

  /** `from`: whose style `style` is, so that a colour can be traced to the theme. */
  const push = (
    text: string,
    style: CSSStyleDeclaration,
    from: { node: Element; pseudo?: string },
    inherited: Carried,
    br = false,
  ) => {
    const decoration = style.textDecorationLine;
    const line = lineHeightPx(style);
    const look = lookOf(from.node, from.pseudo, style, scale, ctx);
    // Glyphs are painted in the fill colour, which is the text colour unless something set it
    // apart. A run has one colour, and it is the one its glyphs show.
    const fill = style.getPropertyValue('-webkit-text-fill-color');
    const painted = !clipped && fill && fill !== style.color ? fill : style.color;
    if (painted !== style.color) {
      look.color = ctx.color(painted, from.node, '-webkit-text-fill-color', from.pseudo);
    }
    const base: RawRun = {
      text: style.textTransform === 'capitalize' ? capitalize(text) : text,
      br,
      look,
      underline: inherited.underline || decoration.includes('underline'),
      strike: inherited.strike || decoration.includes('line-through'),
      lineHeight: line === undefined ? undefined : line * scale,
      ...(inherited.highlight ? { highlight: inherited.highlight } : {}),
      ...(inherited.link ? { link: inherited.link } : {}),
      ...(inherited.script ? { script: inherited.script } : {}),
    };
    // The renderer draws a raised or lowered run at 65% of its size mark.
    if (base.script) base.look = { ...base.look, size: round(base.look.size / 0.65) };
    // A line under or through text is drawn in the colour of the box that asked for it; a
    // mark draws it in the colour of its own run. Where the two differ (a red word in an
    // underlined sentence, an underline given a colour of its own), no mark says it.
    if (!br && text.trim() !== '') {
      const under = decoration.includes('underline')
        ? style.textDecorationColor
        : inherited.underlineColor;
      const through = decoration.includes('line-through')
        ? style.textDecorationColor
        : inherited.strikeColor;
      if (
        (base.underline && under !== undefined && under !== painted) ||
        (base.strike && through !== undefined && through !== painted)
      ) {
        problem = 'a text decoration in another colour than its text';
      }
    }
    raw.push(base);
  };

  const pseudo = (node: Element, which: '::before' | '::after', inherited: Carried) => {
    if (pseudoKind(node, which) !== 'text') return;
    generated = true;
    const style = styleOf(node, which);
    push(pseudoText(style), style, { node, pseudo: which }, inherited);
  };

  const walk = (node: Element, styled: Element, style: CSSStyleDeclaration, inherited: Carried) => {
    const from = { node: styled };
    if (node === styled) pseudo(node, '::before', inherited);
    for (const child of composedChildNodes(node)) {
      if (isText(child)) {
        if (keepNewlines) {
          child.data.split('\n').forEach((line, i) => {
            if (i > 0) push('\n', style, from, inherited, true);
            push(line, style, from, inherited);
          });
        } else push(child.data, style, from, inherited);
        continue;
      }
      if (!isElement(child) || neverRendered(child)) continue;
      if (child.localName === 'br') {
        push('\n', style, from, inherited, true);
        continue;
      }
      const childStyle = styleOf(child);
      if (subtreeHidden(childStyle) || childStyle.visibility !== 'visible') continue;
      if (childStyle.opacity !== '1') problem = 'a translucent part of the text';
      // `direction` alone does nothing to an inline part; with `unicode-bidi` it does.
      if (childStyle.unicodeBidi !== 'normal' && child !== sole?.part) ownDirection = true;
      if (
        JSON.stringify(passthrough(childStyle, scale)) !== signature ||
        (clipped && childStyle.getPropertyValue('-webkit-text-fill-color') !== blockFill)
      ) {
        problem = 'text styling the model has no field for, on a part of the text';
      }
      const decoration = childStyle.textDecorationLine;
      problem = decorationProblem(childStyle) ?? problem;
      const next: Carried = {
        ...inherited,
        underline: inherited.underline || decoration.includes('underline'),
        strike: inherited.strike || decoration.includes('line-through'),
        ...(decoration.includes('underline')
          ? { underlineColor: childStyle.textDecorationColor }
          : {}),
        ...(decoration.includes('line-through')
          ? { strikeColor: childStyle.textDecorationColor }
          : {}),
      };
      if (alphaOf(childStyle.backgroundColor) > 0) {
        next.highlight = ctx.color(childStyle.backgroundColor, child, 'background-color');
      }
      const href = child.localName === 'a' ? child.getAttribute('href') : null;
      if (href) next.link = href;
      if (childStyle.verticalAlign === 'super') next.script = 'sup';
      else if (childStyle.verticalAlign === 'sub') next.script = 'sub';
      else if (childStyle.verticalAlign !== 'baseline')
        problem = 'a vertically shifted part of the text';
      walk(child, child, childStyle, next);
    }
    if (node === styled) pseudo(node, '::after', inherited);
  };
  const decoration = cs.textDecorationLine;
  // A link around the block, or the block itself, makes all of it a link.
  const link = linkAround(owner);
  walk(el, owner, cs, {
    underline: decoration.includes('underline'),
    strike: decoration.includes('line-through'),
    ...(decoration.includes('underline') ? { underlineColor: cs.textDecorationColor } : {}),
    ...(decoration.includes('line-through') ? { strikeColor: cs.textDecorationColor } : {}),
    ...(link ? { link } : {}),
  });
  // A forced conversion keeps the text and loses what the part of it could not carry.
  if (problem && !ctx.lossy) return { unsupported: problem };

  const texts = pre
    ? raw.map((r) => r.text)
    : collapseWhitespace(
        raw.map((r) => r.text),
        raw.map((r) => r.br),
      );
  const kept = raw
    .map((r, i) => ({ ...r, text: texts[i]! }))
    // Text of no size (`font-size: 0`) is in the DOM and not on screen, like text that is
    // hidden. It goes after the white space was collapsed around it: the spaces on its two
    // sides are both drawn, since it stood between them.
    .filter((r) => r.text !== '' && (r.br || r.look.size > 0))
    .flatMap((r) => (r.br ? [r] : byFamily(r, owner.ownerDocument)));
  if (kept.every((r) => r.br)) return { unsupported: 'no visible text' };

  // The style is chosen for the run that holds most of the text.
  const visible = kept.filter((r) => !r.br);
  const dominant = visible.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  const styleRef = chooseTextStyle(dominant.look, theme, values);
  const style = theme.textStyles[styleRef];
  const maxSize = Math.max(...visible.map((r) => (r.script ? r.look.size * 0.65 : r.look.size)));

  const runs: Run[] = [];
  for (const r of kept) {
    const marks: Marks = marksOver(r.look, styleRef, theme, values, ctx.link);
    if (r.underline) marks.underline = true;
    if (r.strike) marks.strike = true;
    if (r.highlight) marks.highlight = r.highlight;
    if (r.link) marks.link = r.link;
    if (r.script) marks.script = r.script;
    const last = runs[runs.length - 1];
    const sameMarks = last && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks);
    // A forced break belongs to the run before it; equal neighbours are one run.
    if (last && (r.br || sameMarks)) last.text += r.text;
    else runs.push({ text: r.text, ...(Object.keys(marks).length > 0 ? { marks } : {}) });
  }

  // The renderer sets a line's height from the larger of the style's size and the run's.
  const lineHeights = visible.map((r) => r.lineHeight).filter((n): n is number => n !== undefined);
  const linePx = pitch ?? (lineHeights.length > 0 ? Math.max(...lineHeights) : undefined);
  const multiplier = linePx === undefined ? undefined : linePx / Math.max(style.size, maxSize);

  const blockDirection: 'rtl' | 'ltr' = cs.direction === 'rtl' ? 'rtl' : 'ltr';
  const indent = round(px(cs.textIndent) * scale);
  const blockAlign = alignOf(cs.textAlign, blockDirection);
  // Text that is all inside one isolate reads as a paragraph of the isolate's direction, on
  // the side of the box the block put it. Not where the block's own direction places more than
  // the lines: a list marker, an indent, the last line of justified text.
  let direction: 'rtl' | 'ltr' = blockDirection;
  if (sole && sole.direction !== blockDirection) {
    if (list || indent !== 0 || blockAlign === 'justify') ownDirection = true;
    else direction = sole.direction;
  }
  const flipped = direction !== blockDirection && (blockAlign === 'start' || blockAlign === 'end');
  const paragraph: Paragraph = {
    dir: direction,
    align: flipped ? (blockAlign === 'start' ? 'end' : 'start') : blockAlign,
    ...(multiplier !== undefined && (!ctx.link || Math.abs(multiplier - style.lineHeight) > 0.004)
      ? { lineHeight: Math.round(multiplier * 10000) / 10000 }
      : {}),
    ...(indent !== 0 && !list ? { indent } : {}),
    ...(list ? { list } : {}),
    styleRef,
    runs,
  };
  return {
    paragraph,
    css: { ...blockCss, ...clip },
    chars: visible.reduce((n, r) => n + r.text.length, 0),
    generated,
    ownDirection,
    maxSize,
    styleSize: style.size,
  };
}

function alignOf(textAlign: string, direction: 'rtl' | 'ltr'): Paragraph['align'] {
  const value = textAlign.replace('-webkit-', '');
  if (value === 'center' || value === 'justify') return value;
  if (value === 'end') return 'end';
  if (value === 'left') return direction === 'rtl' ? 'end' : 'start';
  if (value === 'right') return direction === 'rtl' ? 'start' : 'end';
  return 'start';
}

const BULLETS: Record<string, string> = { disc: '•', circle: '◦', square: '▪' };
/** The renderer's own glyphs by level; a marker equal to it needs no `glyph`. */
const DEFAULT_BULLETS = ['•', '◦', '▪'];

function alphabetic(n: number, first: number): string {
  let s = '';
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26))
    s = String.fromCharCode(first + ((v - 1) % 26)) + s;
  return s;
}

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let s = '';
  let v = n;
  for (const [value, letters] of table) {
    while (v >= value) {
      s += letters;
      v -= value;
    }
  }
  return s;
}

/** The marker text of a counter style the model can show, e.g. "3." for `decimal`. */
function counterText(type: string, n: number): string | undefined {
  // Letters and Roman numerals count from one; below that the browser writes the number.
  const counted = n >= 1;
  switch (type) {
    case 'decimal':
      return `${n}.`;
    case 'decimal-leading-zero':
      return `${n < 0 ? '-' : ''}${String(Math.abs(n)).padStart(2, '0')}.`;
    case 'lower-alpha':
    case 'lower-latin':
      return counted ? `${alphabetic(n, 97)}.` : `${n}.`;
    case 'upper-alpha':
    case 'upper-latin':
      return counted ? `${alphabetic(n, 65)}.` : `${n}.`;
    case 'lower-roman':
      return counted && n < 4000 ? `${roman(n)}.` : `${n}.`;
    case 'upper-roman':
      return counted && n < 4000 ? `${roman(n).toUpperCase()}.` : `${n}.`;
    default:
      return undefined;
  }
}

/**
 * The list marker of an element the browser lays out as a list item: `undefined` when it has
 * none, `unsupported` when the model cannot show it (an image, a counter style it does not
 * know, a marker the page built or dressed in a way a marker of the model is not).
 *
 * Nothing compares a marker with the source's: the renderer draws its own, and the strip it
 * hangs in is left out of the comparison (ADR-017). So a marker is written only from what the
 * browser says of it, and what it does not say plainly is not guessed.
 */
export function readListMarker(
  el: Element,
  cs: CSSStyleDeclaration,
  ctx: TextTheme,
): ListInfo | 'unsupported' | undefined {
  if (cs.display !== 'list-item') return undefined;
  const marker = styleOf(el, '::marker');
  // The marker's own text, when the page wrote one (`li::marker { content: "→ " }`).
  let written: string | undefined;
  if (marker.content === 'none') return undefined;
  if (marker.content && marker.content !== 'normal') {
    const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(marker.content);
    // A counter, a picture, several pieces: put together by rules the model has no word for.
    if (!literal) return 'unsupported';
    written = literal[1]!.replace(/\\(.)/g, '$1').trim();
    if (!written) return undefined;
  } else if (cs.listStyleImage !== 'none') return 'unsupported';
  else if (cs.listStyleType === 'none') return undefined;
  // The renderer draws a marker in the look of the text it hangs beside. One the page gave a
  // size, a weight or a face of its own is one it cannot draw.
  if (
    marker.fontSize !== cs.fontSize ||
    marker.fontWeight !== cs.fontWeight ||
    marker.fontStyle !== cs.fontStyle ||
    marker.fontFamily !== cs.fontFamily
  ) {
    return 'unsupported';
  }
  let level = 0;
  for (let p = composedParent(el); p; p = composedParent(p)) {
    if (styleOf(p).display === 'list-item') level++;
  }
  level = Math.min(level, 8);
  const markerColor = ctx.color(marker.color, el, 'color', '::marker');
  const color =
    JSON.stringify(markerColor) === JSON.stringify(ctx.color(cs.color, el, 'color'))
      ? {}
      : { color: markerColor };
  if (written) return { kind: 'bullet', level, glyph: written, ...color };
  const type = cs.listStyleType;
  const bullet = BULLETS[type];
  if (bullet) {
    return {
      kind: 'bullet',
      level,
      ...(bullet === DEFAULT_BULLETS[level % DEFAULT_BULLETS.length] ? {} : { glyph: bullet }),
      ...color,
    };
  }
  const literal = /^"(.*)"$/.exec(type);
  if (literal) {
    const glyph = literal[1]!.trim();
    return glyph ? { kind: 'bullet', level, glyph, ...color } : undefined;
  }
  const ordinal = ordinalOf(el);
  const text = ordinal === undefined ? undefined : counterText(type, ordinal);
  // Each item is its own text box, so its number is written out rather than counted.
  return text ? { kind: 'number', level, glyph: text, ...color } : 'unsupported';
}

/** Whether the page resets the count of the list items in an element itself. */
export function resetsListCount(cs: CSSStyleDeclaration): boolean {
  return listItemCounter(cs.counterReset, 0) !== undefined;
}

/**
 * What a computed `counter-reset`, `counter-set` or `counter-increment` says about the
 * counter of list items: its number, `undefined` when it does not name the counter, and
 * `unknown` when it names it in a way that is not a plain number (`reversed(list-item)`).
 */
function listItemCounter(value: string, unnamed: number): number | 'unknown' | undefined {
  if (!value || value === 'none') return undefined;
  if (/reversed\(\s*list-item\s*\)/.test(value)) return 'unknown';
  const words = value.trim().split(/\s+/);
  const at = words.indexOf('list-item');
  if (at < 0) return undefined;
  const next = words[at + 1];
  if (next === undefined || !/^[+-]?\d+$/.test(next)) return unnamed;
  return Number(next);
}

const wholeNumber = (el: Element, name: string): number | undefined => {
  const value = el.getAttribute(name);
  return value !== null && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : undefined;
};

/**
 * The number of a list item, as the browser counts it: from where the list starts (`start`),
 * by the step of each item before it (one, minus one in a `reversed` list, or its own
 * `counter-increment`), through every number an item sets (`value`, `counter-set`, the
 * second before the first). Measured against what the browser draws, item by item.
 *
 * `undefined` when the page counts in a way this does not follow: a `counter-reset` of the
 * list's own counter, on the list or on an item. The browser this was measured in draws its
 * numbers as if the list's reset were not there, and the standard says otherwise; a number
 * is content, so neither is written down, and the item keeps its markup.
 */
export function ordinalOf(el: Element): number | undefined {
  const parent = composedParent(el);
  if (!parent) return 1;
  const items = composedChildNodes(parent).filter(
    (node): node is Element => isElement(node) && styleOf(node).display === 'list-item',
  );
  const reversed = parent.localName === 'ol' && parent.hasAttribute('reversed');
  const step = reversed ? -1 : 1;
  if (resetsListCount(styleOf(parent))) return undefined;
  const start = wholeNumber(parent, 'start');
  // Where the count stands before the first item. A reversed list without a start counts
  // down from the number of its items.
  let n = start !== undefined ? start - step : reversed ? items.length + 1 : 0;
  for (const item of items) {
    const style = styleOf(item);
    const increment = listItemCounter(style.counterIncrement, 1);
    const set = listItemCounter(style.getPropertyValue('counter-set'), 0);
    // An item that starts a count of its own inside itself is not one of this row.
    const inner = listItemCounter(style.counterReset, 0);
    if (increment === 'unknown' || set === 'unknown' || inner !== undefined) return undefined;
    n = set ?? wholeNumber(item, 'value') ?? n + (increment ?? step);
    if (item === el) return n;
  }
  return undefined;
}
