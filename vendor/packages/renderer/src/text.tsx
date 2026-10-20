import type {
  Color,
  Direction,
  Insets,
  ListFormat,
  ListInfo,
  Marks,
  Paragraph,
  RichText,
  Run,
  TextElement,
  TextStyleRef,
  Theme,
} from '@slidr/model';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useRenderContext } from './context';
import { passthroughStyle } from './css';
import { colorCss, runFontStack } from './theme';

/**
 * Rich text (SPEC 5.4) as real text: paragraphs are `<p>`, consecutive list paragraphs are
 * `<ul>` / `<ol>` with `<li>` items (EXP-03). Everything is styled inline, so the result is the
 * same with or without a page stylesheet around it (RND-01).
 *
 * Conventions this file fixes for the model:
 * - A paragraph without `styleRef` uses the `body` style.
 * - `letterSpacing` (marks and text styles) is in slide pixels.
 * - A `\n` inside a run is a line break within the paragraph.
 * - `indent` is the first-line indent of a paragraph that is not a list item, in slide pixels.
 * - A sup/sub run is drawn at 65% of its size.
 */

const BULLETS = ['•', '◦', '▪'];
/** Width of the marker column, in em of the paragraph's text. */
export const MARKER_EM = 1.25;
/** Extra indent per list level, in em. */
export const LEVEL_EM = 1.5;

function alpha(n: number): string {
  let s = '';
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26))
    s = String.fromCharCode(97 + ((v - 1) % 26)) + s;
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

/** Hebrew numerals: letters that add up to the number, with 15 and 16 as ט״ו and ט״ז. */
function hebrew(n: number): string {
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const hundreds = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
  const v = n % 1000;
  const rest = v % 100;
  const low =
    rest === 15 ? 'טו' : rest === 16 ? 'טז' : tens[Math.floor(rest / 10)]! + ones[rest % 10]!;
  return hundreds[Math.floor(v / 100)]! + low || String(n);
}

/** The number of the `n`th item, written in a numbering style. */
export function listNumber(n: number, format: ListFormat): string {
  switch (format) {
    case 'decimal':
      return `${n}.`;
    case 'decimal-paren':
      return `${n})`;
    case 'upper-roman':
      return `${roman(n).toUpperCase()}.`;
    case 'upper-alpha':
      return `${alpha(n).toUpperCase()}.`;
    case 'lower-alpha-paren':
      return `${alpha(n)})`;
    case 'lower-alpha':
      return `${alpha(n)}.`;
    case 'lower-roman':
      return `${roman(n)}.`;
    case 'hebrew':
      return `${hebrew(n)}.`;
  }
}

/** The style of a level without one of its own: `1.`, `a.`, `i.`, and again. */
const LEVEL_FORMATS: readonly ListFormat[] = ['decimal', 'lower-alpha', 'lower-roman'];

function numberLabel(n: number, list: ListInfo): string {
  return listNumber(n, list.format ?? LEVEL_FORMATS[list.level % 3]!);
}

/**
 * The font size of a list marker: the text's, or the size of the item's first run, times the
 * list's `size`. Undefined leaves the marker at the size of its paragraph.
 */
/**
 * The width of the marker column in em of the marker: `MARKER_EM` of the paragraph, so that a
 * marker drawn larger or smaller (`size`) keeps the column the paragraph's indent leaves it.
 */
export function markerWidthEm(list: ListInfo): number {
  return MARKER_EM / ((list.size ?? 100) / 100);
}

export function markerFontSize(
  list: ListInfo,
  runSize: number | undefined,
): string | number | undefined {
  if (list.size === undefined) return runSize;
  return runSize !== undefined ? (runSize * list.size) / 100 : `${list.size / 100}em`;
}

/** The marker text of every list paragraph: numbering restarts after any non-list paragraph. */
export function listMarkers(paragraphs: readonly Paragraph[]): (string | undefined)[] {
  const counters: number[] = [];
  return paragraphs.map((p) => {
    const list = p.list;
    if (!list) {
      counters.length = 0;
      return undefined;
    }
    counters.length = list.level + 1;
    if (list.kind === 'bullet') {
      counters[list.level] = 0;
      return list.glyph ?? BULLETS[list.level % BULLETS.length];
    }
    const previous = counters[list.level];
    const n = previous ? previous + 1 : (list.start ?? 1);
    counters[list.level] = n;
    return list.glyph ?? numberLabel(n, list);
  });
}

