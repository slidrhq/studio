import { newId, ulid } from './ids';
import {
  SCHEMA_VERSION,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type AudioElement,
  type ChartElement,
  type Deck,
  type Direction,
  type Element,
  type GroupElement,
  type HtmlElement,
  type ImageElement,
  type Layout,
  type LineElement,
  type Marks,
  type Paragraph,
  type RichText,
  type ShapeElement,
  type Slide,
  type SvgElement,
  type TableElement,
  type TextElement,
  type TextStyleRef,
  type Theme,
  type VideoElement,
} from './schema';

export interface RichTextOptions {
  dir?: Paragraph['dir'];
  align?: Paragraph['align'];
  styleRef?: TextStyleRef;
  marks?: Marks;
}

/** Rich text from plain text: one paragraph per line, one run per paragraph. */
export function richText(text: string, options: RichTextOptions = {}): RichText {
  const { dir = 'auto', align = 'start', styleRef, marks } = options;
  return {
    paragraphs: text.split('\n').map((line) => ({
      dir,
      align,
      ...(styleRef ? { styleRef } : {}),
      runs: line ? [{ text: line, ...(marks ? { marks } : {}) }] : [],
    })),
  };
}

/** The text of a rich text without its formatting: paragraphs joined by newlines. */
export function plainText(content: RichText): string {
  return content.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}

type Common = 'id' | 'type' | 'rotation' | 'opacity';
/** What a factory needs: the element without its type, with the defaulted fields optional. */
type Init<T extends Element, Defaulted extends keyof T = never> = Omit<T, Common | Defaulted> &
  Partial<Pick<T, Exclude<Common, 'type'> | Defaulted>>;

function common(init: { id?: string; rotation?: number; opacity?: number }) {
  return { id: init.id ?? newId('e'), rotation: init.rotation ?? 0, opacity: init.opacity ?? 1 };
}

/** Builds elements with the usual defaults filled in. The id is generated unless given. */
export const createElement = {
  text: (init: Init<TextElement, 'autoFit' | 'vAlign'>): TextElement => ({
    autoFit: 'none',
    vAlign: 'top',
    ...init,
    ...common(init),
    type: 'text',
  }),
  image: (init: Init<ImageElement, 'fit'>): ImageElement => ({
    fit: 'cover',
    ...init,
    ...common(init),
    type: 'image',
  }),
  shape: (init: Init<ShapeElement, 'geometry' | 'fill'>): ShapeElement => ({
    geometry: { kind: 'preset', preset: 'rect' },
    fill: { kind: 'solid', color: { token: 'primary' } },
    ...init,
    ...common(init),
    type: 'shape',
  }),
  line: (init: Init<LineElement, 'stroke' | 'startHead' | 'endHead' | 'curve'>): LineElement => ({
    stroke: { color: { token: 'text' }, width: 2 },
    startHead: 'none',
    endHead: 'none',
    curve: 'straight',
    ...init,
    ...common(init),
    type: 'line',
  }),
  svg: (init: Init<SvgElement>): SvgElement => ({ ...init, ...common(init), type: 'svg' }),
  group: (init: Init<GroupElement>): GroupElement => ({ ...init, ...common(init), type: 'group' }),
  table: (init: Init<TableElement, 'style'>): TableElement => ({
    style: { headerRow: true, bandedRows: false, firstColumn: false },
    ...init,
    ...common(init),
    type: 'table',
  }),
  chart: (init: Init<ChartElement, 'options'>): ChartElement => ({
    options: {
      legend: { show: true, position: 'bottom' },
      axes: { x: { show: true }, y: { show: true } },
      labels: false,
    },
    ...init,
    ...common(init),
    type: 'chart',
  }),
  video: (init: Init<VideoElement, 'autoplay' | 'loop' | 'muted' | 'volume'>): VideoElement => ({
    autoplay: false,
    loop: false,
    muted: false,
    volume: 1,
    ...init,
    ...common(init),
    type: 'video',
  }),
  audio: (
    init: Init<AudioElement, 'autoplay' | 'loop' | 'volume' | 'showControls'>,
  ): AudioElement => ({
    autoplay: false,
    loop: false,
    volume: 1,
    showControls: true,
    ...init,
    ...common(init),
    type: 'audio',
  }),
  html: (init: Init<HtmlElement, 'hasScripts'>): HtmlElement => ({
    hasScripts: false,
    ...init,
    ...common(init),
    type: 'html',
  }),
};

