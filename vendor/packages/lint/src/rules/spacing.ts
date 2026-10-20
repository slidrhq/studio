import type { Frame } from '@slidr/model';
import { moveTops, type Move } from '../arrange';
import { area, slideArea } from '../geometry';
import type { Item, Problem, Rule, SlideContext } from '../rule';
import { arranged } from './alignment';

/** Objects are peers in a row when their tops and their sizes agree this closely (a column: lefts). */
const SAME = 2;
/** Gaps that differ by more than this are not the same gap. */
const UNEVEN = 2;
/** A gap this many times the smallest sets a group apart on purpose: not a slip of the hand. */
const APART = 3;
/** Fewer objects than this have one gap, or none: nothing to compare. */
const MIN_ROW = 3;

interface Axis {
  /** Where the objects of a row (or column) all begin, on the other axis. */
  across: (box: Frame) => number;
  start: (box: Frame) => number;
  size: (box: Frame) => number;
  name: 'row' | 'column';
  move: (by: number) => Move;
}

const ROW: Axis = {
  across: (box) => box.y,
  start: (box) => box.x,
  size: (box) => box.w,
  name: 'row',
  move: (dx) => ({ dx, dy: 0 }),
};
const COLUMN: Axis = {
  across: (box) => box.x,
  start: (box) => box.y,
  size: (box) => box.h,
  name: 'column',
  move: (dy) => ({ dx: 0, dy }),
};

const round = (n: number) => Math.round(n * 10) / 10;

function inside(inner: Frame, outer: Frame): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.w <= outer.x + outer.w + 1 &&
    inner.y + inner.h <= outer.y + outer.h + 1
  );
}

/**
 * The objects that stand for themselves in a row. What sits on a card (inside it, above it) is
 * spaced by its card: the titles of three cards are as far apart as the cards are, and saying
 * so twice helps nobody. A panel behind half the slide or more carries everything and counts
 * as the ground.
 */
function standing(ctx: SlideContext): Item[] {
  const all = arranged(ctx);
  const ground = area(slideArea(ctx.deck)) / 2;
  const carries = (item: Item) =>
    ['shape', 'image', 'group', 'html', 'video'].includes(item.element.type) &&
    area(item.measure.box) < ground;
  return all.filter(
    (item, i) =>
      !all
        .slice(0, i)
        .some((under) => carries(under) && inside(item.measure.box, under.measure.box)),
  );
}

const textSize = ({ measure }: Item) => Math.round(measure.text?.spans[0]?.fontSize ?? 0);

/** Gaps that read the same from both ends (3, 23, 3) part the objects into groups: a pattern. */
function patterned(gaps: number[]): boolean {
  return (
    gaps.length > 2 && gaps.every((gap, i) => Math.abs(gap - gaps[gaps.length - 1 - i]!) <= UNEVEN)
  );
}

function rows(items: Item[], axis: Axis): Item[][] {
  const left = new Set(items);
  const found: Item[][] = [];
  for (const seed of items) {
    if (!left.has(seed)) continue;
    const of = seed.measure.box;
    // Peers: the same kind of object at the same size, begun on one line, and for text, set in
    // one size. A title, a subtitle and a body in a column are not peers, and neither are a
    // figure and the line under it: the gaps between those differ on purpose.
    const row = items.filter((item) => {
      const { box } = item.measure;
      return (
        left.has(item) &&
        item.element.type === seed.element.type &&
        textSize(item) === textSize(seed) &&
        Math.abs(axis.across(box) - axis.across(of)) <= SAME &&
        Math.abs(box.w - of.w) <= SAME &&
        Math.abs(box.h - of.h) <= SAME
      );
    });
    if (row.length < MIN_ROW) continue;
    for (const item of row) left.delete(item);
    found.push(row.sort((a, b) => axis.start(a.measure.box) - axis.start(b.measure.box)));
  }
  return found;
}

/**
 * L10: objects of one size in a row or in a column, with gaps that are not the same. Three
 * cards 24, 24 and 31px apart were meant to be evenly spaced. The fix keeps the first and the last where they
 * are and spreads the others between them, each with what sits on it.
 */
export const L10: Rule = {
  id: 'L10',
  severity: 'warning',
  agent: false,
  check(ctx) {
    const items = standing(ctx);
    const problems: Problem[] = [];
    for (const axis of [ROW, COLUMN]) {
      for (const row of rows(items, axis)) {
        const gaps = row.slice(1).map((item, i) => {
          const before = row[i]!.measure.box;
          return axis.start(item.measure.box) - (axis.start(before) + axis.size(before));
        });
        const least = Math.min(...gaps);
        const most = Math.max(...gaps);
        // Objects that overlap are not spaced at all, and a wide gap parts two groups.
        if (least < 0 || most - least <= UNEVEN || most > APART * Math.max(least, 8)) continue;
        if (patterned(gaps)) continue;
        const even = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
        const moves = new Map<string, Move>();
        let at = axis.start(row[0]!.measure.box);
        for (const item of row) {
          moves.set(item.element.id, axis.move(at - axis.start(item.measure.box)));
          at += axis.size(item.measure.box) + even;
        }
        const fix = moveTops(ctx, moves);
        problems.push({
          elementIds: row.map((item) => item.element.id),
          message: `${row.map((item) => `"${item.element.id}"`).join(', ')} stand in a ${axis.name} with gaps of ${gaps.map(round).join(', ')}px between them. Space them evenly, ${round(even)}px apart.`,
          ...(fix.length ? { fix } : {}),
        });
      }
    }
    return problems;
  },
};
