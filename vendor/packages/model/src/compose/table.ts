import { createElement, plainText } from '../factories';
import { frameCenter, normalizeAngle, rotateVector } from '../geometry';
import type {
  Direction,
  Frame,
  Marks,
  Paragraph,
  Point,
  RichText,
  Stroke,
  TableCell,
  TableElement,
} from '../schema';

/*
 * Table operations (TBL-01 to TBL-07). They are not commands (ADR-007): each one reads the table
 * as it is in the deck and gives the fields for ONE `element.update`, whose patch replaces whole
 * fields. So every operation is one undo step, with no code of its own in the history.
 *
 * Nothing here changes what it is given (the deck is frozen), and nothing parses with the schema:
 * resizing calls these on every pointer move.
 *
 * Rows and columns are logical: column 0 is the first in reading order, which an rtl table draws
 * at the right. Borders and paddings name physical sides.
 *
 * The stored sizes need not add up to the frame (the frame can be resized on its own, and the
 * renderer scales). An operation that changes sizes starts from the sizes as drawn and stores
 * them so that they do add up.
 *
 * An operation with nothing to change gives an empty patch (or undefined, where it says so), and
 * an empty patch makes no undo step.
 */

export interface CellRef {
  row: number;
  col: number;
}

/** A rectangle of cells, inclusive at both ends, in logical rows and columns. */
export interface CellRange {
  row0: number;
  col0: number;
  row1: number;
  col1: number;
}

/** The fields of a table that one `element.update` replaces. */
export type TablePatch = Partial<
  Pick<TableElement, 'frame' | 'rows' | 'cols' | 'cells' | 'dir' | 'style'>
>;

type Grid = readonly (readonly TableCell[])[];
type Side = 'top' | 'right' | 'bottom' | 'left';
type Borders = NonNullable<TableCell['borders']>;

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const round = (value: number): number => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// ---------------------------------------------------------------------------------------------
// Sizes

/** The least a drag leaves of a column's width and of a row's height, in slide px. */
export const MIN_COL = 24;
export const MIN_ROW = 16;

/** Sizes as they are drawn in a box of `total`: the renderer scales them to it. */
function drawn(sizes: readonly number[], total: number): number[] {
  const stored = sum(sizes);
  if (!(total > 0) || !(stored > 0) || Math.abs(stored - total) < 1e-9) return [...sizes];
  return sizes.map((size) => (size * total) / stored);
}

/**
 * Sizes to store for a box of `total`: in proportion, to 2 decimals, and the last one takes what
 * the rounding left, so that they add up to the box.
 */
function fitted(sizes: readonly number[], total: number): number[] {
  const out = drawn(sizes, total).map((size) => Math.max(round(size), 0.01));
  const rest = total - sum(out.slice(0, -1));
  if (rest > 0) out[out.length - 1] = rest;
  return out;
}

const emptyParagraph = (): Paragraph => ({ dir: 'auto', align: 'start', runs: [] });

/** A cell with no text: one empty paragraph, so that its row keeps a line of height. */
const emptyCell = (): TableCell => ({ content: { paragraphs: [emptyParagraph()] } });

/** A cell under another cell's span. It is not drawn, so it holds nothing. */
const coveredCell = (): TableCell => ({ content: { paragraphs: [] }, merged: true });

/**
 * A new table: `rows` x `cols` empty cells that fill `frame` evenly. Default style: headerRow
 * true, bandedRows false, firstColumn false.
 */
export function newTable(options: {
  rows: number;
  cols: number;
  frame: Frame;
  dir: Direction;
  id?: string;
  style?: Partial<TableElement['style']>;
}): TableElement {
  const rows = Math.max(1, Math.floor(options.rows));
  const cols = Math.max(1, Math.floor(options.cols));
  const { frame } = options;
  const even = (count: number, total: number) =>
    fitted(
      Array.from({ length: count }, () => 1),
      total,
    );
  return createElement.table({
    ...(options.id ? { id: options.id } : {}),
    frame: { ...frame },
    rows: even(rows, frame.h),
    cols: even(cols, frame.w),
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, emptyCell)),
    dir: options.dir,
    style: { headerRow: true, bandedRows: false, firstColumn: false, ...options.style },
  });
}

/** Row heights and column widths as drawn: scaled so they add up to the frame. */
export function tableSizes(table: TableElement): { rows: number[]; cols: number[] } {
  return { rows: drawn(table.rows, table.frame.h), cols: drawn(table.cols, table.frame.w) };
}

// ---------------------------------------------------------------------------------------------
// Cells and ranges

export function cellRange(a: CellRef, b: CellRef): CellRange {
  return {
    row0: Math.min(a.row, b.row),
    col0: Math.min(a.col, b.col),
    row1: Math.max(a.row, b.row),
    col1: Math.max(a.col, b.col),
  };
}

/** The whole table. */
export function fullRange(table: TableElement): CellRange {
  return { row0: 0, col0: 0, row1: table.rows.length - 1, col1: table.cols.length - 1 };
}

