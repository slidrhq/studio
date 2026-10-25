/**
 * The cover of a template, as the gallery of the app and the library draw it: its opening layout
 * with the template's name for a title, and the photograph of a template that opens with one.
 *
 * Every cover sets the name alike, so that the covers read as one row of names: one line, its
 * letters as tall as on every other cover, on the start side of the layout's title (the right in
 * a right-to-left deck), across the middle of the slide. Families draw letters of different
 * heights at one size, so the size is each family's own (`letters.generated.ts`). What the layout
 * draws for its title (a rule under it, a tick over it, a tab beside it, a panel around it) goes
 * with the name and keeps close to its letters, though the layout itself draws it elsewhere; the
 * rest of the layout stays where it is.
 */
import {
  contentLanguageOf,
  createDeck,
  createElement,
  createSlide as blankSlide,
  LANGUAGE_SCRIPT,
  richText,
  SLIDE_HEIGHT,
  type AssetMeta,
  type Deck,
  type Direction,
  type Element,
  type FontPair,
  type Frame,
  type Slide,
  type TextElement,
  type Theme,
} from '@slidr/model';
import { seatAlign } from './align';
import { createSlide } from './createSlide';
import { deckFromTemplate } from './deck';
import { LETTER_WEIGHTS, LETTERS, LETTERS_OF, type Letters } from './letters.generated';
import type { Template } from './template';

/**
 * The size of a name set in Heebo, the app's own family, at weight 700: every name's letters
 * stand as tall as Heebo's do at this size, in the letters of its language.
 */
export const COVER_TITLE_SIZE = 176;
const REFERENCE: FontPair = { he: 'Heebo', latin: 'Heebo' };
const REFERENCE_WEIGHT = 700;
/** The height of the name's line, in its sizes. */
const LINE = 1.15;
/**
 * The height of its box, in its sizes: room over and under the line for what a face draws past
 * it, and for a line of the theme's display size where that is larger; not for a second line.
 */
const BOX = 1.6;
/** The scripts whose counterpart draws the whole text, Latin letters too (`familyForLetters`). */
const WHOLE = new Set(['cyrillic', 'vietnamese']);

/**
 * Where an object of the opening layout goes with the name: over its letters or under them, `gap`
 * pixels from them; beside them, as high as they are; or behind them, its middle on theirs.
 */
type Place = 'above' | 'below' | 'beside' | 'behind';

interface Attached {
  /** The layout's objects, by id; they move as one, as they were drawn together. */
  ids: readonly string[];
  place: Place;
  gap?: number;
  /** Moved to the start of the name too: drawn over the middle of a title set in the middle. */
  start?: boolean;
}

/**
 * The gap from the letters of the name, where an entry names none: over the tallest of them (a
 * Latin capital), under those that go below the line (ק, ן, g, p).
 */
const GAP: Record<'above' | 'below', number> = { above: 40, below: 12 };

/**
 * What the opening layout of each built-in template draws for its title, by template id: the
 * rule under it, the mark at the start of the line over it (which the cover leaves empty), the
 * tab beside it, the panel it stands on. A template that is not here draws nothing for its title;
 * its name is set as the others are, and its objects stay where they are.
 */
export const COVER_ATTACHED: Record<string, readonly Attached[]> = {
  tzuk: [{ ids: ['d_tzuk_hero_tick'], place: 'above' }],
  layla: [{ ids: ['d_layla_hero_rule'], place: 'below' }],
  zohar: [{ ids: ['d_zohar_hero_bar'], place: 'above' }],
  migdal: [
    { ids: ['d_migdal_hero_tab'], place: 'beside' },
    { ids: ['d_migdal_hero_bar'], place: 'below' },
  ],
  gan: [{ ids: ['d_gan_hero_wave'], place: 'below' }],
  nof: [{ ids: ['d_nof_hero_dawn'], place: 'above' }],
  bolet: [{ ids: ['d_bolet_hero_rule', 'd_bolet_hero_spark'], place: 'below' }],
  hod: [{ ids: ['d_hod_hero_rule'], place: 'above', start: true }],
  sirtut: [{ ids: ['d_sirtut_hero_dim'], place: 'below' }],
  shidur: [{ ids: ['d_shidur_hero_tick'], place: 'above' }],
  bina: [{ ids: ['d_bina_hero_wave'], place: 'below' }],
  mifgash: [{ ids: ['d_mifgash_hero_slab'], place: 'behind' }],
  kod: [{ ids: ['d_kod_hero_caret', 'd_kod_hero_line'], place: 'below' }],
  // A marker's stroke, drawn across the letters that go below the line.
  luach: [{ ids: ['d_luach_hero_stroke'], place: 'below', gap: -20 }],
  magen: [{ ids: ['d_magen_hero_status'], place: 'below' }],
  anan: [{ ids: ['d_anan_hero_node'], place: 'above' }],
  mutzar: [{ ids: ['d_mutzar_hero_new'], place: 'above' }],
  atlas: [{ ids: ['d_atlas_hero_pin'], place: 'above' }],
};

