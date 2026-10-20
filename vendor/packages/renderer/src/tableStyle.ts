import type { Fill, Stroke, TableCell, TableElement } from '@slidr/model';
import type { TextDefaults } from './text';

/*
 * How a table looks where its cells say nothing (TBL-04). A table style is written in theme tokens
 * only, so it follows the theme, and it is picked by `style.styleId`; the three switches of the
 * model (`headerRow`, `bandedRows`, `firstColumn`) turn its parts on and off. A cell's own `fill`
 * and `borders` always win over the style.
 *
 * The functions here are the one answer to "what does this cell look like": the renderer draws by
 * them, the text editor takes a cell's text defaults from them so that nothing moves when editing
 * starts, and the table tools read the borders a cell shows before they change one of them.
 */

type Borders = NonNullable<TableCell['borders']>;

export interface TableStyle {
  id: string;
  /** The header row: its fill, and the colour (as CSS) and weight of its text. */
  header: { fill?: Fill; color?: string; weight?: number };
  /** Every second body row, when the table has banded rows. */
  band?: Fill;
  /** The first column, below the header row. */
  firstColumn?: { weight?: number };
  /**
   * The lines of the style: under every row, between the columns, around the table, and under
   * the header row. Around the table `outline` stands in for `rows` and `columns`.
   */
  lines: { rows?: Stroke; columns?: Stroke; outline?: Stroke; underHeader?: Stroke };
}

const solid = (token: 'primary' | 'secondary' | 'surface', alpha?: number): Fill => ({
  kind: 'solid',
  color: { token, ...(alpha === undefined ? {} : { alpha }) },
});

const RULE: Stroke = { color: { token: 'muted', alpha: 0.35 }, width: 1 };
const INK: Stroke = { color: { token: 'text' }, width: 2 };
const ON_FILL = { color: 'var(--color-bg)', weight: 600 };

/** The table styles, in the order they are offered. The first is what a table without a `styleId` gets. */
export const tableStyles: readonly TableStyle[] = [
  {
    id: 'plain',
    header: { fill: solid('primary'), ...ON_FILL },
    band: solid('surface'),
    firstColumn: { weight: 600 },
    lines: { rows: RULE },
  },
  {
    id: 'grid',
    header: { fill: solid('primary'), ...ON_FILL },
    band: solid('surface'),
    firstColumn: { weight: 600 },
    lines: { rows: RULE, columns: RULE, outline: RULE },
  },
  {
    id: 'lines',
    header: { weight: 700 },
    band: solid('surface'),
    firstColumn: { weight: 600 },
    lines: { rows: RULE, underHeader: { ...INK, width: 3 } },
  },
  {
    id: 'soft',
    header: { fill: solid('surface'), color: 'var(--color-primary)', weight: 700 },
    band: solid('surface', 0.5),
    firstColumn: { weight: 600 },
    lines: {},
  },
  {
    id: 'tint',
    header: { fill: solid('secondary'), ...ON_FILL },
    band: solid('secondary', 0.1),
    firstColumn: { weight: 600 },
    lines: { rows: { color: { token: 'secondary', alpha: 0.3 }, width: 1 } },
  },
  {
    id: 'boxed',
    header: { fill: solid('surface'), weight: 700 },
    band: solid('surface', 0.5),
    firstColumn: { weight: 600 },
    lines: { rows: RULE, columns: RULE, outline: INK, underHeader: INK },
  },
];

/** The style of an id; a table without one, or with one nobody knows, gets the first. */
export function tableStyle(id: string | undefined): TableStyle {
  return tableStyles.find((style) => style.id === id) ?? (tableStyles[0] as TableStyle);
}

/** Where a cell, with whatever it spans, sits in its table. */
interface Place {
  header: boolean;
  band: boolean;
  firstColumn: boolean;
  top: boolean;
  bottom: boolean;
  /** Screen sides: in a right-to-left table the first column is on the right. */
  left: boolean;
  right: boolean;
}

function placeOf(table: TableElement, row: number, col: number): Place {
  const cell = table.cells[row]?.[col];
  const lastRow = row + (cell?.rowSpan ?? 1) - 1;
  const lastCol = col + (cell?.colSpan ?? 1) - 1;
  const { headerRow, bandedRows, firstColumn } = table.style;
  const header = headerRow && row === 0;
  const start = col === 0;
  const end = lastCol >= table.cols.length - 1;
  return {
    header,
    band: bandedRows && !header && (row - (headerRow ? 1 : 0)) % 2 === 1,
    firstColumn: firstColumn && start && !header,
    top: row === 0,
    bottom: lastRow >= table.rows.length - 1,
    left: table.dir === 'rtl' ? end : start,
    right: table.dir === 'rtl' ? start : end,
  };
}