/** The part of a range that lies in the table. */
function clipped(table: TableElement, range: CellRange): CellRange {
  const lastRow = table.rows.length - 1;
  const lastCol = table.cols.length - 1;
  return {
    row0: clamp(Math.min(range.row0, range.row1), 0, lastRow),
    col0: clamp(Math.min(range.col0, range.col1), 0, lastCol),
    row1: clamp(Math.max(range.row0, range.row1), 0, lastRow),
    col1: clamp(Math.max(range.col0, range.col1), 0, lastCol),
  };
}

function anchorIn(cells: Grid, row: number, col: number): CellRef {
  if (cells[row]?.[col]?.merged) {
    for (let r = row; r >= 0; r--) {
      for (let c = col; c >= 0; c--) {
        const cell = cells[r]?.[c];
        if (!cell || cell.merged) continue;
        if (r + (cell.rowSpan ?? 1) > row && c + (cell.colSpan ?? 1) > col) {
          return { row: r, col: c };
        }
      }
    }
  }
  return { row, col };
}

/** The span of the cell at a position, kept inside the grid; a covered cell has none. */
function spanIn(cells: Grid, row: number, col: number): { rows: number; cols: number } {
  const cell = cells[row]?.[col];
  if (!cell || cell.merged) return { rows: 1, cols: 1 };
  return {
    rows: clamp(cell.rowSpan ?? 1, 1, cells.length - row),
    cols: clamp(cell.colSpan ?? 1, 1, (cells[row]?.length ?? 1) - col),
  };
}

/** The range grown until it cuts through no merged area. */
export function expandRange(table: TableElement, range: CellRange): CellRange {
  const { cells } = table;
  let { row0, col0, row1, col1 } = clipped(table, range);
  // Growing may bring in another merged area, so the range is walked again until it is stable.
  for (let grown = true; grown;) {
    grown = false;
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const cell = cells[row]?.[col];
        if (!cell || (!cell.merged && cell.rowSpan === undefined && cell.colSpan === undefined)) {
          continue;
        }
        const anchor = anchorIn(cells, row, col);
        const span = spanIn(cells, anchor.row, anchor.col);
        const endRow = anchor.row + span.rows - 1;
        const endCol = anchor.col + span.cols - 1;
        if (anchor.row < row0 || anchor.col < col0 || endRow > row1 || endCol > col1) {
          row0 = Math.min(row0, anchor.row);
          col0 = Math.min(col0, anchor.col);
          row1 = Math.max(row1, endRow);
          col1 = Math.max(col1, endCol);
          grown = true;
        }
      }
    }
  }
  return { row0, col0, row1, col1 };
}

/** The cell that draws at a position: itself, or the anchor of the merged area that covers it. */
export function anchorOf(table: TableElement, cell: CellRef): CellRef {
  return anchorIn(table.cells, cell.row, cell.col);
}

export function spanOf(table: TableElement, anchor: CellRef): { rows: number; cols: number } {
  return spanIn(table.cells, anchor.row, anchor.col);
}

/** The anchor cells (not `merged`) inside a range, in reading order (row by row, col ascending). */
export function rangeCells(table: TableElement, range: CellRange): CellRef[] {
  const { row0, col0, row1, col1 } = clipped(table, range);
  const out: CellRef[] = [];
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const cell = table.cells[row]?.[col];
      if (cell && !cell.merged) out.push({ row, col });
    }
  }
  return out;
}

/**
 * The next (step 1) or previous (step -1) anchor cell in reading order; undefined past the end.
 * This is what Tab does.
 */
export function nextCell(table: TableElement, cell: CellRef, step: 1 | -1): CellRef | undefined {
  const width = table.cols.length;
  const count = table.rows.length * width;
  for (let i = cell.row * width + cell.col + step; i >= 0 && i < count; i += step) {
    const row = Math.floor(i / width);
    const col = i % width;
    const at = table.cells[row]?.[col];
    if (at && !at.merged) return { row, col };
  }
  return undefined;
}

/**
 * The neighbouring anchor cell in a SCREEN direction (arrow keys): 'left' and 'right' follow
 * `table.dir` (in an rtl table 'left' is col+1). Skips over the cell's own span; undefined at the
 * edge.
 */
export function neighbourCell(
  table: TableElement,
  cell: CellRef,
  side: 'left' | 'right' | 'up' | 'down',
): CellRef | undefined {
  const anchor = anchorOf(table, cell);
  const span = spanOf(table, anchor);
  let { row, col } = cell;
  if (side === 'up') row = anchor.row - 1;
  else if (side === 'down') row = anchor.row + span.rows;
  else if ((side === 'right') === (table.dir === 'ltr')) col = anchor.col + span.cols;
  else col = anchor.col - 1;
  if (row < 0 || row >= table.rows.length || col < 0 || col >= table.cols.length) return undefined;
  return anchorOf(table, { row, col });
}