export interface CoverOptions {
  lang: string;
  dir: Direction;
  /** The template's name in that language. */
  name: string;
  /** The photograph of a template whose opening layout seats one. */
  picture?: AssetMeta;
}

/** One slide that shows a template: its opening layout, with its name and its photograph. */
export function templateCover(
  template: Template,
  { lang, dir, name, picture }: CoverOptions,
): { deck: Deck; slide: Slide } {
  const deck = deckFromTemplate(template, { lang, dir });
  const first = deck.layouts[0];
  if (!first) {
    // A template without layouts (saved from a plain deck): its name in its own display style.
    const plain = createDeck({ lang, dir, theme: template.theme });
    const slide = blankSlide({
      elements: [
        createElement.text({
          frame: { x: 160, y: 380, w: 1600, h: 320 },
          vAlign: 'middle',
          content: richText(name, { align: 'center', styleRef: 'display' }),
        }),
      ],
    });
    return { deck: plain, slide };
  }
  const has = (role: string) => first.placeholders.some((p) => p.role === role);
  const seated = has('image') ? picture : undefined;
  if (seated) deck.assets[seated.id] = seated;
  const { slide } = createSlide(deck, {
    layoutId: first.id,
    content: {
      ...(has('title') ? { title: richText(name, { dir: 'auto' }) } : {}),
      ...(seated ? { image: { assetId: seated.id } } : {}),
    },
  });
  const title = slide.elements.find(
    (element): element is TextElement => element.type === 'text' && element.role === 'title',
  );
  if (title) {
    const seat = setName(title, template.theme, lang, dir);
    // The layout's objects come first on the slide, in the layout's order (`slideFromLayout`).
    const objects = new Map(
      (first.objects ?? []).map((object, index) => [object.id, slide.elements[index]!]),
    );
    for (const attached of COVER_ATTACHED[template.theme.id] ?? []) {
      const elements = attached.ids.flatMap((id) => objects.get(id) ?? []);
      if (elements.length > 0) attach(elements, seat, title.frame, attached, dir);
    }
  }
  return { deck, slide };
}

/** Where the letters of the name stand on the slide, top to bottom. */
interface Seat {
  /** The top of the tallest of them. */
  top: number;
  /** The top of the letters whose height is their size: the middle of the slide is theirs. */
  letters: number;
  baseline: number;
  /** The foot of those that go below the line. */
  foot: number;
}

/**
 * The families of a font pair, in the order `fontStack` lists them for a language, less the
 * pair's Hebrew-only face (which has the Hebrew letters and nothing else): its Latin family, its
 * Hebrew one, and the counterpart of the letters they lack, before them where it is to draw the
 * whole text.
 */
function stackOf(pair: FontPair, script: string): string[] {
  const names = pair.latin === pair.he ? [pair.latin] : [pair.latin, pair.he];
  const counterpart = (family: string) => {
    if (LETTERS[family]?.[script]) return { family, whole: false };
    const other = LETTERS_OF[family]?.[script];
    return other ? { family: other, whole: WHOLE.has(script) } : undefined;
  };
  const other = script === 'he' ? undefined : (counterpart(pair.latin) ?? counterpart(pair.he));
  if (other && !names.includes(other.family)) {
    if (other.whole) names.unshift(other.family);
    else names.push(other.family);
  }
  return names;
}

/**
 * How the letters of a language stand, set in a font pair: those of the family that draws them
 * (the pair's Hebrew family for Hebrew, through its Hebrew-only face), and those of the first
 * family of the stack, whose ascent and descent alone make the boxes of the line, whichever
 * family draws its letters (CSS's first available font: the first with a space, which the
 * Hebrew-only face has not). Undefined for a family not measured.
 */
