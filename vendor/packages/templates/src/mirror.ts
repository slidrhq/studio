import {
  SLIDE_WIDTH,
  type Background,
  type Element,
  type Fill,
  type Frame,
  type Layout,
} from '@slidr/model';

/*
 * Mirroring for the other direction (THM-02): what is on the right goes to the left. Every
 * function here undoes itself, so mirroring twice gives back what there was.
 */

/**
 * Positions are kept on a grid of a thousandth of a pixel: a mirrored value is then exactly the
 * one that mirrors back, and an element that sat on its placeholder still does.
 */
function onGrid(value: number): number {
  // `+ 0` turns a negative zero into a plain one.
  return Math.round(value * 1000) / 1000 + 0;
}

const negate = (value: number) => (value === 0 ? 0 : -value);

export function mirrorFrame(frame: Frame, width: number = SLIDE_WIDTH): Frame {
  return { ...frame, x: onGrid(width - frame.x - frame.w) };
}

/**
 * What is drawn mirrored along with its box. Text stays readable and a picture stays itself, so
 * those only change sides; a logo is never flipped, whatever it is made of.
 */
const FLIPPED: ReadonlySet<Element['type']> = new Set(['shape', 'line', 'svg']);

const OTHER_SIDE: Partial<Record<string, 'start' | 'end'>> = { start: 'end', end: 'start' };

/**
 * An element as it looks from the other direction, inside a box `width` wide. A group keeps its
 * own box unflipped and mirrors its children inside it, so text in a group stays readable.
 */
export function mirrorElement(element: Element, width: number = SLIDE_WIDTH): Element {
  const out: Element = {
    ...element,
    frame: mirrorFrame(element.frame, width),
    // A mirror turns a rotation the other way (ADR-007: the flip is inside the box, under it).
    rotation: negate(element.rotation),
  };
  if (FLIPPED.has(element.type) && element.role !== 'logo') {
    if (element.flipH) delete out.flipH;
    else out.flipH = true;
  }
  // A shape is flipped with what it draws, its accent included; its text is not, so the room
  // around the text changes sides as a text box's does.
  if ((out.type === 'text' || out.type === 'shape') && out.padding) {
    out.padding = { ...out.padding, left: out.padding.right, right: out.padding.left };
  }
  if (out.type === 'text' && out.role === 'footer') {
    // The deck's footer (SLD-04) is seated like the text of a placeholder, on the side of its
    // box that the layout means. Its box changed sides, and the way it reads did not, so the
    // side is the other word now: without this a Hebrew footer of a deck that was turned
    // left-to-right hugs the far edge of its box.
    out.content = {
      paragraphs: out.content.paragraphs.map((paragraph) => ({
        ...paragraph,
        align: OTHER_SIDE[paragraph.align] ?? paragraph.align,
      })),
    };
  }
  if (out.type === 'group') {
    out.children = out.children.map((child) => mirrorElement(child, element.frame.w));
  }
  return out;
}

/**
 * A fill painted on a box nothing can flip (a background). Gradients change sides; a photo and
 * free CSS stay as they are.
 */
function mirrorFill(fill: Fill): Fill {
  switch (fill.kind) {
    case 'linear':
      return { ...fill, angle: negate(fill.angle) };
    case 'radial':
      return fill.center
        ? { ...fill, center: { ...fill.center, x: onGrid(1 - fill.center.x) } }
        : fill;
    case 'conic':
      // A mirrored sweep runs the other way round: the same stops, read from the end.
      return {
        ...fill,
        angle: negate(fill.angle),
        stops: fill.stops.map((stop) => ({ ...stop, at: onGrid(1 - stop.at) })).reverse(),
        ...(fill.center ? { center: { ...fill.center, x: onGrid(1 - fill.center.x) } } : {}),
      };
    default:
      return fill;
  }
}

export function mirrorBackground(background: Background): Background {
  return {
    ...background,
    fill: mirrorFill(background.fill),
    ...(background.overlay ? { overlay: mirrorFill(background.overlay) } : {}),
  };
}

/**
 * A layout for the other direction: placeholders, decorations and objects change sides, and so
 * do the gradients of its background. Alignment is `start` / `end` already, so it needs no change.
 */
export function mirrorLayout(layout: Layout): Layout {
  return {
    ...layout,
    ...(layout.background ? { background: mirrorBackground(layout.background) } : {}),
    placeholders: layout.placeholders.map((p) => ({ ...p, frame: mirrorFrame(p.frame) })),
    decorations: layout.decorations.map((d) => mirrorElement(d)),
    ...(layout.objects ? { objects: layout.objects.map((o) => mirrorElement(o)) } : {}),
  };
}
