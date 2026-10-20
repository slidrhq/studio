/**
 * A template from layouts that were drawn as slides (WG7-T11a, THM-06). Whoever designs a
 * template, a person or the agent, draws each layout as a slide and marks what a deck fills in
 * with a role. Here that slide becomes a layout: the elements that carry a role are its
 * placeholders, what they were drawn with is the layout's sample, and everything else is its
 * decorations. Two roles mark what the layout draws on every slide and no deck fills in, the
 * master components: the logo, and the slide's number. They stay decorations, with their role.
 *
 * Pure, like the rest of the engine: slides in, a template out. Where the slides come from (the
 * HTML conversion) and where the template goes (a preview, the library) is the app's.
 */
import {
  CommandBus,
  createDeck,
  walkElements,
  type Archetype,
  type AssetMeta,
  type Command,
  type Direction,
  type Element,
  type Frame,
  type Layout,
  type Paragraph,
  type Placeholder,
  type PlaceholderRole,
  type RichText,
  type Slide,
  type TextStyleRef,
  type Theme,
} from '@slidr/model';
import { fillLayout, type RoleFill } from './createSlide';
import { deckFromTemplate } from './deck';
import { copyJson } from './json';
import { layoutsFor, type Template } from './template';
import { withStandardLayouts } from './standardLayouts';

/** A layout as its designer drew it. */
/** The box a part with a role was drawn in: what its designer gave it, not what its text fills. */
export interface DrawnBox {
  role: string;
  frame: Frame;
}

export interface DrawnLayout {
  name: string;
  archetype: Archetype;
  /** The layout as a slide: its placeholders are the elements with a role. */
  slide: Slide;
  /**
   * The boxes of the parts with a role, in the order they were drawn, when whoever converted the
   * drawing could measure them. A converted text is as tall as its words; its placeholder has to
   * be as tall as the room the designer left for words.
   */
  boxes?: readonly DrawnBox[];
}

export interface LayoutFromSlide {
  layout: Layout;
  /** What each placeholder was drawn with, in the order of `layout.placeholders`. */
  fills: (RoleFill | undefined)[];
  /** What the designer should know about what the layout could not keep. English. */
  notes: string[];
}

const TEXT_ROLES: ReadonlySet<PlaceholderRole> = new Set([
  'title',
  'subtitle',
  'body',
  'caption',
  'number',
  'quote',
  'attribution',
  'footer',
]);

/** The text style a role is set in when the drawing does not say. */
const ROLE_STYLE: Partial<Record<PlaceholderRole, TextStyleRef>> = {
  title: 'title',
  subtitle: 'heading',
  body: 'body',
  caption: 'caption',
  number: 'display',
  quote: 'title',
  attribution: 'caption',
  footer: 'caption',
};

/** Two frames that share less than this on either axis only touch. */
const MIN_COVER = 8;

function covers(a: Frame, b: Frame): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w >= MIN_COVER && h >= MIN_COVER;
}

/** A size this close to a style's is that style: rendering lands on fractions of a pixel. */
const SAME_SIZE = 0.5;

/** How far a converted text may sit from the box it was drawn in and still be that box's text. */
const BOX_SLACK = 6;

/**
 * The frame and the vertical alignment of a text placeholder, from the box its text was drawn
 * in. The text is somewhere inside its box: at its top, at its bottom or in its middle, which
 * is how the placeholder then seats what a deck puts into it. A text that sits elsewhere in the
 * box (under a padding) keeps its own top and takes the room below it.
 */