function styleBorders(style: TableStyle, place: Place): Borders {
  const { rows, columns, outline, underHeader } = style.lines;
  const borders: Borders = {};
  const set = (side: keyof Borders, stroke: Stroke | undefined) => {
    if (stroke) borders[side] = stroke;
  };
  set('top', place.top ? outline : undefined);
  set('bottom', place.bottom ? (outline ?? rows) : (place.header && underHeader) || rows);
  set('left', place.left ? outline : undefined);
  set('right', place.right ? outline : columns);
  return borders;
}

/** The padding of a cell that has none of its own, in slide pixels. */
export const CELL_PADDING = { top: 12, right: 20, bottom: 12, left: 20 } as const;

/** What a cell is drawn with: its own fill and borders, or else the style's. */
export interface CellLook {
  fill: Fill | undefined;
  /** Only the sides listed are drawn. */
  borders: Borders;
  /** Over the body text style; the marks of the text still win. */
  text: Pick<TextDefaults, 'color' | 'weight'>;
}

export function cellLook(table: TableElement, row: number, col: number): CellLook {
  const cell = table.cells[row]?.[col];
  const style = tableStyle(table.style.styleId);
  const place = placeOf(table, row, col);
  const text: CellLook['text'] = {};
  // A header cell with a fill of its own is not on the style's header fill: its text is plain.
  if (place.header && !cell?.fill) {
    if (style.header.color) text.color = style.header.color;
    if (style.header.weight) text.weight = style.header.weight;
  } else if (place.firstColumn && style.firstColumn?.weight) {
    text.weight = style.firstColumn.weight;
  }
  return {
    fill: cell?.fill ?? (place.header ? style.header.fill : place.band ? style.band : undefined),
    // An object of the cell's own, even an empty one, is the whole answer: no side falls back.
    borders: cell?.borders ?? styleBorders(style, place),
    text,
  };
}

/** The defaults of the text in a cell, for the renderer and for the editor that takes its place. */
export function cellTextDefaults(table: TableElement, row: number, col: number): TextDefaults {
  return { styleRef: 'body', wrap: true, alignTo: table.dir, ...cellLook(table, row, col).text };
}

const width = (stroke: Stroke | undefined) => (stroke && stroke.width > 0 ? stroke.width : 0);

/**
 * The widths of the borders on the four edges of the table: on each edge the widest border of the
 * cells along it, which is the one a collapsed table shows there and makes room for.
 */
export function tableEdges(table: TableElement): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const edges = { top: 0, right: 0, bottom: 0, left: 0 };
  table.cells.forEach((cells, row) =>
    cells.forEach((cell, col) => {
      if (cell.merged) return;
      const place = placeOf(table, row, col);
      if (!place.top && !place.bottom && !place.left && !place.right) return;
      const { borders } = cellLook(table, row, col);
      if (place.top) edges.top = Math.max(edges.top, width(borders.top));
      if (place.bottom) edges.bottom = Math.max(edges.bottom, width(borders.bottom));
      if (place.left) edges.left = Math.max(edges.left, width(borders.left));
      if (place.right) edges.right = Math.max(edges.right, width(borders.right));
    }),
  );
  return edges;
}

/**
 * The sizes the rows and the columns of a table are laid out with, in slide pixels.
 *
 * A row is as tall, and a column as wide, as its share of the frame: grid line `i` of the table is
 * the sum of the first `i` sizes, scaled to the frame. Borders are collapsed, so a line between two
 * cells is drawn centred on its grid line. On the edges of the table that would put half of the
 * border outside the frame; instead the whole border is inside, and the first and the last row and
 * column give up that half. So every inner line is exactly where the model says, and nothing is
 * drawn outside the frame.
 */
export function tableLayout(table: TableElement): { rows: number[]; cols: number[] } {
  const edges = tableEdges(table);
  const share = (sizes: readonly number[], total: number, before: number, after: number) => {
    const sum = sizes.reduce((a, b) => a + b, 0) || 1;
    return sizes.map((size, i) => {
      const lost = (i === 0 ? before : 0) + (i === sizes.length - 1 ? after : 0);
      return Math.max(0, (size * total) / sum - lost / 2);
    });
  };
  const [first, last] = table.dir === 'rtl' ? [edges.right, edges.left] : [edges.left, edges.right];
  return {
    rows: share(table.rows, table.frame.h, edges.top, edges.bottom),
    cols: share(table.cols, table.frame.w, first, last),
  };
}
