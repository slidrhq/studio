import type { ChangeEvent, CommandBus } from './bus';
import { actorSession } from './commands';
import { allElementIds } from './queries';

/** What changed in the deck behind an agent session's back since its last turn (CMD-08). */
export interface ChangeSummary {
  /** Slides that changed and still exist. */
  slides: string[];
  /** Elements that changed and still exist. */
  elements: string[];
  removedSlides: string[];
  removedElements: string[];
  /** Slides were added, removed or moved. */
  slideOrder: boolean;
  theme: boolean;
}

interface Pending {
  slides: Set<string>;
  elements: Set<string>;
  slideOrder: boolean;
  theme: boolean;
}

function emptyPending(): Pending {
  return { slides: new Set(), elements: new Set(), slideOrder: false, theme: false };
}

/**
 * Keeps, for each agent session, the changes made by anyone else since that session last
 * asked. The summary goes into the context block of the session's next turn (SPEC 11.6), so
 * the agent does not work from a stale picture after the user edited by hand.
 */
export class ChangeDigest {
  readonly #bus: CommandBus;
  readonly #pending = new Map<string, Pending>();
  readonly #unsubscribe: () => void;

  constructor(bus: CommandBus) {
    this.#bus = bus;
    this.#unsubscribe = bus.subscribe((event) => this.#record(event));
  }

  /** Starts collecting for a session. `take` does this too, on its first call. */
  track(sessionId: string): void {
    if (!this.#pending.has(sessionId)) this.#pending.set(sessionId, emptyPending());
  }

  /** Stops collecting for a session that has ended. */
  forget(sessionId: string): void {
    this.#pending.delete(sessionId);
  }

  /** The changes since the previous call for this session. Call it when a turn starts. */
  take(sessionId: string): ChangeSummary {
    const pending = this.#pending.get(sessionId) ?? emptyPending();
    this.#pending.set(sessionId, emptyPending());

    const deck = this.#bus.deck;
    const liveSlides = new Set(deck.slides.map((s) => s.id));
    const liveElements = allElementIds(deck);
    const slides = [...pending.slides];
    const elements = [...pending.elements];
    return {
      slides: slides.filter((id) => liveSlides.has(id)),
      elements: elements.filter((id) => liveElements.has(id)),
      removedSlides: slides.filter((id) => !liveSlides.has(id)),
      removedElements: elements.filter((id) => !liveElements.has(id)),
      slideOrder: pending.slideOrder,
      theme: pending.theme,
    };
  }

  dispose(): void {
    this.#unsubscribe();
    this.#pending.clear();
  }

  #record(event: ChangeEvent): void {
    if (event.kind === 'reset') {
      for (const sessionId of this.#pending.keys()) this.#pending.set(sessionId, emptyPending());
      return;
    }
    const author = actorSession(event.actor);
    for (const [sessionId, pending] of this.#pending) {
      // A session knows its own changes; a rollback of them is still its own doing.
      if (sessionId === author) continue;
      for (const id of event.affected.slides) pending.slides.add(id);
      for (const id of event.affected.elements) pending.elements.add(id);
      pending.slideOrder ||= event.affected.slideOrder;
      pending.theme ||= event.affected.theme || event.affected.layouts.length > 0;
    }
  }
}
