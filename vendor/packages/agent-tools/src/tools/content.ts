import {
  AnimationStep,
  cellText,
  ChartElement,
  ChartType,
  Color,
  createElement,
  deleteCols,
  deleteRows,
  Frame,
  insertCols,
  insertRows,
  Marks,
  newId,
  plainText,
  RichText,
  tableFromGrid,
  tableSizes,
  TextStyleRef,
  Transition,
  type Command,
  type Deck,
  type Paragraph,
  type TableCell,
  type TableElement,
  type TablePatch,
} from '@slidr/model';
// The names only: the runtime itself is browser code, and this package compiles without the DOM.
import { animationPresets, transitionTypes } from '@slidr/runtime/names';
import { z } from 'zod';
import { getElement, getSlide } from '../lookup';
import { markdownToRichText } from '../markdown';
import { replaceInText } from '../textReplace';
import { DeckApiError, defineTool } from '../tool';
import { about, freshElementId } from './shared';

const Id = z.string().min(1);

const MARKDOWN_HELP =
  'Markdown subset: one paragraph per line (blank lines only separate; end a line with \\ for a line break inside the paragraph); "- " bullets and "1. " numbered items, nested by indenting; **bold**, *italic*, ~~strike~~, ==highlight==, [text](url); \\ before a punctuation mark makes it literal. Nothing else: headings, quotes and code stay plain text.';

const DIR_HELP =
  'Direction of every paragraph. Default: each paragraph takes the deck direction, unless all its letters are of the other direction (an English line in a Hebrew deck).';

function textOptions(deck: Deck, previous: RichText | undefined, input: TextFormat) {
  return {
    deckDir: deck.meta.dir,
    previous,
    ...(input.dir ? { dir: input.dir } : {}),
    ...(input.style ? { styleRef: input.style } : {}),
    ...(input.align ? { align: input.align } : {}),
  };
}

interface TextFormat {
  dir?: Paragraph['dir'];
  style?: TextStyleRef;
  align?: Paragraph['align'];
}

