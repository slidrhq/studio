import { isDraft, original } from 'immer';
import type { Archetype, Deck, Element, GroupElement, Slide } from './schema';

/** Every element of a tree, parents before their children. */
export function* walkElements(elements: readonly Element[]): Generator<Element> {
  for (const element of elements) {
    yield element;
    if (element.type === 'group') yield* walkElements(element.children);
  }
}

export function findSlide(deck: Deck, slideId: string): Slide | undefined {
  return deck.slides.find((s) => s.id === slideId);
}

/** The archetype of a slide: its layout's, or its own when it has no layout. */
export function slideArchetype(deck: Deck, slide: Slide): Archetype | undefined {
  const layout = slide.layoutId ? deck.layouts.find((l) => l.id === slide.layoutId) : undefined;
  return layout?.archetype ?? slide.archetype;
}

export interface ElementLocation {
  element: Element;
  /** The array that holds the element: `slide.elements` or a group's `children`. */
  siblings: Element[];
  index: number;
  parent?: GroupElement;
}

/** Finds an element by walking a tree, parents before their children. */
function walkTo(
  elements: Element[],
  elementId: string,
  parent?: GroupElement,
): ElementLocation | undefined {
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!element) continue;
    if (element.id === elementId) return { element, siblings: elements, index, parent };
    if (element.type === 'group') {
      const inside = walkTo(element.children, elementId, element);
      if (inside) return inside;
    }
  }
  return undefined;
}

/** Where the elements of a tree are: for each id, the indices that lead to it from the top. */
interface Places {
  at: Map<string, readonly number[]>;
  /** Taken from this very tree, which cannot change: an id it does not have is not in the tree. */
  exact: boolean;
}

function placesIn(elements: readonly Element[]): Map<string, readonly number[]> {
  const at = new Map<string, readonly number[]>();
  const visit = (list: readonly Element[], above: readonly number[]) => {
    list.forEach((element, index) => {
      if (!element) return;
      const place = [...above, index];
      // As the walk finds them: the first of an id that a broken tree has twice.
      if (!at.has(element.id)) at.set(element.id, place);
      if (element.type === 'group') visit(element.children, place);
    });
  };
  visit(elements, []);
  return at;
}

/** The places of the trees looked in, by the list at their top. */
const placesOf = new WeakMap<readonly Element[], Places>();

/**
 * The places taken last, newest first. A change makes new lists down to what it changed: a drag
 * gives its slide new lists with every frame, and every command of a batch does, and the places
 * in them are the ones before. A tree met for the first time tries these.
 */
let recent: Map<string, readonly number[]>[] = [];
const RECENT = 4;

function remember(at: Map<string, readonly number[]>): void {
  if (recent[0] !== at) recent = [at, ...recent.filter((known) => known !== at)].slice(0, RECENT);
}

/** The element at a place of a tree, when it is the one with this id. */
function atPlace(
  elements: Element[],
  place: readonly number[],
  elementId: string,
): ElementLocation | undefined {
  let siblings = elements;
  let parent: GroupElement | undefined;
  for (let depth = 0; depth < place.length; depth++) {
    const index = place[depth]!;
    const element = siblings[index];
    if (!element) return undefined;
    if (depth === place.length - 1)
      return element.id === elementId ? { element, siblings, index, parent } : undefined;
    if (element.type !== 'group') return undefined;
    parent = element;
    siblings = element.children;
  }
  return undefined;
}

/**
 * Finds an element anywhere in a tree, together with where it sits.
 *
 * By the places of the tree (`Places`), taken once for each list and checked at every use: a
 * selection of many elements looks each of them up, again and again, with every frame of a drag,
 * and walking the tree for each was a walk for every element. In a command's draft the places
 * are those of the list it was made from, and only what they lead to is drafted.
 */
