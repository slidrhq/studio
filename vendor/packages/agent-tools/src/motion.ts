/**
 * Motion by default (ADR-092). A slide the agent makes comes in with the deck's transition, and
 * what is on it enters in the order it is read once the transition has ended: the content rises
 * into place a little after one another, a picture fades in, and the title, the footer and what
 * lies behind everything are there with the slide. Nothing waits for a click, so a deck nobody
 * has looked at for animation still presents with one press per slide.
 *
 * It is a default and nothing more. The agent's own `data-anim` replaces it, `data-anim="none"`
 * on the slide's root keeps a slide still, and `animation_set` or the panel change it later.
 */
import {
  newId,
  type AnimationStep,
  type Deck,
  type Element,
  type Slide,
  type Transition,
} from '@slidr/model';

/** What a slide comes in with when no slide of the deck says otherwise. */
export const DEFAULT_TRANSITION: Transition = {
  type: 'fade',
  duration: 600,
  easing: 'ease-in-out',
  advance: { onClick: true },
};

/**
 * The transition a slide made at `index` takes: the nearest slide's before it that has one, or
 * after it, so the deck keeps one transition (or one per section, as its slides already have
 * it). `none` counts: a deck whose slides were set to cut keeps cutting.
 */
export function deckTransition(deck: Deck, index: number): Transition {
  const at = Math.max(0, Math.min(index, deck.slides.length));
  for (let i = at - 1; i >= 0; i--) {
    const transition = deck.slides[i]?.transition;
    if (transition) return transition;
  }
  for (let i = at; i < deck.slides.length; i++) {
    const transition = deck.slides[i]?.transition;
    if (transition) return transition;
  }
  return DEFAULT_TRANSITION;
}

/** Whether HTML the agent wrote says anything of animation, `none` included. */
export function animatesItself(html: string): boolean {
  return /\sdata-anim\s*=/i.test(html);
}

/** What is there with the slide itself and does not enter. */
const STILL_ROLES = new Set<Element['role']>(['title', 'footer', 'slideNumber', 'logo']);
/** A share of the slide above which a thing is what the slide stands on, not something on it. */
const BACKDROP = 0.4;
/** A decoration this large is a panel or a band: part of the layout, there with the slide. */
const PANEL = 0.08;
/** How near a decoration has to be to something that enters to come in with it, in slide px. */
const NEAR = 48;

const ENTER_MS = 600;
const EASING = 'ease-out';

function hasText(e: Element): boolean {
  const content = e.type === 'text' || e.type === 'shape' ? e.content : undefined;
  return Boolean(content?.paragraphs.some((p) => p.runs.some((run) => run.text.trim() !== '')));
}

/** A shape with nothing to read on it, a line, a small drawing: decoration. */
function decoration(e: Element, share: number): boolean {
  if (e.type === 'line') return true;
  if (e.type === 'shape') return !hasText(e);
  return e.type === 'svg' && share < 0.01;
}

/** The ready-made entrance an element takes. */
function presetFor(e: Element, share: number): { preset: string; direction?: 'up' } {
  if (e.type === 'image' || e.type === 'video' || e.type === 'html' || e.type === 'chart') {
    // A chart builds itself up while it fades in.
    return { preset: 'fade' };
  }
  if (e.type === 'svg') return share < 0.02 ? { preset: 'zoom' } : { preset: 'fade' };
  return { preset: 'rise', direction: 'up' };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const grown = (f: Box, by: number): Box => ({
  x: f.x - by,
  y: f.y - by,
  w: f.w + 2 * by,
  h: f.h + 2 * by,
});
const meets = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centre = (f: Box) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });

/**
 * The entrance of a slide the agent made: everything on it that is not there with the slide
 * enters as the slide opens, in the order the slide lists it (the order the HTML was written in,
 * which is the order it is read in), a little after the one before. A decoration beside
 * something that enters fades in with it.
 */
export function defaultTimeline(slide: Slide, size: { w: number; h: number }): AnimationStep[] {
  const area = size.w * size.h;
  const shareOf = (e: Element) => (e.frame.w * e.frame.h) / area;
  const units: Element[] = [];
  const small: Element[] = [];
  const still: Element[] = [];
  for (const e of slide.elements) {
    if (e.hidden) continue;
    if (STILL_ROLES.has(e.role)) {
      still.push(e);
      continue;
    }
    const share = shareOf(e);
    if (share >= BACKDROP) continue;
    if (decoration(e, share)) {
      if (share < PANEL) small.push(e);
      continue;
    }
    units.push(e);
  }
  if (units.length === 0) return [];

  // Each small decoration comes with the nearest thing beside it, if any is near; beside the
  // title (an underline, a mark before it) it is there with the title.
  const company = new Map<Element, Element[]>();
  for (const e of small) {
    const around = grown(e.frame, NEAR);
    const c = centre(e.frame);
    let best: Element | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const unit of [...units, ...still]) {
      if (!meets(around, unit.frame)) continue;
      const u = centre(unit.frame);
      const d = Math.hypot(u.x - c.x, u.y - c.y);
      if (d < distance) {
        distance = d;
        best = unit;
      }
    }
    if (best && units.includes(best)) company.set(best, [...(company.get(best) ?? []), e]);
  }

  const archetype = slide.archetype;
  const quiet = archetype === 'quote';
  const opening = archetype === 'hero' || archetype === 'section' || archetype === 'closing';
  const gap =
    quiet || opening
      ? 260
      : units.length <= 4
        ? 150
        : Math.max(60, Math.round(900 / (units.length - 1)));
  const duration = quiet ? 900 : ENTER_MS;

  const taken = new Set<string>();
  const id = () => {
    const made = newId('a', (candidate) => taken.has(candidate));
    taken.add(made);
    return made;
  };
  const steps: AnimationStep[] = [];
  units.forEach((unit, i) => {
    const share = shareOf(unit);
    const look = quiet
      ? { preset: 'fade' }
      : archetype === 'bigNumber' && i === 0 && unit.type === 'text'
        ? { preset: 'zoom' }
        : presetFor(unit, share);
    const delay = i * gap;
    steps.push({
      id: id(),
      elementId: unit.id,
      trigger: 'withPrevious',
      category: 'entrance',
      ...look,
      duration,
      delay,
      easing: EASING,
    });
    for (const beside of company.get(unit) ?? []) {
      steps.push({
        id: id(),
        elementId: beside.id,
        trigger: 'withPrevious',
        category: 'entrance',
        preset: 'fade',
        duration,
        delay,
        easing: EASING,
      });
    }
  });
  return steps;
}

/**
 * A slide the agent made, moving by default: its timeline when its HTML said nothing of one, and
 * the deck's transition when it has none of its own. `index` is where it stands in the deck.
 */
export function withDefaultMotion(
  slide: Slide,
  deck: Deck,
  index: number,
  options: { timeline: boolean },
): Slide {
  const timeline =
    options.timeline && slide.timeline.length === 0
      ? defaultTimeline(slide, deck.size)
      : slide.timeline;
  return {
    ...slide,
    timeline,
    ...(slide.transition ? {} : { transition: deckTransition(deck, index) }),
  };
}
