import type { ChartElement } from '@slidr/model';
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useRenderContext } from '../context';
import { Icon } from '../icons';
import { chartController, type ChartController } from './controller';
import { chartSpec } from './spec';

/** The engine and the chart library with it: a chunk of its own, loaded by the first chart. */
const loadEngine = () => import('./engine');

/**
 * Loads the chart library ahead of the first chart, for a host that is about to show slides with
 * charts and wants them drawn as the slides appear, not a moment after.
 */
export async function loadCharts(): Promise<void> {
  await loadEngine();
}

const FILL: CSSProperties = { position: 'absolute', inset: 0, margin: 0, padding: 0 };

/** Whether a chart has a value to show. A layout's chart placeholder has none until it is filled. */
function hasData({ series }: ChartElement['data']): boolean {
  return series.some((s) => Boolean(s.points?.length) || s.values.some((value) => value !== null));
}

/**
 * A chart that has nothing to show yet: a mark of its place, as an image that waits for its
 * picture has (see `RenderMode`). In a show it is not there at all. The chart library is not
 * loaded for it.
 */
function EmptyChart({ element: e }: { element: ChartElement }) {
  const { mode } = useRenderContext();
  if (mode === 'present') return null;
  const size = Math.min(e.frame.w, e.frame.h) * 0.25;
  return (
    <div
      data-slidr-placeholder="chart"
      style={{
        ...FILL,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        backgroundColor: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
        color: 'var(--color-muted)',
        fontFamily: 'var(--font-body)',
        fontSize: Math.max(14, Math.min(28, size / 3)),
      }}
    >
      {size >= 12 ? (
        <Icon name="chart" size={Math.min(size, 96)} style={{ color: 'var(--color-primary)' }} />
      ) : null}
      {e.options.title ? <span>{e.options.title}</span> : null}
    </div>
  );
}

/**
 * A chart with data. React draws only the node, with the chart's spec on it (`CHART_ATTRIBUTE`);
 * the picture inside is the chart library's, drawn by the engine once it has loaded
 * (`controller.ts`). `settle` waits for that, so whoever pictures the slide sees the chart.
 *
 * The node reads left to right whatever the deck's direction: the library places text by its
 * left and right ends, and in a right-to-left box SVG turns them around.
 */
function DrawnChart({ element: e }: { element: ChartElement }) {
  const { theme, dir, lang, mode } = useRenderContext();
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ChartController | null>(null);
  const live = mode === 'present';
  const { chartType, data, options } = e;
  const { w, h } = e.frame;
  const ink = e.css?.color;
  // The model keeps the identity of what a change did not touch (ADR-007): moving a chart draws
  // nothing again.
  const spec = useMemo(
    () => chartSpec({ chartType, data, options, frame: { w, h }, ink }, { theme, dir, lang }),
    [chartType, data, options, w, h, ink, theme, dir, lang],
  );
  const json = useMemo(() => JSON.stringify(spec), [spec]);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const made = chartController(node, live, loadEngine);
    controller.current = made;
    return () => {
      controller.current = null;
      made.dispose();
    };
  }, [live]);

  // After the effect above, and again whenever the chart is another picture.
  useLayoutEffect(() => {
    controller.current?.draw(spec);
  }, [spec, live]);

  return (
    <div
      ref={host}
      data-slidr-chart={json}
      role="img"
      aria-label={options.title ?? chartType}
      dir="ltr"
      style={{
        ...FILL,
        // In the editor the Stage owns the pointer; in a show it reaches the chart, for the tooltip.
        pointerEvents: live ? 'auto' : 'none',
      }}
    />
  );
}

/** A chart (WG6-T05): drawn from its data, or a mark of its place while it has none. */
export function ChartView({ element }: { element: ChartElement }) {
  return hasData(element.data) ? (
    <DrawnChart element={element} />
  ) : (
    <EmptyChart element={element} />
  );
}