/**
 * The box of a cell (an anchor with its span) inside the table's frame, in slide px from the
 * frame's top-LEFT corner, as drawn. A covered cell gives the box of the area that covers it.
 */
export function cellBox(table: TableElement, cell: CellRef): Frame {
  const { rows, cols } = tableSizes(table);
  const anchor = anchorOf(table, cell);
  const span = spanOf(table, anchor);
  const before = sum(cols.slice(0, anchor.col));
  const w = sum(cols.slice(anchor.col, anchor.col + span.cols));
  return {
    x: table.dir === 'rtl' ? sum(cols) - before - w : before,
    y: sum(rows.slice(0, anchor.row)),
    w,
    h: sum(rows.slice(anchor.row, anchor.row + span.rows)),
  };
}

/** The index of the size that holds a position; the first or the last for a position outside. */
function indexAt(sizes: readonly number[], position: number): number {
  let end = 0;
  for (let i = 0; i < sizes.length - 1; i++) {
    end += sizes[i] ?? 0;
    if (position < end) return i;
  }
  return sizes.length - 1;
}

/**
 * The anchor cell under a point given in slide px from the frame's top-left corner; clamps to
 * the nearest cell when outside.
 */
export function cellAt(table: TableElement, point: Point): CellRef {
  const { rows, cols } = tableSizes(table);
  const along = table.dir === 'rtl' ? sum(cols) - point.x : point.x;
  return anchorOf(table, { row: indexAt(rows, point.y), col: indexAt(cols, along) });
}

// ---------------------------------------------------------------------------------------------
// Structure

/** A cell with a span of its own, or none: the old span and `merged` are dropped. */
function withSpan(cell: TableCell, rows: number, cols: number): TableCell {
  const { rowSpan: _rowSpan, colSpan: _colSpan, merged: _merged, ...rest } = cell;
  return {
    ...rest,
    ...(rows > 1 ? { rowSpan: rows } : {}),
    ...(cols > 1 ? { colSpan: cols } : {}),
  };
}

/** A new cell with the look of another: its fill, borders, alignment, padding and text formatting. */
function blankLike(cell: TableCell): TableCell {
  return {
    content: cellText(cell.content, ''),
    ...(cell.fill ? { fill: cell.fill } : {}),
    ...(cell.borders ? { borders: cell.borders } : {}),
    ...(cell.vAlign ? { vAlign: cell.vAlign } : {}),
    ...(cell.padding ? { padding: cell.padding } : {}),
  };
}

/**
 * The grid with rows and columns exchanged, and the spans with them: what is written for rows
 * then works on columns.
 */
function transposed(cells: Grid): TableCell[][] {
  const width = cells[0]?.length ?? 0;
  return Array.from({ length: width }, (_, col) => cells.map((row) => turned(row[col]!)));
}

function turned(cell: TableCell): TableCell {
  if (cell.rowSpan === undefined && cell.colSpan === undefined) return cell;
  const { rowSpan, colSpan, ...rest } = cell;
  return {
    ...rest,
    ...(colSpan === undefined ? {} : { rowSpan: colSpan }),
    ...(rowSpan === undefined ? {} : { colSpan: rowSpan }),
  };
}

/** The grid with `count` new rows before row `at`, which look like row `like`. */
function insertLines(cells: Grid, at: number, count: number, like: number): TableCell[][] {
  const grid = cells.map((row) => [...row]);
  const width = cells[0]?.length ?? 0;
  const lines: TableCell[][] = Array.from({ length: count }, () => []);
  for (let col = 0; col < width; col++) {
    // An area that begins above the line and reaches below it grows; the new cells are under it.
    const anchor = anchorIn(cells, at, col);
    const above = cells[anchor.row]?.[anchor.col];
    if (above && anchor.row < at) {
      if (anchor.col === col) {
        grid[anchor.row]![col] = { ...above, rowSpan: (above.rowSpan ?? 1) + count };
      }
      for (const line of lines) line.push(coveredCell());
      continue;
    }
    // A covered cell has no look of its own: the cell that draws there gives it.
    const from = anchorIn(cells, like, col);
    const model = cells[from.row]?.[from.col];
    for (const line of lines) line.push(model ? blankLike(model) : emptyCell());
  }
  grid.splice(at, 0, ...lines);
  return grid;
}

/** The grid without some rows. A merged area keeps the rows that stay. */
function deleteLines(cells: Grid, gone: ReadonlySet<number>): TableCell[][] {
  const grid = cells.map((row) => [...row]);
  cells.forEach((line, row) => {
    line.forEach((cell, col) => {
      const span = spanIn(cells, row, col);
      if (span.rows === 1) return;
      const staying: number[] = [];
      for (let r = row; r < row + span.rows; r++) if (!gone.has(r)) staying.push(r);
      const first = staying[0];
      if (first === undefined || staying.length === span.rows) return;
      // When the anchor's row goes, the first row that stays takes the cell over.
      grid[first]![col] = withSpan(cell, staying.length, span.cols);
    });
  });
  return grid.filter((_, row) => !gone.has(row));
}

