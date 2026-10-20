/**
 * Motion carried over from an imported file (SPEC 13.3). An HTML deck animates as it shows a
 * slide: the slide comes in (a fade, a slide, a turn), and things on it enter one after another.
 * The import watches that happen. From the moment before the agent's `before` runs until the
 * capture, it keeps every animation the page starts, CSS animations, CSS transitions and those of
 * scripts alike, and reads what each one does: its keyframes and its timing, as the browser has
 * them. It knows no format (IMP-04): what moved, how and when, is all it asks.
 *
 * - What moves inside the captured element enters the slide with keyframes of its own, the same
 *   ones the file played, in the same order and at the same times (`css:` presets, see
 *   `@slidr/runtime/names`). They are written as `@keyframes` the slide carries in its `css`, and
 *   the element is marked (`ANIM_MARK`) so that the conversion gives its elements the step.
 * - What moves the captured element itself, its ancestors, or the slide that leaves, is the
 *   slide's transition, and is matched to the nearest one the runtime has.
 *
 * Build steps that wait for a click are not seen: the agent reveals them in `before` and marks
 * them (`data-slidr-anim` with an `order`), and the motion the page played for them comes with the
 * mark. What the agent's mark says wins over what was seen.
 */
import type { Transition } from '@slidr/model';
import { ANIM_MARK, type AnimSpec } from './anim';
import { scalePx } from './css';

/** A number to `digits` places: offsets and lengths without floating-point noise. */
const fixed = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** What a keyframe sets that moves, shows or hides a box: what a slide element can play. */
const VISUAL: Record<string, string> = {
  opacity: 'opacity',
  transform: 'transform',
  translate: 'translate',
  scale: 'scale',
  rotate: 'rotate',
  filter: 'filter',
  clipPath: 'clip-path',
  visibility: 'visibility',
};

