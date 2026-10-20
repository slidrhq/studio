/**
 * A design of the Elements gallery, from the HTML files Claude wrote, one for each language of
 * its request (Hebrew and English always, and any other content language chosen), to the slides
 * the app's catalog holds (`elements/designs/managed.json`):
 *
 * - converted by the app's own engine (`@slidr/html-import`), as the agent's slides are;
 * - made independent of any deck: text styles linked to the theme are written out on the runs,
 *   so every run names its font (`designs.test.ts`), and a design keeps its look in any deck;
 * - checked against the contract `apps/desktop/src/elements/designs.test.ts` holds every design
 *   to, and by the app's design check (`@slidr/lint`, the rules the agent is held to);
 * - given the point on its picture's subject that the gallery's tests and the editor rely on.
 */
import type { HtmlSlideConversion } from '@slidr/agent-tools';
import { createConversionService } from '@slidr/html-import';
import { lintSlide } from '@slidr/lint';
import {
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  createDeck,
  languageDir,
  languagesOf,
  plainText,
  Slide,
  walkElements,
  type AssetMeta,
  type Color,
  type ContentLanguage,
  type Deck,
  type Element,
  type Localized,
  type Marks,
  type Slide as SlideModel,
  type TextStyleRef,
  type Theme,
} from '@slidr/model';
import { measureSlide, renderSlideOffscreen, type AssetResolver } from '@slidr/renderer';
import { familiesIn, loadFamilies } from './fonts';

export const SUBJECT = '__subject__';
/** A language a design is made in: any content language of the app (`@slidr/model`). */
export type Lang = ContentLanguage;

const isBase = (lang: Lang) => (BASE_LANGUAGES as readonly Lang[]).includes(lang);

/** The languages of a design: those asked for, Hebrew and English always, in the app's order. */
export function designLanguages(wanted: readonly Lang[]): Lang[] {
  return CONTENT_LANGUAGES.filter((lang) => isBase(lang) || wanted.includes(lang));
}

export interface Picture {
  url: string;
  width: number;
  height: number;
}

export interface Finding {
  rule: string;
  severity: string;
  message: string;
  elementIds: string[];
}

export interface LangResult {
  slide?: SlideModel;
  editability?: number;
  notes?: string[];
  issues: string[];
  findings: Finding[];
  fonts: string[];
  error?: string;
  /** The slide as the engine gave it, before it was made independent of the theme (debug). */
  raw?: SlideModel;
  /** The design check of the raw slide (debug). */
  rawFindings?: Finding[];
}

export interface DesignResult {
  designId: string;
  revision: number;
  /** Each language the design was made in: Hebrew and English, and any other asked for. */
  langs: Localized<LangResult>;
  /** A point on the picture's subject, in left-to-right slide pixels. */
  subject: [number, number] | null;
  /** Issues that concern every language. */
  issues: string[];
  /** The contract holds: the design may be approved and published. */
  publishable: boolean;
}

/** The record of the picture, under the id the catalog's slides name it by. */
export function subjectAsset(picture: Picture): AssetMeta {
  return {
    id: SUBJECT,
    file: 'subject.png',
    mime: 'image/png',
    kind: 'image',
    origin: 'ai',
    bytes: 0,
    width: picture.width,
    height: picture.height,
  };
}

/** A deck of one language that holds the picture, to convert into and to render with. */
export function designDeck(lang: Lang, picture: Picture, slides: SlideModel[] = []): Deck {
  const deck = createDeck({ lang, slides });
  deck.assets[SUBJECT] = subjectAsset(picture);
  return deck;
}

export function pictureResolver(picture: Picture): AssetResolver {
  return (asset) => (asset.id === SUBJECT ? picture.url : undefined);
}

/* ---------------------------------------------------------------- conversion */

function blankPicture(width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no picture'))), 'image/png');
  });
}