export function createSlide(init: Partial<Slide> = {}): Slide {
  return { elements: [], timeline: [], ...init, id: init.id ?? newId('s') };
}

/**
 * A plain, neutral theme, so that a deck is valid before a template is chosen. The designed
 * templates are a separate package (WG7).
 */
export function createBaseTheme(): Theme {
  const text = { token: 'text' } as const;
  return {
    id: 'basic',
    name: 'Basic',
    colors: {
      bg: '#ffffff',
      surface: '#f3f4f6',
      text: '#15171a',
      muted: '#5f6672',
      primary: '#2f5bea',
      secondary: '#0f9d8a',
      accent: '#f59e0b',
      chart: ['#2f5bea', '#0f9d8a', '#f59e0b', '#e5484d', '#8e4ec6', '#5f6672'],
    },
    fonts: {
      heading: { he: 'Heebo', latin: 'Inter' },
      body: { he: 'Heebo', latin: 'Inter' },
    },
    textStyles: {
      display: { font: 'heading', size: 112, weight: 800, lineHeight: 1.05, color: text },
      title: { font: 'heading', size: 72, weight: 700, lineHeight: 1.1, color: text },
      heading: { font: 'heading', size: 44, weight: 600, lineHeight: 1.2, color: text },
      body: { font: 'body', size: 30, weight: 400, lineHeight: 1.45, color: text },
      caption: { font: 'body', size: 22, weight: 400, lineHeight: 1.4, color: { token: 'muted' } },
    },
    radius: 16,
    shadow: { x: 0, y: 12, blur: 32, color: { value: '#000000', alpha: 0.14 } },
    background: { fill: { kind: 'solid', color: { token: 'bg' } } },
    // The Background tool offers these as the theme's own, so a theme offers only grounds that
    // all five of its text styles read on, as the built-in templates do (`SURFACE` in their
    // kit). A field of the primary colour was here too: the body text was at 3.25:1 on it and
    // the caption at 1.05:1. A deck saved with that variant keeps it; a new one is not offered it.
    backgroundVariants: [{ fill: { kind: 'solid', color: { token: 'surface' } } }],
  };
}

export interface CreateDeckOptions {
  id?: string;
  title?: string;
  lang?: string;
  dir?: Direction;
  theme?: Theme;
  layouts?: Layout[];
  slides?: Slide[];
  now?: Date;
}

/** Languages written right to left: Hebrew, Arabic, Persian, Urdu and their neighbours. */
const RTL = new Set(['he', 'iw', 'yi', 'ar', 'fa', 'ur', 'ps', 'sd', 'ug', 'ckb', 'dv']);

/** Whether a language tag is of a language written right to left: "he", "ar-EG", "fa-IR". */
export function isRtlLanguage(lang: string): boolean {
  return RTL.has(lang.toLowerCase().split(/[-_]/)[0] ?? '');
}

/** A new deck. Without `dir`, a deck in a right-to-left language is right-to-left. */
export function createDeck(options: CreateDeckOptions = {}): Deck {
  const lang = options.lang ?? 'he';
  const now = (options.now ?? new Date()).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: options.id ?? ulid(),
    meta: {
      title: options.title ?? '',
      lang,
      dir: options.dir ?? (isRtlLanguage(lang) ? 'rtl' : 'ltr'),
      createdAt: now,
      updatedAt: now,
    },
    size: { w: SLIDE_WIDTH, h: SLIDE_HEIGHT },
    theme: options.theme ?? createBaseTheme(),
    layouts: options.layouts ?? [],
    slides: options.slides ?? [],
    assets: {},
  };
}
