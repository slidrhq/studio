import { contentArea, describeBox, describeExcess, excess, fitsIn, slideArea } from '../geometry';
import type { Item, Rule } from '../rule';
import { describeFaint, faintest } from './contrast';
import { MIN_FONT_SIZE, px, smallestText, tooSmall } from './fontSize';

/**
 * What the lint sees inside a chart (ADR-048 left it blind there): the labels, the legend and
 * the titles a chart draws are text like any other, measured where they are drawn. Three rules
 * judge them under the numbers of the rules they extend, and all three are the user's: none
 * goes back to the agent after a write. A chart draws its own text, so the agent has little to
 * change in it, and a finding about contrast would hold its turn (QG-02).
 */
const charts = (items: readonly Item[]) => items.filter(({ element }) => element.type === 'chart');

/** A chart smaller than this has no room for its axes, its labels and its marks together. */
export const MIN_CHART = { w: 480, h: 300 };

/** L03 inside a chart: its labels reach into the safe margins. */
export const L03_CHART: Rule = {
  id: 'L03',
  severity: 'warning',
  agent: false,
  check({ deck, items }) {
    const slide = slideArea(deck);
    const safe = contentArea(deck);
    return charts(items).flatMap(({ element, measure }) => {
      const ink = measure.text?.ink;
      if (!ink || !fitsIn(ink, slide) || fitsIn(ink, safe)) return [];
      return [
        {
          elementIds: [element.id],
          message: `The text of the chart reaches ${describeExcess(excess(ink, safe))} of the safe area (its labels are at ${describeBox(ink)}; the safe area is ${describeBox(safe)}). Move the chart or make it smaller.`,
        },
      ];
    });
  },
};

/** L04 inside a chart: text under 24px, and a chart too small to hold what it draws. */
export const L04_CHART: Rule = {
  id: 'L04',
  severity: 'warning',
  agent: false,
  check({ items }) {
    return charts(items).flatMap((item) => {
      const { element, measure } = item;
      const problems = [];
      const smallest = smallestText(item);
      if (smallest !== undefined && tooSmall(smallest)) {
        problems.push({
          elementIds: [element.id],
          message: `The smallest text of the chart is drawn at ${px(smallest)}; the minimum readable size is ${MIN_FONT_SIZE}px. A chart takes its text size from the theme's caption style.`,
        });
      }
      const { w, h } = measure.box;
      if (w < MIN_CHART.w || h < MIN_CHART.h) {
        problems.push({
          elementIds: [element.id],
          message: `The chart is drawn at ${Math.round(w)}x${Math.round(h)}px. Under ${MIN_CHART.w}x${MIN_CHART.h} its axes, labels and marks crowd each other: give it more room, or show fewer categories.`,
        });
      }
      return problems;
    });
  },
};

/** L05 inside a chart: a label, a legend or a title that does not read on what is under it. */
export const L05_CHART: Rule = {
  id: 'L05',
  severity: 'error',
  agent: false,
  check({ items }) {
    return charts(items).flatMap((item) => {
      const worst = faintest(item);
      if (!worst) return [];
      return [
        {
          elementIds: [item.element.id],
          message: `${describeFaint(worst, 'Text of the chart')} A chart draws its text in the theme's text colours: put the chart on a ground they read on.`,
        },
      ];
    });
  },
};
