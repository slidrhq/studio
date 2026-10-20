import { CommandError, updateElement, type CommandOf } from '../commands';
import { normalizeAngle, rotatedBounds, unionBounds } from '../geometry';
import { allElementIds, locateElement } from '../queries';
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Deck,
  type Element,
  type Frame,
  type GroupElement,
  type Slide,
} from '../schema';
import { ancestorsOf, idSource, slideOrThrow } from './shared';

/** Physical edges: the arrangement works in slide coordinates, whatever the text direction. */
export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';
/** What to align or distribute against: the bounds of the elements themselves, or the slide. */
export type ArrangeReference = 'selection' | 'slide';
export type ZOrderMove = 'front' | 'back' | 'forward' | 'backward';

interface Item {
  element: Element;
  /** The box the element covers on screen, rotation included, in its parent's coordinates. */
  box: Frame;
}

/** The elements, which must share a parent, and the slide's box in that parent's coordinates. */
function arrangeable(
  slide: Slide,
  elementIds: readonly string[],
): { items: Item[]; slideBox: () => Frame } {
  if (elementIds.length === 0) throw new CommandError('invalid_payload', 'No elements were given.');
  let ancestors: GroupElement[] | undefined;
  const items = [...new Set(elementIds)].map((id): Item => {
    const location = locateElement(slide.elements, id);
    if (!location) {
      throw new CommandError(
        'not_found',
        `Element "${id}" does not exist on slide "${slide.id}". It may have been deleted.`,
      );
    }
    const path = ancestorsOf(slide.elements, id) ?? [];
    if (ancestors && ancestors.at(-1)?.id !== path.at(-1)?.id) {
      throw new CommandError(
        'invalid_state',
        'The elements are not in the same group, so they cannot be arranged together.',
      );
    }
    ancestors ??= path;
    const { element } = location;
    return { element, box: rotatedBounds(element.frame, element.rotation) };
  });

  const slideBox = (): Frame => {
    let x = 0;
    let y = 0;
    for (const group of ancestors ?? []) {
      if (normalizeAngle(group.rotation) !== 0 || group.flipH || group.flipV) {
        throw new CommandError(
          'invalid_state',
          'The elements are inside a rotated or mirrored group, so they cannot be arranged against the slide.',
        );
      }
      x += group.frame.x;
      y += group.frame.y;
    }
    return { x: -x, y: -y, w: SLIDE_WIDTH, h: SLIDE_HEIGHT };
  };
  return { items, slideBox };
}

function moveBy(slideId: string, element: Element, dx: number, dy: number) {
  const { frame } = element;
  return updateElement(slideId, element.id, {
    frame: { ...frame, x: frame.x + dx, y: frame.y + dy },
  });
}

const EPSILON = 1e-9;

/**
 * `element.update` commands that align elements by one edge or centre line of the box each one
 * covers on screen (so a rotated element aligns by what is seen). Against `selection` the
 * reference is the bounds of all the elements; against `slide` it is the slide. A single
 * element is aligned to the slide by default. Locked elements count for the bounds and stay
 * put. Elements already in place produce no command.
 */
export function alignElements(
  slide: Slide,
  elementIds: readonly string[],
  edge: AlignEdge,
  relativeTo?: ArrangeReference,
): CommandOf<'element.update'>[] {
  const { items, slideBox } = arrangeable(slide, elementIds);
  const against = relativeTo ?? (items.length === 1 ? 'slide' : 'selection');
  const ref = against === 'slide' ? slideBox() : unionBounds(items.map((i) => i.box));

  const commands: CommandOf<'element.update'>[] = [];
  for (const { element, box } of items) {
    if (element.locked) continue;
    let dx = 0;
    let dy = 0;
    if (edge === 'left') dx = ref.x - box.x;
    else if (edge === 'center') dx = ref.x + ref.w / 2 - (box.x + box.w / 2);
    else if (edge === 'right') dx = ref.x + ref.w - (box.x + box.w);
    else if (edge === 'top') dy = ref.y - box.y;
    else if (edge === 'middle') dy = ref.y + ref.h / 2 - (box.y + box.h / 2);
    else dy = ref.y + ref.h - (box.y + box.h);
    if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON) {
      commands.push(moveBy(slide.id, element, dx, dy));
    }
  }
  return commands;
}