/** Values that mean something only where the file put them: resolved on the page first. */
const NEEDS_PAGE = /var\(|\d(?:r?em|vw|vh|vmin|vmax|ch|ex|lh)\b/;

/** Repeats of a finite animation that are written out; more than this is played once. */
const MAX_ITERATIONS = 6;
/** The recorder looks for new animations this often while the agent's code runs. */
const POLL_MS = 30;
/**
 * Motions that start this close to one another came from one change of style, a frame or two
 * apart on a busy page: they count as starting together, and their own delays say the rest.
 */
const SAME_START_MS = 60;

/** Milliseconds from `from` to the start of a track, with starts close to it counted as at it. */
const since = (track: MotionTrack, from: number) => {
  const lag = track.start - from;
  return lag <= SAME_START_MS ? 0 : lag;
};

/** One keyframe, with the properties it sets by their CSS names. */
export interface MotionFrame {
  offset: number;
  easing?: string;
  props: Record<string, string>;
}

/** What one animation did, read off the page. */
export interface MotionTrack {
  target: Element;
  /** When it started, on the page's clock, in milliseconds. */
  start: number;
  /** When it began to move, after its own delay. */
  begin: number;
  /** How long it moved, every repeat included. */
  duration: number;
  /** The timing function of the whole animation; a CSS animation eases between keyframes instead. */
  easing: string;
  frames: MotionFrame[];
  /** Its own delay, which is what counts once it plays on a click. */
  delay: number;
}

/** A step for an element of the captured slide, and the `@keyframes` it plays. */
export interface MotionStep {
  target: Element;
  /** The step as it plays when the slide opens. */
  spec: AnimSpec & { preset: string };
  /** Its own delay, for when a mark makes it a step of a click. */
  ownDelay: number;
  css: string;
}

export interface MotionFound {
  steps: MotionStep[];
  /** The transition into the slide, when the page played one. */
  transition?: Transition;
}

const safe = <T>(read: () => T, otherwise: T): T => {
  try {
    return read();
  } catch {
    return otherwise;
  }
};

const kebab = (name: string) =>
  VISUAL[name] ?? name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// ------------------------------------------------------------------------------- reading

/** The keyframes of an effect, cut to what moves a box, every repeat written out. */
function framesOf(effect: KeyframeEffect): MotionFrame[] {
  const timing = effect.getComputedTiming();
  const raw = safe(() => effect.getKeyframes(), [] as ComputedKeyframe[]);
  const once: MotionFrame[] = [];
  for (const keyframe of raw) {
    const props: Record<string, string> = {};
    for (const [key, value] of Object.entries(keyframe)) {
      if (!(key in VISUAL) || value === null || value === undefined || value === '') continue;
      props[VISUAL[key]!] = String(value);
    }
    const offset = keyframe.computedOffset ?? keyframe.offset ?? 0;
    once.push({
      offset,
      ...(keyframe.easing && keyframe.easing !== 'linear' ? { easing: keyframe.easing } : {}),
      props,
    });
  }
  if (!once.some((frame) => Object.keys(frame.props).length > 0)) return [];
  const count = Number(timing.iterations ?? 1);
  const times = Number.isInteger(count) && count > 1 && count <= MAX_ITERATIONS ? count : 1;
  const direction = String(effect.getTiming().direction ?? 'normal');
  const frames: MotionFrame[] = [];
  for (let i = 0; i < times; i++) {
    const backwards =
      direction === 'reverse' ||
      (direction === 'alternate' && i % 2 === 1) ||
      (direction === 'alternate-reverse' && i % 2 === 0);
    const run = backwards ? [...once].reverse() : once;
    for (const frame of run) {
      const at = backwards ? 1 - frame.offset : frame.offset;
      frames.push({ ...frame, offset: fixed((i + at) / times, 5) });
    }
  }
  return frames;
}

/** What an animation of the page did; undefined for one that never ends or moves nothing. */
export function trackOf(animation: Animation, seenAt: number): MotionTrack | undefined {
  const effect = animation.effect as KeyframeEffect | null;
  if (!effect || typeof effect.getKeyframes !== 'function') return undefined;
  const target = effect.target;
  // A pseudo-element has no element of its own on the slide.
  if (!target || effect.pseudoElement) return undefined;
  const timing = effect.getComputedTiming();
  const active = Number(timing.activeDuration ?? 0);
  // One that never ends is how the element looks, and the conversion keeps it as it is.
  if (!Number.isFinite(active) || timing.iterations === Infinity) return undefined;
  const frames = framesOf(effect);
  if (frames.length < 2) return undefined;
  const rate = Math.abs(animation.playbackRate || 1);
  const delay = Math.max(0, Number(effect.getTiming().delay ?? 0)) / rate;
  const started = animation.startTime === null ? seenAt : Number(animation.startTime);
  const repeats = Number(timing.iterations ?? 1);
  const written = Number.isInteger(repeats) && repeats > 1 && repeats <= MAX_ITERATIONS;
  const duration = (written ? active : Number(timing.duration ?? 0)) / rate;
  if (!(duration > 0)) return undefined;
  return {
    target,
    start: started,
    begin: started + delay,
    duration,
    easing: String(effect.getTiming().easing ?? 'linear'),
    frames,
    delay,
  };
}

/** Several tracks of one element as one: every property on one timeline. */
export function mergeTracks(tracks: readonly MotionTrack[]): MotionTrack {
  const [first] = tracks;
  if (tracks.length === 1) return first!;
  const begin = Math.min(...tracks.map((t) => t.begin));
  const end = Math.max(...tracks.map((t) => t.begin + t.duration));
  const span = Math.max(end - begin, 1);
  const easings = new Set(tracks.map((t) => t.easing));
  const shared = easings.size === 1 ? first!.easing : 'linear';
  const byOffset = new Map<number, MotionFrame>();
  const put = (offset: number, props: Record<string, string>, easing?: string) => {
    const at = fixed(Math.min(1, Math.max(0, offset)), 5);
    const frame = byOffset.get(at) ?? { offset: at, props: {} };
    frame.props = { ...frame.props, ...props };
    if (easing && !frame.easing) frame.easing = easing;
    byOffset.set(at, frame);
  };
  for (const track of tracks) {
    const from = (track.begin - begin) / span;
    const to = (track.begin + track.duration - begin) / span;
    // A track that moves later or ends sooner holds its first and last values meanwhile.
    if (from > 0) put(0, track.frames[0]!.props);
    for (const frame of track.frames) {
      const easing =
        frame.easing ??
        (shared === 'linear' && track.easing !== 'linear' ? track.easing : undefined);
      put(from + frame.offset * (to - from), frame.props, easing);
    }
    if (to < 1) put(1, track.frames[track.frames.length - 1]!.props);
  }
  return {
    target: first!.target,
    start: Math.min(...tracks.map((t) => t.start)),
    begin,
    duration: span,
    easing: shared,
    frames: Array.from(byOffset.values()).sort((a, b) => a.offset - b.offset),
    delay: Math.min(...tracks.map((t) => t.delay)),
  };
}

// --------------------------------------------------------------------------- judging

const opacityOf = (props: Record<string, string>): number => {
  const value = props.opacity;
  if (value === undefined) return 1;
  const n = Number.parseFloat(value);
  return value.trim().endsWith('%') ? n / 100 : n;
};

const shownIn = (props: Record<string, string>) =>
  props.visibility !== 'hidden' && opacityOf(props) >= 0.05;

/** The values at the start and at the end: what the first and the last keyframe say of each property. */
function ends(frames: readonly MotionFrame[]): [Record<string, string>, Record<string, string>] {
  const start: Record<string, string> = {};
  const finish: Record<string, string> = {};
  for (const frame of frames) {
    for (const [key, value] of Object.entries(frame.props)) {
      if (!(key in start)) start[key] = value;
      finish[key] = value;
    }
  }
  return [start, finish];
}

/**
 * What an animation is to the element: it comes in from nothing or from elsewhere (entrance),
 * it goes away (exit), or it moves and comes back to where it was (emphasis).
 */
export function categoryOf(frames: readonly MotionFrame[]): 'entrance' | 'emphasis' | 'exit' {
  const [start, finish] = ends(frames);
  if (!shownIn(start)) return 'entrance';
  if (!shownIn(finish)) return 'exit';
  const keys = new Set([...Object.keys(start), ...Object.keys(finish)]);
  const still = Array.from(keys).every((key) => start[key] === finish[key]);
  return still ? 'emphasis' : 'entrance';
}

/** A short stable name for a text. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A transform's translation in slide pixels: `matrix()` keeps it in its last numbers. */
export function scaleTransform(value: string, k: number): string {
  if (k === 1) return value;
  const matrix = /^matrix(3d)?\(([^)]*)\)$/.exec(value.trim());
  if (!matrix) return scalePx(value, k);
  const n = matrix[2]!.split(',').map((part) => Number.parseFloat(part));
  const moves = matrix[1] ? [12, 13, 14] : [4, 5];
  for (const i of moves) if (Number.isFinite(n[i])) n[i] = fixed(n[i]! * k, 4);
  return `matrix${matrix[1] ?? ''}(${n.join(', ')})`;
}

