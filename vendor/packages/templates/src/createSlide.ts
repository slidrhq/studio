import {
  CommandError,
  slideFromLayout,
  type Deck,
  type Element,
  type Placeholder,
  type PlaceholderRole,
  type RichText,
  type Slide,
} from '@slidr/model';
import { seatAlign } from './align';

/** What goes into one placeholder: text, an asset of the deck, or a prompt for an image to make. */
export type RoleFill = RichText | { assetId: string } | { imagePrompt: string };

/**
 * Content by role. A list fills the placeholders of the role in the layout's order, which is how
 * a layout with three cards gets three texts; a single value goes to the first of them.
 */
export type LayoutContent = Partial<Record<PlaceholderRole, RoleFill | readonly RoleFill[]>>;

export interface CreateSlideRequest {
  layoutId: string;
  content?: LayoutContent;
  name?: string;
}

export interface CreatedSlide {
  /** The slide, with ids that are free in the deck. Add it with `slide.add`. */
  slide: Slide;
  /**
   * Roles whose content, or part of it, found no place: the layout has no placeholder of the role
   * (or fewer than the values given), or the placeholder cannot hold that kind of content. The
   * slide is made without it; the caller decides whether that is an error.
   */
  unplaced: PlaceholderRole[];
}

const isList = (value: RoleFill | readonly RoleFill[]): value is readonly RoleFill[] =>
  Array.isArray(value);

/**
 * The text takes its look from the placeholder: the layout decides the text style and the side
 * the text sits on. The side is the deck's, so a paragraph that reads the other way is aligned
 * to its own end (see `seatAlign`).
 */
function styled(content: RichText, placeholder: Placeholder, deck: Deck): RichText {
  const { align, styleRef } = placeholder;
  return {
    paragraphs: content.paragraphs.map((paragraph) => ({
      ...paragraph,
      // A placeholder that states no alignment leaves the text its own.
      ...(align ? { align: seatAlign(align, paragraph, deck.meta.dir) } : {}),
      ...(styleRef ? { styleRef } : {}),
    })),
  };
}

/** Puts content into the element of a placeholder. False when the element cannot hold it. */
function fill(element: Element, placeholder: Placeholder, value: RoleFill, deck: Deck): boolean {
  if ('paragraphs' in value) {
    if (element.type !== 'text') return false;
    // Text without a paragraph leaves the empty one the placeholder came with.
    if (value.paragraphs.length > 0) element.content = styled(value, placeholder, deck);
    return true;
  }
  if (element.type !== 'image') return false;
  if ('assetId' in value) {
    if (!deck.assets[value.assetId]) {
      throw new CommandError('not_found', `Asset "${value.assetId}" is not in the deck.`);
    }
    element.assetId = value.assetId;
  } else {
    element.prompt = value.imagePrompt;
  }
  return true;
}

/**
 * A new slide from a layout of the deck, with content filled in by role (WG7-T02). The layout is
 * the deck's, so it is already drawn for the deck's direction. The slide comes from
 * `slideFromLayout`, with one element for each placeholder that takes one; a placeholder left
 * without content keeps its empty element. The deck is not changed.
 */
export function createSlide(
  deck: Deck,
  request: CreateSlideRequest,
  options: { random?: () => number } = {},
): CreatedSlide {
  const { slide } = slideFromLayout(deck, request.layoutId, options);
  if (request.name) slide.name = request.name;
  const layout = deck.layouts.find((l) => l.id === request.layoutId);

  const waiting = new Map<PlaceholderRole, RoleFill[]>();
  for (const [role, value] of Object.entries(request.content ?? {})) {
    if (value === undefined) continue;
    waiting.set(role as PlaceholderRole, isList(value) ? [...value] : [value]);
  }

  // The layout's objects come first, then the elements in the order of the placeholders they
  // came from; some placeholders give none.
  let next = layout?.objects?.length ?? 0;
  for (const placeholder of layout?.placeholders ?? []) {
    const element = slide.elements[next];
    if (element?.role !== placeholder.role) continue;
    next++;
    const values = waiting.get(placeholder.role);
    if (values?.[0] && fill(element, placeholder, values[0], deck)) values.shift();
  }

  const unplaced = [...waiting].filter(([, values]) => values.length > 0).map(([role]) => role);
  return { slide, unplaced };
}

/**
 * A new slide from a layout with content given placeholder by placeholder, in the layout's
 * order. This is how the sample of a template is built from layouts as they were drawn: by role
 * a list cannot say "nothing in the first card, a picture in the second". Content a placeholder
 * cannot hold is left out.
 */
export function fillLayout(
  deck: Deck,
  request: { layoutId: string; fills: readonly (RoleFill | undefined)[]; name?: string },
  options: { random?: () => number } = {},
): Slide {
  const { slide } = slideFromLayout(deck, request.layoutId, options);
  if (request.name) slide.name = request.name;
  const layout = deck.layouts.find((l) => l.id === request.layoutId);
  let next = layout?.objects?.length ?? 0;
  for (const [index, placeholder] of (layout?.placeholders ?? []).entries()) {
    const element = slide.elements[next];
    if (element?.role !== placeholder.role) continue;
    next++;
    const value = request.fills[index];
    if (value) fill(element, placeholder, value, deck);
  }
  return slide;
}
