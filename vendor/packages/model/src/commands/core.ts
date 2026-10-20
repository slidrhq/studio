import { isDraft, original } from 'immer';
import { z } from 'zod';
import { locateElement, type ElementLocation } from '../queries';
import type { AnimationStep, Deck, Element, GroupElement, Slide } from '../schema';

export type CommandErrorCode =
  /** The command type is not in the catalogue. */
  | 'unknown_command'
  /** The command, or the model it would produce, does not match the schema. */
  | 'invalid_payload'
  /** A slide, element or layout the command names does not exist (any more). */
  | 'not_found'
  /** An id the command introduces is already taken. */
  | 'conflict'
  /** The command is well formed but cannot apply to the current state. */
  | 'invalid_state';

/** Why a command was rejected. The deck is untouched when this is thrown. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/** Who made a change (CMD-04): the user, or one turn of one agent session. */
export type Actor = 'user' | `agent:${string}:${string}`;

export function agentActor(sessionId: string, turnId: string): Actor {
  return `agent:${sessionId}:${turnId}`;
}

/** The session id of an agent actor; undefined for the user. */
export function actorSession(actor: Actor): string | undefined {
  return actor === 'user' ? undefined : actor.split(':')[1];
}

/** What a change touched. Ids of removed slides and elements are listed too. */
export interface Affected {
  meta: boolean;
  theme: boolean;
  /** Slides were added, removed or moved. */
  slideOrder: boolean;
  layouts: string[];
  slides: string[];
  elements: string[];
  assets: string[];
}

/** Collects what a command touches while it applies. */
export class Touched {
  meta = false;
  theme = false;
  slideOrder = false;
  readonly layouts = new Set<string>();
  readonly slides = new Set<string>();
  readonly elements = new Set<string>();
  readonly assets = new Set<string>();

  slide(slideId: string): void {
    this.slides.add(slideId);
  }

  element(slideId: string, elementId: string): void {
    this.slides.add(slideId);
    this.elements.add(elementId);
  }

  /** Marks an element and everything inside it. */
  tree(slideId: string, element: Element): void {
    this.element(slideId, element.id);
    if (element.type === 'group') for (const child of element.children) this.tree(slideId, child);
  }

  add(other: Affected): void {
    this.meta ||= other.meta;
    this.theme ||= other.theme;
    this.slideOrder ||= other.slideOrder;
    for (const id of other.layouts) this.layouts.add(id);
    for (const id of other.slides) this.slides.add(id);
    for (const id of other.elements) this.elements.add(id);
    for (const id of other.assets) this.assets.add(id);
  }

  toAffected(): Affected {
    return {
      meta: this.meta,
      theme: this.theme,
      slideOrder: this.slideOrder,
      layouts: [...this.layouts],
      slides: [...this.slides],
      elements: [...this.elements],
      assets: [...this.assets],
    };
  }
}

export function mergeAffected(a: Affected, b: Affected): Affected {
  const touched = new Touched();
  touched.add(a);
  touched.add(b);
  return touched.toAffected();
}

export interface CommandDef<S extends z.ZodType> {
  schema: S;
  /** Mutates an Immer draft of the deck. Throws `CommandError` to reject the command. */
  apply: (deck: Deck, command: z.output<S>, touched: Touched) => void;
}

export function defineCommand<S extends z.ZodType<{ type: string }>>(
  schema: S,
  apply: CommandDef<S>['apply'],
): CommandDef<S> {
  return { schema, apply };
}

/** A position in a list. Omitted means the end; a value past the end is clamped. */
export const ListIndex = z.number().int().nonnegative();

export function clampIndex(index: number | undefined, length: number): number {
  return index === undefined ? length : Math.min(index, length);
}

/**
 * The deck as it was before the current command: a plain object, cheap to scan. Reading a
 * whole deck through an Immer draft creates a proxy for every node.
 */
export function baseDeck(deck: Deck): Deck {
  return isDraft(deck) ? (original(deck) ?? deck) : deck;
}

export function requireSlide(deck: Deck, slideId: string): Slide {
  // Looked for in the list as it was, and read from the draft at that place alone: a search
  // through the draft makes a draft of every slide it passes, and a command on the last slide of
  // 200 paid for 200 of them. A command that has moved slides already is looked for again.
  const list = deck.slides;
  const plain = isDraft(list) ? (original(list) ?? list) : list;
  const at = plain.findIndex((s) => s.id === slideId);
  const there = at >= 0 ? list[at] : undefined;
  if (there?.id === slideId) return there;
  const slide = list.find((s) => s.id === slideId);
  if (!slide) throw new CommandError('not_found', `Slide "${slideId}" does not exist.`);
  return slide;
}

export function requireElement(slide: Slide, elementId: string): ElementLocation {
  const location = locateElement(slide.elements, elementId);
  if (!location) {
    throw new CommandError(
      'not_found',
      `Element "${elementId}" does not exist on slide "${slide.id}". It may have been deleted.`,
    );
  }
  return location;
}

export function requireGroup(
  slide: Slide,
  groupId: string,
): ElementLocation & { element: GroupElement } {
  const location = requireElement(slide, groupId);
  if (location.element.type !== 'group') {
    throw new CommandError('invalid_state', `Element "${groupId}" is not a group.`);
  }
  return location as ElementLocation & { element: GroupElement };
}

/** Every step must have its own id and point at an element of the slide. */
export function checkTimeline(timeline: readonly AnimationStep[], elementIds: Set<string>): void {
  const stepIds = new Set<string>();
  for (const step of timeline) {
    if (stepIds.has(step.id)) {
      throw new CommandError('conflict', `Animation step id "${step.id}" appears twice.`);
    }
    stepIds.add(step.id);
    if (!elementIds.has(step.elementId)) {
      throw new CommandError(
        'not_found',
        `Animation step "${step.id}" points at element "${step.elementId}", which is not on the slide.`,
      );
    }
  }
}

/**
 * Applies a field patch: a value replaces the field, `null` removes it, `undefined` leaves it.
 * Fields are replaced whole, never merged.
 */
export function applyFields<T extends object>(
  target: T,
  patch: { [K in keyof T]?: T[K] | null },
): void {
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete target[key];
    else target[key] = value;
  }
}

/**
 * Moves the items with the given ids to `toIndex`, counted in the list without them. The moved
 * items keep the order they had in the list. Returns undefined when nothing would change.
 */
export function moveToIndex<T extends { id: string }>(
  list: readonly T[],
  ids: Set<string>,
  toIndex: number,
): T[] | undefined {
  const moving = list.filter((item) => ids.has(item.id));
  const rest = list.filter((item) => !ids.has(item.id));
  rest.splice(Math.min(toIndex, rest.length), 0, ...moving);
  return rest.every((item, i) => item.id === list[i]?.id) ? undefined : rest;
}
