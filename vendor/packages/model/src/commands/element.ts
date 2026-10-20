import { current, isDraft } from 'immer';
import { z } from 'zod';
import { frameCenter, normalizeAngle, rotatedBounds, rotateVector, unionBounds } from '../geometry';
import { hasElementId, walkElements } from '../queries';
import { Element, elementSchemas, Id, RichText } from '../schema';
import type { GroupElement, Slide } from '../schema';
import {
  baseDeck,
  clampIndex,
  CommandError,
  defineCommand,
  ListIndex,
  moveToIndex,
  requireElement,
  requireGroup,
  requireSlide,
} from './core';

function setSiblings(slide: Slide, parent: GroupElement | undefined, elements: Element[]): void {
  if (parent) parent.children = elements;
  else slide.elements = elements;
}

/** The list that holds all the given elements. They must sit side by side in one parent. */
function commonSiblings(
  slide: Slide,
  elementIds: readonly string[],
): { siblings: Element[]; parent?: GroupElement } {
  let found: { siblings: Element[]; parent?: GroupElement } | undefined;
  for (const id of elementIds) {
    const { siblings, parent } = requireElement(slide, id);
    if (found && found.parent?.id !== parent?.id) {
      throw new CommandError(
        'invalid_state',
        'The elements are not in the same group, so they cannot be arranged together.',
      );
    }
    found ??= { siblings, parent };
  }
  if (!found) throw new CommandError('invalid_payload', 'No elements were given.');
  return found;
}

export const elementAdd = defineCommand(
  z.strictObject({
    type: z.literal('element.add'),
    slideId: Id,
    element: Element,
    /** Adds the element inside this group instead of at the top level of the slide. */
    parentId: Id.optional(),
    /** Position in z-order; omitted means on top. */
    index: ListIndex.optional(),
  }),
  (deck, { slideId, element, parentId, index }, touched) => {
    const slide = requireSlide(deck, slideId);
    const before = baseDeck(deck);
    const own = new Set<string>();
    for (const added of walkElements([element])) {
      if (own.has(added.id) || hasElementId(before, added.id)) {
        throw new CommandError('conflict', `Element id "${added.id}" is already in use.`);
      }
      own.add(added.id);
    }
    const target = parentId ? requireGroup(slide, parentId).element.children : slide.elements;
    target.splice(clampIndex(index, target.length), 0, element);
    touched.tree(slideId, element);
  },
);

function pruneEmptyGroups(elements: Element[], removed: Set<string>): Element[] {
  return elements.filter((element) => {
    if (element.type !== 'group') return true;
    const before = element.children.length;
    const children = pruneEmptyGroups(element.children, removed);
    if (children.length !== before) element.children = children;
    if (children.length > 0) return true;
    removed.add(element.id);
    return false;
  });
}

/**
 * Removes elements, wherever they sit in the tree. Animation steps of the removed elements go
 * with them, and so does a group that is left empty.
 */
export const elementRemove = defineCommand(
  z.strictObject({
    type: z.literal('element.remove'),
    slideId: Id,
    elementIds: z.array(Id).min(1),
  }),
  (deck, { slideId, elementIds }, touched) => {
    const slide = requireSlide(deck, slideId);
    const removed = new Set<string>();
    for (const id of elementIds) {
      // Already gone as part of a group removed a moment ago.
      if (removed.has(id)) continue;
      const { element, siblings, index } = requireElement(slide, id);
      for (const inside of walkElements([element])) removed.add(inside.id);
      siblings.splice(index, 1);
    }
    const kept = pruneEmptyGroups(slide.elements, removed);
    if (kept.length !== slide.elements.length) slide.elements = kept;
    if (slide.timeline.some((step) => removed.has(step.elementId))) {
      slide.timeline = slide.timeline.filter((step) => !removed.has(step.elementId));
    }
    for (const id of removed) touched.element(slideId, id);
  },
);

/**
 * Replaces one element by others, in its place: the same parent and the same position in the
 * layer order. A replacement may take the id of the element it replaces, which is how an element
 * becomes another kind of element (`element.update` cannot change `type`). A removal followed by
 * an addition cannot say this: a group whose only child is removed is removed with it, and the
 * addition then has no parent to go into. Animation steps of the replaced element, and of what
 * was inside it, go with it.
 */