function lettersOf(pair: FontPair, lang: string): { drawn: Letters; first: Letters } | undefined {
  const own = contentLanguageOf(lang);
  const script = own ? LANGUAGE_SCRIPT[own] : 'latin';
  const stack = stackOf(pair, script);
  const family =
    script === 'he' && LETTERS[pair.he]?.he ? pair.he : stack.find((one) => LETTERS[one]?.[script]);
  const drawn = family && LETTERS[family]?.[script];
  if (!drawn) return undefined;
  // Its file of Latin letters is the one with a space.
  const measured = LETTERS[stack[0]!];
  const first = measured?.latin ?? Object.values(measured ?? {})[0] ?? drawn;
  return { drawn, first };
}

/** The height of the letters at a weight, between those measured. */
function heightAt([light, bold]: Letters, weight: number): number {
  const [from, to] = LETTER_WEIGHTS;
  const at = Math.min(1, Math.max(0, (weight - from) / (to - from)));
  return light + (bold - light) * at;
}

/**
 * The name as every cover sets it: one line, at the size that gives its letters the height of
 * Heebo's at `COVER_TITLE_SIZE`, at the start of the box the layout gives its title, with its
 * letters across the middle of the slide. A name too long for the box is made smaller to fit
 * it, on the same line.
 */
function setName(title: TextElement, theme: Theme, lang: string, dir: Direction): Seat {
  const style = theme.textStyles[title.content.paragraphs[0]?.styleRef ?? 'display'];
  const heebo = LETTERS[REFERENCE.latin]!.latin!;
  const reference = lettersOf(REFERENCE, lang) ?? { drawn: heebo, first: heebo };
  const height = COVER_TITLE_SIZE * heightAt(reference.drawn, REFERENCE_WEIGHT);
  // A family that is not measured (a font of the system's) is taken to stand as Heebo does.
  const { drawn, first } = lettersOf(theme.fonts[style.font], lang) ?? reference;
  const size = height / heightAt(drawn, style.weight);
  const [, , top, bottom] = drawn;
  // The line as CSS lays it out: the box of the name's run and that of its paragraph (at the size
  // of its style), each as tall as its line, round the first font's ascent and descent, on one
  // baseline. The line is as tall as they need together, in the middle of the box of the name.
  const [, , , , ascent, descent] = first;
  const over = Math.max(size, style.size) * ((LINE + ascent - descent) / 2);
  const under = Math.max(size, style.size) * ((LINE - ascent + descent) / 2);
  const baseline = (SLIDE_HEIGHT + height) / 2;
  const h = BOX * size;
  title.frame = { ...title.frame, y: baseline - over - (h - over - under) / 2, h };
  title.vAlign = 'middle';
  title.autoFit = 'shrink';
  title.content = {
    paragraphs: title.content.paragraphs.map((paragraph) => ({
      ...paragraph,
      align: seatAlign('start', paragraph, dir),
      lineHeight: LINE,
      runs: paragraph.runs.map((run) => ({ ...run, marks: { ...run.marks, size } })),
    })),
  };
  return {
    top: baseline - top * size,
    letters: baseline - height,
    baseline,
    foot: baseline + bottom * size,
  };
}

/** The box round frames. */
function union(frames: readonly Frame[]): Frame {
  const x = Math.min(...frames.map((f) => f.x));
  const y = Math.min(...frames.map((f) => f.y));
  const right = Math.max(...frames.map((f) => f.x + f.w));
  const bottom = Math.max(...frames.map((f) => f.y + f.h));
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Moves objects drawn for the title to the letters of the name. They keep their side of the
 * slide, and their place along the line, unless the entry moves them to its start (in `line`, the
 * box of the name).
 */
function attach(
  elements: readonly Element[],
  seat: Seat,
  line: Frame,
  { place, gap, start }: Attached,
  dir: Direction,
): void {
  const box = union(elements.map((element) => element.frame));
  if (place === 'beside') {
    // Drawn again from the top of the tallest letters to the line.
    const scale = (seat.baseline - seat.top) / box.h;
    for (const element of elements) {
      const { frame } = element;
      element.frame = { ...frame, y: seat.top + (frame.y - box.y) * scale, h: frame.h * scale };
    }
    return;
  }
  const y =
    place === 'above'
      ? seat.top - (gap ?? GAP.above) - box.h
      : place === 'below'
        ? seat.foot + (gap ?? GAP.below)
        : (seat.letters + seat.baseline - box.h) / 2;
  const x = !start ? box.x : dir === 'rtl' ? line.x + line.w - box.w : line.x;
  for (const element of elements) {
    const { frame } = element;
    element.frame = { ...frame, x: frame.x + x - box.x, y: frame.y + y - box.y };
  }
}