export interface TextDefaults {
  styleRef: TextStyleRef;
  /** False keeps every paragraph on one line (`TextElement.wrap`). */
  wrap: boolean;
  /** Overrides the text style's colour and weight, e.g. in a table's header row. Marks still win. */
  color?: string;
  weight?: number;
  /** In a table cell: the direction of the table, which `dir: auto` paragraphs are aligned by. */
  alignTo?: Direction;
}

/**
 * The side the lines of a paragraph are aligned to. `start` and `end` are sides of the
 * paragraph's own direction, as in CSS. In a table cell (`alignTo`) a `dir: auto` paragraph
 * takes them from the table instead: its text still reads its own way, but it sits on the side
 * its column starts from. So a column of a Hebrew table has one edge, whether a cell says
 * Hebrew for "Quarter" or "Q1". A paragraph with a direction of its own keeps its own sides.
 */
function alignment(p: Paragraph, defaults: TextDefaults): CSSProperties['textAlign'] {
  const { align } = p;
  if (!defaults.alignTo || p.dir !== 'auto' || (align !== 'start' && align !== 'end')) return align;
  return (align === 'start') === (defaults.alignTo === 'ltr') ? 'left' : 'right';
}

/** The style of a paragraph. The text editor (WG4) uses it too, so text does not move on entering it. */
export function paragraphStyle(p: Paragraph, theme: Theme, defaults: TextDefaults): CSSProperties {
  const ts = theme.textStyles[p.styleRef ?? defaults.styleRef];
  return {
    margin: 0,
    padding: 0,
    fontFamily: `var(--font-${ts.font})`,
    fontSize: ts.size,
    fontWeight: defaults.weight ?? ts.weight,
    fontStyle: 'normal',
    lineHeight: p.lineHeight ?? ts.lineHeight,
    letterSpacing: ts.letterSpacing ?? 'normal',
    color: defaults.color ?? colorCss(ts.color),
    textTransform: ts.case === 'upper' ? 'uppercase' : ts.case === 'lower' ? 'lowercase' : 'none',
    textAlign: alignment(p, defaults),
    textIndent: !p.list && p.indent ? p.indent : 0,
    paddingBlockStart: p.spaceBefore || undefined,
    paddingBlockEnd: p.spaceAfter || undefined,
    whiteSpace: defaults.wrap ? 'pre-wrap' : 'pre',
    overflowWrap: defaults.wrap ? 'break-word' : 'normal',
  };
}

/** The style of a run's marks, over its paragraph's style. Shared with the text editor. */
export function runStyle(
  marks: Marks | undefined,
  role: 'heading' | 'body',
): CSSProperties | undefined {
  if (!marks) return undefined;
  const style: CSSProperties = {};
  if (marks.font) style.fontFamily = runFontStack(marks.font, role);
  if (marks.size !== undefined) style.fontSize = marks.script ? marks.size * 0.65 : marks.size;
  else if (marks.script) style.fontSize = '0.65em';
  if (marks.script) style.verticalAlign = marks.script === 'sup' ? 'super' : 'sub';
  if (marks.weight !== undefined) style.fontWeight = marks.weight;
  if (marks.italic) style.fontStyle = 'italic';
  const lines = [marks.underline && 'underline', marks.strike && 'line-through'].filter(Boolean);
  if (lines.length) style.textDecorationLine = lines.join(' ');
  if (marks.color) style.color = colorCss(marks.color);
  if (marks.highlight) {
    style.backgroundColor = colorCss(marks.highlight);
    style.boxDecorationBreak = 'clone';
    style.WebkitBoxDecorationBreak = 'clone';
  }
  if (marks.letterSpacing !== undefined) style.letterSpacing = marks.letterSpacing;
  if (marks.case) style.textTransform = marks.case === 'upper' ? 'uppercase' : 'lowercase';
  return style;
}