function roomOf(text: Frame, box: Frame): Pick<Placeholder, 'frame' | 'vAlign'> | undefined {
  const inside =
    Math.abs(text.x - box.x) <= BOX_SLACK &&
    Math.abs(text.w - box.w) <= BOX_SLACK &&
    text.y >= box.y - BOX_SLACK &&
    text.y + text.h <= box.y + box.h + BOX_SLACK;
  if (!inside) return undefined;
  const above = text.y - box.y;
  const below = box.y + box.h - (text.y + text.h);
  const round = (frame: Frame): Frame => ({
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
  });
  if (above <= BOX_SLACK) return { frame: round(box), vAlign: 'top' };
  if (below <= BOX_SLACK) return { frame: round(box), vAlign: 'bottom' };
  if (Math.abs(above - below) <= BOX_SLACK) return { frame: round(box), vAlign: 'middle' };
  return { frame: round({ ...box, y: text.y, h: box.y + box.h - text.y }), vAlign: 'top' };
}

const isPlaceholderRole = (element: Element) =>
  element.role !== undefined && element.role !== 'logo';

function holdsPlaceholder(element: Element): boolean {
  return [...walkElements([element])].some(isPlaceholderRole);
}

/**
 * The theme text style of a drawn text. A placeholder can only name a style (SPEC 5.5), so text
 * drawn at a size of its own is given the nearest one, and `size` says what it was drawn at.
 */
function styleOf(
  text: RichText,
  role: PlaceholderRole,
  theme: Theme,
): { ref: TextStyleRef; drawn?: number } {
  const first =
    text.paragraphs.find((p) => p.runs.some((run) => run.text.trim())) ?? text.paragraphs[0];
  const drawn = first?.runs.find((run) => run.marks?.size)?.marks?.size;
  if (first?.styleRef && drawn === undefined) return { ref: first.styleRef };
  if (drawn === undefined) return { ref: ROLE_STYLE[role] ?? 'body' };
  const [ref] = (Object.keys(theme.textStyles) as TextStyleRef[]).sort(
    (a, b) =>
      Math.abs(theme.textStyles[a].size - drawn) - Math.abs(theme.textStyles[b].size - drawn),
  );
  const nearest = ref ?? ROLE_STYLE[role] ?? 'body';
  const same = Math.abs((theme.textStyles[nearest]?.size ?? drawn) - drawn) <= SAME_SIZE;
  return same ? { ref: nearest } : { ref: nearest, drawn };
}

/** The alignment a placeholder seats its text with; `justify` is not one a layout decides. */
function alignOf(paragraph: Paragraph | undefined): Placeholder['align'] {
  const align = paragraph?.align;
  return align === 'center' || align === 'end' ? align : 'start';
}

/**
 * The words of a drawn text without their look: what a deck puts into the placeholder is plain
 * content, and the sample should show the layout as a deck will get it, not as it was drawn.
 */
function plain(text: RichText): RichText | undefined {
  const paragraphs = text.paragraphs.map(({ dir, list, runs }): Paragraph => ({
    dir,
    align: 'start',
    ...(list ? { list: { kind: list.kind, level: list.level } } : {}),
    runs: [{ text: runs.map((run) => run.text).join('') }].filter((run) => run.text !== ''),
  }));
  // A placeholder drawn empty has no sample of its own.
  return paragraphs.some((paragraph) => paragraph.runs.length > 0) ? { paragraphs } : undefined;
}

/** A decoration with ids of the layout's own, so two layouts never share an element id. */
function decorationOf(element: Element, prefix: string, counter: { n: number }): Element {
  const copy = copyJson(element);
  for (const inside of walkElements([copy])) inside.id = `${prefix}_d${++counter.n}`;
  return copy;
}

/**
 * A layout from a slide that draws it. Placeholders keep the frame, the text style and the
 * alignment they were drawn with; a group that holds a placeholder is taken apart, since a
 * placeholder is always at the top of its layout. The slide is not changed.
 */
