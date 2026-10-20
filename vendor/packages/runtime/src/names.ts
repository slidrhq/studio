/**
 * The names of the ready-made animations and transitions, apart from the code that plays them.
 * A picker, the agent's `animation_set` tool and its prompt need the names and nothing of the
 * DOM, so this module imports nothing: `@slidr/runtime/names` compiles without the DOM library.
 * `presets.ts` and `transitions.ts` are typed by these lists, so a name without an implementation,
 * or an implementation without a name, does not compile.
 */
export const entranceNames = [
  'appear',
  'fade',
  'flyIn',
  'rise',
  'zoom',
  'pop',
  'wipe',
  'blur',
  'slideIn',
  'dropIn',
  'scaleUp',
  'rotateIn',
  'swingIn',
  'unfold',
  'expand',
  'elastic',
] as const;

export const emphasisNames = [
  'pulse',
  'spin',
  'wiggle',
  'shake',
  'bounce',
  'flash',
  'growShrink',
  'sway',
  'jello',
  'tada',
  'heartbeat',
  'flicker',
  'float',
  'tilt',
] as const;

export const exitNames = [
  'disappear',
  'fade',
  'flyOut',
  'sink',
  'zoom',
  'pop',
  'wipe',
  'blur',
  'slideOut',
  'dropOut',
  'scaleDown',
  'rotateOut',
  'swingOut',
  'fold',
  'contract',
  'elasticOut',
] as const;

/** `none` shows the next slide at once; the others are played. */
export const transitionNames = [
  'none',
  'fade',
  'push',
  'cover',
  'reveal',
  'wipe',
  'zoom',
  'flip',
  'crossfade',
  'blur',
  'flash',
  'slide',
  'split',
  'iris',
  'dissolve',
  'rotate',
  'cube',
  'swap',
] as const;

export type Category = 'entrance' | 'emphasis' | 'exit';

/** The names of the presets, for a picker and for the agent's prompt. */
export const animationPresets: Record<Category, readonly string[]> = {
  entrance: entranceNames,
  emphasis: emphasisNames,
  exit: exitNames,
};

/** The names of the transitions, for a picker and for the agent's prompt. */
export const transitionTypes: readonly string[] = transitionNames;

/**
 * A preset written `css:<name>` plays the `@keyframes <name>` of the slide's own `css` instead of
 * a ready-made motion: an animation carried over from an imported file as that file wrote it, or
 * one written for the slide. Nothing about it is known before the slide is drawn, so a picker
 * shows it as the original animation of its element.
 */
export const KEYFRAMES_PREFIX = 'css:';

/** The name of the `@keyframes` a preset plays, when it is one of the slide's own. */
export function keyframesOf(preset: string): string | undefined {
  return preset.startsWith(KEYFRAMES_PREFIX) && preset.length > KEYFRAMES_PREFIX.length
    ? preset.slice(KEYFRAMES_PREFIX.length)
    : undefined;
}