/** Those of the given indexes that a list of `length` has, each once. */
function indexSet(indexes: readonly number[], length: number): Set<number> {
  return new Set(indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < length));
}

/**
 * The table's frame at a new size. The corner where the table starts (its top, and the side of
 * column 0) stays where it is on the slide; a mirrored table starts at the opposite side.
 */
function framed(table: TableElement, size: { w: number; h: number }): Frame {
  return resizedFrame(table.frame, table.rotation, size, {
    x: (table.dir === 'rtl') !== Boolean(table.flipH) ? 1 : 0,
    y: table.flipV ? 1 : 0,
  });
}

/**
 * A patch of new sizes, made whole. The sizes of the axis it leaves alone are added when those
 * are not stored as drawn (a table whose frame was resized on its own): after the patch both the
 * rows and the columns add up to the frame. Sizes that come out as they are stored are left out,
 * so an operation that changes nothing gives an empty patch, and no undo step.
 */
function settled(table: TableElement, patch: TablePatch): TablePatch {
  const { w, h } = patch.frame ?? table.frame;
  const asDrawn = (sizes: readonly number[], total: number) =>
    !(total > 0) || Math.abs(sum(sizes) - total) < 1e-6;
  const same = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((size, i) => size === b[i]);
  const rows = patch.rows ?? (asDrawn(table.rows, h) ? table.rows : fitted(table.rows, h));
  const cols = patch.cols ?? (asDrawn(table.cols, w) ? table.cols : fitted(table.cols, w));
  return {
    ...(patch.frame ? { frame: patch.frame } : {}),
    ...(same(rows, table.rows) ? {} : { rows }),
    ...(same(cols, table.cols) ? {} : { cols }),
  };
}

/** Rows of new drawn heights: the frame becomes as tall as they are together. */
function rowsPatch(table: TableElement, heights: readonly number[]): TablePatch {
  const h = round(sum(heights));
  return settled(table, {
    rows: fitted(heights, h),
    ...(h === table.frame.h ? {} : { frame: framed(table, { w: table.frame.w, h }) }),
  });
}

/** Columns of new drawn widths, in a table as wide as it is or of a new width `w`. */
function colsPatch(
  table: TableElement,
  widths: readonly number[],
  w: number = table.frame.w,
): TablePatch {
  return settled(table, {
    cols: fitted(widths, w),
    ...(w === table.frame.w ? {} : { frame: framed(table, { w, h: table.frame.h }) }),
  });
}

/**
 * Inserts `count` rows so that the first new row has index `at` (0..rows.length). New cells take
 * the look of row `like` (fill, borders, vAlign, padding, and the paragraph and first-run
 * formatting of its text, with no text). A merged area that spans across the insertion line
 * grows, and the new cells under it are `merged`. Each new row is as tall as row `like` (drawn
 * size); the frame grows by that, keeping its top-left corner where it is on the slide (see
 * `resizedFrame`).
 */
export function insertRows(
  table: TableElement,
  at: number,
  count: number,
  like: number,
): TablePatch {
  if (!(count >= 1)) return {};
  const heights = tableSizes(table).rows;
  const where = clamp(at, 0, heights.length);
  const model = clamp(like, 0, heights.length - 1);
  const height = heights[model] ?? MIN_ROW;
  heights.splice(where, 0, ...Array.from({ length: count }, () => height));
  return { ...rowsPatch(table, heights), cells: insertLines(table.cells, where, count, model) };
}

/**
 * Same for columns, except that the table KEEPS its width: each new column takes the drawn width
 * of column `like`, then all columns are scaled back so they add up to frame.w. No frame change.
 */
export function insertCols(
  table: TableElement,
  at: number,
  count: number,
  like: number,
): TablePatch {
  if (!(count >= 1)) return {};
  const widths = tableSizes(table).cols;
  const where = clamp(at, 0, widths.length);
  const model = clamp(like, 0, widths.length - 1);
  const width = widths[model] ?? MIN_COL;
  widths.splice(where, 0, ...Array.from({ length: count }, () => width));
  return {
    ...colsPatch(table, widths),
    cells: transposed(insertLines(transposed(table.cells), where, count, model)),
  };
}

/**
 * Removes rows. A merged area loses the rows it had among them; when its anchor row goes and it
 * still covers a row that stays, the first such row's cell becomes the anchor and takes the
 * content and look. The frame shrinks by the removed rows (top-left corner stays). Undefined
 * when no row would be left.
 */
export function deleteRows(table: TableElement, rows: readonly number[]): TablePatch | undefined {
  const heights = tableSizes(table).rows;
  const gone = indexSet(rows, heights.length);
  if (gone.size === heights.length) return undefined;
  if (gone.size === 0) return {};
  return {
    ...rowsPatch(
      table,
      heights.filter((_, row) => !gone.has(row)),
    ),
    cells: deleteLines(table.cells, gone),
  };
}

