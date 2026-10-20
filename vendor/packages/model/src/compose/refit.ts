import type { CommandBus, DispatchOptions } from '../bus';
import type { Affected, Command } from '../commands';
import { rotatedBounds, rotateVector, unionBounds } from '../geometry';
import { newId } from '../ids';
import type { Deck, Element, Frame, GroupElement, Slide } from '../schema';

/**
 * Keeping a group's frame around its children (ARR-01). A child's frame is relative to the group's
 * frame, and the group rotates and mirrors around the centre of that frame. So when a child moves
 * or changes size, the group takes the new bounds of its children and every child shifts by the
 * same amount the other way: nothing moves on the slide, and the frame bounds the children again.
 *
 * The Stage fits the groups around what a gesture changes, in the same commands. Everything else
 * that moves or resizes an element inside a group (an alignment from a menu, a numeric field, the
 * agent) sends its commands through `batchFitted`, which adds the fit to the same undo step.
 */

/** What a gesture changes of an element's placement. `null` stands for an element being removed. */
export type Placement = Partial<Pick<Element, 'frame' | 'rotation'>>;

/** A refit ignores differences below this: the model keeps a thousandth of a pixel. */
const EPSILON = 2e-3;

/** Rounds away floating-point noise without moving anything a user could see. */
function tidy(value: number): number {
  // Adding 0 turns -0 into 0.
  return Math.round(value * 1000) / 1000 + 0;
}

function tidyFrame(frame: Frame): Frame {
  return { x: tidy(frame.x), y: tidy(frame.y), w: tidy(frame.w), h: tidy(frame.h) };
}

/**
 * The placements that go with a change inside nested groups.
 *
 * @param path The groups around the changed elements, outermost first, as they are before the
 *   change.
 * @param changes New frame and / or rotation of children of the innermost group; `null` removes
 *   the child.
 * @returns The changed children, their siblings and the groups of the path, each with the frame it
 *   has to get. Removed elements, and groups left empty by a removal, map to `null`.
 */
export function refitGroups(
  path: readonly GroupElement[],
  changes: ReadonlyMap<string, Placement | null>,
): Map<string, Placement | null> {
  const out = new Map<string, Placement | null>(changes);
  let pending: ReadonlyMap<string, Placement | null> = changes;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const group = path[depth] as GroupElement;
    const children = group.children
      .filter((child) => pending.get(child.id) !== null)
      .map((child) => {
        const change = pending.get(child.id);
        return {
          id: child.id,
          frame: change?.frame ?? child.frame,
          rotation: change?.rotation ?? child.rotation,
        };
      });
    if (children.length === 0) {
      // The command that removes the last child removes the group too (ADR-007).
      out.set(group.id, null);
      pending = new Map([[group.id, null]]);
      continue;
    }
    const bounds = unionBounds(children.map((c) => rotatedBounds(c.frame, c.rotation)));
    const { frame } = group;
    const moved = Math.abs(bounds.x) > EPSILON || Math.abs(bounds.y) > EPSILON;
    const resized =
      Math.abs(bounds.w - frame.w) > EPSILON || Math.abs(bounds.h - frame.h) > EPSILON;
    // The group already bounds its children, so nothing above it changes either.
    if (!moved && !resized) break;
    if (moved) {
      for (const child of children) {
        out.set(child.id, {
          ...out.get(child.id),
          frame: tidyFrame({
            ...child.frame,
            x: child.frame.x - bounds.x,
            y: child.frame.y - bounds.y,
          }),
        });
      }
    }
    // How far the centre of the children moved, in the group's own axes, and from there on the
    // slide: mirrored, then rotated, as the group draws its inside.
    const shift = {
      x: bounds.x + bounds.w / 2 - frame.w / 2,
      y: bounds.y + bounds.h / 2 - frame.h / 2,
    };
    const onParent = rotateVector(
      { x: group.flipH ? -shift.x : shift.x, y: group.flipV ? -shift.y : shift.y },
      group.rotation,
    );
    const next: Frame = tidyFrame({
      x: frame.x + frame.w / 2 + onParent.x - bounds.w / 2,
      y: frame.y + frame.h / 2 + onParent.y - bounds.h / 2,
      w: bounds.w,
      h: bounds.h,
    });
    out.set(group.id, { frame: next });
    pending = new Map([[group.id, { frame: next }]]);
  }
  return out;
}