/** Keyframes as a `@keyframes` rule of their own, named after what they say. */
export function keyframesRule(
  frames: readonly MotionFrame[],
  k: number,
): { name: string; css: string } {
  const body = frames
    .map((frame) => {
      const declarations = Object.entries(frame.props).map(([property, value]) => {
        const scaled =
          property === 'transform' || property === 'translate'
            ? scaleTransform(value, k)
            : property === 'filter' || property === 'clip-path'
              ? scalePx(value, k)
              : value;
        return `${kebab(property)}: ${scaled};`;
      });
      if (frame.easing) declarations.push(`animation-timing-function: ${frame.easing};`);
      return `${fixed(frame.offset * 100, 3)}% { ${declarations.join(' ')} }`;
    })
    .join(' ');
  const name = `slidr-${hashOf(body)}`;
  return { name, css: `@keyframes ${name} { ${body} }` };
}

/** How a slide moved as it came in, or as it left: its start compared with its end. */
export interface SlideMotion {
  opacityFrom: number;
  opacityTo: number;
  /** Where it stood at the start (coming in) or at the end (leaving), off its place of rest, as a share of the slide. */
  dx: number;
  dy: number;
  /** Its scale away from its place of rest. */
  scale: number;
  /** It turned in depth. */
  turns: boolean;
  /** A shape it was cut to. */
  clip?: 'circle' | 'inset' | 'polygon';
  /** For an inset: the side cut away most at the start, as a step along the screen. */
  clipEdge?: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  blurred: boolean;
}