/** Letters of the scripts written right to left. */
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const LETTER = /\p{L}/u;
// The invisible direction marks, by code point so that they can be seen in the source.
const RLM = String.fromCodePoint(0x200f);
const ALM = String.fromCodePoint(0x061c);
const LRM = String.fromCodePoint(0x200e);

/**
 * The direction of the first strong character, as `dir="auto"` finds it: letters are strong,
 * digits, punctuation, spaces and emoji are not. Undefined when the text has no strong character.
 */
export function firstStrong(text: string): Direction | undefined {
  for (const char of text) {
    if (char === RLM || char === ALM) return 'rtl';
    if (char === LRM) return 'ltr';
    if (LETTER.test(char)) return RTL_LETTER.test(char) ? 'rtl' : 'ltr';
  }
  return undefined;
}

/**
 * The direction a paragraph is laid out in. `auto` follows the first strong character of its own
 * text. Text without one (a figure, "87%", an empty line) has nothing to go by and takes
 * `fallback`, the direction of the deck: in a Hebrew deck a lone number sits on the right, and a
 * list keeps its bullets on one side.
 *
 * The renderer writes the result as an explicit `dir`, never `dir="auto"`: the browser's own
 * `auto` falls back to left-to-right, and it counts a list marker ("a.") as part of the text.
 * The text editor uses this function too, so text does not turn when editing starts.
 */
export function paragraphDirection(
  dir: Paragraph['dir'],
  text: string,
  fallback: Direction,
): Direction {
  if (dir !== 'auto') return dir;
  return firstStrong(text) ?? fallback;
}

/**
 * A `dir: auto` paragraph of figures only ("+4%", "12.10.2026") in a right-to-left deck. It sits
 * on the deck's side, like the text around it, but it reads left to right, as every number does:
 * laid out right to left, "+4%" would be drawn "4%+". Each of its runs is drawn as a left-to-right
 * island (`dir="ltr"`); the text editor does the same, run by run.
 */
export function readsAsNumber(dir: Paragraph['dir'], text: string, fallback: Direction): boolean {
  return dir === 'auto' && fallback === 'rtl' && text !== '' && firstStrong(text) === undefined;
}

const paragraphText = (p: Paragraph) => p.runs.map((r) => r.text).join('');

const LINK_STYLE: CSSProperties = { color: 'inherit', textDecoration: 'inherit' };

/** A link to a slide of the deck, as the `link` mark holds it: `#slide=<slideId>` (TXT-09). */
const SLIDE_LINK = /^#slide=(.+)$/;

/**
 * The addresses a slide opens, as the app's text tools write them (`safeLink`). A link that came
 * some other way (an imported file, an agent) to `javascript:`, `data:` or a file is drawn as its
 * text, with no address to follow.
 */
const OPENABLE = /^(?:https?:|mailto:|tel:)/i;

/** Whether an address is one a slide may open at all, wherever it is shown. */
export function opensAddress(address: string): boolean {
  return OPENABLE.test(address.trim());
}

function RunView({ run, role, ltr }: { run: Run; role: 'heading' | 'body'; ltr: boolean }) {
  const { mode, opensLink } = useRenderContext();
  const style = runStyle(run.marks, role);
  const dir = ltr ? 'ltr' : undefined;
  const link = run.marks?.link;
  const slide = link ? SLIDE_LINK.exec(link)?.[1] : undefined;
  if (slide) {
    // Not an address a browser opens: the runtime follows these attributes on a click, as it
    // does for an element's own link. Without `href` an anchor shows no hand, so it is asked for;
    // in a show it is also a stop of Tab, and Enter on it follows it (UI-06).
    return (
      <a
        data-link-kind="slide"
        data-link-target={slide}
        {...(mode === 'present' ? { tabIndex: 0, role: 'link' } : {})}
        dir={dir}
        style={{ ...LINK_STYLE, cursor: 'pointer', ...style }}
      >
        {run.text}
      </a>
    );
  }
  if (link && (opensLink ?? opensAddress)(link)) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        dir={dir}
        style={{ ...LINK_STYLE, ...style }}
      >
        {run.text}
      </a>
    );
  }
  return style || ltr ? (
    <span dir={dir} style={style}>
      {run.text}
    </span>
  ) : (
    <>{run.text}</>
  );
}

