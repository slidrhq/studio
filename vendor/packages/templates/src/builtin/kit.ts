/**
 * What the built-in templates are drawn with. All three are drawn right-to-left, as their
 * reference decks are: `start` is the right side. A frame is given by its distance from the
 * start side, so the numbers here are the ones in the deck's HTML (`inset-inline-start`).
 */
import {
  createElement,
  refitAll,
  rotatedBounds,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type AssetMeta,
  type Background,
  type ChartElement,
  type Color,
  type ColorToken,
  type Deck,
  type Element,
  type Fill,
  type Frame,
  type Layout,
  type Paragraph,
  type Placeholder,
  type PlaceholderRole,
  type RichText,
  type ShapeElement,
  type Slide,
  type TableCell,
  type TextElement,
  type TextStyleRef,
} from '@slidr/model';
import { createSlide, type LayoutContent, type RoleFill } from '../createSlide';
import { deckFromTemplate } from '../deck';
import { mirrorLayout } from '../mirror';
import type { Template } from '../template';

/** A frame at a distance from the start side (the right) of a right-to-left slide. */
export const at = (start: number, top: number, w: number, h: number): Frame => ({
  x: SLIDE_WIDTH - start - w,
  y: top,
  w,
  h,
});

/** A frame at a distance from the end side (the left). */
export const atEnd = (end: number, top: number, w: number, h: number): Frame => ({
  x: end,
  y: top,
  w,
  h,
});

export const token = (name: ColorToken, alpha?: number): Color =>
  alpha === undefined ? { token: name } : { token: name, alpha };

export const solid = (color: Color): Fill => ({ kind: 'solid', color });

export const NO_FILL: Fill = { kind: 'none' };

/**
 * The ground of the theme's surface colour: the background every theme offers beside its own
 * (`Theme.backgroundVariants`, which the Background tool shows as the template's choices).
 *
 * A theme offers only grounds that all five of its text styles read on. Text takes its colour
 * from its text style unless its placeholder gives it one (SPEC 5.5), and a placeholder gives
 * one only for a field the layout itself draws under it. A ground is the slide's, under every
 * text of the slide, so on a field of the primary colour the template's own text is lost: black
 * on black in `defus`, 1.3:1 in `tzuk` and `lavan`. Such fields were offered and are not any more. `builtin.test.ts` holds every theme to this, and
 * the acceptance tests of a template try each variant behind every slide of its sample.
 */
export const SURFACE: Background = { fill: { kind: 'solid', color: { token: 'surface' } } };

/** A placeholder. The alignment is always stated, so text is seated on the layout's side. */
export function place(
  id: string,
  role: PlaceholderRole,
  frame: Frame,
  styleRef: TextStyleRef | undefined = undefined,
  rest: Pick<Placeholder, 'align' | 'vAlign' | 'color'> = {},
): Placeholder {
  const text = role !== 'image' && role !== 'logo' && role !== 'chart' && role !== 'table';
  return {
    id,
    role,
    frame,
    ...(styleRef ? { styleRef } : {}),
    ...(text ? { align: 'start' as const } : {}),
    ...rest,
  };
}

/** A box: a card, a rule, a bar. */
export function rect(
  id: string,
  frame: Frame,
  fill: Fill,
  rest: Partial<Pick<ShapeElement, 'stroke' | 'effects' | 'opacity' | 'geometry'>> = {},
): ShapeElement {
  return createElement.shape({ id, frame, fill, ...rest });
}

/** A dot. */
export function dot(
  id: string,
  frame: Frame,
  fill: Fill,
  rest: Partial<Pick<ShapeElement, 'stroke' | 'opacity'>> = {},
): ShapeElement {
  return createElement.shape({
    id,
    frame,
    fill,
    geometry: { kind: 'preset', preset: 'ellipse' },
    ...rest,
  });
}

/** Text that belongs to the layout itself: a step number, a mark. */
export function label(
  id: string,
  frame: Frame,
  text: string,
  styleRef: TextStyleRef,
  rest: {
    color?: Color;
    weight?: number;
    dir?: Paragraph['dir'];
    align?: Paragraph['align'];
    vAlign?: TextElement['vAlign'];
  } = {},
): TextElement {
  const { color, weight, dir = 'ltr', align = 'end', vAlign = 'top' } = rest;
  const marks = { ...(color ? { color } : {}), ...(weight ? { weight } : {}) };
  return createElement.text({
    id,
    frame,
    vAlign,
    content: {
      paragraphs: [
        {
          dir,
          align,
          styleRef,
          runs: [{ text, ...(Object.keys(marks).length > 0 ? { marks } : {}) }],
        },
      ],
    },
  });
}

