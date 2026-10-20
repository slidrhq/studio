/**
 * Putting a converted slide together (ADR-073). The walk proposes one element for each thing
 * the page draws, and the guard settles each where the source drew it: a box, the title on it,
 * the paragraph under the title, a number in a circle, each an element of its own, in one flat
 * list. Nobody builds a slide that way. This step makes of the same elements what a person
 * would have made:
 *
 * - texts that follow one another in one column become the paragraphs of one text box;
 * - a box with nothing on it but a text that sits in its middle becomes a shape with that text;
 * - a box and what lies on it become a group: the box, then what is on it.
 *
 * It decides by where things were measured to be, as the walk does, and never by what a page
 * calls them (IMP-04). Nothing here may change the picture: the engine draws the composed
 * slide, holds its text against the lines the flat slide drew (`settle`), judges it as it judged
 * the flat one, and takes back whatever does not hold (`refused`).
 */
import {
  createElement,
  rotatedBounds,
  unionBounds,
  type Element as ModelElement,
  type Frame,
  type Insets,
  type Paragraph,
  type TextElement,
  type Theme,
} from '@slidr/model';
import type { Item } from './convert';
import { round, type Line } from './css';
import { composedParent, styleOf } from './measure';

/** An item of the composed slide: alone, or a box with what lies on it. */
export interface Part {
  item: Item;
  /** The id of the group the box and its parts make, and the parts, in paint order. */
  group?: { id: string; parts: Part[] };
}

/** How an item that stands for several was made, and of what. */
export interface Made {
  kind: 'text' | 'label';
  /** The items of the flat proposal it stands for; for a label the box first. */
  of: Item[];
  /** Where the lines of its text were drawn before, in slide px, in the order of the text. */
  lines: Line[];
  /** For each text it was made of: its first line in `lines`, and its first paragraph. */
  starts: { line: number; paragraph: number }[];
}

export interface Composition {
  /** Every item, in paint order: what is drawn and judged. */
  items: Item[];
  /** The same items as they nest. */
  parts: Part[];
  made: Map<Item, Made>;
  /** For every item in a group: the key (`keyOf`) of the innermost group around it. */
  around: Map<Item, string>;
}

export interface ComposeContext {
  /** The element the slide was converted from: its own box is the slide's ground. */
  root: Element;
  /** The theme the slide is drawn with: what a paragraph without a line height of its own takes. */
  theme: Theme;
  slide: { w: number; h: number };
  /** Where the lines of each text were drawn on the flat slide, in slide px. */
  lines: ReadonlyMap<Item, readonly Line[]>;
  /** The id of the group around a box: the same one every time the plan is made again. */
  groupId(base: Item): string;
  /** Compositions that did not hold when they were drawn (`keyOf`): not proposed again. */
  refused: ReadonlySet<string>;
  /** Elements of an earlier plan that were already settled, by `keyOf`: taken as they are. */
  kept?: ReadonlyMap<string, ModelElement>;
}

/** What names a composition from one plan to the next: the elements it is made of. */
export function keyOf(kind: Made['kind'] | 'group', of: readonly Item[]): string {
  return `${kind}:${of.map((item) => item.element.id).join('+')}`;
}

/** Slack for "the same place" between two measured positions across a line, in slide px. */
const SAME = 0.1;
/** And down the slide, where a hair decides which row of pixels the glyphs fall on. */
const SAME_ROW = 0.02;
/**
 * How far under the last line of a text the first line of the next still follows it, top to
 * top, in heights of the taller glyphs of the two: a line, and up to a line and a half of room.
 */
const FOLLOWS = 2.5;
/** Room left beside a one-line text in a shape, so that a box measured to its glyphs cannot wrap. */
const SLACK = 2;
/** How far from the glyphs of a text what stands beside it may be, in heights of its glyphs. */
const NEAR = 2;
/** How wide the one line of a text that marks a row may be, in heights of its glyphs. */
const MARK = 3;

const right = (f: Frame) => f.x + f.w;
const bottom = (f: Frame) => f.y + f.h;
const fine = (n: number) => Math.round(n * 1000) / 1000;

