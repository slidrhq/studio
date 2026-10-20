import {
  unionBounds,
  walkElements,
  type Background,
  type Element,
  type Frame,
  type HtmlElement,
  type ShapeElement,
} from '@slidr/model';
import { area, isOutside } from './geometry';
import type { Drawn, Item } from './rule';

/** A shape thinner than this is a rule or an accent bar, not a picture. */
const MIN_SHAPE_SIDE = 24;

/** A group of fewer marks than this is a rule and a bar side by side, not a drawing. */
const MIN_DRAWING_PARTS = 3;

function isDrawn(shape: ShapeElement): boolean {
  return (shape.fill.kind !== 'none' || (shape.stroke?.width ?? 0) > 0) && shape.opacity > 0;
}

/**
 * A shape that reads as a visual of its own (QG-04): it is drawn, neither side is a hairline,
 * and it is smaller than half the slide. That leaves out what a shape is when it is not content:
 * a divider or accent bar (thin), a background panel (half the slide or more), and an outline
 * with nothing to draw. Cards, diagram nodes, badges and arrows count. Sizes are the frame's,
 * so a rotated bar stays a bar.
 */
export function isMeaningfulShape(shape: ShapeElement, slide: Frame): boolean {
  const { w, h } = shape.frame;
  return isDrawn(shape) && Math.min(w, h) >= MIN_SHAPE_SIDE && w * h < area(slide) / 2;
}

/**
 * Whether free HTML draws something besides text. Its markup is all the model knows of it: a
 * picture, a drawing or a table by its tag, and a painted box (a card, a bar, a panel) by the
 * CSS that paints it. A slide the conversion kept whole as `html` is full of such boxes, and
 * calling it "only text" sent the agent to pile shapes on top of a slide it could not see into.
 */
export function htmlHasVisual(element: HtmlElement): boolean {
  return (
    element.hasScripts ||
    /<(img|svg|canvas|video|picture|table)\b/i.test(element.markup) ||
    /\b(background(-color|-image)?|box-shadow)\s*:/i.test(element.markup)
  );
}

/**
 * Whether a photograph is painted behind the slide. The conversion puts a full-bleed picture
 * over a slide that has a colour of its own into `overlay` (the colour is the fill), so both
 * are read.
 */
export function hasPhoto(background: Background): boolean {
  return background.fill.kind === 'image' || background.overlay?.kind === 'image';
}

/** Whether an element on the slide is a visual by itself: a picture, a chart, a card. */
function isVisual({ element, measure }: Item, slide: Frame): boolean {
  if (isOutside(measure.box, slide)) return false;
  switch (element.type) {
    case 'image':
    case 'svg':
    case 'chart':
    case 'table':
    case 'video':
      return true;
    case 'shape':
      return isMeaningfulShape(element, slide);
    case 'html':
      return htmlHasVisual(element);
    default:
      return false;
  }
}

/** Whether what is drawn holds a visual: an element that is one, or a drawing made of several. */
export function showsVisual({ items, drawings }: Drawn, slide: Frame): boolean {
  return (
    drawings.some((box) => !isOutside(box, slide)) || items.some((item) => isVisual(item, slide))
  );
}

/** A part of a drawing: a mark with no words in it. */
function isDrawingPart(element: Element): boolean {
  if (element.type === 'svg' || element.type === 'line') return true;
  if (element.type !== 'shape' || !isDrawn(element)) return false;
  return !element.content?.paragraphs.some((p) => p.runs.some((run) => run.text.trim() !== ''));
}

/**
 * The groups that read as one drawing, each as the box around its parts: three or more shapes,
 * lines or drawings grouped with nothing else. Each bar of a pattern, or of a chart drawn from
 * boxes, is an accent bar by itself; together they are the picture of the slide. `boxes` holds
 * where each element is, by id; what is absent from it (hidden, not rendered) is not drawn.
 */
export function drawingsIn(
  elements: readonly Element[],
  boxes: ReadonlyMap<string, Frame>,
): Frame[] {
  const found: Frame[] = [];
  for (const element of elements) {
    if (element.type !== 'group' || element.hidden) continue;
    const parts = [...walkElements(element.children)].filter(
      (child) => child.type !== 'group' && boxes.has(child.id),
    );
    if (parts.length >= MIN_DRAWING_PARTS && parts.every(isDrawingPart)) {
      found.push(unionBounds(parts.map((part) => boxes.get(part.id)!)));
    } else {
      // A drawing may sit inside a group that also holds its caption.
      found.push(...drawingsIn(element.children, boxes));
    }
  }
  return found;
}