declare global {
  interface Window {
    /** Set by the headless browser: a real picture of a region of the page, as base64 PNG. */
    __slidrCapture?: (rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<string>;
  }
}

/** Pictures of the page for the engine's fidelity guard: real ones in the headless browser. */
async function capture(rect: { x: number; y: number; width: number; height: number }) {
  if (!window.__slidrCapture) return blankPicture(rect.width, rect.height);
  const base64 = await window.__slidrCapture(rect);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

/** Assets the conversion stored: pictures other than the subject, which a design may not have. */
const stored: AssetMeta[] = [];

const service = (picture: Picture) =>
  createConversionService({
    capture,
    async storeAsset(bytes, info) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const id = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      const asset: AssetMeta = {
        id,
        file: `${id}.bin`,
        mime: info.mime,
        kind: info.mime.startsWith('image/') ? 'image' : 'other',
        bytes: bytes.byteLength,
        origin: 'import',
        ...(info.name ? { name: info.name } : {}),
      };
      stored.push(asset);
      return asset;
    },
    resolveAsset: pictureResolver(picture),
  });

/* ---------------------------------------------------------------- independence from the deck */

function literal(color: Color, theme: Theme): Color {
  if (!('token' in color)) return color;
  const value = (theme.colors as Record<string, unknown>)[color.token];
  if (typeof value !== 'string') return color;
  return color.alpha === undefined ? { value } : { value, alpha: color.alpha };
}

/**
 * Writes the text style a paragraph was drawn in out on its runs (font, size, weight, colour,
 * spacing) and on the paragraph (line height), so that a design inserted into a deck keeps its
 * type whatever that deck's theme says. Every run then names its font.
 *
 * The paragraph keeps a link to a text style for one thing only, the size of its line box: CSS
 * makes a line at least as tall as the paragraph's own font size times the line height, so the
 * engine links small text to a small style (a 24px kicker to `caption`). The link goes to the
 * theme's smallest style, which never makes a line taller than its text in any deck.
 */
export function detachFromTheme(slide: SlideModel, theme: Theme, lang: Lang): SlideModel {
  const copy = structuredClone(slide);
  // A run that names no font gets the theme's Hebrew family in Hebrew, its Latin one in any other
  // language (where the Latin family lacks the letters, the system's font draws them).
  const fontOf = (role: 'heading' | 'body') => {
    const pair = theme.fonts[role];
    return lang === 'he' ? pair.he : pair.latin;
  };
  const refs = Object.keys(theme.textStyles) as TextStyleRef[];
  const smallest = refs.reduce((a, b) =>
    theme.textStyles[b].size < theme.textStyles[a].size ? b : a,
  );
  for (const element of walkElements(copy.elements)) {
    const content =
      element.type === 'text' || element.type === 'shape' ? element.content : undefined;
    for (const paragraph of content?.paragraphs ?? []) {
      // A paragraph without a link is drawn in `body` (`packages/renderer/src/text.tsx`).
      const style = theme.textStyles[paragraph.styleRef ?? 'body'];
      for (const run of paragraph.runs) {
        const marks: Marks = { ...run.marks };
        marks.font ??= fontOf(style.font);
        marks.size ??= style.size;
        marks.weight ??= style.weight;
        marks.color ??= style.color;
        marks.letterSpacing ??= style.letterSpacing ?? 0;
        if (style.case) marks.case ??= style.case;
        marks.color = literal(marks.color, theme);
        if (marks.highlight) marks.highlight = literal(marks.highlight, theme);
        run.marks = marks;
      }
      paragraph.lineHeight ??= style.lineHeight;
      paragraph.styleRef = smallest;
    }
  }
  return copy;
}

/* ---------------------------------------------------------------- the contract */

/** The words of a placeholder, in the languages a design may be made in. */
export const PLACEHOLDER = new RegExp(
  [
    'lorem ipsum',
    'placeholder',
    'add your text',
    'your text here',
    'טקסט לדוגמה',
    'הכנס טקסט',
    'نص تجريبي',
    'أدخل النص',
    'platzhalter',
    'ihr text hier',
    'texto de ejemplo',
    'texte d’exemple',
    "texte d'exemple",
    'votre texte ici',
    'testo segnaposto',
    'seu texto aqui',
    'текст-заполнитель',
    'ваш текст здесь',
    'metninizi buraya',
    'văn bản mẫu',
    'teks contoh',
    'यहाँ टेक्स्ट',
    'ダミーテキスト',
    'ここにテキスト',
    '여기에 텍스트',
    '占位文本',
    '在此输入文本',
  ].join('|'),
  'i',
);

function worded(elements: readonly Element[]) {
  return elements.flatMap((element) =>
    (element.type === 'text' || element.type === 'shape') && element.content
      ? [element.content]
      : [],
  );
}

/** What `designs.test.ts` would fail on, and what a design of the gallery may not have. */
export function contractIssues(slide: SlideModel, conversion: HtmlSlideConversion): string[] {
  const issues: string[] = [];
  const parsed = Slide.safeParse(slide);
  if (!parsed.success) {
    issues.push(`The slide is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}.`);
  }
  const pictures = new Set<string>();
  for (const element of walkElements(slide.elements)) {
    if (element.type !== 'image') continue;
    if (element.assetId) pictures.add(element.assetId);
    else
      issues.push(
        'An image frame has no picture (an empty placeholder); use data-asset="__subject__".',
      );
  }
  if (!pictures.has(SUBJECT))
    issues.push('The picture (data-asset="__subject__") is not on the slide.');
  const others = [...pictures].filter((id) => id !== SUBJECT);
  if (others.length > 0 || conversion.assets.length > 0) {
    issues.push(
      'The slide has a raster picture other than __subject__ (a src, a data: URL or a CSS background image). Draw decoration as inline SVG or CSS.',
    );
  }
  const texts = worded(slide.elements);
  if (texts.length < 3) {
    issues.push(
      `Only ${texts.length} blocks of text stand at the top level of the slide; a design has at least three. Text inside a card that became a group does not count: let the title, the line under it and the details stand on their own.`,
    );
  }
  const copy = texts.map((content) => plainText(content)).join(' ');
  if (PLACEHOLDER.test(copy)) issues.push('The copy contains placeholder words.');
  if (copy.length <= 25) issues.push('The copy is too short to be a design.');
  const html = slide.elements.filter((element) => element.type === 'html').length;
  if (html > 0) {
    issues.push(
      `${html} part(s) of the slide stayed html, which the user cannot edit with handles. The conversion notes say why.`,
    );
  }
  if (JSON.stringify(slide).includes('"token"')) {
    issues.push('A colour is linked to the theme (var(--color-…)); a design uses literal colours.');
  }
  return issues;
}

/* ---------------------------------------------------------------- the subject */

const within = (element: Element, x: number, y: number) =>
  x >= element.frame.x &&
  x <= element.frame.x + element.frame.w &&
  y >= element.frame.y &&
  y <= element.frame.y + element.frame.h;

const isPicture = (element: Element | undefined) =>
  element?.type === 'image' && element.assetId === SUBJECT;

/**
 * A point on the picture where the picture is what lies on top in every language: at the
 * English point in a left-to-right slide, mirrored in a right-to-left one (Hebrew, Arabic). What
 * the gallery's test checks, and where a click selects the picture. The point nearest the middle
 * of the largest frame of the English picture wins.
 */
export function subjectPoint(
  slides: Partial<Record<Lang, SlideModel>> & { en: SlideModel },
  width = 1920,
): [number, number] | null {
  const { en } = slides;
  const sides = languagesOf(slides).map((lang) => ({
    slide: slides[lang]!,
    mirrored: languageDir(lang) === 'rtl',
  }));
  const frames = en.elements
    .filter((element) => isPicture(element))
    .sort((a, b) => b.frame.w * b.frame.h - a.frame.w * a.frame.h);
  for (const picture of frames) {
    const { x, y, w, h } = picture.frame;
    const points: [number, number][] = [];
    for (let i = 1; i < 12; i += 1) {
      for (let j = 1; j < 12; j += 1) points.push([x + (w * i) / 12, y + (h * j) / 12]);
    }
    const cx = x + w / 2;
    const cy = y + h / 2;
    points.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const [px, py] of points) {
      const visibleX = Math.min(Math.max(px, 0), width);
      const onTop = sides.every(({ slide, mirrored }) => {
        const at = mirrored ? width - visibleX : visibleX;
        return isPicture(slide.elements.findLast((element) => within(element, at, py)));
      });
      if (onTop) return [Math.round(visibleX), Math.round(py)];
    }
  }
  return null;
}