export function layoutFromSlide(
  { name, archetype, slide, boxes: boxes_ }: DrawnLayout,
  options: { id: string; theme: Theme },
): LayoutFromSlide {
  const { id, theme } = options;
  // The drawn boxes, each used once: the first of its role that the converted text sits in.
  const boxes = [...(boxes_ ?? [])];
  const room = (role: PlaceholderRole, text: Frame) => {
    for (const [index, box] of boxes.entries()) {
      if (box.role !== role) continue;
      const found = roomOf(text, box.frame);
      if (!found) continue;
      boxes.splice(index, 1);
      return found;
    }
    return undefined;
  };
  const placeholders: Placeholder[] = [];
  const fills: (RoleFill | undefined)[] = [];
  const decorations: Element[] = [];
  /** Decorations drawn above a placeholder they cover: a layout draws them under the content. */
  const buried = new Set<string>();
  const notes: string[] = [];
  const counter = { n: 0 };
  const say = (note: string) => notes.push(`Layout "${name}": ${note}`);

  const place = (
    role: PlaceholderRole,
    frame: Frame,
    rest: Partial<Placeholder>,
    fill?: RoleFill,
  ) => {
    placeholders.push({ id: `${id}_p${placeholders.length + 1}`, role, frame, ...rest });
    fills.push(fill);
  };

  /** A decoration keeps its role only where the role says what the layout draws: a master component. */
  const decorate = (element: Element, frame: Frame, keepRole = element.role === 'logo') => {
    const { role: _role, ...rest } = element;
    const kept = { ...(keepRole ? element : rest), frame } as Element;
    if (placeholders.some((p) => covers(p.frame, frame))) buried.add(element.name ?? element.type);
    decorations.push(decorationOf(kept, id, counter));
  };

  const visit = (elements: readonly Element[], dx: number, dy: number) => {
    for (const element of elements) {
      if (element.hidden) continue;
      const frame = { ...element.frame, x: element.frame.x + dx, y: element.frame.y + dy };
      if (element.type === 'group' && holdsPlaceholder(element)) {
        visit(element.children, frame.x, frame.y);
        continue;
      }
      const role = isPlaceholderRole(element) ? element.role : undefined;
      if (!role) {
        decorate(element, frame);
      } else if (TEXT_ROLES.has(role)) {
        if (element.type === 'text') {
          const style = styleOf(element.content, role, theme);
          if (style.drawn !== undefined) {
            say(
              `the ${role} text is drawn at ${Math.round(style.drawn)}px. A placeholder takes one of the theme's text styles, so it was given "${style.ref}" (${theme.textStyles[style.ref]?.size}px): set that size in the theme's text styles, or draw the text at the size of a style.`,
            );
          }
          const first = element.content.paragraphs[0];
          const drawn = room(role, frame);
          place(
            role,
            drawn?.frame ?? frame,
            {
              styleRef: style.ref,
              align: alignOf(first),
              vAlign: drawn?.vAlign ?? element.vAlign,
            },
            plain(element.content),
          );
        } else {
          // The role sits on a box, or on text that stayed HTML: the place is known, the look is not.
          say(
            `data-role="${role}" is on a ${element.type} element, not on text. Its frame became the placeholder, in the "${ROLE_STYLE[role] ?? 'body'}" style; put the role on the element that holds the text itself.`,
          );
          place(role, frame, { styleRef: ROLE_STYLE[role] ?? 'body', align: 'start' });
          if (element.type === 'shape') decorate({ ...element, content: undefined }, frame);
        }
      } else if (role === 'image') {
        const fill =
          element.type === 'image'
            ? element.assetId
              ? { assetId: element.assetId }
              : element.prompt
                ? { imagePrompt: element.prompt }
                : undefined
            : undefined;
        place(role, frame, {}, fill);
      } else if (role === 'slideNumber') {
        // The slide's number is not something a deck fills in: the layout draws it, and the
        // renderer writes in it the number of each slide (SLD-04). As a placeholder it gave a
        // slide no element, and nothing drew the number at all.
        if (element.type === 'text') {
          decorate(element, frame, true);
        } else {
          say(
            `data-role="slideNumber" is on a ${element.type} element, not on text, so the number of a slide cannot be written in it: it is drawn as it is on every slide. Put the role on the text that shows the number.`,
          );
          decorate(element, frame);
        }
      } else {
        // A chart, a table: the frame is the placeholder, and what was drawn in it was an example.
        place(role, frame, {});
      }
    }
  };
  visit(slide.elements, 0, 0);

  if (placeholders.length === 0) {
    say('no element carries a data-role, so a slide made from it has nothing to fill in.');
  }
  if (buried.size > 0) {
    say(
      `a layout draws its decorations under the content of the slide, so ${[...buried].join(', ')} will be under the placeholder it was drawn over. A picture with a scrim and text over it cannot be a layout; give the picture and the text frames of their own.`,
    );
  }
  const kept = decorations.filter((d) => [...walkElements([d])].some((e) => e.type === 'html'));
  if (kept.length > 0) {
    say(
      `${kept.length} part${kept.length > 1 ? 's' : ''} stayed HTML and ${kept.length > 1 ? 'are' : 'is'} drawn as it was written; it will not follow a change of colours.`,
    );
  }
  if (slide.css) say('slide-level CSS is not carried by a layout and was dropped.');

  return {
    layout: {
      id,
      name,
      archetype,
      ...(slide.background ? { background: copyJson(slide.background) } : {}),
      placeholders,
      decorations,
    },
    fills,
    notes,
  };
}

