import type { ChartSeriesSpec, ChartSpec } from './spec';

/**
 * A chart spec as the option object of the chart library (WG6-T05, CHT-01, CHT-03). A pure
 * function: the same spec gives the same option in the editor, in the capture window and in an
 * exported file, which is what keeps the five pictures of one chart the same (RND-01).
 *
 * This module, `engine.ts` and `standalone.ts` are what an exported file carries, so they import
 * nothing of React and nothing of the model.
 */
export type ChartOption = Record<string, unknown>;

/** How a chart is drawn: still, or building up (CHT-07, CHT-08). */
export interface ChartMotion {
  /** Tooltips and highlights under the pointer: on in a show, off in the editor. */
  live: boolean;
  /** The series grow in, `delay` milliseconds from now and over `duration`. Absent: drawn whole. */
  build?: { delay: number; duration: number } | undefined;
}

export interface TextFont {
  family: string;
  size: number;
  weight: number;
}

/** The width of a line of text in slide pixels. */
export type Measure = (text: string, font: TextFont) => number;

/** A stand-in where nothing can measure (unit tests): the average glyph is half an em wide. */
export const roughMeasure: Measure = (text, font) => text.length * font.size * 0.52;

// The invisible direction marks, by code point so that they can be seen in the source.
const RLI = String.fromCodePoint(0x2067);
const PDI = String.fromCodePoint(0x2069);
const RLM = String.fromCodePoint(0x200f);
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;

/** Whether the first letter of a text is a right-to-left one: the rule of `dir="auto"`. */
function startsRtl(text: string): boolean {
  for (const char of text) {
    if (char === RLM) return true;
    if (LETTER.test(char)) return RTL_LETTER.test(char);
  }
  return false;
}

/**
 * A label as the chart draws it. The chart is laid out left to right whatever the deck's
 * direction, because the library places text by its left and right ends; a label that starts
 * with a right-to-left letter is isolated as right-to-left text, so that Hebrew for "Sales Q1"
 * keeps its reading order and a closing bracket stays at its end. Numbers are left as they are,
 * and read from left to right (SPEC 5.4).
 */
export function label(text: string): string {
  return startsRtl(text) ? `${RLI}${text}${PDI}` : text;
}

/** Numbers as the deck's language writes them, with at most two decimals. */
export function numberFormat(lang: string): (value: number) => string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  } catch {
    format = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  }
  return (value) => format.format(value);
}

/**
 * Every sign a chart may come to show: its texts, and whatever a number can be written with. A
 * tooltip shows values no label has, so an export that cuts fonts down to the signs in use
 * (ADR-032) has to be told of the digits too.
 */