export interface SlideMove {
  type: string;
  /** The way the slides travel on screen. */
  travel?: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
}

const FULL = 0.8;
const MOVED = 0.03;

function along(dx: number, dy: number): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx > 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy > 0 ? 1 : -1 };
}

/** The transition of the runtime nearest to what the slides did. */
export function classifyTransition(
  incoming: SlideMotion | undefined,
  outgoing: SlideMotion | undefined,
): SlideMove | undefined {
  const inMoves = incoming ? Math.max(Math.abs(incoming.dx), Math.abs(incoming.dy)) : 0;
  const outMoves = outgoing ? Math.max(Math.abs(outgoing.dx), Math.abs(outgoing.dy)) : 0;
  // A slide that comes in from the right travels left; one that leaves to the left does too.
  const travel = () =>
    incoming && inMoves >= MOVED
      ? along(-incoming.dx, -incoming.dy)
      : along(outgoing?.dx ?? -1, outgoing?.dy ?? 0);
  if (incoming?.turns || outgoing?.turns) {
    return { type: incoming?.turns && outgoing?.turns ? 'cube' : 'flip', travel: travel() };
  }
  if (incoming?.clip === 'circle') return { type: 'iris' };
  if (incoming?.clip === 'polygon') return { type: 'split' };
  if (incoming?.clip === 'inset') {
    return { type: 'wipe', ...(incoming.clipEdge ? { travel: incoming.clipEdge } : {}) };
  }
  if (incoming?.blurred) return { type: 'blur' };
  if (inMoves >= FULL || outMoves >= FULL) {
    const both = inMoves >= FULL && outMoves >= FULL;
    return { type: both ? 'push' : inMoves >= FULL ? 'cover' : 'reveal', travel: travel() };
  }
  const zoomed = (m?: SlideMotion) => m !== undefined && Math.abs(m.scale - 1) >= 0.03;
  if (zoomed(incoming) || zoomed(outgoing)) return { type: 'zoom' };
  if (inMoves >= MOVED || outMoves >= MOVED) return { type: 'slide', travel: travel() };
  const fadesIn = incoming !== undefined && incoming.opacityFrom < 0.5;
  const fadesOut = outgoing !== undefined && outgoing.opacityTo < 0.5;
  if (fadesIn && fadesOut) return { type: 'crossfade' };
  if (fadesIn) return { type: 'fade' };
  if (fadesOut) return { type: 'crossfade' };
  return undefined;
}

/** A step along the screen as the runtime's direction, in a slide that reads `dir`. */
export function flowOf(
  v: { x: -1 | 0 | 1; y: -1 | 0 | 1 },
  dir: 'ltr' | 'rtl',
): NonNullable<Transition['direction']> {
  if (v.y < 0) return 'up';
  if (v.y > 0) return 'down';
  const left = v.x < 0;
  return left === (dir === 'ltr') ? 'start' : 'end';
}

