import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { settle } from './settle';
import { SlideRenderer, type SlideRendererProps } from './SlideRenderer';

export interface OffscreenSlide {
  /** The slide root: 1920x1080, unscaled, at the top-left corner of its container. */
  root: HTMLElement;
  /** The element the slide was mounted in. */
  container: HTMLElement;
  dispose(): void;
}

export interface OffscreenOptions {
  /** Where to mount. Default: a container of its own on `document.body`. */
  parent?: HTMLElement;
  /**
   * Laid out but not painted (the default), which is enough to measure. Pass `false` when the
   * pixels are needed; the container then sits at the top-left corner of the viewport.
   */
  hidden?: boolean;
}

/**
 * Renders a slide outside the editor and waits until it has settled, for code that measures the
 * rendered DOM of a deck state nobody is looking at: lint after an agent's write (LNT-02), the
 * HTML conversion comparing its result with the source (ADR-005). Call `dispose` when done.
 */
export async function renderSlideOffscreen(
  props: SlideRendererProps,
  { parent = document.body, hidden = true }: OffscreenOptions = {},
): Promise<OffscreenSlide> {
  const container = document.createElement('div');
  // Hidden, and transparent as well: a part of the slide that says `visibility: visible` (the
  // markup of an `html` element, the paths of a picture) is drawn under a hidden parent, and
  // would show over the window for as long as the slide is measured. Nothing in the slide
  // undoes the opacity of what it is in.
  container.style.cssText =
    'position:fixed;left:0;top:0;width:1920px;height:1080px;overflow:hidden;contain:strict;' +
    `pointer-events:none;${hidden ? 'visibility:hidden;opacity:0;' : ''}`;
  parent.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<SlideRenderer {...props} />));
  const dispose = () => {
    reactRoot.unmount();
    container.remove();
  };
  const root = container.querySelector<HTMLElement>('[data-slide-id]');
  if (!root) {
    dispose();
    throw new Error('The slide did not render.');
  }
  await settle(container.ownerDocument);
  return { root, container, dispose };
}