/**
 * The number of the slide, drawn by the layout (SLD-04): a text whose role makes the renderer
 * write the slide's own number in it. A figure reads left to right and sits on the deck's side,
 * so `end` is the far corner in both directions; `1` stands in where no deck numbers the slide.
 */
export function pageNumber(
  id: string,
  frame: Frame,
  styleRef: TextStyleRef = 'caption',
  rest: Parameters<typeof label>[4] = {},
): TextElement {
  return {
    ...label(id, frame, '1', styleRef, { dir: 'auto', align: 'end', ...rest }),
    role: 'slideNumber',
    name: 'slide number',
  };
}

/** Inline SVG whose colours follow the theme: each literal colour of the markup maps to a token. */
export function drawing(
  id: string,
  frame: Frame,
  markup: string,
  colors: Record<string, Color>,
  rest: { role?: PlaceholderRole; name?: string } = {},
): Element {
  return createElement.svg({ id, frame, markup, colorOverrides: colors, ...rest });
}

/** How far above the top of the foot a decoration may start and still be part of it. */
const FOOT_ZONE = 24;

/** The share of the slide a decoration covers from which it is the slide's ground. */
const GROUND = 0.9;

/** An element with every group in it fitted to what it holds (ARR-01), as the Stage keeps them. */
function fitted(element: Element): Element {
  const placements = refitAll([element]);
  if (placements.size === 0) return element;
  const fit = (one: Element): Element => {
    const placed: Element = { ...one, ...placements.get(one.id) };
    return placed.type === 'group' ? { ...placed, children: placed.children.map(fit) } : placed;
  };
  return fit(element);
}

/**
 * Whether a decoration of a layout frames every slide, and so stays the layout's: a master
 * component (the logo, the slide's number, the deck's footer: SLD-04), what stands in the foot
 * of the slide with them, and a ground that covers the slide, which a press anywhere on the
 * slide would pick if the slide held it. A hidden decoration stays as it is.
 */
export function framesTheSlide(layout: Layout): (decoration: Element) => boolean {
  const master = (d: Element) =>
    d.role === 'logo' || d.role === 'slideNumber' || d.role === 'footer';
  const low = [
    ...layout.decorations.filter(master).map((d) => d.frame.y),
    ...layout.placeholders.filter((p) => p.role === 'footer').map((p) => p.frame.y),
  ].filter((y) => y > SLIDE_HEIGHT / 2);
  const foot = low.length > 0 ? Math.min(...low) - FOOT_ZONE : Infinity;
  return (decoration) => {
    if (master(decoration) || decoration.hidden) return true;
    const box = rotatedBounds(decoration.frame, decoration.rotation);
    if (box.y >= foot) return true;
    const x = Math.max(0, Math.min(box.x + box.w, SLIDE_WIDTH) - Math.max(box.x, 0));
    const y = Math.max(0, Math.min(box.y + box.h, SLIDE_HEIGHT) - Math.max(box.y, 0));
    return x * y >= GROUND * SLIDE_WIDTH * SLIDE_HEIGHT;
  };
}

/** Whether two boxes share some area. */
const overlap = (a: Frame, b: Frame) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A template whose layouts give what makes up their slides as objects (`Layout.objects`): the
 * slide holds them, and the user moves, restyles and deletes them like anything else. Every
 * decoration that does not frame the slide (`framesTheSlide`) goes over, in its order, with its
 * groups fitted to what they hold; the layouts drawn for the other direction are split the same
 * way. Called before the sample is made, so the sample holds the objects.
 *
 * What a decoration that stays is drawn over stays under it: the slide's objects are drawn over
 * every decoration, and the card the slide's number stands on would cover the number.
 */