function overlap(a: Frame, b: Frame): boolean {
  return (
    Math.min(right(a), right(b)) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > 0.5
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A plain text box, as the walk makes them: one that another can be joined to. */
function plainText(item: Item): item is Item & { element: TextElement } {
  const e = item.element;
  return (
    e.type === 'text' &&
    item.covers !== 'box' &&
    !item.exempt &&
    e.rotation === 0 &&
    !e.flipH &&
    !e.flipV &&
    !e.padding &&
    !e.columns &&
    !e.link &&
    !e.locked &&
    !e.hidden &&
    e.vAlign === 'top' &&
    e.autoFit === 'none' &&
    e.content.paragraphs.length > 0
  );
}

/** The side of its box a paragraph's lines are put against. */
function anchorOf(paragraph: Paragraph): 'left' | 'center' | 'right' {
  if (paragraph.align === 'center') return 'center';
  const rtl = paragraph.dir === 'rtl';
  return (paragraph.align === 'end') === rtl ? 'left' : 'right';
}

/**
 * How tall the renderer makes each line of a paragraph: its line height, times the largest
 * text on it. The paragraph itself counts as text of its style's size, however small its runs.
 */
function lineBox(paragraph: Paragraph, theme: Theme): number {
  const style = theme.textStyles[paragraph.styleRef ?? 'body'];
  const sizes = paragraph.runs.map((run) => run.marks?.size ?? style.size);
  return (paragraph.lineHeight ?? style.lineHeight) * Math.max(style.size, ...sizes);
}

/**
 * Makes the one line of a paragraph lower by `by`. A line box loses height above its text and
 * below it alike, so the text rises by half of it within the box: the caller moves the
 * paragraph down by that half, and the text stays where it was.
 */
function lowerLine(paragraph: Paragraph, theme: Theme, by: number): boolean {
  const style = theme.textStyles[paragraph.styleRef ?? 'body'];
  const sizes = paragraph.runs.map((run) => run.marks?.size ?? style.size);
  const largest = Math.max(style.size, ...sizes);
  const height = lineBox(paragraph, theme) - by;
  // A line box may be lower than its glyphs, which are drawn past it; not to no height at all.
  if (height < 0.25 * largest) return false;
  paragraph.lineHeight = Math.round((height / largest) * 10000) / 10000;
  return true;
}

/** Plans the composition of the items of a settled proposal. Changes none of them. */
export function compose(flat: readonly Item[], ctx: ComposeContext): Composition {
  const order = new Map(flat.map((item, index) => [item, index]));
  const made = new Map<Item, Made>();
  /** The lines of the flat texts, and of the texts joined from them. */
  const lines = new Map(ctx.lines);

  /**
   * Where an item is, in slide px. A text is where its glyphs are: the box of a text element
   * is where its lines start from, which the guard moves until the glyphs sit right. A shadow
   * is not counted: it is the judge that says whether one that now falls over something it
   * fell under is seen.
   */
  const reach = (item: Item): Frame => {
    const own = lines.get(item);
    if (item.element.type === 'text' && own?.length) {
      return unionBounds(
        own.map((l) => ({ x: l.left, y: l.top, w: l.right - l.left, h: l.bottom - l.top })),
      );
    }
    return rotatedBounds(item.element.frame, item.element.rotation);
  };

  const regionOf = (items: readonly Item[]) => {
    const { x, y, w, h } = unionBounds(items.map((i) => ({ ...i.region })));
    return { x, y, w, h };
  };

  // ------------------------------------------------------------------------------- the boxes

  const coversSlide = (f: Frame) =>
    f.x <= 0.5 && f.y <= 0.5 && right(f) >= ctx.slide.w - 0.5 && bottom(f) >= ctx.slide.h - 0.5;
  /** A box that things lie on. One that fills the slide is its ground, not a card. */
  const isBase = (item: Item) =>
    item.covers === 'box' &&
    !item.pseudo &&
    !item.exempt &&
    item.node !== ctx.root &&
    (item.element.type === 'shape' || item.element.type === 'html') &&
    item.element.rotation === 0 &&
    !coversSlide(item.element.frame);
  const baseOf = new Map<Element, Item>();
  for (const item of flat) if (isBase(item)) baseOf.set(item.node, item);

  /** The nearest box around an item: the box of its own node for a text, a parent's for a box. */
  const ownerOf = (item: Item): Item | undefined => {
    let node = baseOf.get(item.node) === item ? composedParent(item.node) : item.node;
    for (; node; node = node === ctx.root ? undefined : composedParent(node)) {
      const base = baseOf.get(node);
      if (base) return base;
    }
    return undefined;
  };
  const lying = new Map<Item | undefined, Item[]>();
  for (const item of flat) {
    const owner = ownerOf(item);
    lying.set(owner, [...(lying.get(owner) ?? []), item]);
  }

  /** Every item of a part, the box first. */
  const leaves = (part: Part): Item[] => [
    part.item,
    ...(part.group?.parts.flatMap((inner) => leaves(inner)) ?? []),
  ];
  /** The flat items a part stands for. */
  const sources = (part: Part): Item[] =>
    leaves(part).flatMap((item) => made.get(item)?.of ?? [item]);
  const at = (part: Part) => Math.min(...sources(part).map((item) => order.get(item)!));
  /** The box around a part. */
  const extent = (part: Part): Frame => unionBounds(sources(part).map(reach));

  /**
   * Whether items may be painted as one, right after the first of them. What is painted
   * between them then lies over all of them, where before it lay under those that came after
   * it: nothing is seen of that only where the two do not meet.
   */
  const together = (members: readonly Item[]): boolean => {
    const set = new Set(members);
    const places = members.map((item) => order.get(item)!);
    const first = Math.min(...places);
    const last = Math.max(...places);
    for (let index = first + 1; index < last; index++) {
      const other = flat[index]!;
      if (set.has(other)) continue;
      const over = reach(other);
      for (const member of members) {
        if (order.get(member)! > index && overlap(reach(member), over)) return false;
      }
    }
    return true;
  };

  // ------------------------------------------------------------------------------- the texts

  interface Member {
    part: Part;
    item: Item & { element: TextElement };
    lines: readonly Line[];
    /** One line that cannot wrap: it sits where its paragraph's alignment puts it. */
    loose: boolean;
  }

  /** How tall the glyphs of a line are: what the distance between two texts is counted in. */
  const glyphs = (line: Line) => line.bottom - line.top;

  /**
   * The box a run of texts shares, and the alignment each of its one-line members needs in it.
   * A text that wraps, and an item of a list, are laid out in their own box, so the run's box
   * is theirs; one-line texts go wherever their line can be put by an alignment.
   */
  const boxOf = (
    members: readonly Member[],
  ): { x: number; w: number; align: (Paragraph['align'] | undefined)[] } | undefined => {
    const rigid = members.filter((m) => !m.loose);
    const frames = (rigid.length > 0 ? rigid : members).map((m) => m.item.element.frame);
    const x = Math.min(...frames.map((f) => f.x));
    const r = Math.max(...frames.map(right));
    if (rigid.some((m) => Math.abs(m.item.element.frame.x - x) > SAME)) return undefined;
    if (rigid.some((m) => Math.abs(right(m.item.element.frame) - r) > SAME)) return undefined;
    const align: (Paragraph['align'] | undefined)[] = [];
    for (const m of members) {
      if (!m.loose) {
        align.push(undefined);
        continue;
      }
      const paragraph = m.item.element.content.paragraphs[0]!;
      const line = m.lines[0]!;
      const rtl = paragraph.dir === 'rtl';
      const fits = {
        start: Math.abs(rtl ? line.right - r : line.left - x) <= SAME,
        center: Math.abs((line.left + line.right) / 2 - (x + r) / 2) <= SAME,
        end: Math.abs(rtl ? line.left - x : line.right - r) <= SAME,
      };
      const now = paragraph.align === 'justify' ? 'start' : paragraph.align;
      const found = fits[now] ? now : (['start', 'center', 'end'] as const).find((a) => fits[a]);
      if (!found) return undefined;
      align.push(found);
    }
    return { x, w: r - x, align };
  };

  /** Whether `next` is the text that follows `last` in the run: like it, under it, and close. */
  const follows = (last: Member, next: Member): boolean => {
    const a = last.item.element;
    const b = next.item.element;
    if (
      a.role !== b.role ||
      a.opacity !== b.opacity ||
      !same(a.css, b.css) ||
      !same(a.effects, b.effects) ||
      !same(last.item.anim, next.item.anim) ||
      last.item.scaled !== next.item.scaled
    ) {
      return false;
    }
    // By the glyphs, which are where the guard put them: the box of a text element is where
    // its lines start from, and that is not always where they are drawn.
    const end = last.lines[last.lines.length - 1]!;
    const start = next.lines[0]!;
    const tall = Math.max(glyphs(end), glyphs(start));
    const down = start.top - end.top;
    return down >= 0.5 * Math.min(glyphs(end), glyphs(start)) && down <= FOLLOWS * tall;
  };

  /**
   * A text that marks a row rather than says something: one short line, a number or a year,
   * no wider than a few of its glyphs are tall.
   */
  const mark = (item: Item): boolean => {
    const own = lines.get(item);
    if (item.element.type !== 'text' || own?.length !== 1) return false;
    return own[0]!.right - own[0]!.left <= MARK * glyphs(own[0]!);
  };

  /**
   * What stands beside a text, on its lines and close to them: its number in a circle, its
   * icon, its number set as a text of its own. Texts that each have one of their own are the
   * rows of a list, and stay texts of their own: as the paragraphs of one box, a line more in
   * one row would push every row after it away from what stands beside it. A title with a
   * badge and the lines under it are still one text. A picture across the slide from the
   * text, or a dot at its edge, stands beside nothing; nor does the next column of words.
   */
  const beside = (member: Member, siblings: readonly Part[]): Part[] => {
    const top = member.lines[0]!.top;
    const end = member.lines[member.lines.length - 1]!.bottom;
    const left = Math.min(...member.lines.map((l) => l.left));
    const far = Math.max(...member.lines.map((l) => l.right));
    const near = NEAR * Math.max(...member.lines.map(glyphs));
    return siblings.filter((part) => {
      if (part === member.part) return false;
      if (!part.group && part.item.element.type === 'text') {
        if (!mark(part.item) && !mark(member.item)) return false;
      }
      const box = extent(part);
      if (Math.min(right(box), far) - Math.max(box.x, left) > 0.5) return false;
      if (Math.max(box.x - far, left - right(box)) > near) return false;
      const shared = Math.min(bottom(box), end) - Math.max(box.y, top);
      return shared > 0.5 * Math.min(box.h, end - top);
    });
  };

  /**
   * Whether the box a run would share is the run's own: nothing else on the same ground lies
   * in it. A rule between two of the texts, a word beside one of them on its line: with either
   * in the box, the texts are not one column of paragraphs. What lies across the whole of it
   * (a sheen over the card) is over the text however the text is held.
   */
  const alone = (
    run: readonly Member[],
    box: { x: number; w: number },
    siblings: readonly Part[],
  ) => {
    // From the letters of the first line to those of the last. The box a browser reports for a
    // line of glyphs is the font's whole height, which the letters fill only the middle of:
    // a fifth of it at either end is room the line next to it may well reach into.
    const first = run[0]!.lines[0]!;
    const lines = run[run.length - 1]!.lines;
    const last = lines[lines.length - 1]!;
    const top = first.top + 0.2 * glyphs(first);
    const area = { x: box.x, y: top, w: box.w, h: last.bottom - 0.2 * glyphs(last) - top };
    const within = (outer: Frame) =>
      outer.x <= area.x + 0.5 &&
      outer.y <= area.y + 0.5 &&
      right(outer) >= right(area) - 0.5 &&
      bottom(outer) >= bottom(area) - 0.5;
    return !siblings.some((part) => {
      if (run.some((m) => m.part === part)) return false;
      const other = extent(part);
      return overlap(other, area) && !within(other);
    });
  };

  /**
   * One text box for a run of texts: a paragraph each, starting where the text started. A
   * paragraph starts where the one above it ends, at the nearest, and a one-line text whose
   * line box reaches further down than that (a small label in the line of a larger style) has
   * its line made lower until it does not. Undefined when the texts cannot be stacked so.
   */
  const joined = (
    run: readonly Member[],
    box: NonNullable<ReturnType<typeof boxOf>>,
  ): Item | undefined => {
    const first = run[0]!;
    const members = run.map((m) => m.item);
    const paragraphs = run.map((m, index): Paragraph => {
      const paragraph = m.item.element.content.paragraphs[0]!;
      const align = box.align[index];
      return { ...paragraph, ...(align ? { align } : {}) };
    });
    const tops = run.map((m) => m.item.element.frame.y);
    const heights = run.map((m, i) => m.lines.length * lineBox(paragraphs[i]!, ctx.theme));
    for (let i = 1; i < run.length; i++) {
      const over = tops[i - 1]! + heights[i - 1]! - tops[i]!;
      if (over <= 0) continue;
      if (run[i - 1]!.lines.length !== 1 || !lowerLine(paragraphs[i - 1]!, ctx.theme, 2 * over))
        return undefined;
      heights[i - 1]! -= 2 * over;
      tops[i - 1]! += over;
    }
    const starts: Made['starts'] = [];
    let count = 0;
    run.forEach((m, i) => {
      starts.push({ line: count, paragraph: i });
      count += m.lines.length;
      const space = i === 0 ? 0 : fine(tops[i]! - tops[i - 1]! - heights[i - 1]!);
      if (space > 0) paragraphs[i]!.spaceBefore = space;
    });
    const last = run.length - 1;
    const named = run.find((m) => m.item.element.name)?.item.element.name;
    const { wrap: _wrap, name: _name, ...rest } = first.item.element;
    const element: ModelElement = ctx.kept?.get(keyOf('text', members)) ?? {
      ...rest,
      frame: {
        x: round(box.x),
        y: fine(tops[0]!),
        w: round(box.w),
        h: round(tops[last]! + heights[last]! - tops[0]!),
      },
      content: { paragraphs },
      // Kept on one line only where no line of it ever wrapped.
      ...(run.every((m) => m.item.element.wrap === false) ? { wrap: false } : {}),
      ...(named ? { name: named } : {}),
    };
    const source = members.every((item) => item.lines)
      ? members.flatMap((item) => item.lines!)
      : undefined;
    const ignored = members.flatMap((item) => item.ignored ?? []);
    // Where each character sits was compared when the texts stood apart, and a paragraph is
    // laid out the same in a box it shares: the joined text is not asked again.
    const { lines: _lines, ignored: _ignored, characters: _characters, ...head } = first.item;
    const item: Item = {
      ...head,
      element,
      region: regionOf(members),
      ...(source ? { lines: source } : {}),
      ...(ignored.length > 0 ? { ignored } : {}),
      units: members.reduce((sum, i) => sum + i.units, 0),
      chars: members.reduce((sum, i) => sum + i.chars, 0),
    };
    const drawn = run.flatMap((m) => [...m.lines]);
    made.set(item, { kind: 'text', of: members, lines: drawn, starts });
    lines.set(item, drawn);
    return item;
  };

  /** The texts among the parts on one box, joined where they follow one another. */
  const joinTexts = (parts: Part[]): Part[] => {
    const members: Member[] = [];
    for (const part of parts) {
      const item = part.item;
      const own = lines.get(item);
      if (part.group || !plainText(item) || !own || own.length === 0) continue;
      // The walk makes a text of one paragraph; anything else is not its own, and is left.
      if (item.element.content.paragraphs.length !== 1) continue;
      const paragraph = item.element.content.paragraphs[0]!;
      members.push({
        part,
        item,
        lines: own,
        loose: item.element.wrap === false && own.length === 1 && !paragraph.list,
      });
    }
    members.sort((a, b) => a.lines[0]!.top - b.lines[0]!.top);
    const runs: Member[][] = [];
    for (const member of members) {
      // The run it continues: the one that ends nearest above it, in the same column.
      const end = (run: Member[]) => bottom(run[run.length - 1]!.item.element.frame);
      const open = runs
        .filter((run) => {
          if (!follows(run[run.length - 1]!, member)) return false;
          // Rows that each have something of their own beside them are rows, and the row a text
          // starts does not take in the lines above it either: they would push it off its mark.
          const had = new Set(run.flatMap((m) => beside(m, parts)));
          if (beside(member, parts).some((part) => !had.has(part))) return false;
          const longer = [...run, member];
          const box = boxOf(longer);
          return box !== undefined && alone(longer, box, parts);
        })
        .sort((a, b) => end(b) - end(a))[0];
      if (open) open.push(member);
      else runs.push([member]);
    }
    const replaced = new Map<Part, Part | null>();
    for (const run of runs) {
      if (run.length < 2) continue;
      const items = run.map((m) => m.item);
      const box = boxOf(run);
      if (!box || ctx.refused.has(keyOf('text', items)) || !together(items)) continue;
      const lowest = [...run].sort((a, b) => order.get(a.item)! - order.get(b.item)!)[0]!;
      const text = joined(run, box);
      if (!text) continue;
      for (const m of run) replaced.set(m.part, m === lowest ? { item: text } : null);
    }
    return parts.flatMap((part) => {
      const to = replaced.get(part);
      return to === undefined ? [part] : to ? [to] : [];
    });
  };

  // ------------------------------------------------------------------------------- the label

  /**
   * Whether the page itself keeps the text in the middle of the box, from top to bottom: the
   * box is the text's own (it is as tall as its text and the room around it), or something
   * between the two lays its content out around the middle. A card whose paragraph happens to
   * fill it is not that: on a taller card the paragraph would stay at the top.
   */
  const keptInMiddle = (base: Item, text: Item): boolean => {
    if (text.node === base.node) return true;
    for (let node = composedParent(text.node); node; node = composedParent(node)) {
      const cs = styleOf(node);
      const middle = (value: string) => /(^|\s)center$/.test(value);
      if (/flex$/.test(cs.display)) {
        if (middle(cs.flexDirection.startsWith('column') ? cs.justifyContent : cs.alignItems))
          return true;
      } else if (/grid$/.test(cs.display)) {
        if (middle(cs.alignItems) || middle(cs.alignContent)) return true;
      } else if (cs.display === 'table-cell' && cs.verticalAlign === 'middle') return true;
      if (node === base.node) break;
    }
    return false;
  };

  /**
   * A box with one text in its middle, as a shape with that text: a number in a circle, a
   * chip, a button. The text keeps its place through the room the shape leaves around it. A
   * text at the top of a taller box is a text box on a card, and stays one; so do texts that
   * were joined, which a card has and a label does not.
   */
  const labelled = (base: Item, text: Item): Item | undefined => {
    const shape = base.element;
    const t = text.element;
    const own = lines.get(text);
    if (shape.type !== 'shape' || shape.content || shape.geometry.kind !== 'preset')
      return undefined;
    if (!plainText(text) || t.type !== 'text' || !own || own.length === 0) return undefined;
    if (t.opacity !== shape.opacity || t.css || t.effects || t.role) return undefined;
    if (!same(base.anim, text.anim) || made.has(text)) return undefined;
    const of = [base, text];
    if (ctx.refused.has(keyOf('label', of)) || !together(of)) return undefined;
    const box = shape.frame;
    // By the glyphs, which are where the guard put them; the box of a text element is not
    // always the box of its lines.
    const above = own[0]!.top - box.y;
    const below = bottom(box) - own[own.length - 1]!.bottom;
    if (above < -SAME || below < -SAME) return undefined;
    if (Math.abs(above - below) > Math.max(3, 0.25 * Math.min(above, below))) return undefined;
    if (!keptInMiddle(base, text)) return undefined;

    const paragraphs = t.content.paragraphs;
    const one = t.wrap === false && own.length === 1 && paragraphs.length === 1;
    let left = t.frame.x - box.x;
    let end = right(box) - right(t.frame);
    let align: Paragraph['align'] | undefined;
    if (one && !paragraphs[0]!.list) {
      // A box measured to the glyphs: the line is put by an alignment, with room to spare.
      const line = own[0]!;
      const rtl = paragraphs[0]!.dir === 'rtl';
      const ahead = line.left - box.x;
      const after = right(box) - line.right;
      if (ahead < -SAME || after < -SAME) return undefined;
      if (Math.abs(ahead - after) <= Math.max(1, 0.05 * Math.min(ahead, after))) {
        align = 'center';
        // The same room on both sides, in whole pixels; a line that sits a real fraction off
        // the middle keeps the fraction on the side it leans from.
        const room = Math.max(0, Math.floor(Math.min(ahead, after) - SLACK));
        const lean = Math.abs(ahead - after) <= SAME ? 0 : ahead - after;
        left = room + Math.max(0, lean);
        end = room + Math.max(0, -lean);
      } else if (ahead <= after === !rtl) {
        align = 'start';
        left = rtl ? 0 : ahead;
        end = rtl ? after : 0;
      } else {
        align = 'end';
        left = rtl ? ahead : 0;
        end = rtl ? 0 : after;
      }
    } else if (left < -SAME || end < -SAME) return undefined;
    // Above and below, the same room: the shape keeps its text in the middle, and `settle`
    // leans it by whatever fraction the lines then sit off.
    const room = Math.max(0, Math.floor(Math.min(above, below)));
    const padding: Insets = {
      top: room,
      right: round(Math.max(0, end)),
      bottom: room,
      left: round(Math.max(0, left)),
    };
    const element: ModelElement = ctx.kept?.get(keyOf('label', of)) ?? {
      ...shape,
      content: {
        paragraphs: paragraphs.map((p, i) => (i === 0 && align ? { ...p, align } : p)),
      },
      padding,
      ...(t.name ? { name: t.name } : {}),
    };
    const { lines: _lines, ignored: _ignored, characters: _characters, ...head } = base;
    const item: Item = {
      ...head,
      element,
      region: regionOf([base, text]),
      ...(text.lines ? { lines: text.lines } : {}),
      ...(text.ignored ? { ignored: text.ignored } : {}),
      units: base.units + text.units,
      chars: base.chars + text.chars,
    };
    made.set(item, {
      kind: 'label',
      of,
      lines: [...own],
      starts: [{ line: 0, paragraph: 0 }],
    });
    return item;
  };

  // ------------------------------------------------------------------------------- the groups

  /** The parts that lie on a box (or, with none, on the slide itself), composed. */
  const on = (owner: Item | undefined): Part[] => {
    const parts = (lying.get(owner) ?? []).flatMap((item) =>
      isBase(item) ? boxed(item) : [{ item }],
    );
    return joinTexts(parts.sort((a, b) => at(a) - at(b)));
  };

  /** A box and what lies on it: a shape with its text, a group, or the parts side by side. */
  const boxed = (base: Item): Part[] => {
    const parts = on(base);
    if (parts.length === 0) return [{ item: base }];
    if (parts.length === 1 && !parts[0]!.group) {
      const label = labelled(base, parts[0]!.item);
      if (label) return [{ item: label }];
    }
    const members = [base, ...parts.flatMap(sources)];
    const lowest = Math.min(...members.map((item) => order.get(item)!));
    // What a layout seats by its role is looked for on the slide itself, not inside a group.
    const seated = members.some((item) => item.element.role);
    if (
      seated ||
      lowest !== order.get(base) ||
      ctx.refused.has(keyOf('group', members)) ||
      !together(members)
    ) {
      return [{ item: base }, ...parts];
    }
    const key = keyOf('group', members);
    for (const item of [base, ...parts.flatMap(leaves)])
      if (!around.has(item)) around.set(item, key);
    return [{ item: base, group: { id: ctx.groupId(base), parts } }];
  };

  /** The innermost group each item is in, by its key: filled from the inside out. */
  const around = new Map<Item, string>();
  const parts = on(undefined);
  return { items: parts.flatMap(leaves), parts, made, around };
}

/** Whether a plan leaves the proposal as it was. */
export function unchanged(composition: Composition): boolean {
  return composition.made.size === 0 && composition.parts.every((part) => !part.group);
}

/**
 * Holds the text of a composed item to the lines it drew before it was put together. `drawn`:
 * its lines as the composed slide lays them out, in slide px. A text that sits a fraction off
 * is put right through what holds it in place (the box, the space before a paragraph, the room
 * a shape leaves around its text), in the element itself; one that is laid out differently is
 * `refused`.
 */
export function settle(
  item: Item,
  how: Made,
  drawn: readonly Line[],
  theme: Theme,
): 'settled' | 'moved' | 'refused' {
  const element = item.element;
  const content = element.type === 'text' || element.type === 'shape' ? element.content : undefined;
  if (!content || drawn.length !== how.lines.length || drawn.length === 0) return 'refused';
  const down = how.starts.map(({ line }) => drawn[line]!.top - how.lines[line]!.top);
  // Inside each text the lines keep their own spacing: only where it starts can be put right.
  const spaced = how.starts.every(({ line }, i) => {
    const until = how.starts[i + 1]?.line ?? drawn.length;
    for (let l = line; l < until; l++) {
      if (Math.abs(drawn[l]!.top - how.lines[l]!.top - down[i]!) > SAME) return false;
    }
    return true;
  });
  if (!spaced) return 'refused';
  const first = content.paragraphs[0]!;
  const anchor = anchorOf(first);
  const centre = (l: Line) => (l.left + l.right) / 2;
  const sideways = drawn.map((d, i) => {
    const was = how.lines[i]!;
    return anchor === 'center'
      ? centre(d) - centre(was)
      : anchor === 'left'
        ? d.left - was.left
        : d.right - was.right;
  });
  // Across the lines only a shape with one line has something to give: the room beside it.
  const lone = element.type === 'shape' && drawn.length === 1;
  const across = sideways.every((dx) => Math.abs(dx) <= SAME);
  const widths = drawn.every(
    (d, i) => Math.abs(d.right - d.left - (how.lines[i]!.right - how.lines[i]!.left)) <= SAME,
  );
  if (!widths || (!across && !lone)) return 'refused';

  let moved = false;
  /** How far the first text has to go down besides: see `lowerLine`. */
  let lowered = 0;
  const spaceOut = (paragraph: Paragraph, space: number) => {
    if (space > 0) paragraph.spaceBefore = fine(space);
    else delete paragraph.spaceBefore;
  };
  // Between the texts: the space before the first paragraph of each.
  for (let i = 1; i < how.starts.length; i++) {
    const more = down[i]! - down[i - 1]!;
    if (Math.abs(more) <= SAME_ROW) continue;
    const paragraph = content.paragraphs[how.starts[i]!.paragraph]!;
    const space = (paragraph.spaceBefore ?? 0) - more;
    moved = true;
    if (space >= -SAME_ROW) {
      spaceOut(paragraph, space);
      continue;
    }
    // No room left to take: the line above is lower than its box, if it is one line.
    const above = how.starts[i - 1]!;
    const before = content.paragraphs[above.paragraph]!;
    if (how.starts[i]!.line - above.line !== 1 || !lowerLine(before, theme, -2 * space))
      return 'refused';
    spaceOut(paragraph, 0);
    if (i === 1) lowered = -space;
    else spaceOut(before, (before.spaceBefore ?? 0) - space);
  }
  const dy = down[0]! - lowered;
  const dx = lone ? sideways[0]! : 0;
  if (element.type === 'text') {
    if (Math.abs(dy) > SAME_ROW) {
      element.frame = { ...element.frame, y: fine(element.frame.y - dy) };
      moved = true;
    }
  } else if (element.type === 'shape' && (Math.abs(dy) > SAME_ROW || Math.abs(dx) > SAME)) {
    const p = element.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
    /** Two rooms on opposite sides of a text that sits in the middle, after it moves by `by`. */
    const middle = (before: number, after: number, by: number): [number, number] => {
      const sum = before + after;
      const lean = before - after - 2 * by;
      const a = (sum + lean) / 2;
      const b = (sum - lean) / 2;
      return a < 0 ? [0, -lean] : b < 0 ? [lean, 0] : [a, b];
    };
    let { top, bottom: below, left, right: after } = p;
    if (Math.abs(dy) > SAME_ROW) [top, below] = middle(top, below, dy);
    if (Math.abs(dx) > SAME) {
      if (anchor === 'center') [left, after] = middle(left, after, dx);
      else if (anchor === 'left') left -= dx;
      else after += dx;
    }
    if ([top, below, left, after].some((n) => n < -SAME)) return 'refused';
    element.padding = {
      top: fine(Math.max(0, top)),
      right: fine(Math.max(0, after)),
      bottom: fine(Math.max(0, below)),
      left: fine(Math.max(0, left)),
    };
    moved = true;
  }
  return moved ? 'moved' : 'settled';
}

/**
 * The elements of composed parts. A group's frame is the box around what is in it, and the
 * frames of its children count from its corner. The corner is put on the grid a browser lays
 * boxes out on (a 64th of a pixel), so that a child drawn at "corner plus offset" lands on the
 * very position it had on the slide, and not a rounding away from it.
 */
export function elementsOf(parts: readonly Part[]): ModelElement[] {
  return parts.map((part) => {
    if (!part.group) return part.item.element;
    const children = [part.item.element, ...elementsOf(part.group.parts)];
    const around = unionBounds(children.map((c) => rotatedBounds(c.frame, c.rotation)));
    const x = Math.floor(around.x * 64 + 1e-6) / 64;
    const y = Math.floor(around.y * 64 + 1e-6) / 64;
    const within = (child: ModelElement): ModelElement => ({
      ...child,
      frame: { ...child.frame, x: child.frame.x - x, y: child.frame.y - y },
    });
    // The name a page gave the box is the name of the thing, which is the group now.
    const { name, ...box } = part.item.element;
    return createElement.group({
      id: part.group.id,
      ...(name ? { name } : {}),
      frame: { x, y, w: right(around) - x, h: bottom(around) - y },
      children: [within(box), ...children.slice(1).map(within)],
    });
  });
}