/**
 * Removes columns; the table keeps its width (the remaining columns are scaled up). Same span
 * rules. Undefined when no column would be left.
 */
export function deleteCols(table: TableElement, cols: readonly number[]): TablePatch | undefined {
  const widths = tableSizes(table).cols;
  const gone = indexSet(cols, widths.length);
  if (gone.size === widths.length) return undefined;
  if (gone.size === 0) return {};
  return {
    ...colsPatch(
      table,
      widths.filter((_, col) => !gone.has(col)),
    ),
    cells: transposed(deleteLines(transposed(table.cells), gone)),
  };
}

// ---------------------------------------------------------------------------------------------
// Sizes of rows and columns

/**
 * Moves the line after column `col` (0..cols.length-1) by `delta` slide px along the reading
 * direction (positive: column `col` grows). An inner line takes the width from the next column
 * (the table keeps its width; neither column goes under MIN_COL). The line after the LAST column
 * changes that column and the frame's width, keeping the table's start edge where it is (the
 * left edge for ltr, the RIGHT edge for rtl; correct under rotation, see `resizedFrame`).
 */
export function resizeColumn(table: TableElement, col: number, delta: number): TablePatch {
  const widths = tableSizes(table).cols;
  const width = widths[col];
  if (width === undefined) return {};
  // A column that is already narrower than the minimum is not made to grow; it just cannot shrink.
  const least = Math.min(0, MIN_COL - width);
  const next = widths[col + 1];
  if (next === undefined) {
    widths[col] = width + Math.max(delta, least);
    return colsPatch(table, widths, round(sum(widths)));
  }
  const by = clamp(delta, least, Math.max(0, next - MIN_COL));
  widths[col] = width + by;
  widths[col + 1] = next - by;
  return colsPatch(table, widths);
}

/**
 * Changes the height of row `row` by `delta` (not under MIN_ROW); the rows below move and the
 * frame's height changes, top-left corner fixed.
 */
export function resizeRow(table: TableElement, row: number, delta: number): TablePatch {
  const heights = tableSizes(table).rows;
  const height = heights[row];
  if (height === undefined) return {};
  heights[row] = height + Math.max(delta, Math.min(0, MIN_ROW - height));
  return rowsPatch(table, heights);
}

/** Sizes with those from `from` to `to` made equal, their total kept. */
function evened(sizes: readonly number[], from: number, to: number): number[] {
  const first = clamp(Math.min(from, to), 0, sizes.length - 1);
  const last = clamp(Math.max(from, to), 0, sizes.length - 1);
  const each = sum(sizes.slice(first, last + 1)) / (last - first + 1);
  return sizes.map((size, i) => (i >= first && i <= last ? each : size));
}

/** Makes the rows of a range equally tall, keeping their total. */
export function distributeRows(table: TableElement, range: CellRange): TablePatch {
  const heights = evened(tableSizes(table).rows, range.row0, range.row1);
  return settled(table, { rows: fitted(heights, table.frame.h) });
}

/** Makes the columns of a range equally wide, keeping their total. */
export function distributeCols(table: TableElement, range: CellRange): TablePatch {
  return colsPatch(table, evened(tableSizes(table).cols, range.col0, range.col1));
}

/**
 * A frame of a new size that keeps one corner of the old one where it is on the slide, under
 * `rotation` (degrees, clockwise, around the frame's centre). `anchor` is the corner in the
 * frame's own axes: x 0 = left, 1 = right; y 0 = top, 1 = bottom.
 */
export function resizedFrame(
  frame: Frame,
  rotation: number,
  size: { w: number; h: number },
  anchor: { x: 0 | 1; y: 0 | 1 },
): Frame {
  const { w, h } = size;
  // Unrotated, the corner is a matter of adding: no trip through the centre, so no rounding noise.
  if (normalizeAngle(rotation) === 0) {
    return {
      x: anchor.x === 0 || w === frame.w ? frame.x : frame.x + frame.w - w,
      y: anchor.y === 0 || h === frame.h ? frame.y : frame.y + frame.h - h,
      w,
      h,
    };
  }
  // The frame turns around its centre, so a new size moves the centre: by the change in the
  // corner's offset from it, turned like the frame.
  const center = frameCenter(frame);
  const shift = rotateVector(
    { x: (anchor.x - 0.5) * (frame.w - w), y: (anchor.y - 0.5) * (frame.h - h) },
    rotation,
  );
  return { x: center.x + shift.x - w / 2, y: center.y + shift.y - h / 2, w, h };
}

/**
 * Row heights replaced by measured ones (the editor measures the drawn rows: a row is never
 * shorter than its text). `heights` are the drawn heights in slide px, one per row; the frame's
 * height becomes their sum (top-left corner fixed). An empty patch when the rows are drawn at
 * these heights already.
 */