export function withObjects(template: Template): Template {
  const split = (layout: Layout): Layout => {
    const frames = framesTheSlide(layout);
    const drawn = layout.decorations.map(fitted);
    const boxes = drawn.map((d) => rotatedBounds(d.frame, d.rotation));
    const kept = new Set(drawn.filter(frames));
    for (let grew = true; grew;) {
      grew = false;
      drawn.forEach((d, i) => {
        if (kept.has(d)) return;
        const under = drawn.some((k, j) => j > i && kept.has(k) && overlap(boxes[i]!, boxes[j]!));
        if (under) {
          kept.add(d);
          grew = true;
        }
      });
    }
    const objects = [...(layout.objects ?? []), ...drawn.filter((d) => !kept.has(d))];
    return {
      ...layout,
      decorations: drawn.filter((d) => kept.has(d)),
      ...(objects.length > 0 ? { objects } : {}),
    };
  };
  return {
    ...template,
    layouts: template.layouts.map(split),
    ...(template.flipped ? { flipped: template.flipped.map(split) } : {}),
  };
}

/** Whether box `a` lies wholly within box `b`. */
const within = (a: Frame, b: Frame) =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/**
 * What layouts keep of their drawings that their slides should hold (ADR-094), by the id of the
 * layout: when none of them gives its slide objects (the template did not go through
 * `withObjects`), every decoration that does not frame the slide; otherwise one that stays only
 * because a decoration drawn over it reaches into it. One that a decoration drawn over it stands
 * on wholly stays as it should: the field under the foot, the card under the slide's number.
 * The layouts of one direction at a time: those drawn for the other have the same ids.
 */
export function lockedDrawings(layouts: readonly Layout[]): Map<string, Element[]> {
  const given = layouts.some((layout) => layout.objects?.length);
  const locked = new Map<string, Element[]>();
  for (const layout of layouts) {
    const frames = framesTheSlide(layout);
    const boxes = layout.decorations.map((d) => rotatedBounds(d.frame, d.rotation));
    const drawings = layout.decorations.filter(
      (d, i) => !frames(d) && (!given || !boxes.some((box, j) => j > i && within(box, boxes[i]!))),
    );
    if (drawings.length > 0) locked.set(layout.id, drawings);
  }
  return locked;
}

/**
 * Layouts for the other direction that the mirror alone does not get right (`Template.flipped`):
 * the mirror of each, with the background drawn by hand. Free CSS is the case: a glow in a
 * corner is not something `mirrorLayout` can turn.
 */