function Marker({ text, list, firstRun }: { text: string; list: ListInfo; firstRun?: Run }) {
  const size = markerFontSize(list, firstRun?.marks?.size);
  const color = list.color ?? firstRun?.marks?.color;
  return (
    <span
      aria-hidden
      data-slidr-marker
      style={{
        display: 'inline-block',
        // At least the column the indent leaves, and wider for a long or large marker, which then
        // pushes its line's text along rather than running into it.
        minWidth: `${markerWidthEm(list)}em`,
        boxSizing: 'border-box',
        paddingInlineEnd: '0.2em',
        whiteSpace: 'nowrap',
        marginInlineStart: `-${markerWidthEm(list)}em`,
        textIndent: 0,
        textAlign: 'start',
        textDecorationLine: 'none',
        ...(size !== undefined ? { fontSize: size } : {}),
        ...(color ? { color: colorCss(color) } : {}),
      }}
    >
      {text}
    </span>
  );
}

function paragraphContent(p: Paragraph, role: 'heading' | 'body', ltr: boolean): ReactNode {
  const empty = p.runs.every((r) => r.text === '');
  if (empty) {
    // An empty line still has the height of its text: a line break, in the first run's marks.
    const style = runStyle(p.runs[0]?.marks, role);
    return style ? (
      <span style={style}>
        <br />
      </span>
    ) : (
      <br />
    );
  }
  return p.runs.map((run, i) => <RunView key={i} run={run} role={role} ltr={ltr} />);
}

/**
 * The paragraphs of a rich text, without a box around them. Memoised: an element that is moved or
 * resized is drawn again, and its text, which is the object it was, is not.
 */
export const RichTextView = memo(function RichTextView({
  content,
  theme,
  defaults,
  dir,
}: {
  content: RichText;
  theme: Theme;
  defaults: TextDefaults;
  /** The direction of a `dir: auto` paragraph without letters: the deck's, or the table's. */
  dir: Direction;
}) {
  const markers = listMarkers(content.paragraphs);
  const direction = (p: Paragraph) => paragraphDirection(p.dir, paragraphText(p), dir);
  const number = (p: Paragraph) => readsAsNumber(p.dir, paragraphText(p), dir);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < content.paragraphs.length) {
    const first = content.paragraphs[i] as Paragraph;
    if (!first.list) {
      const role = theme.textStyles[first.styleRef ?? defaults.styleRef].font;
      out.push(
        <p key={i} dir={direction(first)} style={paragraphStyle(first, theme, defaults)}>
          {paragraphContent(first, role, number(first))}
        </p>,
      );
      i++;
      continue;
    }
    // A run of list paragraphs is one list element, of the kind of its first item.
    const start = i;
    const items: ReactNode[] = [];
    while (i < content.paragraphs.length && content.paragraphs[i]?.list) {
      const p = content.paragraphs[i] as Paragraph & { list: ListInfo };
      const role = theme.textStyles[p.styleRef ?? defaults.styleRef].font;
      items.push(
        <li
          key={i}
          dir={direction(p)}
          style={{
            ...paragraphStyle(p, theme, defaults),
            display: 'block',
            listStyle: 'none',
            paddingInlineStart: `${p.list.level * LEVEL_EM + MARKER_EM}em`,
          }}
        >
          <Marker text={markers[i] ?? ''} list={p.list} firstRun={p.runs[0]} />
          {paragraphContent(p, role, number(p))}
        </li>,
      );
      i++;
    }
    const Tag = first.list.kind === 'number' ? 'ol' : 'ul';
    out.push(
      <Tag key={`list-${start}`} style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {items}
      </Tag>,
    );
  }
  return <>{out}</>;
});

/**
 * The text of a slide-number element (SLD-04): the number of the slide it is drawn on, in the
 * paragraph and the marks of its first run. What the element itself holds is the look of the
 * number, and a stand-in for where no deck gives the slide one.
 */
export function numberedText(content: RichText, number: number | undefined): RichText {
  const first = content.paragraphs[0];
  if (number === undefined || !first) return content;
  return { paragraphs: [{ ...first, runs: [{ ...first.runs[0], text: String(number) }] }] };
}