export const elementReplace = defineCommand(
  z.strictObject({
    type: z.literal('element.replace'),
    slideId: Id,
    elementId: Id,
    elements: z.array(Element).min(1),
  }),
  (deck, { slideId, elementId, elements }, touched) => {
    const slide = requireSlide(deck, slideId);
    const { element, siblings, index } = requireElement(slide, elementId);
    const replaced = new Set<string>();
    for (const inside of walkElements([element])) replaced.add(inside.id);
    const before = baseDeck(deck);
    const own = new Set<string>();
    for (const added of walkElements(elements)) {
      // The ids of what is replaced are free to be taken again.
      const taken = !replaced.has(added.id) && hasElementId(before, added.id);
      if (own.has(added.id) || taken) {
        throw new CommandError('conflict', `Element id "${added.id}" is already in use.`);
      }
      own.add(added.id);
    }
    siblings.splice(index, 1, ...elements);
    if (slide.timeline.some((step) => replaced.has(step.elementId))) {
      slide.timeline = slide.timeline.filter((step) => !replaced.has(step.elementId));
    }
    for (const id of replaced) touched.element(slideId, id);
    for (const added of elements) touched.tree(slideId, added);
  },
);

const FIXED_FIELDS = new Set(['id', 'type', 'children']);

/**
 * Changes fields of one element. Each key of the patch replaces that field whole; `null`
 * removes an optional field. The result must be a valid element of the same type.
 */
export const elementUpdate = defineCommand(
  z.strictObject({
    type: z.literal('element.update'),
    slideId: Id,
    elementId: Id,
    patch: z.record(z.string(), z.unknown()),
  }),
  (deck, { slideId, elementId, patch }, touched) => {
    const slide = requireSlide(deck, slideId);
    const { element } = requireElement(slide, elementId);
    const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
    for (const key of keys) {
      if (FIXED_FIELDS.has(key)) {
        throw new CommandError('invalid_payload', `"${key}" cannot be changed by element.update.`);
      }
    }

    const merged: Record<string, unknown> = { ...(isDraft(element) ? current(element) : element) };
    for (const key of keys) {
      if (patch[key] === null) delete merged[key];
      else merged[key] = patch[key];
    }
    const parsed = elementSchemas[element.type].safeParse(merged);
    if (!parsed.success) {
      throw new CommandError(
        'invalid_payload',
        `The patch does not give a valid ${element.type} element:\n${z.prettifyError(parsed.error)}`,
      );
    }

    // Only the patched fields are written, so the untouched parts keep their identity.
    const target = element as unknown as Record<string, unknown>;
    const next = parsed.data as unknown as Record<string, unknown>;
    for (const key of keys) {
      if (patch[key] === null) delete target[key];
      else target[key] = next[key];
    }
    touched.element(slideId, elementId);
  },
);

/** Moves each selected element one step up, unless the one above it is selected too. */
function stepForward(list: Element[], ids: Set<string>): void {
  for (let i = list.length - 2; i >= 0; i--) {
    const item = list[i];
    const above = list[i + 1];
    if (!item || !above || !ids.has(item.id) || ids.has(above.id)) continue;
    list[i] = above;
    list[i + 1] = item;
  }
}

export const elementReorder = defineCommand(
  z.strictObject({
    type: z.literal('element.reorder'),
    slideId: Id,
    elementIds: z.array(Id).min(1),
    /** Z-order target. An index is counted in the list without the moved elements. */
    to: z.union([
      z.enum(['front', 'back', 'forward', 'backward']),
      z.strictObject({ index: ListIndex }),
    ]),
  }),
  (deck, { slideId, elementIds, to }, touched) => {
    const slide = requireSlide(deck, slideId);
    const { siblings, parent } = commonSiblings(slide, elementIds);
    const ids = new Set(elementIds);

    let next: Element[] | undefined;
    if (to === 'forward' || to === 'backward') {
      const list = to === 'forward' ? [...siblings] : [...siblings].reverse();
      stepForward(list, ids);
      if (to === 'backward') list.reverse();
      next = list.every((item, i) => item.id === siblings[i]?.id) ? undefined : list;
    } else {
      const index = to === 'front' ? siblings.length : to === 'back' ? 0 : to.index;
      next = moveToIndex(siblings, ids, index);
    }
    if (!next) return;
    setSiblings(slide, parent, next);
    for (const id of ids) touched.element(slideId, id);
  },
);

/**
 * Puts elements of one parent into a new group, at the z-position of the topmost of them.
 * Their ids and animation steps are kept.
 */