/**
 * `element.update` commands that make the gaps between elements equal along one axis, using
 * the boxes they cover on screen. Against `selection` (needs three elements or more) the two
 * outermost stay put; against `slide` the first and last touch the slide's edges, and a single
 * element is centred. The order along the axis is kept. Locked elements are not moved, so they
 * are left out.
 */
export function distributeElements(
  slide: Slide,
  elementIds: readonly string[],
  axis: DistributeAxis,
  relativeTo: ArrangeReference = 'selection',
): CommandOf<'element.update'>[] {
  const { items: all, slideBox } = arrangeable(slide, elementIds);
  const items = all.filter((item) => !item.element.locked);
  if (relativeTo === 'selection' && items.length < 3) {
    throw new CommandError(
      'invalid_state',
      'Distributing needs at least three movable elements (or distribute against the slide).',
    );
  }
  const horizontal = axis === 'horizontal';
  const start = (b: Frame) => (horizontal ? b.x : b.y);
  const size = (b: Frame) => (horizontal ? b.w : b.h);
  const sorted = [...items].sort(
    (a, b) => start(a.box) + size(a.box) / 2 - (start(b.box) + size(b.box) / 2),
  );

  let from: number;
  let to: number;
  if (relativeTo === 'slide') {
    const box = slideBox();
    from = start(box);
    to = from + size(box);
  } else {
    const first = sorted[0]!.box;
    const last = sorted.at(-1)!.box;
    from = start(first);
    to = start(last) + size(last);
  }
  const total = sorted.reduce((sum, item) => sum + size(item.box), 0);
  const gap = sorted.length > 1 ? (to - from - total) / (sorted.length - 1) : 0;
  let at = sorted.length > 1 ? from : from + (to - from - total) / 2;

  const commands: CommandOf<'element.update'>[] = [];
  for (const { element, box } of sorted) {
    const delta = at - start(box);
    if (Math.abs(delta) > EPSILON) {
      commands.push(moveBy(slide.id, element, horizontal ? delta : 0, horizontal ? 0 : delta));
    }
    at += size(box) + gap;
  }
  return commands;
}

/**
 * `element.reorder` commands for elements that may sit in different groups: one command per
 * parent, each moving that parent's elements within it.
 */
export function reorderElements(
  slide: Slide,
  elementIds: readonly string[],
  to: ZOrderMove,
): CommandOf<'element.reorder'>[] {
  const byParent = new Map<string, string[]>();
  for (const id of new Set(elementIds)) {
    const location = locateElement(slide.elements, id);
    if (!location) {
      throw new CommandError(
        'not_found',
        `Element "${id}" does not exist on slide "${slide.id}". It may have been deleted.`,
      );
    }
    const key = location.parent?.id ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), id]);
  }
  return [...byParent.values()].map((ids) => ({
    type: 'element.reorder',
    slideId: slide.id,
    elementIds: ids,
    to,
  }));
}

/**
 * Whether a z-order move would change anything. It would not when, in every parent, the
 * elements already sit together at the end they would move towards.
 */
export function canReorder(slide: Slide, elementIds: readonly string[], to: ZOrderMove): boolean {
  const byParent = new Map<string, { siblings: readonly Element[]; ids: Set<string> }>();
  for (const id of new Set(elementIds)) {
    const location = locateElement(slide.elements, id);
    if (!location) continue;
    const key = location.parent?.id ?? '';
    const entry = byParent.get(key) ?? { siblings: location.siblings, ids: new Set<string>() };
    entry.ids.add(id);
    byParent.set(key, entry);
  }
  const up = to === 'front' || to === 'forward';
  for (const { siblings, ids } of byParent.values()) {
    const end = up ? siblings.slice(-ids.size) : siblings.slice(0, ids.size);
    if (!end.every((element) => ids.has(element.id))) return true;
  }
  return false;
}

/** An `element.group` with a new group id that is free in the deck. */
export function groupElements(
  deck: Deck,
  slideId: string,
  elementIds: readonly string[],
  options: { name?: string; random?: () => number } = {},
): CommandOf<'element.group'> {
  slideOrThrow(deck, slideId);
  const groupId = idSource(allElementIds(deck), options.random)('e');
  return {
    type: 'element.group',
    slideId,
    elementIds: [...elementIds],
    groupId,
    ...(options.name ? { name: options.name } : {}),
  };
}
