import type { ChartElement, Color, Direction, Theme } from '@slidr/model';
import { fontStack } from '../theme';

/**
 * A chart as everything needed to draw it and nothing else (WG6-T05): the data and the options of
 * the element, with the theme resolved to literal colours and font families. The chart engine
 * draws from it, in the editor and in an exported file alike. An export writes it on the chart's
 * node as JSON, since the file does not carry the model (SPEC 12), so it holds plain data only.
 */
export interface ChartSpec {
  type: ChartElement['chartType'];
  /** The chart's box in slide pixels: a chart is drawn at this size, whatever scale it is shown at. */
  w: number;
  h: number;
  /** The direction and language of the deck: where the axes start, how numbers are written. */
  dir: Direction;
  lang: string;
  categories: string[];
  series: ChartSeriesSpec[];
  /** One colour per series; for a pie or a donut, per category. */
  palette: string[];
  title?: string;
  legend: ChartElement['options']['legend'];
  /** `x` is the axis of the categories, `y` the axis of the values, whichever way the chart lies. */
  axes: ChartElement['options']['axes'];
  labels: boolean;
  colors: {
    /** The title, and the text of a tooltip. */
    text: string;
    /** Axis labels, the legend, value labels. */
    muted: string;
    /** Axis lines. */
    line: string;
    /** Grid lines. */
    grid: string;
    /** The ground of a tooltip, and the gap between the slices of a pie. */
    surface: string;
    bg: string;
  };
  font: {
    family: string;
    size: number;
    titleFamily: string;
    titleSize: number;
    titleWeight: number;
  };
  /** The theme's corner radius, in slide pixels: how round a chart's own corners may be. */
  radius: number;
}

export interface ChartSeriesSpec {
  name: string;
  values: (number | null)[];
  points?: { x: number; y: number }[];
  /** The series' own colour, over the palette. */
  color?: string;
}

/** `#rgb`, `#rrggbb` and `rgb(r, g, b)` as numbers; other syntaxes are left to the browser. */
function channels(css: string): [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim())?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(css.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

/**
 * A colour at an opacity, as a literal. An SVG attribute does not resolve `var()`, so a chart
 * cannot follow the theme's variables as other elements do: its colours are written out, and the
 * chart is drawn again when the theme changes.
 */
export function fade(css: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha >= 1) return css;
  if (alpha <= 0) return 'transparent';
  const rgb = channels(css);
  if (rgb) return `rgba(${rgb.join(', ')}, ${Math.round(alpha * 1000) / 1000})`;
  return `color-mix(in srgb, ${css} ${Math.round(alpha * 1000) / 10}%, transparent)`;
}

function literal(color: Color, theme: Theme): string {
  return fade('token' in color ? theme.colors[color.token] : color.value, color.alpha);
}

export interface ChartSpecContext {
  theme: Theme;
  dir: Direction;
  lang: string;
}

/** What of a chart element its picture depends on. */
export type ChartSource = Pick<ChartElement, 'chartType' | 'data' | 'options'> & {
  frame: { w: number; h: number };
  /**
   * The CSS `color` of the chart's box, when the element sets one (`css.color`). The chart's
   * text and lines take it in place of the theme's text colours: a chart on a slide whose
   * background is dark in a light theme is given a light colour this way.
   */
  ink?: string | undefined;
};

/** A colour written as one of the theme's variables, as the theme has it; any other as it is. */
function themed(css: string, theme: Theme): string {
  const name = /^var\(\s*--color-([a-z]+)(?:-([0-9]+))?\s*\)$/.exec(css.trim());
  if (!name) return css;
  const [, token, index] = name;
  if (token === 'chart') return theme.colors.chart[Number(index) - 1] ?? css;
  const value = (theme.colors as Record<string, unknown>)[token ?? ''];
  return typeof value === 'string' ? value : css;
}

/** The spec of a chart element under a theme (CHT-04: the theme's chart palette, or the chart's own). */
export function chartSpec(element: ChartSource, { theme, dir, lang }: ChartSpecContext): ChartSpec {
  const { options, data } = element;
  const { colors, textStyles, fonts } = theme;
  const palette = options.palette?.length
    ? options.palette.map((color) => literal(color, theme))
    : colors.chart;
  const ink = element.ink ? themed(element.ink, theme) : undefined;
  return {
    type: element.chartType,
    w: element.frame.w,
    h: element.frame.h,
    dir,
    lang,
    categories: data.categories,
    series: data.series.map((series) => ({
      name: series.name,
      values: series.values,
      ...(series.points ? { points: series.points } : {}),
      ...(series.color ? { color: literal(series.color, theme) } : {}),
    })),
    palette,
    ...(options.title ? { title: options.title } : {}),
    legend: options.legend,
    axes: options.axes,
    labels: options.labels,
    colors: {
      text: ink ?? colors.text,
      muted: ink ? fade(ink, 0.78) : colors.muted,
      line: fade(ink ?? colors.muted, 0.5),
      grid: fade(ink ?? colors.muted, 0.22),
      surface: colors.surface,
      bg: colors.bg,
    },
    font: {
      family: fontStack(fonts[textStyles.caption.font], lang),
      size: textStyles.caption.size,
      titleFamily: fontStack(fonts[textStyles.heading.font], lang),
      titleSize: textStyles.body.size,
      titleWeight: textStyles.heading.weight,
    },
    radius: theme.radius,
  };
}