export const textSet = defineTool({
  name: 'text_set',
  description: `Replaces the text of a text box, a shape, or one table cell, from Markdown or as RichText JSON. New paragraphs keep the formatting of the text they replace (style, alignment, spacing, colour), so restyling is rarely needed. ${MARKDOWN_HELP} Returns the ids changed.`,
  input: z.strictObject({
    elementId: Id,
    slideId: Id.optional(),
    markdown: z.string().optional().describe('The new text. Give this or richText.'),
    richText: about(RichText, 'The new text as RichText JSON, for full control.').optional(),
    cell: z
      .strictObject({ row: z.number().int().nonnegative(), col: z.number().int().nonnegative() })
      .optional()
      .describe('For a table: the cell, counted from 0.'),
    style: TextStyleRef.optional().describe(
      'Theme text style for every paragraph (Markdown only).',
    ),
    align: z
      .enum(['start', 'center', 'end', 'justify'])
      .optional()
      .describe('Alignment of every paragraph (Markdown only); start follows the direction.'),
    dir: z.enum(['rtl', 'ltr', 'auto']).optional().describe(`${DIR_HELP} Markdown only.`),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: true,
  run(input, ctx) {
    const { elementId, slideId, markdown, richText, cell } = input;
    if ((markdown === undefined) === (richText === undefined)) {
      throw new DeckApiError('invalid_input', 'Give exactly one of markdown and richText.');
    }
    const { slide, element } = getElement(ctx.deck, elementId, slideId);
    let previous: RichText | undefined;
    if (element.type === 'table') {
      if (!cell) throw new DeckApiError('invalid_input', 'A table needs `cell` to set text.');
      previous = element.cells[cell.row]?.[cell.col]?.content;
    } else if (element.type === 'text' || element.type === 'shape') {
      previous = element.content;
    } else {
      throw new DeckApiError(
        'invalid_state',
        `Element "${elementId}" is a ${element.type}, which holds no text.`,
      );
    }
    const content =
      richText ??
      markdownToRichText(markdown!, {
        ...textOptions(ctx.deck, previous, input),
        // A cell's text is aligned by the direction of its table, which `auto` leaves to it.
        ...(element.type === 'table' && !input.dir ? { dir: 'auto' as const } : {}),
        defaultAlign: element.type === 'shape' ? 'center' : 'start',
      });
    // A one-line text box that came from HTML is as wide as its glyphs and told not to wrap, so
    // that it looks exactly as written (ADR-005). Longer text would run out of it sideways, and
    // often off the slide: from here on the box wraps.
    const wraps =
      element.type === 'text' &&
      element.wrap === false &&
      plainText(content).length > plainText(element.content).length;
    ctx.write([
      { type: 'text.set', slideId: slide.id, elementId, content, ...(cell ? { cell } : {}) },
      ...(wraps
        ? [{ type: 'element.update' as const, slideId: slide.id, elementId, patch: { wrap: true } }]
        : []),
    ]);
    return {};
  },
});

export const textReplace = defineTool({
  name: 'text_replace',
  description:
    'Changes one stretch of the text of a text box, a shape or a table cell, and keeps the rest and its formatting as they are: how to change the text the user selected (`text_selection` in the context) or words inside a longer text. `find` is the stretch, within one paragraph; `occurrence` picks one of its appearances, from 1. `replace` takes the formatting of what it replaces (\\n breaks the line); `marks` restyles the stretch (bold: weight 700). Across paragraphs, use text_set. Returns the ids changed.',
  input: z.strictObject({
    elementId: Id,
    slideId: Id.optional(),
    cell: z
      .strictObject({ row: z.number().int().nonnegative(), col: z.number().int().nonnegative() })
      .optional()
      .describe('For a table: the cell, counted from 0.'),
    find: z.string().min(1),
    occurrence: z.number().int().min(1).optional().describe('Default 1.'),
    replace: z.string().optional(),
    marks: Marks.optional(),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: true,
  run(input, ctx) {
    const { elementId, slideId, cell, find, occurrence = 1, replace, marks } = input;
    if (replace === undefined && !marks) {
      throw new DeckApiError('invalid_input', 'Give `replace`, `marks` or both.');
    }
    const { slide, element } = getElement(ctx.deck, elementId, slideId);
    let content: RichText | undefined;
    if (element.type === 'table') {
      if (!cell) throw new DeckApiError('invalid_input', 'A table needs `cell` to change text.');
      content = element.cells[cell.row]?.[cell.col]?.content;
      if (!element.cells[cell.row]?.[cell.col]) {
        throw new DeckApiError('invalid_input', `The table has no cell ${cell.row}, ${cell.col}.`);
      }
    } else if (element.type === 'text' || element.type === 'shape') {
      content = element.content;
    } else {
      throw new DeckApiError(
        'invalid_state',
        `Element "${elementId}" is a ${element.type}, which holds no text.`,
      );
    }
    const outcome = replaceInText(content ?? { paragraphs: [] }, find, occurrence, {
      ...(replace !== undefined ? { replace } : {}),
      ...(marks ? { marks } : {}),
    });
    if (!outcome.ok) {
      throw new DeckApiError(
        'invalid_input',
        outcome.reason === 'paragraphs'
          ? '`find` runs from one paragraph into the next. Change each paragraph on its own, or rewrite the text with text_set.'
          : outcome.found === 0
            ? `"${find}" is not in the text of element "${elementId}"${cell ? ` (cell ${cell.row}, ${cell.col})` : ''}. Read it with element_get: the user may have changed it.`
            : `"${find}" appears ${outcome.found} time(s) in the text, so there is no appearance ${occurrence}.`,
      );
    }
    // Longer text in a one-line box from HTML would run out of it sideways (see text_set).
    const wraps =
      element.type === 'text' &&
      element.wrap === false &&
      plainText(outcome.content).length > plainText(element.content).length;
    ctx.write([
      {
        type: 'text.set',
        slideId: slide.id,
        elementId,
        content: outcome.content,
        ...(cell ? { cell } : {}),
      },
      ...(wraps
        ? [{ type: 'element.update' as const, slideId: slide.id, elementId, patch: { wrap: true } }]
        : []),
    ]);
    return {};
  },
});

const ChartSeries = ChartElement.shape.data.shape.series.element;
const ChartOptions = ChartElement.shape.options.shape;

/**
 * The table styles of the renderer (`tableStyle.ts`, ADR-033), by `style.styleId`. The renderer
 * owns them and this package compiles without it, so the ids are repeated here; a test in the
 * app, which has both, holds the two lists together.
 */
export const TABLE_STYLE_IDS = ['plain', 'grid', 'lines', 'soft', 'tint', 'boxed'] as const;

const STYLE_HELP =
  'The look of the table, in theme colours: plain (primary header, lines under the rows), grid (plain, with lines between the columns and around the table), lines (bold header over a heavy line, no fills), soft (surface header with primary text, no lines), tint (secondary header, tinted bands), boxed (surface header, a heavy outline). Default: plain. A cell written with its own fill or borders keeps them over the style.';

/** A cell's text from Markdown. Every paragraph is `auto`: its alignment follows the table. */
function cellContent(markdown: string, deck: Deck, previous: RichText | undefined): RichText {
  const content = markdownToRichText(markdown, { deckDir: deck.meta.dir, previous, dir: 'auto' });
  // A cell with no text keeps one empty paragraph, so that its row keeps a line of height.
  return content.paragraphs.length > 0 ? content : cellText(previous, '');
}

const indicesFrom = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

export const tableSet = defineTool({
  name: 'table_set',
  description: `Sets the data and design of a table, or creates one when elementId is absent (then slideId, frame and cells are required). Cells are Markdown (the subset of text_set); a cell keeps the formatting of the text it replaces, and its text is aligned by the direction of the table. A new table gets columns as wide as their text asks. An existing table keeps its frame, its merged cells and the look of its rows when rows or columns are added (after the last) or removed (from the end). Returns \`elementId\` and the ids created or changed.`,
  input: z.strictObject({
    elementId: Id.optional().describe('The table to change. Absent: create a new table.'),
    slideId: Id.optional(),
    frame: about(Frame, 'For a new table: position and size in slide pixels.').optional(),
    cells: z
      .array(z.array(z.string()))
      .optional()
      .describe('Rows of cells, each cell in Markdown. All rows need the same length.'),
    colWidths: z.array(z.number().positive()).optional().describe('In slide pixels.'),
    rowHeights: z.array(z.number().positive()).optional().describe('In slide pixels.'),
    headerRow: z.boolean().optional(),
    bandedRows: z.boolean().optional(),
    firstColumn: z.boolean().optional(),
    styleId: z.enum(TABLE_STYLE_IDS).optional().describe(STYLE_HELP),
    dir: z
      .enum(['rtl', 'ltr'])
      .optional()
      .describe('Column order. Default for a new table: the deck direction.'),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: true,
  run(input, ctx) {
    const { deck } = ctx;
    const existing = input.elementId ? getElement(deck, input.elementId, input.slideId) : undefined;
    if (existing && existing.element.type !== 'table') {
      throw new DeckApiError('invalid_state', `Element "${input.elementId}" is not a table.`);
    }
    const table = existing?.element.type === 'table' ? existing.element : undefined;
    if (!table && (!input.slideId || !input.frame || !input.cells)) {
      throw new DeckApiError(
        'invalid_input',
        'A new table needs slideId, frame and cells (or give the elementId of an existing table).',
      );
    }
    const slideId = existing?.slide.id ?? getSlide(deck, input.slideId!).id;
    const frame = table?.frame ?? input.frame!;

    const texts = input.cells;
    const rowCount = texts?.length ?? table!.rows.length;
    const colCount = texts?.[0]?.length ?? table!.cols.length;
    if (texts && (rowCount === 0 || colCount === 0 || texts.some((r) => r.length !== colCount))) {
      throw new DeckApiError(
        'invalid_input',
        'cells must be a non-empty grid: every row the same length.',
      );
    }
    for (const [what, given, count] of [
      ['colWidths', input.colWidths, colCount],
      ['rowHeights', input.rowHeights, rowCount],
    ] as const) {
      if (given && given.length !== count) {
        throw new DeckApiError(
          'invalid_input',
          `${what} has ${given.length} entries for ${count}.`,
        );
      }
    }

    // The table the texts go into: the old one brought to the new grid by the editor's own
    // operations, which keep merged cells and give new rows the look of the last one, or a new
    // one with columns sized by their text.
    let grid: TableElement;
    if (table) {
      grid = table;
      const apply = (patch: TablePatch | undefined) => {
        if (patch) grid = { ...grid, ...patch };
      };
      const { length: oldRows } = table.rows;
      const { length: oldCols } = table.cols;
      if (rowCount > oldRows) apply(insertRows(grid, oldRows, rowCount - oldRows, oldRows - 1));
      if (rowCount < oldRows) apply(deleteRows(grid, indicesFrom(rowCount, oldRows)));
      if (colCount > oldCols) apply(insertCols(grid, oldCols, colCount - oldCols, oldCols - 1));
      if (colCount < oldCols) apply(deleteCols(grid, indicesFrom(colCount, oldCols)));
    } else {
      grid = tableFromGrid(texts!, { frame, dir: input.dir ?? deck.meta.dir });
    }

    const cells = grid.cells.map((row, r) =>
      row.map((cell, c): TableCell => {
        const text = texts?.[r]?.[c];
        // A cell under another's span is not drawn: it holds nothing.
        if (text === undefined || cell.merged) return cell;
        return { ...cell, content: cellContent(text, deck, table ? cell.content : undefined) };
      }),
    );

    // The table keeps its frame, and its rows and columns share it in the proportions they
    // have, unless the sizes themselves are given.
    const kept = tableSizes({ ...grid, frame });
    const cols = input.colWidths ?? kept.cols;
    const rows = input.rowHeights ?? kept.rows;
    const sum = (sizes: readonly number[]) => sizes.reduce((a, b) => a + b, 0);
    const fields = {
      frame: {
        ...frame,
        ...(input.colWidths ? { w: sum(cols) } : {}),
        ...(input.rowHeights ? { h: sum(rows) } : {}),
      },
      rows,
      cols,
      cells,
      style: {
        ...grid.style,
        ...(input.headerRow !== undefined ? { headerRow: input.headerRow } : {}),
        ...(input.bandedRows !== undefined ? { bandedRows: input.bandedRows } : {}),
        ...(input.firstColumn !== undefined ? { firstColumn: input.firstColumn } : {}),
        ...(input.styleId ? { styleId: input.styleId } : {}),
      },
      dir: input.dir ?? grid.dir,
    };
    if (table) {
      ctx.write([{ type: 'element.update', slideId, elementId: table.id, patch: fields }]);
      return { data: { elementId: table.id } };
    }
    const element = createElement.table({ ...fields, id: freshElementId(deck) });
    ctx.write([{ type: 'element.add', slideId, element }]);
    return { data: { elementId: element.id } };
  },
});

export const chartSet = defineTool({
  name: 'chart_set',
  description:
    'Sets the data and options of a chart, or creates one when elementId is absent (then slideId, frame, chartType, categories and series are required). The app draws the chart in the theme colours, mirrored in a right-to-left deck. Omitted fields keep their value, so a change of chartType keeps the data; options are merged key by key, and a key that is given is given whole. Each series has one value per category (null for a gap); a scatter series may give `points` instead, with `values: []`. A pie shows the first series; a donut shows each series as a ring. The text of a chart is in the theme text colours; on a slide with a dark background give the chart a light one with element_update, as `css: {"color": "#ffffff"}`. Returns `elementId` and the ids created or changed.',
  input: z.strictObject({
    elementId: Id.optional().describe('The chart to change. Absent: create a new chart.'),
    slideId: Id.optional(),
    frame: about(Frame, 'For a new chart: position and size in slide pixels.').optional(),
    chartType: ChartType.optional(),
    categories: z.array(z.string()).optional(),
    series: z.array(ChartSeries).optional(),
    title: z.string().nullable().optional().describe('null removes the title.'),
    legend: ChartOptions.legend.optional(),
    axes: about(
      ChartOptions.axes,
      'x is the axis of the categories and y the axis of the values, whichever way the chart lies; in a scatter chart, of the x and the y values. min and max apply to an axis of values.',
    ).optional(),
    labels: z.boolean().optional().describe('Show value labels on the data.'),
    palette: z
      .array(Color)
      .nullable()
      .optional()
      .describe('Series colours; null goes back to the theme chart palette.'),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: true,
  run(input, ctx) {
    const existing = input.elementId
      ? getElement(ctx.deck, input.elementId, input.slideId)
      : undefined;
    if (existing && existing.element.type !== 'chart') {
      throw new DeckApiError('invalid_state', `Element "${input.elementId}" is not a chart.`);
    }
    const chart = existing?.element.type === 'chart' ? existing.element : undefined;
    if (
      !chart &&
      (!input.slideId || !input.frame || !input.chartType || !input.categories || !input.series)
    ) {
      throw new DeckApiError(
        'invalid_input',
        'A new chart needs slideId, frame, chartType, categories and series (or the elementId of an existing chart).',
      );
    }
    const data = {
      categories: input.categories ?? chart!.data.categories,
      series: input.series ?? chart!.data.series,
    };
    for (const s of data.series) {
      if (!s.points && s.values.length !== data.categories.length) {
        throw new DeckApiError(
          'invalid_input',
          `Series "${s.name}" has ${s.values.length} values for ${data.categories.length} categories.`,
        );
      }
    }
    const chartType = input.chartType ?? chart!.chartType;
    const frame = chart?.frame ?? input.frame!;
    const options: Record<string, unknown> = {
      ...(chart?.options ?? createElement.chart({ frame, chartType, data }).options),
    };
    for (const key of ['title', 'legend', 'axes', 'labels', 'palette'] as const) {
      const value = input[key];
      if (value === null) delete options[key];
      else if (value !== undefined) options[key] = value;
    }
    if (chart) {
      ctx.write([
        {
          type: 'element.update',
          slideId: existing!.slide.id,
          elementId: chart.id,
          patch: { chartType, data, options },
        },
      ]);
      return { data: { elementId: chart.id } };
    }
    const slideId = getSlide(ctx.deck, input.slideId!).id;
    const element = {
      ...createElement.chart({ id: freshElementId(ctx.deck), frame, chartType, data }),
      options,
    } as ChartElement;
    ctx.write([{ type: 'element.add', slideId, element }]);
    return { data: { elementId: element.id } };
  },
});

const StepInput = AnimationStep.partial({
  id: true,
  trigger: true,
  category: true,
  duration: true,
  delay: true,
  easing: true,
});

const TransitionInput = Transition.partial({ duration: true, easing: true, advance: true });

const oneOf = (names: readonly string[]) => names.join(', ');

/**
 * The model keeps `preset` and `type` as free text, because the runtime owns the lists (ADR-020).
 * A name the runtime does not know would play as a plain fade, so it is refused here, with the
 * names that exist.
 */
function checkPreset(step: Pick<AnimationStep, 'category' | 'preset'>): void {
  if (step.category === 'motion') {
    throw new DeckApiError(
      'invalid_input',
      'Motion paths cannot be played yet: use category entrance, emphasis or exit.',
    );
  }
  const names = animationPresets[step.category];
  if (!names.includes(step.preset)) {
    throw new DeckApiError(
      'invalid_input',
      `Unknown ${step.category} preset "${step.preset}". Use one of: ${oneOf(names)}.`,
    );
  }
}

export function checkTransitionType(type: string): void {
  if (!transitionTypes.includes(type)) {
    throw new DeckApiError(
      'invalid_input',
      `Unknown transition type "${type}". Use one of: ${oneOf(transitionTypes)}.`,
    );
  }
}

export const animationSet = defineTool({
  name: 'animation_set',
  description:
    "Sets the animations of a slide: its timeline, in play order, and the transition into it. Give steps, transition, or both; what is not given stays. With elementIds, only the steps of those elements are replaced and the rest of the timeline stays (in an object session this is the default, for the session's elements). Step defaults: trigger onClick, category entrance, duration 500 ms, delay 0, easing ease-out, new id. Returns the ids changed.",
  input: z.strictObject({
    slideId: Id,
    steps: z
      .array(StepInput)
      .optional()
      .describe(
        `Each step animates one element of the slide; an empty list removes all animations. preset, by category: entrance ${oneOf(animationPresets.entrance)}; emphasis ${oneOf(animationPresets.emphasis)}; exit ${oneOf(animationPresets.exit)}. trigger: onClick, withPrevious or afterPrevious. direction is the way the element, or the edge of a wipe, travels: flyIn with up comes from below; start and end follow the reading direction of the slide. textBy paragraph brings a text in one paragraph per trigger; word and char stagger within one step.`,
      ),
    elementIds: z
      .array(Id)
      .optional()
      .describe(
        'Replace only the steps of these elements; the new steps go where their first old step was.',
      ),
    transition: TransitionInput.nullable()
      .optional()
      .describe(
        `How the slide comes in; null removes it. type: ${oneOf(transitionTypes)}. direction is the way the slides travel (default start, the way a deck reads forwards). Defaults: duration 600 ms, easing ease-in-out, advance { onClick: true }; advance.afterMs moves on by itself.`,
      ),
  }),
  scopes: ['deck', 'slide', 'object'],
  writes: true,
  run({ slideId, steps, elementIds, transition }, ctx) {
    const slide = getSlide(ctx.deck, slideId);
    if (!steps && transition === undefined) {
      throw new DeckApiError('invalid_input', 'Nothing to change: give steps, transition or both.');
    }
    const commands: Command[] = [];
    if (transition !== undefined) {
      if (transition) checkTransitionType(transition.type);
      const next = transition && {
        duration: 600,
        easing: 'ease-in-out',
        advance: { onClick: true },
        ...transition,
      };
      commands.push({ type: 'slide.update', slideId, patch: { transition: next } });
    }
    if (!steps) {
      ctx.write(commands);
      return { data: { stepIds: [] } };
    }
    const scope = ctx.turn.scope;
    const only = elementIds ?? (scope.kind === 'object' ? scope.elementIds : undefined);
    const taken = new Set(slide.timeline.map((s) => s.id));
    const fresh = steps.map((step) => {
      const id = step.id ?? newId('a', (candidate) => taken.has(candidate));
      taken.add(id);
      const whole = {
        trigger: 'onClick' as const,
        category: 'entrance' as const,
        duration: 500,
        delay: 0,
        easing: 'ease-out',
        ...step,
        id,
      };
      checkPreset(whole);
      return whole;
    });
    let timeline = fresh;
    if (only) {
      const replaced = new Set(only);
      const outside = fresh.find((step) => !replaced.has(step.elementId));
      if (outside) {
        throw new DeckApiError(
          'invalid_input',
          `Step for element "${outside.elementId}" is not among elementIds.`,
        );
      }
      const at = slide.timeline.findIndex((step) => replaced.has(step.elementId));
      const kept = slide.timeline.filter((step) => !replaced.has(step.elementId));
      // Every step before the first replaced one is kept, so `at` is also its place in `kept`.
      const insertAt = at < 0 ? kept.length : at;
      timeline = [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)];
    }
    commands.push({ type: 'slide.setTimeline', slideId, timeline });
    ctx.write(commands);
    return { data: { stepIds: fresh.map((s) => s.id) } };
  },
});
