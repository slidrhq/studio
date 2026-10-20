import {
  createElement,
  updateElement,
  type Color,
  type Command,
  type Frame,
  type Paragraph,
  type Run,
  type Theme,
} from '@slidr/model';
import { blend, contrastRatio, hex, luminance } from '../color';
import { intersection, slideArea } from '../geometry';
import type { Rgb, TextSpanMeasure } from '../measure';
import { colorRgb, distance, tokenRgb } from '../palette';
import type { Item, Problem, Rule, SlideContext } from '../rule';
import { mapRuns, proseOf, setText, styleOf } from '../text';

/** WCAG AA (SPEC 9.1): 4.5:1, and 3:1 for large text, which on a slide is text above 48px. */
const AA = 4.5;
const AA_LARGE = 3;
const LARGE_ABOVE = 48;

/**
 * Share of the area under a text that may fall short. Over a solid colour every sample is the
 * same; over a photo or a gradient this keeps a few stray pixels from deciding, while a tenth
 * of the text being hard to read is already a problem.
 */
const TOLERATED_SHARE = 0.1;

/** Glyphs this faint are not what draws the text (outlined or clipped text): nothing to judge. */
const INVISIBLE = 0.05;

export function requiredContrast(fontSize: number): number {
  return fontSize > LARGE_ABOVE ? AA_LARGE : AA;
}

/**
 * The contrast a span keeps over all but the worst tenth of what is under it, and the colour
 * there. Undefined when the backdrop is unknown or the glyphs are not drawn.
 */
export function spanContrast(span: TextSpanMeasure): { ratio: number; under: Rgb } | undefined {
  if (span.backdrop.length === 0 || span.alpha < INVISIBLE) return undefined;
  const ratios = span.backdrop
    .map((under) => ({ ratio: contrastRatio(blend(span.color, span.alpha, under), under), under }))
    .sort((a, b) => a.ratio - b.ratio);
  return ratios[Math.floor((ratios.length - 1) * TOLERATED_SHARE)];
}

export interface Faint {
  span: TextSpanMeasure;
  ratio: number;
  under: Rgb;
  required: number;
}

/** The span of an element that falls furthest short of the contrast it needs, if any does. */
export function faintest({ measure }: Item): Faint | undefined {
  let worst: Faint | undefined;
  for (const span of measure.text?.spans ?? []) {
    const contrast = spanContrast(span);
    if (!contrast) continue;
    const required = requiredContrast(span.fontSize);
    if (contrast.ratio >= required) continue;
    if (!worst || contrast.ratio / required < worst.ratio / worst.required) {
      worst = { span, ...contrast, required };
    }
  }
  return worst;
}