/** The CSS that paints text with a background: the background, and its clip to the glyphs. */
const TEXT_FILL = new Set([
  'background',
  'background-image',
  'background-clip',
  '-webkit-background-clip',
]);

/**
 * The part of an element's `css` that fills its text with a background (`background-clip: text`,
 * a gradient fill of the text, TXT-11), for the box of the text itself. On a text box the
 * element's box is that box. A shape draws its own fill over the box of the element, which would
 * hide such a background, so the box of its text takes these properties as well.
 */
export function textFillStyle(css: Record<string, string> | undefined): CSSProperties | undefined {
  const own = Object.entries(css ?? {}).filter(([name]) =>
    TEXT_FILL.has(name.trim().toLowerCase()),
  );
  const clipped = own.some(
    ([name, value]) => /clip$/i.test(name.trim()) && value.trim() === 'text',
  );
  return clipped ? passthroughStyle(Object.fromEntries(own)) : undefined;
}

const V_ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' } as const;
/** Smallest scale `shrink` goes down to; below it the text overflows instead. */
const MIN_FIT = 0.25;
/** The zooms the search tells apart are steps 0 (`MIN_FIT`) to this one (1). */
const FIT_TOP = 2 ** 8;
/** The finest difference of zoom the search tells apart. */
const FIT_STEP = (1 - MIN_FIT) / FIT_TOP;

/**
 * The zoom of a step, as it is written on the DOM: to three places, which is what an export
 * keeps. The search measures the text at the very zoom it then leaves on it.
 */
const zoomAt = (step: number): number =>
  step >= FIT_TOP ? 1 : Math.floor((MIN_FIT + step * FIT_STEP) * 1000) / 1000;

/** The step each text was fitted at last, by the node that carries its zoom. */
const fittedSteps = new WeakMap<HTMLElement, number>();

function insetsStyle(padding: Insets | undefined): CSSProperties {
  if (!padding) return { padding: 0 };
  return {
    paddingTop: padding.top,
    paddingRight: padding.right,
    paddingBottom: padding.bottom,
    paddingLeft: padding.left,
  };
}

/**
 * Fits the content into the box (TXT-07 "shrink") and returns the scale. Text and spacing shrink
 * together through CSS `zoom` on the content, so the text re-wraps at the smaller size exactly as
 * if every size had been scaled. Measured in layout pixels, which ancestor transforms (the Stage
 * zoom) do not affect. The zoom is set on the DOM directly and is not part of the React style, so
 * a re-render does not undo it; an export that serialises the DOM keeps it.
 */
export function shrinkToFit(box: HTMLElement, measure: HTMLElement, content: HTMLElement): number {
  const cs = getComputedStyle(box);
  const available =
    box.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  let step = FIT_TOP;
  // No layout (a detached or hidden box) measures zero: leave the text as it is.
  if (available > 0) {
    // Every call lays the box out again.
    const fits = (at: number) => {
      const zoom = zoomAt(at);
      content.style.zoom = zoom === 1 ? '' : String(zoom);
      return measure.offsetHeight <= available + 0.5;
    };
    step = fittedStep(fits, fittedSteps.get(content));
    fittedSteps.set(content, step);
  }
  const result = zoomAt(step);
  content.style.zoom = result === 1 ? '' : String(result);
  return result;
}

/**
 * The largest step at which the text fits, or 0 when it fits at none and overflows at the
 * smallest zoom. A text is most often fitted again for one more letter, and its step still holds
 * while the next one still does not: two layouts settle that, where the whole search takes ten.
 * A text that no longer fits there (or now fits higher) is looked for from that step on, a step
 * away and then twice as far each time, so a few letters more cost a few layouts and not ten.
 */
function fittedStep(fits: (step: number) => boolean, last: number | undefined): number {
  if (last === undefined) {
    if (fits(FIT_TOP)) return FIT_TOP;
    return fits(0) ? largestFitting(fits, 0, FIT_TOP) : 0;
  }
  if (fits(last)) {
    if (last === FIT_TOP || !fits(last + 1)) return last;
    // Shorter text, or a larger box: up from the step after it.
    let lo = last + 1;
    for (let gap = 2; lo < FIT_TOP; gap *= 2) {
      const next = Math.min(FIT_TOP, last + gap);
      if (!fits(next)) return largestFitting(fits, lo, next);
      lo = next;
    }
    return FIT_TOP;
  }
  // Longer text, or a smaller box: down from it.
  let hi = last;
  for (let gap = 1; hi > 0; gap *= 2) {
    const next = Math.max(0, last - gap);
    if (fits(next)) return largestFitting(fits, next, hi);
    hi = next;
  }
  return 0;
}

