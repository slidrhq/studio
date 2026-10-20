import { watchCues } from './cue';
import type { ChartHandle } from './engine';
import { chartGlyphs } from './option';
import type { ChartSpec } from './spec';

/**
 * A chart's node between the one who wants it drawn (the renderer, or the script of an exported
 * file) and the engine that draws it. It waits for what a chart needs before its first line: the
 * engine itself, and the fonts, because the library measures its text on a canvas, and a width
 * measured in a fallback font stays wrong after the real one arrives.
 *
 * This module does not import the engine: whoever shows a chart says how to get it. The renderer
 * imports it lazily, so a deck without a chart never loads the library.
 */
export interface ChartEngine {
  mountChart: (host: HTMLElement, spec: ChartSpec, live: boolean) => ChartHandle;
}

export interface ChartController {
  /** Draws this spec, in place of whatever the node shows. */
  draw: (spec: ChartSpec) => void;
  dispose: () => void;
}

/** A font that has not loaded by now is not going to: the chart is drawn without it. */
const FONT_TIMEOUT_MS = 3000;

/**
 * How soon after it was drawn a chart is drawn again for another size. A resize gives the chart a
 * new size every frame, and drawing it took some 5 ms a frame: between two drawings the picture
 * is stretched to the box (`ChartHandle.stretch`), and the size it ends at is drawn.
 */
const RESIZE_MS = 120;

/** The two specs draw the same chart but for its size. */
function onlyResized(a: ChartSpec, b: ChartSpec): boolean {
  if (a.w === b.w && a.h === b.h) return false;
  return JSON.stringify({ ...a, w: 0, h: 0 }) === JSON.stringify({ ...b, w: 0, h: 0 });
}

const pending = new Set<Promise<void>>();

/**
 * Resolves when every chart that was asked for has been drawn. `settle` waits for it, so a
 * capture, a thumbnail or a lint measurement never sees a chart's empty box.
 */
export async function chartsSettled(): Promise<void> {
  while (pending.size > 0) await Promise.all(pending);
}

/** Loads the faces a chart's text is drawn in, for exactly the signs it may show. */
async function loadFonts(doc: Document, spec: ChartSpec): Promise<void> {
  const fonts = doc.fonts as FontFaceSet | undefined;
  if (typeof fonts?.load !== 'function') return;
  const text = chartGlyphs(spec);
  const { font } = spec;
  const loads = [
    fonts.load(`400 ${font.size}px ${font.family}`, text),
    ...(spec.title
      ? [fonts.load(`${font.titleWeight} ${font.titleSize}px ${font.titleFamily}`, spec.title)]
      : []),
  ];
  await Promise.race([
    Promise.all(loads).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS)),
  ]);
}

/**
 * The signs a live chart may show that its picture does not: an invisible line of them, in the
 * chart's font. An export embeds only the glyphs it finds in the DOM (ADR-032), and a tooltip's
 * digits would otherwise fall back to another font.
 */
function glyphCarrier(host: HTMLElement, spec: ChartSpec): void {
  let carrier = host.querySelector<HTMLElement>(':scope > [data-slidr-chart-glyphs]');
  if (!carrier) {
    carrier = host.ownerDocument.createElement('span');
    carrier.setAttribute('data-slidr-chart-glyphs', '');
    carrier.setAttribute('aria-hidden', 'true');
    host.prepend(carrier);
  }
  carrier.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;font:400 ${spec.font.size}px ${spec.font.family};`;
  carrier.textContent = chartGlyphs(spec);
}

export function chartController(
  host: HTMLElement,
  live: boolean,
  loadEngine: () => Promise<ChartEngine>,
): ChartController {
  const stopWatching = watchCues(host);
  let handle: ChartHandle | undefined;
  let wanted: ChartSpec | undefined;
  /** The spec the picture shows, and when it was drawn. */
  let drawn: ChartSpec | undefined;
  let drawnAt = 0;
  let working = false;
  let disposed = false;

  /** Draws the latest spec, and again if another came while it was getting ready. */
  async function work(): Promise<void> {
    try {
      let engine: ChartEngine | undefined;
      while (!disposed && wanted && wanted !== drawn) {
        const spec = wanted;
        const wait = drawnAt + RESIZE_MS - performance.now();
        if (handle?.stretch && drawn && wait > 0 && onlyResized(drawn, spec)) {
          handle.stretch(spec);
          // Then the size it has by then; `settle` waits for that drawing too.
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        const [loaded] = await Promise.all([
          engine ?? loadEngine(),
          loadFonts(host.ownerDocument, spec),
        ]);
        engine = loaded;
        if (disposed || wanted !== spec) continue;
        if (handle) handle.update(spec);
        else {
          // The picture an export wrote into the file gives way to the live chart.
          host.querySelector(':scope > [data-slidr-chart-box]')?.remove();
          handle = engine.mountChart(host, spec, live);
        }
        glyphCarrier(host, spec);
        delete host.dataset.slidrChartError;
        drawn = spec;
        drawnAt = performance.now();
      }
    } catch (error) {
      // A chart that cannot be drawn leaves its box empty; the slide around it is still shown.
      host.dataset.slidrChartError = error instanceof Error ? error.message : String(error);
      console.warn('A chart could not be drawn', error);
    } finally {
      working = false;
    }
  }

  return {
    draw(spec) {
      wanted = spec;
      if (disposed) return;
      // A frame of a resize while the chart waits to be drawn: the picture follows the box.
      if (working && handle?.stretch && drawn && onlyResized(drawn, spec)) handle.stretch(spec);
      if (working) return;
      working = true;
      const job = work();
      pending.add(job);
      void job.finally(() => pending.delete(job));
    },
    dispose() {
      disposed = true;
      stopWatching();
      handle?.dispose();
      handle = undefined;
    },
  };
}