/** A theme with a patch over it, merged as `theme.update` merges, under an id and a name. */
export function themeFrom(
  base: Theme,
  patch: Extract<Command, { type: 'theme.update' }>['patch'],
  identity: { id: string; name: string },
): Theme {
  const bus = new CommandBus(createDeck({ theme: copyJson(base) }), { validate: true });
  if (Object.keys(patch).length > 0) bus.dispatch({ type: 'theme.update', patch });
  return { ...copyJson(bus.deck.theme), ...identity };
}

export interface DraftInput {
  /** The id of the draft: the id of its theme, as for every template. */
  id: string;
  name: string;
  /** The whole theme (`themeFrom`). */
  theme: Theme;
  /** The direction the layouts were drawn for. */
  dir: Direction;
  layouts: readonly DrawnLayout[];
  /** The assets the drawn layouts may use; the template keeps those they do. */
  assets?: Readonly<Record<string, AssetMeta>>;
  /**
   * The template the draft starts as a copy of. A drawn layout replaces its layout of the same
   * archetype when it has exactly one, else the one of the same name, and takes its id; any
   * other drawn layout is added. A layout of the base is replaced once in a call: of two drawn
   * layouts that would stand in for the same one, the first does, and the second is added.
   */
  base?: Template;
  description?: string;
}

