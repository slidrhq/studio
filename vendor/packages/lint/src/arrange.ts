import { updateElement, type Command, type Frame } from '@slidr/model';
import { SLACK } from './geometry';
import type { Item, SlideContext } from './rule';

/** A move on the slide, in slide pixels. */
export interface Move {
  dx: number;
  dy: number;
}

/** Frames are kept on a grid of a thousandth of a pixel, as the template engine keeps them. */
const settle = (n: number) => Math.round(n * 1000) / 1000;

const still = ({ dx, dy }: Move) => Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001;

function moved(frame: Frame, { dx, dy }: Move): Frame {
  return { ...frame, x: settle(frame.x + dx), y: settle(frame.y + dy) };
}

function inside(inner: Frame, outer: Frame): boolean {
  return (
    inner.x >= outer.x - SLACK &&
    inner.y >= outer.y - SLACK &&
    inner.x + inner.w <= outer.x + outer.w + SLACK &&
    inner.y + inner.h <= outer.y + outer.h + SLACK
  );
}

/** What other elements can sit on: a card, a picture, a group. Text and lines carry nothing. */
const CARRIES: ReadonlySet<string> = new Set(['shape', 'image', 'group', 'html', 'video']);

/**
 * The commands that move elements at the top of the slide's tree. What sits on a moved element
 * (inside its box, and above it) goes with it: the text of a card moves with the card, though
 * nothing in the model ties them. An element that is given a move of its own keeps that one.
 * A locked element that sits on a moved one stays where the user locked it.
 */
export function moveTops(
  ctx: Pick<SlideContext, 'slide' | 'tops' | 'locked'>,
  moves: ReadonlyMap<string, Move>,
): Command[] {
  const all = new Map(moves);
  ctx.tops.forEach((item, i) => {
    const move = moves.get(item.element.id);
    if (!move || !CARRIES.has(item.element.type)) return;
    for (const rider of ctx.tops.slice(i + 1)) {
      const { id } = rider.element;
      if (moves.has(id) || ctx.locked.has(id)) continue;
      if (inside(rider.measure.box, item.measure.box)) all.set(id, move);
    }
  });
  const commands: Command[] = [];
  for (const { element } of ctx.tops) {
    const move = all.get(element.id);
    if (!move || still(move)) continue;
    commands.push(updateElement(ctx.slide.id, element.id, { frame: moved(element.frame, move) }));
  }
  return commands;
}

/**
 * The command that moves one element, wherever it is in the tree. A frame is in the pixels of
 * its group, which are the slide's as long as no group above it is rotated or flipped; where
 * one is, a move of the frame is not that move on the slide, and there is no command.
 */
export function moveElement(
  ctx: Pick<SlideContext, 'slide' | 'turned'>,
  { element }: Item,
  move: Move,
): Command[] | undefined {
  if (ctx.turned.has(element.id) || still(move)) return undefined;
  return [updateElement(ctx.slide.id, element.id, { frame: moved(element.frame, move) })];
}

/** How far a box has to move to lie inside an area; undefined when it is larger than the area. */
export function pullIn(box: Frame, area: Frame): Move | undefined {
  if (box.w > area.w + SLACK || box.h > area.h + SLACK) return undefined;
  return {
    dx: Math.max(0, area.x - box.x) - Math.max(0, box.x + box.w - (area.x + area.w)),
    dy: Math.max(0, area.y - box.y) - Math.max(0, box.y + box.h - (area.y + area.h)),
  };
}
