import { plainText, walkElements, type Element, type Layout, type Slide } from '@slidr/model';
import { equalJson } from './json';

/*
 * The objects of a layout (`Layout.objects`) are copied onto each of its slides, where they are
 * elements like any other. A copy is named after its slide and its object (`layoutObjects`),
 * and that name is what makes it the layout's: it goes with the layout when the slide changes
 * layout or template, whatever was done to it.
 */

/** An element without its id, or the ids of what is inside it. */
function withoutIds(element: Element): unknown {
  const { id: _id, ...rest } = element;
  return rest.type === 'group' ? { ...rest, children: rest.children.map(withoutIds) } : rest;
}

/** Whether two elements draw the same: equal in everything but their ids. */
export function sameDrawing(a: Element, b: Element): boolean {
  return equalJson(withoutIds(a), withoutIds(b));
}

/** Whether two layouts put the same objects on their slides, in the same order. */
export function sameObjects(a: Layout, b: Layout): boolean {
  const left = a.objects ?? [];
  const right = b.objects ?? [];
  return left.length === right.length && left.every((object, i) => sameDrawing(object, right[i]!));
}

/** The words written in an element and in what it holds: in a text box, or in a shape. */
function words(element: Element): string {
  return [...walkElements([element])]
    .map((inside) =>
      inside.type === 'text' || (inside.type === 'shape' && inside.content)
        ? plainText(inside.content!)
        : '',
    )
    .join('\n');
}

/**
 * The elements of a slide that are copies of its layout's objects, each with the index of its
 * object. A copy is known by the name `layoutObjects` gave it, whatever the user did to it since:
 * moved, resized, recoloured or animated, it is still the template's drawing, and goes with the
 * template. One under another name (made before copies were named) is known by drawing exactly
 * as its object. A copy the user wrote in is not among them: what was typed is never taken away
 * by a change of layout or template. A duplicate the user made is under a new name, and is theirs.
 * Only the top level of the slide is looked at.
 */
export function layoutCopies(
  slide: Pick<Slide, 'id' | 'elements'>,
  layout: Layout | undefined,
): Map<string, number> {
  const found = new Map<string, number>();
  const objects = layout?.objects ?? [];
  const free = new Set(objects.keys());
  const take = (element: Element, index: number) => {
    if (words(element) !== words(objects[index]!)) return;
    free.delete(index);
    found.set(element.id, index);
  };
  // By name first: a duplicate that draws the same does not take the place of the copy.
  const named = new Map(objects.map((object, index) => [`${slide.id}_${object.id}`, index]));
  for (const element of slide.elements) {
    const index = named.get(element.id);
    if (index !== undefined && free.has(index)) take(element, index);
  }
  for (const element of slide.elements) {
    if (free.size === 0) break;
    if (found.has(element.id) || named.has(element.id)) continue;
    const index = [...free].find((i) => sameDrawing(element, objects[i]!));
    if (index !== undefined) take(element, index);
  }
  return found;
}

/**
 * The elements of a slide that are objects of its layout still as the layout put them there,
 * each with the index of its object: what a turn of the deck may replace by the drawing the
 * template made for the other direction. One the user moved, resized, recoloured, wrote in or
 * animated is not among them: it is the slide's own now, and stays when the slide changes
 * layout or template, as anything put there by hand does. Only the top level of the slide is
 * looked at.
 */
export function untouchedObjects(
  slide: Pick<Slide, 'elements' | 'timeline'>,
  layout: Layout | undefined,
): Map<string, number> {
  const found = new Map<string, number>();
  const objects = layout?.objects ?? [];
  const free = new Set(objects.keys());
  const animated = new Set(slide.timeline.map((step) => step.elementId));
  for (const element of slide.elements) {
    if (free.size === 0) break;
    if (animated.has(element.id)) continue;
    const index = [...free].find((i) => sameDrawing(element, objects[i]!));
    if (index === undefined) continue;
    free.delete(index);
    found.set(element.id, index);
  }
  return found;
}
