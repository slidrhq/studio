import { chartsSettled } from './chart/controller';

/**
 * Resolves once a rendered slide shows what it will show (RND-05): fonts loaded, images decoded,
 * frames loaded, charts drawn, and text re-measured after the last font. Whoever pictures or measures the
 * rendered DOM waits for it first: the capture page, the visual regression pages, lint and the
 * HTML conversion's comparison.
 */
export async function settle(doc: Document = document): Promise<void> {
  // Listen to frames first. A sandboxed frame's document cannot be read, so its `load` event is
  // the only signal, and one that fires while fonts and images are awaited would be missed and
  // cost the whole fallback.
  const frames = Array.from(doc.querySelectorAll('iframe')).map(
    (frame) =>
      new Promise<void>((resolve) => {
        if (frame.contentDocument?.readyState === 'complete') resolve();
        else frame.addEventListener('load', () => resolve(), { once: true });
        setTimeout(resolve, 2000);
      }),
  );
  // A chart is drawn by a library that is loaded when the first chart is shown, in fonts it
  // asks for itself: it is not there yet when React has rendered.
  await chartsSettled();
  await doc.fonts.ready;
  await Promise.all(
    images(doc).map((img) => (img.src ? img.decode().catch(() => undefined) : Promise.resolve())),
  );
  await Promise.all(frames);
  // Two frames: text measured after the last font load re-renders once more. A minimized or
  // hidden window gets no frames, so a timer stands in for them: lint after an agent's write
  // must not wait for the user to bring the window back.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    setTimeout(resolve, FRAMES_FALLBACK_MS);
  });
  await doc.fonts.ready;
  // A chart that was asked for in the meantime (a render after the first) is waited for as well.
  await chartsSettled();
}

const FRAMES_FALLBACK_MS = 250;

/** Every `<img>`, including those inside the open shadow roots of `html` elements (ADR-009). */
function images(root: Document | ShadowRoot): HTMLImageElement[] {
  const found = Array.from(root.querySelectorAll('img'));
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (element.shadowRoot) found.push(...images(element.shadowRoot));
  }
  return found;
}