/** What `element.update` takes; `frame` and `rotation` are what a refit reads and writes. */
export type PlacementPatch = Record<string, unknown> & Placement;

/**
 * The patches of a gesture on children of the innermost group of `path`, together with the frames
 * that keep the groups around them fitted. At the top level of the slide they are returned as
 * they are.
 */
export function refitPatches(
  path: readonly GroupElement[],
  patches: ReadonlyMap<string, PlacementPatch>,
): Map<string, PlacementPatch> {
  const out = new Map(patches);
  if (path.length === 0) return out;
  const placements = new Map<string, Placement>();
  for (const [id, patch] of patches) {
    placements.set(id, {
      ...(patch.frame ? { frame: patch.frame } : {}),
      ...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
    });
  }
  for (const [id, placement] of refitGroups(path, placements)) {
    if (placement) out.set(id, { ...out.get(id), ...placement });
  }
  return out;
}

/**
 * The frames that fit every group of a tree to its children, innermost first: for changes that
 * were made without a refit, such as moving elements of several groups at once.
 */
export function refitAll(elements: readonly Element[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const visit = (list: readonly Element[]): Element[] =>
    list.map((element) => {
      if (element.type !== 'group' || element.children.length === 0) return element;
      const children = visit(element.children);
      const fitted = refitGroups([{ ...element, children }], new Map());
      for (const [id, placement] of fitted)
        if (placement) out.set(id, { ...out.get(id), ...placement });
      const frame = fitted.get(element.id)?.frame ?? element.frame;
      return { ...element, frame, children };
    });
  visit(elements);
  return out;
}

function holds(element: Element, ids: ReadonlySet<string>): boolean {
  if (ids.has(element.id)) return true;
  return element.type === 'group' && element.children.some((child) => holds(child, ids));
}

/**
 * The commands that fit the groups of a slide to their children again. None when every group
 * already bounds what is in it, which is what a slide without groups always gives. With
 * `within`, only the groups around those elements are looked at (and the elements themselves,
 * when they are groups): a change is not the moment to tidy the rest of the slide.
 */
export function refitCommands(slide: Slide, within?: readonly string[]): Command[] {
  const ids = within && new Set(within);
  const trees = ids ? slide.elements.filter((element) => holds(element, ids)) : slide.elements;
  return [...refitAll(trees)].map(([elementId, patch]) => ({
    type: 'element.update',
    slideId: slide.id,
    elementId,
    patch,
  }));
}

/**
 * The commands that fit the groups around what a change touched. `previous` is the deck before
 * the change: an element that was removed is no longer there to be found, and the group it was
 * in is.
 */
export function refitAfter(
  deck: Deck,
  previous: Deck,
  affected: Pick<Affected, 'slides' | 'elements'>,
): Command[] {
  const ids = new Set(affected.elements);
  return affected.slides.flatMap((slideId) => {
    const slide = deck.slides.find((s) => s.id === slideId);
    if (!slide) return [];
    const was = previous.slides.find((s) => s.id === slideId);
    const left = was ? was.elements.filter((e) => holds(e, ids)).map((e) => e.id) : [];
    return refitCommands(slide, [...ids, ...left]);
  });
}

/**
 * Sends commands as `bus.batch` does and then, in the same undo step, the frames that keep the
 * groups around what they touched fitted to their children. For every change of an element that
 * may sit in a group and is not a gesture of the Stage, which fits its groups itself.
 */
export function batchFitted(
  bus: CommandBus,
  commands: readonly Command[],
  options: DispatchOptions = {},
): Affected {
  // One transaction, so the fit joins the step of the change it follows.
  const step = { ...options, txId: options.txId ?? newId('tx') };
  const previous = bus.deck;
  const affected = bus.batch(commands, step);
  const fit = refitAfter(bus.deck, previous, affected);
  if (fit.length > 0) bus.batch(fit, step);
  return affected;
}