export interface Draft {
  template: Template;
  /** The sample content of the drawn layouts, by layout id. */
  fills: Record<string, (RoleFill | undefined)[]>;
  notes: string[];
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The layout of the base a drawn layout stands in for. A layout of the base is stood in for
 * once: `redrawn` holds the ones earlier drawn layouts of the same call took. A second drawn
 * layout of an archetype the base has one of is a layout more (three cards, and four), not a
 * second version of the first, which it used to overwrite without a word.
 */
function replaced(
  base: Template | undefined,
  drawn: DrawnLayout,
  redrawn: ReadonlySet<string>,
): Layout | undefined {
  if (!base) return undefined;
  const ofArchetype = base.layouts.filter((layout) => layout.archetype === drawn.archetype);
  const old =
    ofArchetype.length === 1
      ? ofArchetype[0]
      : base.layouts.find((layout) => sameName(layout.name, drawn.name));
  return old && !redrawn.has(old.id) ? old : undefined;
}

/**
 * A template as if it had been drawn for `dir`: the same layouts for every deck. Its layouts are
 * the ones a deck of that direction gets, and where it had a layout drawn by hand for the other
 * direction, the layout it was drawn with is now that hand-drawn one.
 */
function turned(template: Template, dir: Direction): Template {
  if (template.dir === dir) return template;
  const byHand = new Set((template.flipped ?? []).map((layout) => layout.id));
  const flipped = template.layouts.filter((layout) => byHand.has(layout.id));
  const { flipped: _flipped, ...rest } = template;
  return {
    ...rest,
    dir,
    layouts: layoutsFor(template, dir),
    ...(flipped.length > 0 ? { flipped: copyJson(flipped) } : {}),
  };
}

/** An id fit for a layout of the draft: unique among templates, since it carries the draft's id. */
function layoutId(draftId: string, index: number, taken: ReadonlySet<string>): string {
  let n = index + 1;
  while (taken.has(`l_${draftId}_${n}`)) n++;
  return `l_${draftId}_${n}`;
}

/**
 * A template from drawn layouts, or an existing template with some of its layouts redrawn and
 * its theme changed. Nothing here saves or applies it.
 */
export function draftTemplate(input: DraftInput): Draft {
  const { id, name, theme, dir } = input;
  const base = input.base ? turned(withStandardLayouts(input.base), dir) : undefined;
  const notes: string[] = [];
  const fills: Draft['fills'] = {};
  const layouts: Layout[] = copyJson(base?.layouts ?? []);
  const flipped = copyJson(base?.flipped ?? []);
  const taken = new Set(layouts.map((layout) => layout.id));
  const redrawn = new Set<string>();

  for (const [index, drawn] of input.layouts.entries()) {
    const old = replaced(base, drawn, redrawn);
    if (old) redrawn.add(old.id);
    const own = old?.id ?? layoutId(id, index, taken);
    taken.add(own);
    const made = layoutFromSlide(drawn, { id: own, theme });
    notes.push(...made.notes);
    fills[own] = made.fills;
    const at = layouts.findIndex((layout) => layout.id === own);
    if (at >= 0) {
      layouts[at] = made.layout;
      // The hand-drawn layout of the other direction belonged to the layout that is gone.
      const flip = flipped.findIndex((layout) => layout.id === own);
      if (flip >= 0) flipped.splice(flip, 1);
    } else {
      layouts.push(made.layout);
    }
  }

  const drawn = JSON.stringify([layouts, flipped]);
  const assets = Object.values({ ...base?.assets, ...input.assets }).filter((asset) =>
    drawn.includes(asset.id),
  );
  const template: Template = withStandardLayouts({
    theme: { ...copyJson(theme), id, name },
    ...(input.description ? { description: input.description } : {}),
    dir,
    layouts,
    ...(flipped.length > 0 ? { flipped } : {}),
    ...(assets.length > 0
      ? { assets: Object.fromEntries(assets.map((asset) => [asset.id, copyJson(asset)])) }
      : {}),
  });
  return { template, fills, notes };
}

/**
 * A deck that shows a template: one slide for each layout, in the direction and language asked
 * for, filled with what the layout was drawn with. `fallback` gives the words for a text
 * placeholder that has none (a layout kept from another template, which carries no sample).
 */
export function sampleDeckOf(
  template: Template,
  fills: Draft['fills'],
  options: {
    dir: Direction;
    lang: string;
    fallback?: (role: PlaceholderRole) => string | undefined;
    /** Every asset the sample may show, the deck's own among them. */
    assets?: Readonly<Record<string, AssetMeta>>;
    random?: () => number;
  },
) {
  const deck = deckFromTemplate(template, { lang: options.lang, dir: options.dir });
  deck.assets = { ...copyJson(options.assets ?? {}), ...deck.assets };
  for (const layout of deck.layouts) {
    const given = fills[layout.id] ?? [];
    const content = layout.placeholders.map((placeholder, index): RoleFill | undefined => {
      const fill = given[index];
      if (fill) return 'assetId' in fill && !deck.assets[fill.assetId] ? undefined : fill;
      const words = TEXT_ROLES.has(placeholder.role) ? options.fallback?.(placeholder.role) : '';
      return words
        ? { paragraphs: [{ dir: 'auto', align: 'start', runs: [{ text: words }] }] }
        : undefined;
    });
    const slide = fillLayout(
      deck,
      { layoutId: layout.id, fills: content, name: layout.name },
      options.random ? { random: options.random } : {},
    );
    deck.slides.push(slide);
  }
  return deck;
}