export const elementGroup = defineCommand(
  z.strictObject({
    type: z.literal('element.group'),
    slideId: Id,
    elementIds: z.array(Id).min(1),
    groupId: Id,
    name: z.string().min(1).optional(),
  }),
  (deck, { slideId, elementIds, groupId, name }, touched) => {
    const slide = requireSlide(deck, slideId);
    if (hasElementId(baseDeck(deck), groupId)) {
      throw new CommandError('conflict', `Element id "${groupId}" is already in use.`);
    }
    const { siblings, parent } = commonSiblings(slide, elementIds);
    const ids = new Set(elementIds);
    const members = siblings.filter((e) => ids.has(e.id));
    const frame = unionBounds(members.map((m) => rotatedBounds(m.frame, m.rotation)));
    for (const member of members) {
      member.frame.x -= frame.x;
      member.frame.y -= frame.y;
    }
    const group: GroupElement = {
      id: groupId,
      type: 'group',
      ...(name ? { name } : {}),
      frame,
      rotation: 0,
      opacity: 1,
      children: members,
    };
    const top = siblings.findLastIndex((e) => ids.has(e.id));
    const rest = siblings.filter((e) => !ids.has(e.id));
    rest.splice(top - (members.length - 1), 0, group);
    setSiblings(slide, parent, rest);
    touched.element(slideId, groupId);
    for (const id of ids) touched.element(slideId, id);
  },
);

/**
 * Replaces a group by its children, in place. The group's rotation, mirroring, opacity, lock
 * and visibility are folded into each child; its own effects, link and CSS are dropped, and so
 * are animation steps that targeted the group.
 */
export const elementUngroup = defineCommand(
  z.strictObject({ type: z.literal('element.ungroup'), slideId: Id, groupId: Id }),
  (deck, { slideId, groupId }, touched) => {
    const slide = requireSlide(deck, slideId);
    const { element: group, siblings, index } = requireGroup(slide, groupId);
    const center = frameCenter(group.frame);
    const flipH = Boolean(group.flipH);
    const flipV = Boolean(group.flipV);
    const children = [...group.children];

    for (const child of children) {
      // Where the child's centre sits relative to the group's centre, in the group's own box.
      const offset = {
        x: (child.frame.x + child.frame.w / 2 - group.frame.w / 2) * (flipH ? -1 : 1),
        y: (child.frame.y + child.frame.h / 2 - group.frame.h / 2) * (flipV ? -1 : 1),
      };
      const moved = rotateVector(offset, group.rotation);
      child.frame.x = center.x + moved.x - child.frame.w / 2;
      child.frame.y = center.y + moved.y - child.frame.h / 2;
      // A single mirror turns the child's own rotation the other way.
      const own = flipH !== flipV ? -child.rotation : child.rotation;
      child.rotation = normalizeAngle(own + group.rotation);
      if (flipH) child.flipH = !child.flipH;
      if (flipV) child.flipV = !child.flipV;
      child.opacity *= group.opacity;
      if (group.hidden) child.hidden = true;
      if (group.locked) child.locked = true;
      touched.element(slideId, child.id);
    }

    siblings.splice(index, 1, ...children);
    if (slide.timeline.some((step) => step.elementId === groupId)) {
      slide.timeline = slide.timeline.filter((step) => step.elementId !== groupId);
    }
    touched.element(slideId, groupId);
  },
);

/**
 * Sets the rich text of a text box, of a shape, or of one table cell (`cell` is required for
 * a table and only for a table).
 */
export const textSet = defineCommand(
  z.strictObject({
    type: z.literal('text.set'),
    slideId: Id,
    elementId: Id,
    content: RichText,
    cell: z
      .strictObject({ row: z.number().int().nonnegative(), col: z.number().int().nonnegative() })
      .optional(),
  }),
  (deck, { slideId, elementId, content, cell }, touched) => {
    const slide = requireSlide(deck, slideId);
    const { element } = requireElement(slide, elementId);
    if (element.type === 'table') {
      if (!cell) throw new CommandError('invalid_payload', 'A table needs `cell` to set text.');
      const target = element.cells[cell.row]?.[cell.col];
      if (!target) {
        throw new CommandError(
          'not_found',
          `The table has no cell at row ${cell.row}, column ${cell.col}.`,
        );
      }
      target.content = content;
    } else if (element.type === 'text' || element.type === 'shape') {
      if (cell) throw new CommandError('invalid_payload', '`cell` applies only to a table.');
      element.content = content;
    } else {
      throw new CommandError('invalid_state', `A ${element.type} element holds no text.`);
    }
    touched.element(slideId, elementId);
  },
);