export function withRowHeights(table: TableElement, heights: readonly number[]): TablePatch {
  const now = tableSizes(table).rows;
  const next = now.map((height, row) => {
    const measured = heights[row];
    return measured !== undefined && measured > 0 ? measured : height;
  });
  if (next.every((height, row) => Math.abs(height - (now[row] ?? 0)) < 0.005)) return {};
  return rowsPatch(table, next);
}

// ---------------------------------------------------------------------------------------------
// Merge and split

const hasText = (cell: TableCell): boolean =>
  cell.content.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text !== ''));

/** The anchors of the merged areas that a range touches. */
function mergedAnchors(table: TableElement, range: CellRange): CellRef[] {
  return rangeCells(table, expandRange(table, range)).filter((at) => {
    const span = spanOf(table, at);
    return span.rows > 1 || span.cols > 1;
  });
}

/** Whether the (expanded) range holds more than one cell to merge. */
export function canMerge(table: TableElement, range: CellRange): boolean {
  return rangeCells(table, expandRange(table, range)).length > 1;
}

/** Whether the range touches a merged area. */
export function canSplit(table: TableElement, range: CellRange): boolean {
  return mergedAnchors(table, range).length > 0;
}

/**
 * Merges the (expanded) range into its top-first cell. The text of every cell that has text is
 * kept, in reading order, as paragraphs of the merged cell; the look is the first cell's.
 * Undefined when there is nothing to merge.
 */
export function mergeCells(table: TableElement, range: CellRange): TablePatch | undefined {
  const area = expandRange(table, range);
  const parts = rangeCells(table, area);
  if (parts.length < 2) return undefined;
  const cells = table.cells.map((row) => [...row]);
  const first = cells[area.row0]?.[area.col0];
  if (!first) return undefined;
  const paragraphs: Paragraph[] = [];
  for (const at of parts) {
    const cell = table.cells[at.row]?.[at.col];
    if (cell && hasText(cell)) paragraphs.push(...cell.content.paragraphs);
  }
  for (let row = area.row0; row <= area.row1; row++) {
    for (let col = area.col0; col <= area.col1; col++) cells[row]![col] = coveredCell();
  }
  cells[area.row0]![area.col0] = {
    ...withSpan(first, area.row1 - area.row0 + 1, area.col1 - area.col0 + 1),
    // With no text anywhere, the first cell keeps its (empty) text and its formatting.
    content: paragraphs.length > 0 ? { paragraphs } : first.content,
  };
  return { cells };
}

/**
 * Takes every merged area in the range apart: the anchor keeps its content, the uncovered cells
 * get the anchor's look and empty text. Undefined when nothing in the range is merged.
 */
export function splitCells(table: TableElement, range: CellRange): TablePatch | undefined {
  const anchors = mergedAnchors(table, range);
  if (anchors.length === 0) return undefined;
  const cells = table.cells.map((row) => [...row]);
  for (const at of anchors) {
    const anchor = cells[at.row]?.[at.col];
    if (!anchor) continue;
    const span = spanOf(table, at);
    for (let row = at.row; row < at.row + span.rows; row++) {
      for (let col = at.col; col < at.col + span.cols; col++) {
        if (cells[row]?.[col]?.merged) cells[row]![col] = blankLike(anchor);
      }
    }
    cells[at.row]![at.col] = withSpan(anchor, 1, 1);
  }
  return { cells };
}

// ---------------------------------------------------------------------------------------------
// Cell properties

/**
 * Changes cells with a function; cells for which it returns the same object are untouched. An
 * empty patch when no cell changes.
 */
export function updateCells(
  table: TableElement,
  cells: readonly CellRef[],
  change: (cell: TableCell, at: CellRef) => TableCell,
): TablePatch {
  let grid: TableCell[][] | undefined;
  for (const at of cells) {
    const cell = (grid ?? table.cells)[at.row]?.[at.col];
    if (!cell) continue;
    const next = change(cell, at);
    if (next === cell) continue;
    grid ??= table.cells.map((row) => [...row]);
    grid[at.row]![at.col] = next;
  }
  return grid ? { cells: grid } : {};
}

export type BorderEdges =
  | 'all'
  | 'outer'
  | 'inner'
  | 'innerHorizontal'
  | 'innerVertical'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'none';

/**
 * Sets (stroke) or removes (null) borders on edges of a range. 'left' and 'right' are screen
 * sides (they follow `dir`); 'outer' is the outline of the range, 'inner' the lines between its
 * cells; 'none' removes every border in and around the range regardless of `stroke`.
 *
 * A line between two cells is written on BOTH cells that share it, also on a neighbour outside
 * the range, because collapsed borders show the stronger of the two. A neighbour has one stroke
 * for its whole side, so it takes the line only when that whole side lies along the range: a
 * merged cell that reaches past the range is left as it is, rather than drawn on beyond it.
 *
 * Before a cell whose `borders` is undefined is changed, `base(cell, at)` gives the borders it
 * shows by its table style (default: none), so its other sides stay as they look. The range is
 * expanded, and the edges of a merged area are those of its whole span.
 */
