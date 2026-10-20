/**
 * What every image request of a deck shares (GEN-05, AIO-10): the shape a frame asks for, the
 * deck's image style, and the placeholders that wait for a picture. Pure functions over the
 * model, used by the image tools here and by the app's own "generate" buttons, so that an image
 * the user asks for and one the agent asks for come out alike.
 */
import { walkElements, type Deck, type Element, type Slide } from '@slidr/model';
import type { ImageAspect } from './services';

const ASPECTS: readonly [ImageAspect, number][] = [
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['9:16', 9 / 16],
];

/** The shape an image provider is asked for, nearest to a frame's proportions. */
export function closestAspect(frame: { w: number; h: number }): ImageAspect {
  if (!(frame.w > 0 && frame.h > 0)) return '16:9';
  const wanted = Math.log(frame.w / frame.h);
  let best = ASPECTS[0]!;
  for (const candidate of ASPECTS) {
    if (Math.abs(Math.log(candidate[1]) - wanted) < Math.abs(Math.log(best[1]) - wanted)) {
      best = candidate;
    }
  }
  return best[0];
}

/** A colour as a prompt can name it: hex colours as they are, anything else left out. */
function hex(color: string): string | undefined {
  const value = color.trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value.toUpperCase() : undefined;
}

/**
 * A prompt as it is sent to an image provider (AIO-10): what the picture shows, then the deck's
 * image style (`meta.imageStyle`) and the theme's palette, so that the images of one deck belong
 * together whoever wrote the prompt. A prompt that already quotes the style is not given it
 * twice.
 */
export function styledPrompt(deck: Deck, prompt: string): string {
  const text = prompt.trim();
  const style = deck.meta.imageStyle?.trim();
  const { primary, secondary, accent, bg } = deck.theme.colors;
  const palette = [
    ['primary', primary],
    ['secondary', secondary],
    ['accent', accent],
    ['background', bg],
  ].flatMap(([name, color]) => {
    const value = hex(color ?? '');
    return value ? [`${name} ${value}`] : [];
  });
  const notes: string[] = [];
  if (style && !text.includes(style)) {
    notes.push(`Style, shared by every image of this presentation: ${style}`);
  }
  if (palette.length > 0) {
    notes.push(
      `The presentation's palette is ${palette.join(', ')}. Where the picture is free to choose its colours, choose ones that sit well with it.`,
    );
  }
  return notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text;
}

/** An image element that waits for its picture and says what it should show. */
export interface ImagePlaceholder {
  slideId: string;
  elementId: string;
  prompt: string;
  frame: { w: number; h: number };
}

const isWaiting = (element: Element): element is Extract<Element, { type: 'image' }> =>
  element.type === 'image' && !element.assetId && Boolean(element.prompt);

/** The placeholders of one slide that carry a prompt (`<img data-image-prompt>`), in z-order. */
export function slidePlaceholders(slide: Slide): ImagePlaceholder[] {
  return [...walkElements(slide.elements)].flatMap((element) =>
    isWaiting(element)
      ? [
          {
            slideId: slide.id,
            elementId: element.id,
            prompt: element.prompt ?? '',
            frame: { w: element.frame.w, h: element.frame.h },
          },
        ]
      : [],
  );
}

/** The placeholders of the given slides, or of the whole deck, that carry a prompt. */
export function imagePlaceholders(deck: Deck, slideIds?: readonly string[]): ImagePlaceholder[] {
  const wanted = slideIds ? new Set(slideIds) : undefined;
  return deck.slides.filter((slide) => !wanted || wanted.has(slide.id)).flatMap(slidePlaceholders);
}
