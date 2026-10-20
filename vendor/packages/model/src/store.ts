import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChangeEvent, CommandBus } from './bus';
import { findSlide, locateElement } from './queries';
import type { Deck } from './schema';

/** A store that can be read and watched but not written. */
export type ReadonlyStore<T> = Pick<StoreApi<T>, 'getState' | 'getInitialState' | 'subscribe'>;

export interface DeckState {
  deck: Deck;
  canUndo: boolean;
  canRedo: boolean;
  /** Goes up by one with every change. Compare with the value at the last save to know if the deck is dirty. */
  revision: number;
}

export type DeckStore = ReadonlyStore<DeckState>;

/**
 * The deck as reactive state. It mirrors the bus and has no setter: the only way to change
 * the deck is `bus.dispatch` (SPEC 5.1).
 */
export function createDeckStore(bus: CommandBus): DeckStore {
  const store = createStore<DeckState>(() => ({
    deck: bus.deck,
    canUndo: bus.canUndo,
    canRedo: bus.canRedo,
    revision: 0,
  }));
  bus.subscribe((event) => {
    store.setState({
      deck: event.deck,
      canUndo: bus.canUndo,
      canRedo: bus.canRedo,
      revision: store.getState().revision + 1,
    });
  });
  const { getState, getInitialState, subscribe } = store;
  return { getState, getInitialState, subscribe };
}

/** What the user is looking at and has selected. Not part of the document or of undo (CMD-05). */
export interface SelectionState {
  /** The slide shown on the stage. Null only when the deck has no slides. */
  currentSlideId: string | null;
  /** Slides selected in the filmstrip. Includes the current slide. */
  selectedSlideIds: string[];
  /** Selected elements of the current slide. */
  selectedElementIds: string[];
  /**
   * The element being edited in place, if any. What that means follows its type: the text of a
   * text box or a shape, the crop of an image. It is always the one selected element. Working
   * inside a group is not this: the group the user has entered is the Stage's own state, and it
   * shows in the selection only as ids of nested elements (ADR-016).
   */
  editingElementId: string | null;

  setCurrentSlide: (slideId: string) => void;
  selectSlides: (slideIds: string[], currentSlideId?: string) => void;
  selectElements: (elementIds: string[]) => void;
  toggleElement: (elementId: string) => void;
  clearSelection: () => void;
  startEditing: (elementId: string) => void;
  stopEditing: () => void;
}

export type SelectionStore = StoreApi<SelectionState>;

type SelectionData = Pick<
  SelectionState,
  'currentSlideId' | 'selectedSlideIds' | 'selectedElementIds' | 'editingElementId'
>;

function initialSelection(deck: Deck): SelectionData {
  const first = deck.slides[0]?.id ?? null;
  return {
    currentSlideId: first,
    selectedSlideIds: first ? [first] : [],
    selectedElementIds: [],
    editingElementId: null,
  };
}

/** Drops whatever the selection points at that the deck no longer has. */
function reconcile(state: SelectionData, event: ChangeEvent): SelectionData | undefined {
  const { deck, previous } = event;
  if (event.kind === 'reset') return initialSelection(deck);

  let currentSlideId = state.currentSlideId;
  if (!currentSlideId || !findSlide(deck, currentSlideId)) {
    // Stay at the same place in the filmstrip: the slide that took the removed one's position.
    const oldIndex = previous.slides.findIndex((s) => s.id === currentSlideId);
    const index = Math.min(Math.max(oldIndex, 0), deck.slides.length - 1);
    currentSlideId = deck.slides[index]?.id ?? null;
  }
  const slide = currentSlideId ? findSlide(deck, currentSlideId) : undefined;
  const hasElement = (id: string) => Boolean(slide && locateElement(slide.elements, id));

  const selectedSlideIds = state.selectedSlideIds.filter((id) => findSlide(deck, id));
  if (currentSlideId && !selectedSlideIds.includes(currentSlideId)) {
    selectedSlideIds.push(currentSlideId);
  }
  const sameSlide = currentSlideId === state.currentSlideId;
  const selectedElementIds = sameSlide ? state.selectedElementIds.filter(hasElement) : [];
  const editingElementId =
    sameSlide && state.editingElementId && hasElement(state.editingElementId)
      ? state.editingElementId
      : null;

  const unchanged =
    sameSlide &&
    editingElementId === state.editingElementId &&
    selectedSlideIds.length === state.selectedSlideIds.length &&
    selectedElementIds.length === state.selectedElementIds.length;
  return unchanged
    ? undefined
    : { currentSlideId, selectedSlideIds, selectedElementIds, editingElementId };
}

/**
 * The selection store. It follows the deck: when a change removes a selected slide or element
 * (a delete, an undo, an agent edit), the selection is trimmed to what still exists.
 */
export function createSelectionStore(bus: CommandBus): SelectionStore {
  const store = createStore<SelectionState>((set, get) => ({
    ...initialSelection(bus.deck),

    setCurrentSlide: (slideId) => {
      if (slideId === get().currentSlideId || !findSlide(bus.deck, slideId)) return;
      set({
        currentSlideId: slideId,
        selectedSlideIds: [slideId],
        selectedElementIds: [],
        editingElementId: null,
      });
    },

    selectSlides: (slideIds, currentSlideId) => {
      const ids = slideIds.filter((id) => findSlide(bus.deck, id));
      const current = currentSlideId ?? ids.at(-1);
      if (!current || !ids.includes(current)) return;
      const moved = current !== get().currentSlideId;
      set({
        currentSlideId: current,
        selectedSlideIds: ids,
        ...(moved ? { selectedElementIds: [], editingElementId: null } : {}),
      });
    },

    selectElements: (elementIds) => {
      const { currentSlideId, editingElementId } = get();
      const slide = currentSlideId ? findSlide(bus.deck, currentSlideId) : undefined;
      const ids = slide ? elementIds.filter((id) => locateElement(slide.elements, id)) : [];
      const stillEditing =
        editingElementId !== null && ids.length === 1 && ids[0] === editingElementId;
      set({ selectedElementIds: ids, editingElementId: stillEditing ? editingElementId : null });
    },

    toggleElement: (elementId) => {
      const selected = get().selectedElementIds;
      get().selectElements(
        selected.includes(elementId)
          ? selected.filter((id) => id !== elementId)
          : [...selected, elementId],
      );
    },

    clearSelection: () => set({ selectedElementIds: [], editingElementId: null }),

    startEditing: (elementId) => {
      get().selectElements([elementId]);
      if (get().selectedElementIds[0] === elementId) set({ editingElementId: elementId });
    },

    stopEditing: () => set({ editingElementId: null }),
  }));

  bus.subscribe((event) => {
    const next = reconcile(store.getState(), event);
    if (next) store.setState(next);
  });
  return store;
}