export function setBorders(
  table: TableElement,
  range: CellRange,
  edges: BorderEdges,
  stroke: Stroke | null,
  base: (cell: TableCell, at: CellRef) => Borders = () => ({}),
): TablePatch {
  const area = expandRange(table, range);
  const line = edges === 'none' ? null : stroke;
  // The screen sides of the first and of the last column.
  const startSide: Side = table.dir === 'rtl' ? 'right' : 'left';
  const endSide: Side = table.dir === 'rtl' ? 'left' : 'right';

  const everywhere = edges === 'all' || edges === 'none';
  const outline = everywhere || edges === 'outer';
  const want = {
    top: outline || edges === 'top',
    bottom: outline || edges === 'bottom',
    start: outline || edges === startSide,
    end: outline || edges === endSide,
    horizontal: everywhere || edges === 'inner' || edges === 'innerHorizontal',
    vertical: everywhere || edges === 'inner' || edges === 'innerVertical',
  };

  const sides: { at: CellRef; side: Side }[] = [];

  // Inside the range a line is a side of the cells on both of its sides, and each writes its own.
  for (const at of rangeCells(table, area)) {
    const span = spanOf(table, at);
    const lastRow = at.row + span.rows - 1;
    const lastCol = at.col + span.cols - 1;
    if (at.row === area.row0 ? want.top : want.horizontal) sides.push({ at, side: 'top' });
    if (lastRow === area.row1 ? want.bottom : want.horizontal) sides.push({ at, side: 'bottom' });
    if (at.col === area.col0 ? want.start : want.vertical) sides.push({ at, side: startSide });
    if (lastCol === area.col1 ? want.end : want.vertical) sides.push({ at, side: endSide });
  }

  // The outline is also a side of the cells across it.
  const across = (row: number, col: number, side: Side) => {
    if (!table.cells[row]?.[col]) return;
    const at = anchorOf(table, { row, col });
    if (table.cells[at.row]?.[at.col]?.merged) return;
    const span = spanOf(table, at);
    const along =
      side === 'top' || side === 'bottom'
        ? at.col >= area.col0 && at.col + span.cols - 1 <= area.col1
        : at.row >= area.row0 && at.row + span.rows - 1 <= area.row1;
    if (along) sides.push({ at, side });
  };
  for (let col = area.col0; col <= area.col1; col++) {
    if (want.top) across(area.row0 - 1, col, 'bottom');
    if (want.bottom) across(area.row1 + 1, col, 'top');
  }
  for (let row = area.row0; row <= area.row1; row++) {
    if (want.start) across(row, area.col0 - 1, endSide);
    if (want.end) across(row, area.col1 + 1, startSide);
  }

  if (sides.length === 0) return {};
  const cells = table.cells.map((row) => [...row]);
  for (const { at, side } of sides) {
    const cell = cells[at.row]?.[at.col];
    if (!cell) continue;
    const borders: Borders = { ...(cell.borders ?? base(cell, at)) };
    if (line) borders[side] = { ...line };
    else delete borders[side];
    cells[at.row]![at.col] = { ...cell, borders };
  }
  return { cells };
}

/** Empties the text of cells and keeps its formatting. Cells with no text are untouched. */
export function clearCells(table: TableElement, cells: readonly CellRef[]): TablePatch {
  return updateCells(table, cells, (cell) =>
    cell.merged || (cell.content.paragraphs.length <= 1 && !hasText(cell))
      ? cell
      : { ...cell, content: cellText(cell.content, '') },
  );
}

/** A cell with its left and right borders and paddings exchanged. */
function mirrored(cell: TableCell): TableCell {
  let next = cell;
  const { borders, padding } = cell;
  if (borders && borders.left !== borders.right) {
    const { left, right, ...rest } = borders;
    next = {
      ...next,
      borders: { ...rest, ...(right ? { left: right } : {}), ...(left ? { right: left } : {}) },
    };
  }
  if (padding && padding.left !== padding.right) {
    next = { ...next, padding: { ...padding, left: padding.right, right: padding.left } };
  }
  return next;
}

/**
 * Reverses the column order on screen (TBL-07): flips `dir`, and swaps the left and right borders
 * and paddings of every cell so the picture is mirrored, not broken.
 */
