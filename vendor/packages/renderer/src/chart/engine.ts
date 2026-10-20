/**
 * The chart library, and the one place that calls it (CHT-06): ECharts with its SVG renderer,
 * reduced to the eight chart types of the model (CHT-01). The editor loads this module only when
 * a slide with a chart is first drawn (`controller.ts`); an exported file carries it, with the
 * library, only when the deck has a chart (`standalone.ts`, EXP-12).
 */
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
// Under its own name the library's `use` reads as React's hook to the lint rules.
import { init, use as register } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { lastCue, onCue, type ChartCue } from './cue';
import { BUILD_MS, chartOption, roughMeasure, type ChartMotion, type Measure } from './option';
import type { ChartSpec } from './spec';

register([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  GridComponent,
  RadarComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  SVGRenderer,
]);

export interface ChartHandle {
  /** Draws another spec in place of the one shown. */
  update: (spec: ChartSpec) => void;
  /**
   * Stretches the picture shown to the box of another size, until it is drawn at that size: a
   * frame of a resize, between two drawings of the chart.
   */
  stretch?: (size: { w: number; h: number }) => void;
  dispose: () => void;
}

/** A chart that waits for its step keeps its series at their first frame this long: for good. */
const HOLD_MS = 1e9;

let context: CanvasRenderingContext2D | null | undefined;

/** The width of text as the library itself measures it: on a canvas, in the font it is drawn in. */
const measure: Measure = (text, font) => {
  if (context === undefined) context = document.createElement('canvas').getContext('2d');
  if (!context) return roughMeasure(text, font);
  context.font = `${font.weight} ${font.size}px ${font.family}`;
  return context.measureText(text).width;
};

/**
 * Draws a chart into its node and keeps it drawn. The picture is in the DOM when this returns:
 * without animation the library renders within the call, which a capture relies on.
 *
 * The chart follows the cues the node is given (`cue.ts`): it waits with its series undrawn,
 * builds them on its step, or shows them whole. Without a cue it is drawn whole.
 */
export function mountChart(host: HTMLElement, spec: ChartSpec, live: boolean): ChartHandle {
  const box = host.ownerDocument.createElement('div');
  box.setAttribute('data-slidr-chart-box', '');
  host.append(box);
  const chart = init(box, null, { renderer: 'svg', width: spec.w, height: spec.h });
  let current = spec;
  /** What the picture shows now: the series not yet there, growing, or whole. */
  let shown: ChartCue['state'] = 'rest';

  const draw = (state: ChartCue['state'], build?: ChartMotion['build']) => {
    chart.off('finished');
    // A build starts from an empty plot: over a drawn chart the library would animate the change
    // from the old picture, which is no change at all.
    if (build || shown !== 'rest') chart.clear();
    shown = build ? state : 'rest';
    chart.setOption(chartOption(current, { live, build }, measure), {
      notMerge: true,
      lazyUpdate: false,
    });
    // Once built, the picture is the one a chart at rest has.
    if (state === 'play' && build) {
      chart.on('finished', () => {
        shown = 'rest';
      });
    }
  };

  const follow = (cue: ChartCue, elapsed: number) => {
    if (cue.state === 'wait') {
      if (shown !== 'wait') draw('wait', { delay: HOLD_MS, duration: BUILD_MS });
    } else if (cue.state === 'play') {
      // A cue heard before the library was loaded has used up part of its time.
      const left = cue.delay + cue.duration - elapsed;
      if (left > 0) {
        draw('play', {
          delay: Math.max(cue.delay - elapsed, 0),
          duration: Math.min(cue.duration, left),
        });
      } else if (shown !== 'rest') draw('rest');
    } else if (shown !== 'rest') draw('rest');
  };

  draw('rest');
  const last = lastCue(host);
  if (last) follow(last.cue, performance.now() - last.at);
  onCue(host, ({ cue }) => follow(cue, 0));

  return {
    update(next) {
      const resized = next.w !== current.w || next.h !== current.h;
      current = next;
      box.style.transform = '';
      if (resized) chart.resize({ width: next.w, height: next.h });
      if (shown === 'wait') draw('wait', { delay: HOLD_MS, duration: BUILD_MS });
      else draw('rest');
    },
    stretch({ w, h }) {
      if (current.w <= 0 || current.h <= 0) return;
      box.style.transformOrigin = '0 0';
      box.style.transform =
        w === current.w && h === current.h ? '' : `scale(${w / current.w}, ${h / current.h})`;
    },
    dispose() {
      chart.dispose();
      box.remove();
    },
  };
}
