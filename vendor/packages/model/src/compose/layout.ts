import { CommandError, type CommandOf } from '../commands';
import { createElement, richText } from '../factories';
import { newId } from '../ids';
import type { Deck, Element, Layout, PlaceholderRole } from '../schema';
import { cloneElement, takenIds } from './duplicate';
import { idSource } from './shared';

/** Placeholder roles that hold text. */
const TEXT_ROLES: ReadonlySet<PlaceholderRole> = new Set([
  'title',
  'subtitle',
  'body',
  'caption',
  'number',
  'quote',
  'attribution',
  'footer',
]);
/** Placeholder roles that hold a picture. */
const IMAGE_ROLES: ReadonlySet<PlaceholderRole> = new Set(['image', 'logo']);

/** Rows and columns of the table a table placeholder starts with. */
const TABLE_SIZE = 3;

/** `count` equal parts of a length; never zero, which a table does not accept. */
function equalParts(length: number, count: number): number[] {
  return Array.from({ length: count }, () => Math.max(length / count, 1));
}

export interface SlideFromLayoutOptions {
  /** Position of the new slide in the deck. Default: at the end. */
  index?: number;
  random?: () => number;
}

/**
 * The objects of a layout (`Layout.objects`) as elements of the slide `slideId`: copies, in the
 * layout's order. A copy, and everything inside a group, is named after the slide and its
 * object (`<slide>_<object>`), so what a slide gave back to its layout comes back under the
 * same ids when the slide returns to it: a deck switched to another template and back is the
 * deck it was. A name that is taken gives way to a new id. `taken` holds the ids in use in the
 * deck (`takenIds`), and every id handed out is added to it.
 */
export function layoutObjects(
  layout: Layout,
  slideId: string,
  taken: Set<string>,
  random?: () => number,
): Element[] {
  return (layout.objects ?? []).map((object) =>
    cloneElement(object, (id) => {
      const named = `${slideId}_${id}`;
      const given = taken.has(named) ? newId('e', (other) => taken.has(other), random) : named;
      taken.add(given);
      return given;
    }),
  );
}

/**
 * A `slide.add` with a new slide of a layout (SLD-01): first the layout's objects, the slide's
 * own copies (`layoutObjects`), then one empty element for each placeholder, in the order of
 * the placeholders: a text box carrying the role, text style, alignment and the colour the
 * placeholder gives its text, an image frame, a chart without data, or a table of empty cells
 * in the deck's direction. The decorations and the background stay with the layout, which the
 * slide points at, so the renderer draws them. A placeholder for the slide number gives nothing: no element shows
 * the number of its slide yet (SLD-04). Filling the elements with content by role, and layouts
 * for the other direction, are the layout engine's (`@slidr/templates`).
 */
export function slideFromLayout(
  deck: Deck,
  layoutId: string,
  options: SlideFromLayoutOptions = {},
): CommandOf<'slide.add'> {
  const layout = deck.layouts.find((l) => l.id === layoutId);
  if (!layout) throw new CommandError('not_found', `Layout "${layoutId}" does not exist.`);
  const taken = takenIds(deck);
  const fresh = idSource(taken, options.random);

  const elements: Element[] = [];
  for (const { role, frame, styleRef, color, align, vAlign } of layout.placeholders) {
    if (TEXT_ROLES.has(role)) {
      elements.push(
        createElement.text({
          id: fresh('e'),
          role,
          frame: { ...frame },
          vAlign: vAlign ?? 'top',
          ...(color ? { color: { ...color } } : {}),
          content: richText('', { align: align ?? 'start', styleRef }),
        }),
      );
    } else if (IMAGE_ROLES.has(role)) {
      elements.push(createElement.image({ id: fresh('e'), role, frame: { ...frame } }));
    } else if (role === 'chart') {
      elements.push(
        createElement.chart({
          id: fresh('e'),
          role,
          frame: { ...frame },
          chartType: 'column',
          data: { categories: [], series: [] },
        }),
      );
    } else if (role === 'table') {
      const rows = equalParts(frame.h, TABLE_SIZE);
      const cols = equalParts(frame.w, TABLE_SIZE);
      elements.push(
        createElement.table({
          id: fresh('e'),
          role,
          frame: { ...frame },
          rows,
          cols,
          dir: deck.meta.dir,
          cells: rows.map(() => cols.map(() => ({ content: richText('') }))),
        }),
      );
    }
  }
  const id = fresh('s');
  const objects = layoutObjects(layout, id, taken, options.random);
  return {
    type: 'slide.add',
    slide: { id, layoutId, elements: [...objects, ...elements], timeline: [] },
    ...(options.index === undefined ? {} : { index: options.index }),
  };
}