export function flipDirection(table: TableElement): TablePatch {
  const cells = table.cells.map((row) => row.map(mirrored));
  const changed = cells.some((row, r) => row.some((cell, c) => cell !== table.cells[r]?.[c]));
  return { dir: table.dir === 'rtl' ? 'ltr' : 'rtl', ...(changed ? { cells } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Text in and out

/** The marks of the first run of a text, without its link: a link belongs to the text it was on. */
function firstMarks(content: RichText | undefined): Marks | undefined {
  for (const paragraph of content?.paragraphs ?? []) {
    const run = paragraph.runs[0];
    if (!run) continue;
    const { link: _link, ...marks } = run.marks ?? {};
    return Object.keys(marks).length > 0 ? marks : undefined;
  }
  return undefined;
}

/**
 * Text for a cell in the formatting of the content it replaces: the paragraph fields of its
 * first paragraph and the marks of its first run. One paragraph per line of `text`; an empty
 * line keeps the marks on a run with no text.
 */
export function cellText(like: RichText | undefined, text: string): RichText {
  const { runs: _runs, ...fields } = like?.paragraphs[0] ?? emptyParagraph();
  const marks = firstMarks(like);
  return {
    paragraphs: text.split(/\r\n?|\n/).map((line) => ({
      ...fields,
      runs: marks ? [{ text: line, marks: { ...marks } }] : line ? [{ text: line }] : [],
    })),
  };
}

/**
 * Writes a grid of texts into the table from `at` (pasting, TBL-06). The table grows as needed:
 * rows are added at the bottom (like the last row), columns at the end (like the last column,
 * table width kept). Merged areas the grid lands on are split first. A row of the grid that is
 * shorter than the others leaves the cells past its end as they are. Returns the patch and the
 * range that was written.
 */
export function pasteGrid(
  table: TableElement,
  at: CellRef,
  grid: readonly (readonly string[])[],
): { patch: TablePatch; range: CellRange } {
  const row0 = Math.max(0, at.row);
  const col0 = Math.max(0, at.col);
  const width = grid.reduce((widest, line) => Math.max(widest, line.length), 0);
  if (width === 0) return { patch: {}, range: { row0, col0, row1: row0, col1: col0 } };
  const range: CellRange = { row0, col0, row1: row0 + grid.length - 1, col1: col0 + width - 1 };

  // Each step works on the table the steps before it left, and the patch adds them up.
  let patch: TablePatch = {};
  let next = table;
  const apply = (change: TablePatch | undefined) => {
    if (!change) return;
    patch = { ...patch, ...change };
    next = { ...next, ...change };
  };
  const rows = table.rows.length;
  const cols = table.cols.length;
  if (range.row1 >= rows) apply(insertRows(next, rows, range.row1 - rows + 1, rows - 1));
  if (range.col1 >= cols) apply(insertCols(next, cols, range.col1 - cols + 1, cols - 1));
  apply(splitCells(next, range));

  const cells = next.cells.map((row) => [...row]);
  grid.forEach((line, i) => {
    line.forEach((text, j) => {
      const cell = cells[row0 + i]?.[col0 + j];
      if (cell) cells[row0 + i]![col0 + j] = { ...cell, content: cellText(cell.content, text) };
    });
  });
  apply({ cells });
  return { patch, range };
}

/** The longest line of a text, in characters. */
function longestLine(text: string): number {
  return text.split('\n').reduce((longest, line) => Math.max(longest, line.length), 0);
}

/**
 * How wide each column asks to be: as its longest line of text, and each between 60% and 240%
 * of the average.
 */
function columnShares(grid: readonly (readonly string[])[], cols: number): number[] {
  // The padding of a cell is about as wide as three characters of its text.
  let shares = Array.from(
    { length: cols },
    (_, col) =>
      3 + grid.reduce((longest, line) => Math.max(longest, longestLine(line[col] ?? '')), 0),
  );
  // Bringing a column inside the limits moves the average, so it is repeated until it settles.
  for (let i = 0; i < 24; i++) {
    const average = sum(shares) / cols;
    shares = shares.map((share) => clamp(share, 0.6 * average, 2.4 * average));
  }
  return shares;
}

/**
 * A table that holds a grid of texts, laid out inside `frame`: columns as wide as their longest
 * text asks (each between 60% and 240% of the average), rows even.
 */
export function tableFromGrid(
  grid: readonly (readonly string[])[],
  options: { frame: Frame; dir: Direction; id?: string; headerRow?: boolean },
): TableElement {
  const cols = Math.max(
    1,
    grid.reduce((widest, line) => Math.max(widest, line.length), 0),
  );
  const table = newTable({
    rows: Math.max(1, grid.length),
    cols,
    frame: options.frame,
    dir: options.dir,
    ...(options.id ? { id: options.id } : {}),
    ...(options.headerRow === undefined ? {} : { style: { headerRow: options.headerRow } }),
  });
  return {
    ...table,
    cols: fitted(columnShares(grid, cols), options.frame.w),
    cells: table.cells.map((row, r) =>
      row.map((cell, c) => {
        const text = grid[r]?.[c];
        return text ? { content: cellText(undefined, text) } : cell;
      }),
    ),
  };
}

/** The texts of a range, row by row (covered cells give ''), for copying as TSV. */
export function tableText(table: TableElement, range: CellRange): string[][] {
  const { row0, col0, row1, col1 } = clipped(table, range);
  const out: string[][] = [];
  for (let row = row0; row <= row1; row++) {
    const line: string[] = [];
    for (let col = col0; col <= col1; col++) {
      const cell = table.cells[row]?.[col];
      line.push(cell && !cell.merged ? plainText(cell.content) : '');
    }
    out.push(line);
  }
  return out;
}