export function chartGlyphs(spec: ChartSpec): string {
  const format = numberFormat(spec.lang);
  const digits = Array.from({ length: 10 }, (_, d) => format(d)).join('');
  const texts = [
    spec.title ?? '',
    spec.axes.x.title ?? '',
    spec.axes.y.title ?? '',
    ...spec.categories,
    ...spec.series.map((series) => series.name),
  ];
  return `${texts.join('')}${digits}${format(-1234567.5)}%:() `;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The next round number at or above a value: 1, 2, 2.5 or 5 times a power of ten. */
export function roundUp(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

const seriesColor = (spec: ChartSpec, series: ChartSeriesSpec, i: number): string =>
  series.color ?? spec.palette[i % spec.palette.length] ?? '#888888';

const sliceColor = (spec: ChartSpec, i: number): string =>
  spec.palette[i % spec.palette.length] ?? '#888888';

const isRound = (spec: ChartSpec) => spec.type === 'pie' || spec.type === 'donut';

/** The roundest the corners of a bar get, in slide pixels, however round the theme is. */
const BAR_RADIUS = 3;

/** The points of a scatter series: its own, or its values over the categories read as numbers. */
function scatterPoints(spec: ChartSpec, series: ChartSeriesSpec): [number, number][] {
  if (series.points?.length) return series.points.map((p) => [p.x, p.y]);
  const xs = spec.categories.map((category) => Number(category.replace(/[\s,]/g, '')));
  const numeric =
    xs.length > 0 && xs.every((x, i) => Number.isFinite(x) && spec.categories[i] !== '');
  const points: [number, number][] = [];
  series.values.forEach((y, i) => {
    if (y !== null) points.push([numeric ? (xs[i] as number) : i + 1, y]);
  });
  return points;
}

/** The names the legend lists: the series, or for a pie its slices. */
function legendNames(spec: ChartSpec): string[] {
  return isRound(spec) ? spec.categories : spec.series.map((series) => series.name);
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Layout {
  /** What is left for the plot, as insets from the chart's box. */
  plot: Box;
  title?: Record<string, unknown>;
  legend: Record<string, unknown>;
}

/**
 * Where the title, the legend and the plot go. The library does not keep them out of each
 * other's way, so the title and the legend are measured here and the plot gets what is left.
 */
function layout(spec: ChartSpec, measure: Measure): Layout {
  const { font, colors, w, h } = spec;
  const rtl = spec.dir === 'rtl';
  const pad = Math.round(font.size * 0.5);
  const gap = Math.round(font.size * 0.7);
  const plot: Box = { left: pad, top: pad, right: pad, bottom: pad };
  const out: Layout = { plot, legend: { show: false } };

  if (spec.title) {
    const titleHeight = Math.round(font.titleSize * 1.25);
    out.title = {
      text: label(spec.title),
      top: pad,
      // The title starts where the deck's text starts. With an alignment of its own the library
      // takes `left` as the point the text is aligned at: the right end of a right-aligned title.
      ...(rtl ? { left: w - pad, textAlign: 'right' } : { left: pad, textAlign: 'left' }),
      padding: 0,
      textStyle: {
        color: colors.text,
        fontFamily: font.titleFamily,
        fontSize: font.titleSize,
        fontWeight: font.titleWeight,
        lineHeight: titleHeight,
        width: Math.max(w - 2 * pad, 1),
        overflow: 'truncate',
      },
    };
    plot.top += titleHeight + gap;
  }

  const names = legendNames(spec);
  if (spec.legend.show && names.length > 0) {
    const icon = Math.round(font.size * 0.72);
    const itemGap = Math.round(font.size * 1.1);
    const lineHeight = Math.round(font.size * 1.4);
    const textFont = { family: font.family, size: font.size, weight: 400 };
    // The library leaves five pixels between the mark and its text.
    const widths = names.map((name) => icon + 5 + measure(label(name), textFont));
    const { position } = spec.legend;
    const horizontal = position === 'top' || position === 'bottom';
    const common = {
      show: true,
      type: 'plain',
      icon: 'roundRect',
      itemWidth: icon,
      itemHeight: icon,
      itemGap,
      padding: 0,
      // In a right-to-left deck the mark sits to the right of its text.
      align: rtl ? 'right' : 'left',
      // A click on the slide moves the show on; it must not hide a series as well.
      selectedMode: false,
      textStyle: {
        color: colors.muted,
        fontFamily: font.family,
        fontSize: font.size,
        lineHeight,
      },
    };
    if (horizontal) {
      const room = Math.max(w - 2 * pad, 1);
      let rows = 1;
      let line = 0;
      for (const width of widths) {
        if (line > 0 && line + itemGap + width > room) {
          rows++;
          line = width;
        } else line += (line > 0 ? itemGap : 0) + width;
      }
      const height = rows * lineHeight + (rows - 1) * (itemGap - (lineHeight - icon));
      out.legend = {
        ...common,
        orient: 'horizontal',
        // The first series is the one nearest the start of the line.
        data: (rtl ? [...names].reverse() : names).map(label),
        left: 'center',
        width: room,
        ...(position === 'top' ? { top: plot.top } : { bottom: pad }),
      };
      if (position === 'top') plot.top += height + gap;
      else plot.bottom += height + gap;
    } else {
      const widest = Math.ceil(Math.max(...widths));
      // A legend beside the plot takes no more than two fifths of the chart; longer names are cut.
      const width = Math.min(widest, Math.round(w * 0.4));
      // `start` is the side the deck's text starts on.
      const onLeft = (position === 'start') !== rtl;
      out.legend = {
        ...common,
        orient: 'vertical',
        data: names.map(label),
        top: Math.max(plot.top, Math.round((h - names.length * (icon + itemGap)) / 2)),
        ...(onLeft ? { left: pad } : { right: pad }),
        ...(width < widest
          ? {
              textStyle: {
                ...common.textStyle,
                width: Math.max(width - icon - 5, 1),
                overflow: 'truncate',
              },
            }
          : {}),
      };
      if (onLeft) plot.left += width + gap;
      else plot.right += width + gap;
    }
  }
  return out;
}

interface Built {
  parts: ChartOption;
  /** `axis`: the tooltip lists every series at a category. `item`: the one mark under the pointer. */
  tooltip: 'axis' | 'item';
}

function cartesian(spec: ChartSpec, plot: Box, live: boolean): Built {
  const { font, colors, axes } = spec;
  const rtl = spec.dir === 'rtl';
  const format = numberFormat(spec.lang);
  const lying = spec.type === 'bar';
  const scatter = spec.type === 'scatter';
  const text = { color: colors.muted, fontFamily: font.family, fontSize: font.size };
  const name = (title: string | undefined, show: boolean) =>
    title && show
      ? {
          name: label(title),
          nameLocation: 'middle',
          nameGap: font.size * 0.6,
          nameTextStyle: text,
        }
      : {};
  const line = (show: boolean) => ({ show, lineStyle: { color: colors.line, width: 2 } });
  const grid = (show: boolean) => ({ show, lineStyle: { color: colors.grid, width: 1.5 } });

  const valueAxis = (axis: ChartSpec['axes']['x'], gridByDefault: boolean) => ({
    type: 'value',
    ...(axis.min !== undefined ? { min: axis.min } : {}),
    ...(axis.max !== undefined ? { max: axis.max } : {}),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { ...text, show: axis.show, margin: font.size * 0.5, formatter: format },
    splitLine: grid(axis.gridLines ?? gridByDefault),
    ...name(axis.title, axis.show),
  });
  const categoryAxis = {
    type: 'category',
    data: spec.categories.map(label),
    axisLine: line(axes.x.show),
    axisTick: { show: false },
    axisLabel: {
      ...text,
      show: axes.x.show,
      margin: font.size * 0.5,
      interval: 0,
      hideOverlap: true,
    },
    splitLine: grid(axes.x.gridLines ?? false),
    ...name(axes.x.title, axes.x.show),
  };

  // In a right-to-left deck the categories run from the right and the values are read off the
  // right-hand side. A scatter chart is a plane of numbers, which reads left to right everywhere.
  const flip = rtl && !scatter;
  const side = flip ? 'right' : 'left';
  let xAxis: Record<string, unknown>;
  let yAxis: Record<string, unknown>;
  if (scatter) {
    xAxis = valueAxis(axes.x, true);
    yAxis = { ...valueAxis(axes.y, true), position: side };
  } else if (lying) {
    // The first category on top, as a list is read.
    yAxis = { ...categoryAxis, inverse: true, position: side };
    xAxis = { ...valueAxis(axes.y, true), inverse: flip };
  } else {
    xAxis = { ...categoryAxis, inverse: flip };
    yAxis = { ...valueAxis(axes.y, true), position: side };
  }

  const emphasis = live ? { focus: 'series' } : { disabled: true };
  const valueLabel = {
    show: spec.labels,
    position: lying ? 'outside' : 'top',
    distance: font.size * 0.25,
    color: colors.muted,
    fontFamily: font.family,
    fontSize: font.size,
    formatter: ({ value }: { value: unknown }) => {
      const y = Array.isArray(value) ? (value[1] as unknown) : value;
      return typeof y === 'number' ? format(y) : '';
    },
  };
  const series = spec.series.map((s, i) => {
    const color = seriesColor(spec, s, i);
    const base = { name: label(s.name), silent: !live, emphasis, label: valueLabel };
    const values = s.values.map((value) => value ?? '-');
    switch (spec.type) {
      case 'scatter':
        return {
          ...base,
          type: 'scatter',
          data: scatterPoints(spec, s),
          symbolSize: Math.round(font.size * 0.7),
          itemStyle: { color, opacity: 0.85 },
        };
      case 'line':
      case 'area':
        return {
          ...base,
          type: 'line',
          data: values,
          symbol: 'circle',
          symbolSize: Math.round(font.size * 0.5),
          lineStyle: { color, width: 4 },
          itemStyle: { color },
          ...(spec.type === 'area' ? { areaStyle: { color, opacity: 0.22 } } : {}),
        };
      default:
        return {
          ...base,
          type: 'bar',
          data: values,
          // A few columns in a wide chart are broad, not thin posts far apart.
          barMaxWidth: Math.round(Math.max(font.size * 5, (lying ? spec.h : spec.w) * 0.14)),
          barGap: '12%',
          barCategoryGap: '32%',
          // The corners of the theme, and no rounder than this: a bar is a narrow thing. In a
          // theme whose corners are square the bars are square too.
          itemStyle: { color, borderRadius: Math.min(BAR_RADIUS, spec.radius) },
        };
    }
  });

  return {
    tooltip: scatter ? 'item' : 'axis',
    parts: {
      grid: {
        ...plot,
        // Room for value labels over the tallest column, or past the longest bar.
        ...(spec.labels && !lying ? { top: plot.top + Math.round(font.size * 1.3) } : {}),
        ...(spec.labels && lying
          ? flip
            ? { left: plot.left + Math.round(font.size * 2.6) }
            : { right: plot.right + Math.round(font.size * 2.6) }
          : {}),
        // The axis labels and names stay inside the plot's share of the box.
        outerBoundsMode: 'same',
        outerBoundsContain: 'all',
      },
      xAxis,
      yAxis,
      series,
    },
  };
}

/**
 * The middle and the radius of what a plot box leaves for a round chart, in slide pixels, with
 * room beside it and above it for what is written around it.
 */
function circle(spec: ChartSpec, plot: Box, beside: number, above: number) {
  const width = Math.max(spec.w - plot.left - plot.right, 1);
  const height = Math.max(spec.h - plot.top - plot.bottom, 1);
  return {
    center: [plot.left + width / 2, plot.top + height / 2],
    radius: Math.max(Math.min(width / 2 - beside, height / 2 - above), 1),
  };
}

function round(spec: ChartSpec, plot: Box, live: boolean, measure: Measure): Built {
  const { font, colors } = spec;
  const format = numberFormat(spec.lang);
  const donut = spec.type === 'donut';
  // A pie shows one series. A donut shows each series as a ring, the first one innermost.
  const rings = donut ? spec.series : spec.series.slice(0, 1);
  const outerRing = rings[rings.length - 1];
  const share = (percent: number) => `${format(percent)}%`;
  // Beside the outer ring: the share of each slice, and its name when no legend names it.
  const named = (i: number, percent: number) =>
    label(`${spec.categories[i] ?? ''} ${share(percent)}`);
  const total = (outerRing?.values ?? []).reduce<number>((sum, v) => sum + Math.max(v ?? 0, 0), 0);
  const percents = spec.categories.map((_, i) =>
    total > 0 ? (Math.max(outerRing?.values[i] ?? 0, 0) / total) * 100 : 0,
  );
  const textFont = { family: font.family, size: font.size, weight: 400 };
  const widest = (text: (i: number, percent: number) => string) =>
    Math.max(0, ...percents.map((percent, i) => measure(text(i, Math.round(percent)), textFont)));
  const room = Math.max(spec.w - plot.left - plot.right, 1);
  // Names are written out only where they leave the circle most of the width.
  const withNames = !spec.legend.show && widest(named) < room * 0.22;
  const text = withNames ? named : (_: number, percent: number) => share(percent);
  const line = { length: font.size * 0.4, length2: font.size * 0.5 };
  const beside = spec.labels
    ? widest(text) + line.length + line.length2 + font.size * 0.6
    : font.size * 0.2;
  const { center, radius } = circle(
    spec,
    plot,
    beside,
    spec.labels ? font.size * 1.5 : font.size * 0.2,
  );
  const hole = donut ? radius * 0.56 : 0;
  const band = (radius - hole) / Math.max(rings.length, 1);
  const series = rings.map((ring, r) => {
    const outer = r === rings.length - 1;
    return {
      type: 'pie',
      name: label(ring.name),
      center,
      radius: [hole + band * r, hole + band * (r + 1)],
      startAngle: 90,
      clockwise: spec.dir !== 'rtl',
      silent: !live,
      avoidLabelOverlap: true,
      itemStyle: { borderColor: colors.bg, borderWidth: 2 },
      emphasis: live ? { scaleSize: 6 } : { disabled: true },
      label: {
        show: spec.labels && outer,
        position: 'outside',
        color: colors.muted,
        fontFamily: font.family,
        fontSize: font.size,
        // The room was measured for the whole label: it is never cut.
        overflow: 'none',
        formatter: ({ dataIndex, percent }: { dataIndex: number; percent?: number }) =>
          text(dataIndex, percent ?? 0),
      },
      labelLine: {
        show: spec.labels && outer,
        ...line,
        lineStyle: { color: colors.line, width: 1.5 },
      },
      data: spec.categories.map((category, i) => ({
        name: label(category),
        value: Math.max(ring.values[i] ?? 0, 0),
        itemStyle: { color: sliceColor(spec, i) },
      })),
    };
  });
  return { tooltip: 'item', parts: { series } };
}

function radar(spec: ChartSpec, plot: Box, live: boolean, measure: Measure): Built {
  const { font, colors, axes } = spec;
  const format = numberFormat(spec.lang);
  const values = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = axes.y.max ?? roundUp(Math.max(0, ...values));
  const min = axes.y.min ?? Math.min(0, ...values);
  const lineStyle = { color: colors.grid, width: 1.5 };
  return {
    tooltip: 'item',
    parts: {
      radar: {
        // The names of the spokes stand around the web: room for the widest beside it.
        ...circle(
          spec,
          plot,
          Math.max(
            0,
            ...spec.categories.map((category) =>
              measure(label(category), { family: font.family, size: font.size, weight: 400 }),
            ),
          ) +
            font.size * 0.8,
          font.size * 1.9,
        ),
        startAngle: 90,
        // The spokes are read in the direction of the deck.
        clockwise: spec.dir !== 'rtl',
        splitNumber: 4,
        indicator: spec.categories.map((category) => ({ name: label(category), max, min })),
        axisName: { color: colors.muted, fontFamily: font.family, fontSize: font.size },
        axisNameGap: font.size * 0.5,
        axisLine: { lineStyle },
        splitLine: { lineStyle },
        splitArea: { show: false },
        axisLabel: { show: false },
      },
      series: [
        {
          type: 'radar',
          silent: !live,
          symbol: 'circle',
          symbolSize: Math.round(font.size * 0.4),
          emphasis: live ? { focus: 'self' } : { disabled: true },
          data: spec.series.map((s, i) => {
            const color = seriesColor(spec, s, i);
            return {
              name: label(s.name),
              value: s.values.map((v) => v ?? 0),
              lineStyle: { color, width: 3 },
              itemStyle: { color },
              areaStyle: { color, opacity: 0.16 },
              label: {
                show: spec.labels,
                color: colors.muted,
                fontFamily: font.family,
                fontSize: font.size,
                formatter: ({ value }: { value: unknown }) =>
                  typeof value === 'number' ? format(value) : '',
              },
            };
          }),
        },
      ],
    },
  };
}

interface TooltipItem {
  name?: string;
  seriesName?: string;
  color?: unknown;
  value?: unknown;
  percent?: number;
}

/**
 * The text of a tooltip (CHT-07), as markup in the deck's direction: what the pointer is on, and
 * a line for each value under it. Every text is escaped; a number is kept left to right.
 */
function tooltipText(spec: ChartSpec, kind: Built['tooltip']) {
  const format = numberFormat(spec.lang);
  const number = (value: unknown) =>
    `<span dir="ltr" style="font-variant-numeric:tabular-nums">${
      typeof value === 'number' ? escapeHtml(format(value)) : '–'
    }</span>`;
  const row = (color: unknown, text: string, value: string) =>
    `<div style="display:flex;align-items:center;gap:0.5em">` +
    `<span style="flex:none;width:0.6em;height:0.6em;border-radius:50%;background:${
      typeof color === 'string' ? escapeHtml(color) : 'currentColor'
    }"></span>` +
    `<span style="flex:1;margin-inline-end:1em">${escapeHtml(text)}</span>${value}</div>`;
  const head = (text: string) => (text ? `<div style="opacity:0.7">${escapeHtml(text)}</div>` : '');

  return (params: TooltipItem | TooltipItem[]): string => {
    const items = Array.isArray(params) ? params : [params];
    const first = items[0];
    if (!first) return '';
    if (kind === 'axis') {
      return (
        head(first.name ?? '') +
        items.map((p) => row(p.color, p.seriesName ?? '', number(p.value))).join('')
      );
    }
    if (spec.type === 'radar') {
      const values = Array.isArray(first.value) ? (first.value as unknown[]) : [];
      return (
        head(first.name ?? '') +
        values.map((v, i) => row(first.color, spec.categories[i] ?? '', number(v))).join('')
      );
    }
    if (spec.type === 'scatter') {
      const [x, y] = Array.isArray(first.value) ? (first.value as unknown[]) : [];
      return row(first.color, first.seriesName ?? '', `${number(x)}<span>, </span>${number(y)}`);
    }
    // A slice: its value and its share.
    const share = `${number(first.value)}<span dir="ltr" style="opacity:0.7;margin-inline-start:0.6em">${escapeHtml(
      format(first.percent ?? 0),
    )}%</span>`;
    return (
      head(spec.series.length > 1 ? (first.seriesName ?? '') : '') +
      row(first.color, first.name ?? '', share)
    );
  };
}

/** How long a chart takes to build when nothing says otherwise, in milliseconds. */
export const BUILD_MS = 900;

export function chartOption(
  spec: ChartSpec,
  motion: ChartMotion,
  measure: Measure = roughMeasure,
): ChartOption {
  const { font, colors } = spec;
  const { plot, title, legend } = layout(spec, measure);
  const built =
    spec.type === 'radar'
      ? radar(spec, plot, motion.live, measure)
      : isRound(spec)
        ? round(spec, plot, motion.live, measure)
        : cartesian(spec, plot, motion.live);
  const bars = spec.type === 'column' || spec.type === 'bar';
  return {
    animation: Boolean(motion.build),
    animationDuration: motion.build?.duration ?? BUILD_MS,
    animationDelay: motion.build?.delay ?? 0,
    animationEasing: 'cubicOut',
    // A change of data in a show is drawn at once: only the build is animated.
    animationDurationUpdate: 0,
    textStyle: { fontFamily: font.family, fontSize: font.size, color: colors.muted },
    ...(title ? { title } : {}),
    legend,
    tooltip: motion.live
      ? {
          show: true,
          trigger: built.tooltip,
          confine: true,
          // The slide may be scaled: a tooltip that moves by itself would drift from the pointer.
          transitionDuration: 0,
          axisPointer: {
            type: bars ? 'shadow' : 'line',
            lineStyle: { color: colors.line, width: 2 },
            shadowStyle: { color: colors.grid },
          },
          backgroundColor: colors.surface,
          borderWidth: 0,
          padding: [Math.round(font.size * 0.45), Math.round(font.size * 0.7)],
          textStyle: { color: colors.text, fontFamily: font.family, fontSize: font.size },
          extraCssText: `direction:${spec.dir};text-align:start;border-radius:${Math.round(
            font.size * 0.4,
          )}px;box-shadow:0 6px 24px rgba(0,0,0,0.2);line-height:1.4;`,
          formatter: tooltipText(spec, built.tooltip),
        }
      : { show: false },
    ...built.parts,
  };
}