/** Between a step at which the text fits (`lo`) and one at which it does not (`hi`). */
function largestFitting(fits: (step: number) => boolean, lo: number, hi: number): number {
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Counts finished web-font loads, so text measured before its font arrived is measured again. */
function useFontLoads(enabled: boolean): number {
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || !document.fonts) return;
    const bump = () => setLoads((n) => n + 1);
    document.fonts.addEventListener('loadingdone', bump);
    return () => document.fonts.removeEventListener('loadingdone', bump);
  }, [enabled]);
  return loads;
}

/** The box of a text element or of the text inside a shape: padding, vertical alignment, fitting. */
export function TextBox({
  content,
  vAlign,
  padding,
  autoFit,
  columns,
  wrap,
  size,
  styleRef = 'body',
  color,
  children,
}: {
  content: RichText;
  vAlign: TextElement['vAlign'];
  padding?: Insets;
  autoFit: TextElement['autoFit'];
  columns?: number;
  wrap?: boolean;
  /** The size of the element's frame: text that shrinks to fit is fitted again when it changes. */
  size?: { w: number; h: number };
  styleRef?: TextStyleRef;
  /** The colour of the text where a run sets none, in place of the text style's (`TextElement.color`). */
  color?: Color;
  /** Shown instead of the text (a `TextSlot`); the box around it stays the same. */
  children?: ReactNode;
}) {
  const ctx = useRenderContext();
  const box = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const shrink = autoFit === 'shrink';
  const fontLoads = useFontLoads(shrink);
  /** The size of the box the text was last fitted into. */
  const fitted = useRef<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!box.current || !measure.current || !inner.current) return;
    if (shrink) {
      // The box is as large as its frame whatever the zoom of the text in it: read before the
      // fit writes a zoom, the size costs no layout of its own.
      const size = { w: box.current.clientWidth, h: box.current.clientHeight };
      shrinkToFit(box.current, measure.current, inner.current);
      fitted.current = size;
    } else inner.current.style.zoom = '';
    // The frame is among what the fit depends on: a resize gives the element a new frame and
    // leaves its text, its padding and the theme the objects they were (ADR-007).
  }, [shrink, fontLoads, content, padding, columns, wrap, ctx.theme, size?.w, size?.h]);
  // And whatever else makes the box another size (the element's own `css`, a slot): the box
  // itself is watched, since it is what the text is measured against.
  useLayoutEffect(() => {
    const el = box.current;
    if (!shrink || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const size = { w: el.clientWidth, h: el.clientHeight };
      const last = fitted.current;
      if (last && last.w === size.w && last.h === size.h) return;
      if (!measure.current || !inner.current) return;
      shrinkToFit(el, measure.current, inner.current);
      fitted.current = size;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shrink]);
  const grow = autoFit === 'growHeight';
  // The same object while the settings stay, so the text is not drawn again with its box.
  const defaults = useMemo<TextDefaults>(
    () => ({ styleRef, wrap: wrap ?? true, ...(color ? { color: colorCss(color) } : {}) }),
    [styleRef, wrap, color],
  );
  return (
    <div
      ref={box}
      data-slidr-text
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: V_ALIGN[vAlign],
        boxSizing: 'border-box',
        width: '100%',
        height: grow ? 'auto' : '100%',
        ...insetsStyle(padding),
      }}
    >
      <div ref={measure} data-slidr-text-block style={{ flex: 'none' }}>
        <div
          ref={inner}
          style={columns && columns > 1 ? { columnCount: columns, columnGap: 48 } : undefined}
        >
          {children ?? (
            <RichTextView content={content} theme={ctx.theme} defaults={defaults} dir={ctx.dir} />
          )}
        </div>
      </div>
    </div>
  );
}