export function locateElement(
  elements: Element[],
  elementId: string,
  parent?: GroupElement,
): ElementLocation | undefined {
  if (parent) return walkTo(elements, elementId, parent);
  const draft = isDraft(elements);
  const tree: Element[] = draft ? (original(elements) ?? elements) : elements;
  let places = placesOf.get(tree);
  if (!places) {
    const before = recent.find((at) => {
      const place = at.get(elementId);
      return place !== undefined && atPlace(elements, place, elementId) !== undefined;
    });
    places = before
      ? { at: before, exact: false }
      : { at: placesIn(tree), exact: !draft && Object.isFrozen(tree) };
    placesOf.set(tree, places);
  }
  remember(places.at);
  const place = places.at.get(elementId);
  const found = place && atPlace(elements, place, elementId);
  if (found) return found;
  if (!place && places.exact) return undefined;
  // The places are of another state of the tree: what they do not lead to is looked for.
  const walked = walkTo(elements, elementId);
  if (walked && !draft) {
    const at = placesIn(tree);
    placesOf.set(tree, { at, exact: Object.isFrozen(tree) });
    remember(at);
  }
  return walked;
}

export function findElement(slide: Slide, elementId: string): Element | undefined {
  return locateElement(slide.elements, elementId)?.element;
}

/** Finds an element by id alone: element ids are unique across the slides of a deck. */
export function findElementInDeck(
  deck: Deck,
  elementId: string,
): { slide: Slide; element: Element } | undefined {
  for (const slide of deck.slides) {
    const element = findElement(slide, elementId);
    if (element) return { slide, element };
  }
  return undefined;
}

/** Ids of all elements on all slides, nested ones included. */
export function allElementIds(deck: Deck): Set<string> {
  const ids = new Set<string>();
  for (const slide of deck.slides) {
    for (const element of walkElements(slide.elements)) ids.add(element.id);
  }
  return ids;
}

/**
 * The ids of the elements of a frozen slide, nested ones included. A slide that changes is
 * another object.
 */
const idsOfSlide = new WeakMap<Slide, ReadonlySet<string>>();

function slideElementIds(slide: Slide): ReadonlySet<string> {
  const known = idsOfSlide.get(slide);
  if (known) return known;
  const ids = new Set<string>();
  for (const element of walkElements(slide.elements)) ids.add(element.id);
  if (Object.isFrozen(slide) && Object.isFrozen(slide.elements)) idsOfSlide.set(slide, ids);
  return ids;
}

/**
 * Whether an element of the deck has this id. Each slide's ids are kept for as long as the slide
 * is the same object, so a paste of forty elements into a deck of thousands checks forty ids, and
 * does not walk the whole deck forty times (`allElementIds`): on 200 slides that took 42 ms.
 */
export function hasElementId(deck: Deck, elementId: string): boolean {
  return deck.slides.some((slide) => slideElementIds(slide).has(elementId));
}

/**
 * Ids of the assets the deck still uses. An asset counts as used when its id appears anywhere
 * outside the asset table: in a model field, or inside free HTML or CSS, which the model does
 * not parse (SPEC 5.9). Fonts are used by family name, never by id, so they always count.
 */
export function referencedAssetIds(deck: Deck): Set<string> {
  const { assets, ...rest } = deck;
  const haystack = JSON.stringify(rest);
  const ids = new Set<string>();
  for (const asset of Object.values(assets)) {
    if (asset.kind === 'font' || haystack.includes(asset.id)) ids.add(asset.id);
  }
  return ids;
}

/** The separators of paths, drives and streams, and the characters Windows refuses in a name. */
const NOT_IN_A_FILE_NAME = '/\\:<>"|?*';
/** What Windows reads as a device, whatever the extension: `NUL`, `con.png`, `COM1`. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Whether `name` can be an asset's `file`: the name of one file inside the document's `assets/`
 * folder (SPEC 5.7), on every system the app runs on. A path, an address, and a name that
 * Windows would refuse, cut short (a dot or a space at the end) or take for a device are not.
 *
 * The storage layer judges by the same rule when it saves (`is_plain_file_name`, in Rust), and
 * leaves such an asset out of the file; the two are held to one list of names by their tests.
 */
export function isAssetFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  for (const char of name) {
    if (char.charCodeAt(0) < 0x20 || NOT_IN_A_FILE_NAME.includes(char)) return false;
  }
  const stem = (name.split('.')[0] ?? name).replace(/ +$/, '');
  return !DEVICE_NAME.test(stem);
}
