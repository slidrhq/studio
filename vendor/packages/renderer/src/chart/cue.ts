/**
 * What the animation runtime tells a chart (CHT-08). A chart is drawn by a library the runtime
 * does not carry, so the two meet in the DOM and nowhere else: the runtime dispatches a
 * `slidr-chart` event on the chart's node, and whoever draws the chart listens.
 *
 * The names are repeated in `packages/runtime/src/charts.ts`, which depends on nothing; a test
 * in `@slidr/html-export`, which has both packages, holds the two together.
 */
export const CHART_ATTRIBUTE = 'data-slidr-chart';
export const CHART_EVENT = 'slidr-chart';

export type ChartCue =
  /** Before its step: the chart with its series not yet drawn. */
  | { state: 'wait' }
  /** Its step: the series grow in, `delay` milliseconds from now and over `duration`. */
  | { state: 'play'; delay: number; duration: number }
  /** Drawn whole, at once. */
  | { state: 'rest' };

export interface HeardCue {
  cue: ChartCue;
  /** `performance.now()` when it came. */
  at: number;
}

const heard = new WeakMap<HTMLElement, HeardCue>();
const listeners = new WeakMap<HTMLElement, (cue: HeardCue) => void>();

function isCue(detail: unknown): detail is ChartCue {
  const state = (detail as { state?: unknown } | null)?.state;
  return state === 'wait' || state === 'play' || state === 'rest';
}

/**
 * Starts listening on a chart's node, and remembers the last cue: the library that draws the
 * chart is loaded only when a chart is first shown, and a show may start before it is there.
 * Returns the way to stop.
 */
export function watchCues(host: HTMLElement): () => void {
  const onCue = (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail;
    if (!isCue(detail)) return;
    const cue = { cue: detail, at: performance.now() };
    heard.set(host, cue);
    listeners.get(host)?.(cue);
  };
  host.addEventListener(CHART_EVENT, onCue);
  return () => {
    host.removeEventListener(CHART_EVENT, onCue);
    heard.delete(host);
    listeners.delete(host);
  };
}

/** The last cue a watched node was given, if any. */
export function lastCue(host: HTMLElement): HeardCue | undefined {
  return heard.get(host);
}

/** Hands every later cue of a watched node to `listener`. */
export function onCue(host: HTMLElement, listener: (cue: HeardCue) => void): void {
  listeners.set(host, listener);
}
