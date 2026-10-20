/**
 * Animation as HTML says it (SPEC 11.5): the `data-anim` of the agent's own slides, and the marks
 * an import puts on the imported page (`ANIM_MARK`, see `motion.ts`). A value is a preset name,
 * as it always was, or JSON with the fields of an animation step: one step or a list of them.
 * `none` asks for no animation at all, also not the one an ancestor gives.
 *
 * Whatever comes here is checked against what the runtime plays: a step the runtime cannot play
 * is left out with a note, so the agent hears of it instead of watching a fallback play.
 */
import type { AnimationStep } from '@slidr/model';
import { animationPresets, keyframesOf } from '@slidr/runtime/names';

/** The attribute an import marks the elements of the imported page with: the page's own `data-anim` is the page's business. */
export const ANIM_MARK = 'data-slidr-anim';

type Category = 'entrance' | 'emphasis' | 'exit';

/** One step as HTML gives it; what it leaves out takes the defaults of `animation_set`. */
export interface AnimSpec {
  preset: string;
  category?: Category;
  trigger?: AnimationStep['trigger'];
  /** Milliseconds. */
  delay?: number;
  duration?: number;
  easing?: string;
  direction?: NonNullable<AnimationStep['direction']>;
  textBy?: NonNullable<AnimationStep['textBy']>;
  /**
   * Where the step stands among the slide's steps: 0 plays by itself as the slide opens, `n`
   * with the n-th click. Steps of one order play together, each after its own `delay`.
   */
  order?: number;
}

/** What one `data-anim` says. `group` tells apart the elements one attribute produced. */
export interface Anim {
  steps: readonly AnimSpec[];
  group: number;
}

/** The defaults of a step, the same as `animation_set` gives. */
export const STEP_DEFAULTS = { duration: 500, delay: 0, easing: 'ease-out' } as const;

const CATEGORIES: readonly Category[] = ['entrance', 'emphasis', 'exit'];
const TRIGGERS: readonly AnimationStep['trigger'][] = ['onClick', 'withPrevious', 'afterPrevious'];
const DIRECTIONS = ['up', 'down', 'start', 'end'] as const;
const TEXT_BY = ['all', 'paragraph', 'word', 'char'] as const;
/** A name `@keyframes` can have without quotes. */
const KEYFRAMES_NAME = /^-?[A-Za-z_][\w-]*$/;
const MAX_MS = 60_000;
const MAX_STEPS = 8;

export type ParsedAnim =
  { steps: AnimSpec[]; notes: string[]; keyframes: string[] } | { none: true; notes: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ms = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_MS)
    : undefined;

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * One step, checked: undefined with a note when the runtime cannot play it. A `css:` preset
 * names a `@keyframes` rule of the page, which the slide then carries in its `css`.
 */
function checkSpec(raw: unknown, where: string, notes: string[]): AnimSpec | undefined {
  const fields = typeof raw === 'string' ? { preset: raw } : raw;
  if (!isObject(fields) || typeof fields.preset !== 'string' || !fields.preset.trim()) {
    notes.push(`${where}: a step needs a preset name; it was left out.`);
    return undefined;
  }
  const preset = fields.preset.trim();
  const category = oneOf(CATEGORIES, fields.category) ?? 'entrance';
  const own = keyframesOf(preset);
  if (
    own !== undefined ? !KEYFRAMES_NAME.test(own) : !animationPresets[category].includes(preset)
  ) {
    notes.push(
      `${where}: "${preset}" is not a${category === 'entrance' ? 'n' : ''} ${category} preset; the step was left out. Use one of: ${animationPresets[category].join(', ')}.`,
    );
    return undefined;
  }
  const spec: AnimSpec = { preset };
  if (fields.category !== undefined) spec.category = category;
  const trigger = oneOf(TRIGGERS, fields.trigger);
  if (trigger) spec.trigger = trigger;
  const delay = ms(fields.delay);
  if (delay !== undefined) spec.delay = delay;
  const duration = ms(fields.duration);
  if (duration !== undefined) spec.duration = duration;
  if (typeof fields.easing === 'string' && fields.easing.trim() && fields.easing.length <= 200) {
    spec.easing = fields.easing.trim();
  }
  const direction = oneOf(DIRECTIONS, fields.direction);
  if (direction) spec.direction = direction;
  const textBy = oneOf(TEXT_BY, fields.textBy ?? fields.by);
  if (textBy && textBy !== 'all') spec.textBy = textBy;
  if (typeof fields.order === 'number' && Number.isInteger(fields.order) && fields.order >= 0) {
    spec.order = Math.min(fields.order, 999);
  }
  return spec;
}

/** What an attribute value says; undefined for no value. */
export function parseAnim(
  value: string | null | undefined,
  where = 'data-anim',
): ParsedAnim | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const notes: string[] = [];
  if (text === 'none') return { none: true, notes };
  let raw: unknown = text;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      raw = JSON.parse(text);
    } catch {
      notes.push(`${where}: not valid JSON; the element was left without animation.`);
      return { steps: [], notes, keyframes: [] };
    }
  }
  const list = (Array.isArray(raw) ? raw : [raw]).slice(0, MAX_STEPS);
  const steps = list
    .map((item) => checkSpec(item, where, notes))
    .filter((spec): spec is AnimSpec => spec !== undefined);
  const keyframes = steps
    .map((spec) => keyframesOf(spec.preset))
    .filter((name): name is string => name !== undefined);
  return { steps, notes, keyframes };
}

/** One element that a `data-anim` brings in, in the order the slide lists them. */
export interface Entering {
  elementId: string;
  anim: Anim;
}

/**
 * The timeline of a slide from what its elements enter with. Steps go in document order, or by
 * `order` where any step gives one. A step without a trigger waits for a click, unless it is of
 * order 0 or of the order of the step before it, which it then plays with. Every element one
 * attribute produced after the first plays with it: they are one thing to the author.
 */
export function timelineOf(entering: readonly Entering[], newId: () => string): AnimationStep[] {
  const drafts = entering.flatMap(({ elementId, anim }) =>
    anim.steps.map((spec, n) => ({ elementId, spec, unit: `${anim.group}:${n}` })),
  );
  const ordered = drafts.some((draft) => draft.spec.order !== undefined);
  const rank = (spec: AnimSpec) => spec.order ?? Number.POSITIVE_INFINITY;
  // Array.prototype.sort is stable: document order stays within an order.
  if (ordered) drafts.sort((a, b) => rank(a.spec) - rank(b.spec));
  const started = new Set<string>();
  return drafts.map(({ elementId, spec, unit }, i) => {
    const before = drafts[i - 1]?.spec;
    const trigger = started.has(unit)
      ? 'withPrevious'
      : (spec.trigger ??
        (spec.order === 0 || (spec.order !== undefined && before?.order === spec.order)
          ? 'withPrevious'
          : 'onClick'));
    started.add(unit);
    return {
      id: newId(),
      elementId,
      trigger,
      category: spec.category ?? 'entrance',
      preset: spec.preset,
      duration: spec.duration ?? STEP_DEFAULTS.duration,
      delay: spec.delay ?? STEP_DEFAULTS.delay,
      easing: spec.easing ?? STEP_DEFAULTS.easing,
      ...(spec.direction ? { direction: spec.direction } : {}),
      ...(spec.textBy ? { textBy: spec.textBy } : {}),
    };
  });
}