/** "Text in #777777 at 50% opacity has a contrast of 2.1:1 against ...", for a message. */
export function describeFaint({ span, ratio, under, required }: Faint, what = 'Text'): string {
  const faint = span.alpha < 1 ? ` at ${Math.round(span.alpha * 100)}% opacity` : '';
  // Rounded down, so a ratio just short of the bar never reads as meeting it.
  return `${what} in ${hex(span.color)}${faint} has a contrast of ${Math.floor(ratio * 100) / 100}:1 against what is under it (${hex(under)}); ${Math.round(span.fontSize)}px text needs ${required}:1 (WCAG AA; 3:1 only above ${LARGE_ABOVE}px).`;
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** How dense a veil under the text may have to be before the letters read on it. */
const VEILS = [0.5, 0.65, 0.8];
/** Room around the glyphs under a veil, in slide pixels. */
const VEIL_PAD = 24;
/** The name a veil of this fix carries: by it the fix knows its own veils again. */
const VEIL = 'veil';

/** A colour of the model, and what it draws. */
interface Paint {
  color: Color;
  rgb: Rgb;
}

/**
 * The veils this fix may lay, each with the letters that read on it. The theme's own pair comes
 * first, its background under its text colour and the other way round: a veil made of the two
 * is right on any template the deck is switched to, where a black one under white letters stays
 * a black box on a slide that has turned white. Black and white are for a theme whose own two
 * colours do not read here. Of each kind, the veil nearer to what is under the text is tried
 * first: it changes the picture least.
 */
function veils(theme: Theme, dark: boolean): { veil: Paint; letters: Paint }[] {
  const both = (a: Paint, b: Paint) => [
    { veil: a, letters: b },
    { veil: b, letters: a },
  ];
  const bg = tokenRgb(theme, 'bg');
  const text = tokenRgb(theme, 'text');
  const themed =
    bg && text
      ? both({ color: { token: 'bg' }, rgb: bg }, { color: { token: 'text' }, rgb: text })
      : [];
  const plain = both(
    { color: { value: '#000000' }, rgb: BLACK },
    { color: { value: '#ffffff' }, rgb: WHITE },
  );
  const far = ({ veil }: { veil: Paint }) => Number(luminance(veil.rgb) < 0.5 !== dark);
  const nearFirst = (kind: typeof plain) => [...kind].sort((a, b) => far(a) - far(b));
  return [...nearFirst(themed), ...nearFirst(plain)];
}

const sameColour = (a: Color, b: Color) =>
  'token' in a
    ? 'token' in b && a.token === b.token
    : 'value' in b && a.value.toLowerCase() === b.value.toLowerCase();

function union(a: Frame, b: Frame): Frame {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * The fix the table of SPEC 9.2 names. First a colour: the theme's text colour, its background
 * or its surface, then black or white, whichever is the first to read on what is under the
 * text. Only the runs drawn in the colour that fails change. Where no colour reads (a busy
 * photograph), a veil goes under the text and the text takes the colour that reads on the veil
 * (see `veils`).
 */
function fixOf(ctx: SlideContext, item: Item, worst: Faint): Command[] | undefined {
  const { element } = item;
  const prose = proseOf(element);
  if (!prose) return undefined;
  const { theme } = ctx.deck;
  const own = element.type === 'text' ? element.color : undefined;
  const colourOf = (run: Run, paragraph: Paragraph) =>
    run.marks?.color ?? own ?? styleOf(theme, paragraph).color;
  const failing = (run: Run, paragraph: Paragraph) => {
    const drawn = colorRgb(theme, colourOf(run, paragraph));
    return drawn !== undefined && distance(drawn, worst.span.color) <= 4;
  };
  const faint = prose.paragraphs.flatMap((p) =>
    p.runs.filter((run) => run.text && failing(run, p)).map((run) => colourOf(run, p).alpha ?? 1),
  );
  // The colour that goes in is opaque: what stays of the faintness is the element's own.
  const opacity = Math.min(1, worst.span.alpha / Math.max(...faint, worst.span.alpha));
  const reads = (rgb: Rgb, backdrop = worst.span.backdrop) =>
    (spanContrast({ ...worst.span, color: rgb, alpha: opacity, backdrop })?.ratio ?? 0) >=
    worst.required;

  const recolour = (color: Color) => {
    // Where the model's colours cannot be read (a CSS colour that is not hex), all of it turns.
    const content = mapRuns(prose, (run, paragraph) =>
      faint.length === 0 || failing(run, paragraph)
        ? { ...run, marks: { ...run.marks, color } }
        : run,
    );
    return content ? setText(ctx.slide.id, element.id, content) : undefined;
  };

  const colours: { color: Color; rgb: Rgb | undefined }[] = [
    ...(['text', 'bg', 'surface'] as const).map((token) => ({
      color: { token },
      rgb: tokenRgb(theme, token),
    })),
    { color: { value: '#000000' }, rgb: BLACK },
    { color: { value: '#ffffff' }, rgb: WHITE },
  ];
  const colour = colours.find(({ rgb }) => rgb && reads(rgb));
  if (colour) {
    const command = recolour(colour.color);
    return command ? [command] : undefined;
  }

  // A veil sits under the text in the slide's own list, so only text at the top of the tree.
  const at = ctx.slide.elements.findIndex((e) => e.id === element.id);
  const ink = item.measure.text?.ink;
  if (at === -1 || !ink || element.rotation !== 0) return undefined;
  const mean =
    worst.span.backdrop.reduce((sum, c) => sum + luminance(c), 0) / worst.span.backdrop.length;
  const pairs = veils(theme, mean < 0.5);
  const under = (veil: Rgb, alpha: number) =>
    worst.span.backdrop.map((backdrop) => blend(veil, alpha, backdrop));
  const padded: Frame = {
    x: ink.x - VEIL_PAD,
    y: ink.y - VEIL_PAD,
    w: ink.w + 2 * VEIL_PAD,
    h: ink.h + 2 * VEIL_PAD,
  };
  const frame = intersection(padded, slideArea(ctx.deck)) ?? padded;
  const lettered = (letters: Paint, veil: Command) => {
    const command = recolour(letters.color);
    return [veil, ...(command ? [command] : [])];
  };

  // The veil of the text next to this one is made to hold both: two veils that overlap are
  // darker where they meet, and a title with the line under it reads as two boxes. A veil the
  // user locked stays the size it is, and this text gets one of its own.
  for (const laid of ctx.slide.elements.slice(0, at).reverse()) {
    if (laid.type !== 'shape' || laid.name !== VEIL || laid.rotation !== 0) continue;
    if (ctx.locked.has(laid.id)) continue;
    if (laid.fill.kind !== 'solid' || !intersection(laid.frame, frame)) continue;
    const { color } = laid.fill;
    const pair = pairs.find(({ veil }) => sameColour(veil.color, color));
    if (!pair || !reads(pair.letters.rgb, under(pair.veil.rgb, color.alpha ?? 1))) continue;
    return lettered(
      pair.letters,
      updateElement(ctx.slide.id, laid.id, { frame: union(laid.frame, frame) }),
    );
  }

  for (const { veil, letters } of pairs) {
    for (const alpha of VEILS) {
      if (!reads(letters.rgb, under(veil.rgb, alpha))) continue;
      let id = `${element.id}_veil`;
      for (let n = 2; ctx.items.some((other) => other.element.id === id); n++) {
        id = `${element.id}_veil${n}`;
      }
      const shape = createElement.shape({
        id,
        name: VEIL,
        frame,
        fill: { kind: 'solid', color: { ...veil.color, alpha } },
        effects: { radius: theme.radius },
      });
      return lettered(letters, {
        type: 'element.add',
        slideId: ctx.slide.id,
        element: shape,
        index: at,
      });
    }
  }
  return undefined;
}

/**
 * L05: text whose contrast against what is really under it is below WCAG AA. The text a chart
 * draws is judged by the user's rule of the same number (see `chart.ts`).
 */
export const L05: Rule = {
  id: 'L05',
  severity: 'error',
  agent: true,
  check(ctx) {
    return ctx.items.flatMap((item): Problem[] => {
      // One finding per element: its worst span, relative to what that span needs.
      const worst = item.element.type === 'chart' ? undefined : faintest(item);
      if (!worst) return [];
      const shade = luminance(worst.span.color) > luminance(worst.under) ? 'darker' : 'lighter';
      const fix = fixOf(ctx, item, worst);
      return [
        {
          elementIds: [item.element.id],
          message: `${describeFaint(worst)} Change the text colour, or put a ${shade} shape or overlay under the text.`,
          ...(fix ? { fix } : {}),
        },
      ];
    });
  },
};