/* ---------------------------------------------------------------- the design check */

async function designCheck(deck: Deck, slide: SlideModel, picture: Picture): Promise<Finding[]> {
  const rendered = await renderSlideOffscreen({
    deck,
    slide,
    mode: 'thumbnail',
    resolveAsset: pictureResolver(picture),
  });
  try {
    const measured = await measureSlide(rendered.root);
    return lintSlide(deck, slide, measured, 'agent').map(
      ({ rule, severity, message, elementIds }) => ({
        rule,
        severity,
        message,
        elementIds: [...elementIds],
      }),
    );
  } finally {
    rendered.dispose();
  }
}

/* ---------------------------------------------------------------- the whole */

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a design names the files of its languages by. */
const fileOf = (lang: Lang) => `${lang}.html`;

/** The files as a list: "he.html and en.html", "he.html, en.html and ar.html". */
const listOf = (langs: readonly Lang[]) => {
  const names = langs.map(fileOf);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/**
 * Converts and checks a design in each of its languages: `languages` (the request's, which the
 * server sends), else those `html` has; Hebrew and English always.
 */
export async function convertDesign(input: {
  designId: string;
  revision: number;
  html: Partial<Record<Lang, string>>;
  languages?: readonly Lang[];
  image: Picture;
  debug?: boolean;
}): Promise<DesignResult> {
  const convert = service(input.image);
  const languages = designLanguages(input.languages ?? languagesOf(input.html));
  const langs = {} as Localized<LangResult>;
  for (const lang of languages) {
    const html = input.html[lang];
    const fonts = html === undefined ? [] : familiesIn(html);
    const side: LangResult = { issues: [], findings: [], fonts };
    langs[lang] = side;
    if (html === undefined) {
      side.error = `${fileOf(lang)} was not written.`;
      continue;
    }
    try {
      await loadFamilies(fonts);
      if (fonts.length === 0) {
        side.issues.push('No text names a font of the library in its font-family.');
      }
      const deck = designDeck(lang, input.image);
      stored.length = 0;
      const conversion = await convert.htmlToSlide(deck, { html, name: input.designId });
      const slide = detachFromTheme(conversion.slide, deck.theme, lang);
      if (input.debug) {
        side.raw = conversion.slide;
        side.rawFindings = await designCheck(
          designDeck(lang, input.image, [conversion.slide]),
          conversion.slide,
          input.image,
        );
      }
      side.slide = slide;
      side.editability = conversion.editability;
      side.notes = conversion.notes;
      side.issues.push(...contractIssues(slide, conversion));
      side.findings = await designCheck(designDeck(lang, input.image, [slide]), slide, input.image);
    } catch (error) {
      side.error = message(error);
    }
  }
  const issues: string[] = [];
  let subject: [number, number] | null = null;
  const en = langs.en.slide;
  const slides = Object.fromEntries(
    languages.flatMap((lang) => (langs[lang]?.slide ? [[lang, langs[lang].slide]] : [])),
  ) as Partial<Record<Lang, SlideModel>>;
  // Only when every language has a slide: a language without one has its own error.
  if (en && languages.every((lang) => slides[lang])) {
    subject = subjectPoint({ ...slides, en });
    if (!subject) {
      const ltr = languages.filter((lang) => languageDir(lang) === 'ltr');
      const rtl = languages.filter((lang) => languageDir(lang) === 'rtl');
      issues.push(
        languages.length === 2
          ? 'No point of the picture lies on top in both languages at mirrored places: mirror the picture frame exactly between he.html and en.html, keep its <img> a direct child of the root, and let nothing cover the middle of its subject.'
          : `No point of the picture lies on top in every language at the same place (mirrored in the right-to-left files): keep the picture frame where it is in en.html in ${listOf(ltr)}, mirror it exactly in ${listOf(rtl)}, keep its <img> a direct child of the root, and let nothing cover the middle of its subject.`,
      );
    }
  }
  const publishable =
    issues.length === 0 &&
    languages.every((lang) => {
      const side = langs[lang];
      return side && !side.error && side.issues.length === 0 && side.slide;
    });
  return {
    designId: input.designId,
    revision: input.revision,
    langs,
    subject,
    issues,
    publishable,
  };
}