export function flipBackgrounds(
  layouts: readonly Layout[],
  backgrounds: Record<string, Background>,
): Layout[] {
  return layouts.flatMap((layout) => {
    const background = backgrounds[layout.id];
    return background ? [{ ...mirrorLayout(layout), background }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Content of the sample slides

/** A paragraph of plain text. `auto` reads in the direction of its first letter. */
export function para(text: string, rest: Partial<Paragraph> = {}): Paragraph {
  return { dir: 'auto', align: 'start', runs: text ? [{ text }] : [], ...rest };
}

/** Plain text, a paragraph per line. */
export function text(...lines: string[]): RichText {
  return { paragraphs: lines.map((line) => para(line)) };
}

/** A bulleted list. */
export function bullets(...lines: string[]): RichText {
  return { paragraphs: lines.map((line) => para(line, { list: { kind: 'bullet', level: 0 } })) };
}

/**
 * A list whose lines each open with a few words in bold, as the text slide of a sample has it:
 * `[opening, rest]` a line, bulleted or numbered, the marks in the colour `mark`, and `gap`
 * pixels between one line and the next.
 */
export function points(
  lines: readonly (readonly [opening: string, rest?: string])[],
  look: { kind?: 'bullet' | 'number'; mark?: Color; gap?: number } = {},
): RichText {
  const { kind = 'bullet', mark, gap = 0 } = look;
  return {
    paragraphs: lines.map(([opening, rest], i) =>
      para('', {
        list: { kind, level: 0, ...(mark ? { color: mark } : {}) },
        ...(gap > 0 && i < lines.length - 1 ? { spaceAfter: gap } : {}),
        runs: [{ text: opening, marks: { weight: 700 } }, ...(rest ? [{ text: rest }] : [])],
      }),
    ),
  };
}

const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;
const LETTER = /\p{L}/u;

/**
 * The direction of a sample paragraph, as the Markdown of `text_set` would set it: the deck's,
 * unless the text has letters and none of them is of that direction. A Hebrew sentence that
 * opens with an English term is still a Hebrew sentence; `auto` would turn it around.
 */
function settled(paragraph: Paragraph, deckDir: 'rtl' | 'ltr'): Paragraph {
  if (paragraph.dir !== 'auto') return paragraph;
  const letters = [...paragraph.runs.map((run) => run.text).join('')].filter((c) => LETTER.test(c));
  if (letters.length === 0) return paragraph;
  const rtl = letters.some((letter) => RTL_LETTER.test(letter));
  const ltr = letters.some((letter) => !RTL_LETTER.test(letter));
  const dir = deckDir === 'rtl' ? (rtl ? 'rtl' : 'ltr') : ltr ? 'ltr' : 'rtl';
  return { ...paragraph, dir };
}

function settledContent(content: LayoutContent, deckDir: 'rtl' | 'ltr'): LayoutContent {
  const fill = (value: RoleFill): RoleFill =>
    'paragraphs' in value
      ? { paragraphs: value.paragraphs.map((paragraph) => settled(paragraph, deckDir)) }
      : value;
  const out: LayoutContent = {};
  for (const [role, value] of Object.entries(content)) {
    if (value === undefined) continue;
    out[role as PlaceholderRole] = Array.isArray(value)
      ? (value as readonly RoleFill[]).map(fill)
      : fill(value as RoleFill);
  }
  return out;
}

/** One sample slide: the layout, what goes into its placeholders, and what a role cannot say. */
export interface SampleSlide {
  layout: string;
  name: string;
  content: LayoutContent;
  /** The data of the slide's chart. */
  chart?: Pick<ChartElement, 'chartType' | 'data'> & { title?: string };
  /** The rows of the slide's table, header first. */
  table?: { rows: string[][]; cols: number[]; rowHeight: number };
}

/** A small seeded generator, so the ids of the sample slides are the same on every call. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sample slides of a template, made by the engine itself from the template's layouts:
 * `createSlide` for every slide, in a deck of the given direction, so every element sits on its
 * placeholder. Content the layout has no place for is an error: a sample shows the template.
 */
export function sampleSlides(
  template: Template,
  slides: readonly SampleSlide[],
  options: { dir?: 'rtl' | 'ltr'; lang?: string; seed?: number } = {},
): Slide[] {
  const dir = options.dir ?? template.dir;
  const lang = options.lang ?? (dir === 'rtl' ? 'he' : 'en');
  const deck = deckFromTemplate(template, { lang, dir });
  // The pictures of the sample: a deck that only takes the template does not carry them.
  deck.assets = { ...deck.assets, ...template.assets };
  const random = seeded(options.seed ?? 1);
  for (const sample of slides) {
    const { slide, unplaced } = createSlide(
      deck,
      { layoutId: sample.layout, name: sample.name, content: settledContent(sample.content, dir) },
      { random },
    );
    if (unplaced.length > 0) {
      throw new Error(`${sample.layout} has no place for ${unplaced.join(', ')}`);
    }
    for (const element of slide.elements) {
      if (element.type === 'chart' && sample.chart) {
        element.chartType = sample.chart.chartType;
        element.data = sample.chart.data;
        if (sample.chart.title) element.options.title = sample.chart.title;
      }
      if (element.type === 'table' && sample.table) {
        const { rows, cols, rowHeight } = sample.table;
        element.cols = cols;
        element.rows = rows.map(() => rowHeight);
        element.cells = rows.map((row) =>
          row.map((cell): TableCell => ({ content: { paragraphs: [settled(para(cell), dir)] } })),
        );
      }
    }
    deck.slides.push(slide);
  }
  return deck.slides;
}

/** A deck on a template with sample slides on it, in the direction the slides were written for. */
export function sampleDeck(
  template: Template,
  slides: readonly SampleSlide[],
  options: { dir: 'rtl' | 'ltr'; lang: string },
): Deck {
  const deck = deckFromTemplate(template, options);
  deck.assets = { ...deck.assets, ...template.assets };
  deck.slides = sampleSlides(template, slides, options);
  return deck;
}

/** The asset table of a template from its picture files. */
export function assetTable(assets: readonly AssetMeta[]): Record<string, AssetMeta> {
  return Object.fromEntries(assets.map((asset) => [asset.id, asset]));
}