// ------------------------------------------------------------------------- the page

/** The value a property computes to where `near` is, for a value that depends on its place. */
function onPage(
  near: Element,
  property: string,
  value: string,
  box?: { w: number; h: number },
): string {
  const doc = near.ownerDocument;
  const parent = near.parentElement ?? doc.body;
  if (!parent) return value;
  const probe = doc.createElement('div');
  const size = box ?? {
    w: (near as HTMLElement).offsetWidth || 0,
    h: (near as HTMLElement).offsetHeight || 0,
  };
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${size.w}px;height:${size.h}px;transition:none;animation:none`;
  probe.style.setProperty(property, value);
  parent.append(probe);
  const computed = doc.defaultView?.getComputedStyle(probe).getPropertyValue(property) ?? value;
  probe.remove();
  return computed || value;
}

/** Keyframes whose values hold on the slide: what depends on the page computed there. */
function settled(track: MotionTrack): MotionFrame[] {
  return track.frames.map((frame) => {
    const props: Record<string, string> = {};
    for (const [property, value] of Object.entries(frame.props)) {
      props[property] = NEEDS_PAGE.test(value) ? onPage(track.target, property, value) : value;
    }
    return { ...frame, props };
  });
}

/** One transform out of `transform`, `translate`, `scale` and `rotate`, as the browser composes them. */
function composedTransform(props: Record<string, string>): string {
  const parts: string[] = [];
  if (props.translate && props.translate !== 'none') {
    parts.push(`translate(${props.translate.trim().split(/\s+/).slice(0, 2).join(', ')})`);
  }
  if (props.rotate && props.rotate !== 'none') parts.push(`rotate(${props.rotate})`);
  if (props.scale && props.scale !== 'none') {
    parts.push(`scale(${props.scale.trim().split(/\s+/).slice(0, 2).join(', ')})`);
  }
  if (props.transform && props.transform !== 'none') parts.push(props.transform);
  return parts.join(' ') || 'none';
}

function insetEdge(clip: string): SlideMotion['clipEdge'] {
  const inside = /inset\(([^)]*)\)/.exec(clip)?.[1];
  if (!inside) return undefined;
  const values = inside
    .split(/\s+round\s+/)[0]!
    .trim()
    .split(/\s+/)
    .map((v) => Number.parseFloat(v) || 0);
  const [top = 0, right = top, bottom = top, left = right] = values;
  const sides: [number, { x: -1 | 0 | 1; y: -1 | 0 | 1 }][] = [
    [top, { x: 0, y: -1 }],
    [right, { x: 1, y: 0 }],
    [bottom, { x: 0, y: 1 }],
    [left, { x: -1, y: 0 }],
  ];
  sides.sort((a, b) => b[0] - a[0]);
  return sides[0]![0] > 0 ? sides[0]![1] : undefined;
}

/** How one slide-sized box moved: at rest at one end, `away` at the other. */
function slideMotion(
  tracks: readonly MotionTrack[],
  size: { w: number; h: number },
  coming: boolean,
): SlideMotion {
  const merged = mergeTracks(tracks);
  const [start, finish] = ends(merged.frames);
  const away = coming ? start : finish;
  const rest = coming ? finish : start;
  const view = merged.target.ownerDocument.defaultView;
  const Matrix =
    (view as unknown as { DOMMatrix?: typeof DOMMatrix } | null)?.DOMMatrix ?? DOMMatrix;
  const matrix = (props: Record<string, string>) => {
    const text = composedTransform(props);
    if (text === 'none') return new Matrix();
    return safe(() => new Matrix(onPage(merged.target, 'transform', text, size)), new Matrix());
  };
  const a = matrix(away);
  const b = matrix(rest);
  const scaleOf = (m: DOMMatrix) => Math.hypot(m.a, m.b);
  const clip = away['clip-path'];
  const kind =
    !clip || clip === 'none'
      ? undefined
      : clip.startsWith('circle') || clip.startsWith('ellipse')
        ? 'circle'
        : clip.startsWith('polygon')
          ? 'polygon'
          : clip.startsWith('inset')
            ? 'inset'
            : undefined;
  const blur = /blur\(\s*([\d.]+)px/.exec(away.filter ?? '');
  const edge = kind === 'inset' ? insetEdge(clip!) : undefined;
  return {
    opacityFrom: opacityOf(start),
    opacityTo: opacityOf(finish),
    dx: size.w > 0 ? (a.e - b.e) / size.w : 0,
    dy: size.h > 0 ? (a.f - b.f) / size.h : 0,
    scale: scaleOf(b) > 0 ? scaleOf(a) / scaleOf(b) : 1,
    turns: !a.is2D || !b.is2D,
    ...(kind ? { clip: kind } : {}),
    ...(edge ? { clipEdge: edge } : {}),
    blurred: blur !== null && Number.parseFloat(blur[1]!) > 2,
  };
}

/** A transform that leaves a box where it is. */
const IDENTITY =
  /^(none|matrix\(1, 0, 0, 1, 0, 0\)|matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\))$/;

/** Whether keyframes end with the box as it is at rest: fully shown, unmoved, unfiltered. */
function endsAtRest(frames: readonly MotionFrame[]): boolean {
  const [, finish] = ends(frames);
  return Object.entries(finish).every(([property, value]) => {
    const v = value.trim();
    if (property === 'opacity') return opacityOf(finish) >= 0.999;
    if (property === 'visibility') return v === 'visible' || v === 'inherit';
    if (property === 'transform')
      return (
        /^(none|translate[XYZ3d]*\(0(px)?(, ?0(px)?)*\)|scale\(1\)|rotate\(0(deg)?\))$/.test(v) ||
        IDENTITY.test(v)
      );
    if (property === 'translate') return /^(none|0(px)?( 0(px)?)*)$/.test(v);
    if (property === 'scale') return /^(none|1( 1)*)$/.test(v);
    if (property === 'rotate') return /^(none|0(deg)?)$/.test(v);
    return v === 'none';
  });
}

/** What can be seen of a box: how shown it is and where it is. */
function lookOf(el: Element): string {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const at = [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 2) / 2).join(',');
  const transform = cs?.transform ?? 'none';
  return `${cs?.opacity}|${cs?.visibility}|${IDENTITY.test(transform) ? 'none' : transform}|${cs?.filter}|${at}`;
}

/**
 * An animation that has ended, and holds its element where the element would be without it,
 * lets go of it: the steps of the slide play it from now on. Held, it keeps the element on a
 * layer of its own, where text is drawn otherwise than on the slide, and the comparison of the
 * capture with the page would keep the element as html for that alone. Should letting go change
 * how the element looks (the page hides it without the animation), it is held again.
 */
function letGo(animation: Animation, track: MotionTrack): void {
  if (!endsAtRest(track.frames)) return;
  const before = lookOf(track.target);
  safe(() => animation.cancel(), undefined);
  if (lookOf(track.target) === before) return;
  safe(() => {
    animation.play();
    animation.finish();
  }, undefined);
}

/** Elements on the same level as `root` or one of its ancestors: where the slide that leaves is. */
function besideTheSlide(el: Element, root: Element): boolean {
  let level: Element | null = root;
  for (let depth = 0; level && depth < 4; depth++, level = level.parentElement) {
    if (el.parentElement && el.parentElement === level.parentElement && el !== level) return true;
  }
  return false;
}

export interface MotionRecorder {
  /**
   * Reads what moved since the recorder started, for the slide `root`, and brings it to its end
   * (an animation still running would be captured half way). `k` is slide px per CSS px of the
   * root; `dir` the way the file reads, which the transition's direction follows.
   */
  take(root: Element, options: { k: number; dir: 'ltr' | 'rtl' }): MotionFound;
  /** Stops watching. */
  stop(): void;
}

/** Starts watching a document for the animations it starts. */
export function recordMotion(doc: Document): MotionRecorder {
  const now = () => Number(doc.timeline?.currentTime ?? 0);
  const before = new Set(safe(() => doc.getAnimations(), [] as Animation[]));
  const seen = new Map<Animation, number>();
  const look = () => {
    for (const animation of safe(() => doc.getAnimations(), [] as Animation[])) {
      if (!before.has(animation) && !seen.has(animation)) seen.set(animation, now());
    }
  };
  look();
  const timer = setInterval(look, POLL_MS);

  return {
    stop: () => clearInterval(timer),
    take(root, { k, dir }) {
      look();
      clearInterval(timer);
      // What the slide still holds from before (a first slide that came in as the file loaded)
      // is its motion too.
      const all = new Map(seen);
      for (const animation of safe(
        () => root.getAnimations({ subtree: true }),
        [] as Animation[],
      )) {
        if (!all.has(animation)) all.set(animation, now());
      }
      const tracks: MotionTrack[] = [];
      const played = new Map<MotionTrack, Animation>();
      for (const [animation, at] of all) {
        const track = safe(() => trackOf(animation, at), undefined);
        if (track) {
          tracks.push(track);
          played.set(track, animation);
        }
      }
      // Brought to their end: the capture is of the slide once it has come in.
      for (const animation of all.keys()) {
        const timing = safe(() => animation.effect?.getComputedTiming(), undefined);
        if (timing && Number.isFinite(Number(timing.endTime)))
          safe(() => animation.finish(), undefined);
      }
      for (const [track, animation] of played) {
        if (track.target === root || root.contains(track.target)) letGo(animation, track);
      }

      const r = root.getBoundingClientRect();
      const size = {
        w: (root as HTMLElement).offsetWidth || r.width,
        h: (root as HTMLElement).offsetHeight || r.height,
      };
      const inside: MotionTrack[] = [];
      const coming: MotionTrack[] = [];
      const leaving: MotionTrack[] = [];
      for (const track of tracks) {
        const { target } = track;
        if (target !== root && root.contains(target)) inside.push(track);
        else if (target === root || target.contains(root)) coming.push(track);
        else if (besideTheSlide(target, root)) leaving.push(track);
      }

      const incoming = coming.length > 0 ? slideMotion(coming, size, true) : undefined;
      const outgoing = leaving.length > 0 ? slideMotion(leaving, size, false) : undefined;
      const move = classifyTransition(incoming, outgoing);
      const turn = [...coming, ...leaving];
      let transition: Transition | undefined;
      let opened = Number.POSITIVE_INFINITY;
      if (move && turn.length > 0) {
        opened = Math.min(...turn.map((t) => t.start));
        const ended = Math.max(...turn.map((t) => since(t, opened) + t.delay + t.duration));
        const lead = coming.length > 0 ? mergeTracks(coming) : mergeTracks(leaving);
        const eased =
          lead.easing !== 'linear' ? lead.easing : (lead.frames[0]?.easing ?? 'ease-in-out');
        transition = {
          type: move.type,
          ...(move.travel ? { direction: flowOf(move.travel, dir) } : {}),
          duration: Math.round(ended),
          easing: eased,
          advance: { onClick: true },
        };
      }

      const byTarget = new Map<Element, MotionTrack[]>();
      for (const track of inside) {
        const list = byTarget.get(track.target);
        if (list) list.push(track);
        else byTarget.set(track.target, [track]);
      }
      const merged = Array.from(byTarget.values(), mergeTracks);
      // The slide opened when the first of its motions started; in the deck its steps start once
      // its transition has ended.
      const open = Math.min(opened, ...merged.map((t) => t.start));
      const after = transition?.duration ?? 0;
      const steps: MotionStep[] = merged
        .sort((a, b) => a.begin - b.begin)
        .map((track) => {
          const frames = settled(track);
          const { name, css } = keyframesRule(frames, k);
          return {
            target: track.target,
            spec: {
              preset: `css:${name}`,
              category: categoryOf(frames),
              trigger: 'withPrevious',
              order: 0,
              delay: Math.max(
                0,
                Math.round(since(track, open) + track.begin - track.start - after),
              ),
              duration: Math.round(track.duration),
              easing: track.easing,
            },
            ownDelay: Math.round(track.delay),
            css,
          };
        });
      return { steps, ...(transition ? { transition } : {}) };
    },
  };
}

// --------------------------------------------------------------------------- marking

type Fields = Record<string, unknown>;

/** A mark as the agent wrote it: fields, `none`, or a list it gave whole. */
function markOf(value: string | null): Fields | 'none' | 'list' | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text === 'none') return 'none';
  if (text.startsWith('[')) return 'list';
  if (!text.startsWith('{')) return { preset: text };
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Fields)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The nearest ancestor of `el` inside `root` that the agent marked, and its mark. */
function markAbove(el: Element, root: Element): Fields | 'none' | undefined {
  for (let up = el.parentElement; up && root.contains(up); up = up.parentElement) {
    const mark = markOf(up.getAttribute(ANIM_MARK));
    if (mark === 'none') return 'none';
    if (mark && mark !== 'list') return mark;
    if (up === root) break;
  }
  return undefined;
}

/**
 * Marks what moved for the conversion, and adds the `@keyframes` the marks name to the page.
 * The agent's own marks (set in `before`) say when a step plays; what the page played says how,
 * where the mark does not. Returns the function that takes all of it away again.
 */
export function markMotion(root: Element, found: MotionFound): () => void {
  const doc = root.ownerDocument;
  const style = doc.createElement('style');
  style.setAttribute('data-slidr-motion', '');
  style.textContent = Array.from(new Set(found.steps.map((step) => step.css))).join('\n');
  (doc.head ?? doc.documentElement).append(style);
  const marked = new Set<Element>();
  for (const step of found.steps) {
    const own = markOf(step.target.getAttribute(ANIM_MARK));
    if (own === 'none' || own === 'list') continue;
    const above = own ? undefined : markAbove(step.target, root);
    if (above === 'none') continue;
    // Within something the agent marked, it plays with that, on the same click.
    const when: Fields = above
      ? { trigger: 'withPrevious', ...(above.order !== undefined ? { order: above.order } : {}) }
      : {};
    const clicked = own
      ? own.trigger !== undefined || (own.order !== undefined && own.order !== 0)
      : above !== undefined;
    // A step of a click starts with the click, after its own delay, not with the slide.
    const seen: Fields = { ...step.spec };
    if (clicked) {
      delete seen.trigger;
      seen.delay = step.ownDelay;
    }
    const spec: Fields = { ...seen, ...when, ...(own ?? {}) };
    if (own && own.trigger !== undefined && own.order === undefined) delete spec.order;
    step.target.setAttribute(ANIM_MARK, JSON.stringify(spec));
    marked.add(step.target);
  }
  // A mark that names no preset and moved nothing on the page fades in.
  for (const el of Array.from(root.querySelectorAll(`[${ANIM_MARK}]`))) {
    if (marked.has(el)) continue;
    const own = markOf(el.getAttribute(ANIM_MARK));
    if (own && own !== 'none' && own !== 'list' && typeof own.preset !== 'string') {
      el.setAttribute(ANIM_MARK, JSON.stringify({ preset: 'fade', ...own }));
    }
  }
  return () => {
    style.remove();
    clearMarks(doc);
  };
}

/** The marks hold for one capture, whether it succeeded or not: the agent sets them again in the `before` of the next. */
export function clearMarks(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`[${ANIM_MARK}]`))) {
    el.removeAttribute(ANIM_MARK);
  }
}
