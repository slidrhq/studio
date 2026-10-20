import type { Direction, Stroke, TableElement } from '@slidr/model';
import { useRenderContext } from './context';
import { num } from './css';
import { fillStyle } from './fill';
import { CELL_PADDING, cellLook, tableLayout } from './tableStyle';
import { RichTextView, type TextDefaults } from './text';
import { colorCss } from './theme';

const V_ALIGN = { top: 'top', middle: 'middle', bottom: 'bottom' } as const;

/**
 * The defaults of the text of a cell, the same object for the same look: the text of a cell is
 * memoised (`RichTextView`), and a new object for every cell made a drag of a table draw every
 * cell's text again for every frame. A table's cells have a few looks between them.
 */
const cellDefaults = new Map<string, TextDefaults>();

function defaultsOf(dir: Direction, text: Pick<TextDefaults, 'color' | 'weight'>): TextDefaults {
  const key = `${dir} ${text.color ?? ''} ${text.weight ?? ''}`;
  let known = cellDefaults.get(key);
  if (!known) {
    known = { styleRef: 'body', wrap: true, alignTo: dir, ...text };
    cellDefaults.set(key, known);
  }
  return known;
}

function strokeCss(stroke: Stroke | undefined): string | undefined {
  if (!stroke || stroke.width <= 0) return undefined;
  return `${stroke.width}px ${stroke.dash ?? 'solid'} ${colorCss(stroke.color)}`;
}

/**
 * A table as a real `<table>` (ADR-005: a table taken apart into boxes loses its look), with
 * collapsed borders and a fixed layout. Where a cell has no fill or borders of its own, the table
 * style gives them (`tableStyle.ts`).
 *
 * The sizes of the model are scaled to the frame, and the outer borders are drawn inside it (see
 * `tableLayout`). The height of a row is a minimum, as in every table: a row whose text needs more
 * grows, and the table with it. The editor writes the height it measured back to the model.
 *
 * Every cell carries `data-row` and `data-col`, its place in the model.
 */
export function TableView({ element: e }: { element: TableElement }) {
  const ctx = useRenderContext();
  const layout = tableLayout(e);
  return (
    <table
      style={{
        width: '100%',
        height: '100%',
        margin: 0,
        borderCollapse: 'collapse',
        borderSpacing: 0,
        tableLayout: 'fixed',
        direction: e.dir,
      }}
    >
      <colgroup>
        {layout.cols.map((width, i) => (
          <col key={i} style={{ width: num(width, 3) }} />
        ))}
      </colgroup>
      <tbody>
        {e.cells.map((row, r) => (
          <tr key={r} style={{ height: num(layout.rows[r] ?? 0, 3) }}>
            {row.map((cell, c) => {
              if (cell.merged) return null;
              const look = cellLook(e, r, c);
              const pad = cell.padding ?? CELL_PADDING;
              const b = look.borders;
              return (
                <td
                  key={c}
                  data-row={r}
                  data-col={c}
                  rowSpan={cell.rowSpan}
                  colSpan={cell.colSpan}
                  style={{
                    margin: 0,
                    padding: `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`,
                    verticalAlign: V_ALIGN[cell.vAlign ?? 'middle'],
                    overflow: 'hidden',
                    ...(look.fill ? fillStyle(look.fill, ctx) : {}),
                    borderTop: strokeCss(b.top),
                    borderRight: strokeCss(b.right),
                    borderBottom: strokeCss(b.bottom),
                    borderLeft: strokeCss(b.left),
                  }}
                >
                  {ctx.cellSlot?.(e, r, c) ?? (
                    <RichTextView
                      content={cell.content}
                      theme={ctx.theme}
                      defaults={defaultsOf(e.dir, look.text)}
                      dir={e.dir}
                    />
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
