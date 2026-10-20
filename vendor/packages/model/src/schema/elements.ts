import { z } from 'zod';
import {
  AssetId,
  Color,
  CssPassthrough,
  Fill,
  Frame,
  Id,
  Insets,
  Point,
  Shadow,
  Stroke,
} from './primitives';
import { RichText } from './text';

/** What a placeholder or an element is for. Layout switching maps content by role (SPEC 5.5). */
export const PlaceholderRole = z.enum([
  'title',
  'subtitle',
  'body',
  'image',
  'chart',
  'table',
  'caption',
  'number',
  'quote',
  'attribution',
  'footer',
  'slideNumber',
  'logo',
]);
export type PlaceholderRole = z.infer<typeof PlaceholderRole>;

const Link = z.strictObject({ kind: z.enum(['url', 'slide']), target: z.string().min(1) });

const Effects = z.strictObject({
  shadow: Shadow.optional(),
  blur: z.number().nonnegative().optional(),
  radius: z.number().nonnegative().optional(),
});

/** Fields every element has (SPEC 5.2). */
const base = {
  id: Id,
  /** Readable by people and by the agent, e.g. "hero-image". */
  name: z.string().min(1).optional(),
  role: PlaceholderRole.optional(),
  frame: Frame,
  /** Degrees, clockwise, around the centre of the frame. */
  rotation: z.number(),
  /** Mirroring happens in the element's own box, before the rotation. */
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  opacity: z.number().min(0).max(1),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  effects: Effects.optional(),
  link: Link.optional(),
  css: CssPassthrough.optional(),
};

export const TextElement = z.strictObject({
  ...base,
  type: z.literal('text'),
  content: RichText,
  /**
   * The colour of the text where a run sets none, in place of its text style's. A layout gives
   * it to the text of a placeholder that stands on a field of the layout's own, a card for
   * one, where the colour the style has on the slide's ground would not read (SPEC 5.5).
   */
  color: Color.optional(),
  autoFit: z.enum(['none', 'shrink', 'growHeight']),
  vAlign: z.enum(['top', 'middle', 'bottom']),
  padding: Insets.optional(),
  columns: z.number().int().min(1).max(6).optional(),
  /**
   * False keeps every paragraph on one line. Imported single-line text is stored this way so
   * that a box measured to the glyphs can never wrap (ADR-005).
   */
  wrap: z.boolean().optional(),
});
export type TextElement = z.infer<typeof TextElement>;

const ImageAdjust = z.strictObject({
  brightness: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
  temperature: z.number().optional(),
  hue: z.number().optional(),
  blur: z.number().nonnegative().optional(),
  grayscale: z.number().min(0).max(1).optional(),
});

const ImageMask = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ellipse') }),
  z.strictObject({ kind: z.literal('rounded'), radius: z.number().nonnegative() }),
  z.strictObject({ kind: z.literal('shape'), preset: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('path'),
    d: z.string().min(1),
    viewBox: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
  }),
  /**
   * The window of a card that the photograph shows through, the window going where the
   * photograph goes (a magnet's photograph, ADR-095). `markup` is the card, an SVG that lays
   * itself out: the photograph shows wherever it does not paint. The photograph is the card's
   * `opening`: the card around it is laid out at `scale` (slide pixels to a unit of `viewBox`)
   * with its margins as they are, and drawn smaller only around a photograph smaller than the
   * opening (`windowLayout`).
   */
  z.strictObject({
    kind: z.literal('window'),
    markup: z.string().min(1),
    viewBox: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
    opening: Frame,
    scale: z.number().positive(),
  }),
]);

/**
 * Artwork around a photograph, drawn above it in a box of `viewBox`; the photograph shows
 * through `opening`. Artwork that says its `scale` keeps its size: in a picture that is larger
 * than the artwork, or of other proportions, the margins around the opening are as wide as
 * they were and the opening takes up the difference (`frameLayout`). The cut of the photograph
 * (`mask`) is then part of the artwork: its round corners are in the artwork's units. Artwork
 * that says no scale is a picture of one size, stretched with the element.
 */
export const SmartImageFrame = z
  .strictObject({
    viewBox: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
    opening: Frame,
    /** Slide pixels to a unit of the artwork: the size the artwork is drawn at, and keeps. */
    scale: z.number().positive().optional(),
    background: Fill.optional(),
    decorations: z.array(
      z.lazy(() => z.union([ShapeElement, SvgElement, TextElement, LineElement])),
    ),
  })
  .refine(
    ({ opening: o, viewBox: v }) =>
      o.w > 0 && o.h > 0 && o.x >= 0 && o.y >= 0 && o.x + o.w <= v.w && o.y + o.h <= v.h,
    { message: 'the image opening must be a nonempty rectangle inside the frame viewBox' },
  );
export type SmartImageFrame = z.infer<typeof SmartImageFrame>;

export const ImageElement = z.strictObject({
  ...base,
  type: z.literal('image'),
  /** Absent only while the image is a placeholder waiting for `prompt` to be fulfilled. */
  assetId: AssetId.optional(),
  /** What to generate for this placeholder (SPEC 11.5, `data-image-prompt`). */
  prompt: z.string().min(1).optional(),
  /** Visible part of the original, normalised 0..1. The original is never altered (IMG-12). */
  crop: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      h: z.number().positive(),
    })
    .optional(),
  fit: z.enum(['cover', 'contain', 'fill']),
  mask: ImageMask.optional(),
  smartFrame: SmartImageFrame.optional(),
  adjust: ImageAdjust.optional(),
  filterPreset: z.string().min(1).optional(),
  border: Stroke.optional(),
  alt: z.string().optional(),
});
export type ImageElement = z.infer<typeof ImageElement>;

const Geometry = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preset'),
    preset: z.string().min(1),
    adjust: z.array(z.number()).optional(),
  }),
  /** SVG path data in a box of the given size, stretched to the frame. */
  z.strictObject({
    kind: z.literal('path'),
    d: z.string().min(1),
    viewBox: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
  }),
]);

/**
 * One side of a box drawn apart from the rest of it: the coloured edge of a card (ADR-073). It
 * runs the whole length of the side, inside the outline.
 */
export const Accent = z.strictObject({
  side: z.enum(['top', 'right', 'bottom', 'left']),
  /** Thickness in slide pixels. */
  size: z.number().positive(),
  fill: Fill,
  /**
   * How it meets rounded corners: cut straight by them (the default), or going around them and
   * thinning out as a border does. A border has one colour: any other fill is cut.
   */
  corners: z.enum(['cut', 'follow']).optional(),
});
export type Accent = z.infer<typeof Accent>;

export const ShapeElement = z.strictObject({
  ...base,
  type: z.literal('shape'),
  geometry: Geometry,
  fill: Fill,
  stroke: Stroke.optional(),
  /** For the box presets (`rect`, `roundRect`, `ellipse`); a path has no sides. */
  accent: Accent.optional(),
  content: RichText.optional(),
  /** Room between the outline and `content`. Without it: 8 above and below, 16 on the sides. */
  padding: Insets.optional(),
});
export type ShapeElement = z.infer<typeof ShapeElement>;

const LineHead = z.enum(['none', 'arrow', 'triangle', 'circle', 'diamond', 'bar']);

export const LineElement = z.strictObject({
  ...base,
  type: z.literal('line'),
  /** Relative to the frame's top-left corner, in slide pixels. */
  points: z.array(Point).min(2),
  stroke: Stroke,
  startHead: LineHead,
  endHead: LineHead,
  curve: z.enum(['straight', 'elbow', 'curved']),
});
export type LineElement = z.infer<typeof LineElement>;

/** Parts of a text background that may lengthen; everything between them keeps its scale. */
const StretchBands = z
  .array(z.tuple([z.number().nonnegative(), z.number().positive()]))
  .min(1)
  .max(4);
export const SvgStretch = z
  .strictObject({
    viewBox: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
    scale: z.number().positive(),
    x: StretchBands,
    y: StretchBands,
  })
  .refine(
    (value) =>
      (['x', 'y'] as const).every((axis) => {
        const size = value.viewBox[axis === 'x' ? 'w' : 'h'];
        return value[axis].every(
          ([start, end], i, bands) =>
            start < end && end <= size && (i === 0 || start > bands[i - 1]![1]),
        );
      }),
    { message: 'stretch bands must be ordered, separate, and inside the drawing' },
  );
export type SvgStretch = z.infer<typeof SvgStretch>;

export const SvgElement = z
  .strictObject({
    ...base,
    type: z.literal('svg'),
    assetId: AssetId.optional(),
    markup: z.string().min(1).optional(),
    /** Source colour -> replacement, so icons and illustrations can follow the theme. */
    colorOverrides: z.record(z.string().min(1), Color).optional(),
    /** A resizable text background: its flexible bands grow while corners and ornaments stay. */
    stretch: SvgStretch.optional(),
    /**
     * A drawing that lays itself out (no `viewBox`), as the artwork of a frame does (ADR-086):
     * drawn at `scale`, slide pixels to a unit, in a box of its units never smaller than
     * `viewBox`. Made larger, it keeps its margins and ornaments as they are (`artworkLayout`).
     */
    layout: z
      .strictObject({
        viewBox: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
        scale: z.number().positive(),
      })
      .optional(),
  })
  .refine((e) => Boolean(e.assetId) !== Boolean(e.markup), {
    message: 'an svg element has either assetId or markup',
  })
  .refine((e) => !e.stretch || Boolean(e.markup), {
    message: 'a stretchable svg carries its drawing as markup',
  })
  .refine((e) => !e.layout || (Boolean(e.markup) && !e.stretch), {
    message: 'an svg that lays itself out carries its drawing as markup, and is not stretched',
  });
export type SvgElement = z.infer<typeof SvgElement>;

const CellBorders = z.strictObject({
  top: Stroke.optional(),
  right: Stroke.optional(),
  bottom: Stroke.optional(),
  left: Stroke.optional(),
});

const TableCell = z.strictObject({
  content: RichText,
  rowSpan: z.number().int().min(1).optional(),
  colSpan: z.number().int().min(1).optional(),
  /** True for a cell covered by another cell's span. */
  merged: z.boolean().optional(),
  fill: Fill.optional(),
  borders: CellBorders.optional(),
  vAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  padding: Insets.optional(),
});
export type TableCell = z.infer<typeof TableCell>;

export const TableElement = z
  .strictObject({
    ...base,
    type: z.literal('table'),
    /** Row heights and column widths in slide pixels. */
    rows: z.array(z.number().positive()).min(1),
    cols: z.array(z.number().positive()).min(1),
    /** cells[row][col] */
    cells: z.array(z.array(TableCell)),
    /** Column order (TBL-07). */
    dir: z.enum(['rtl', 'ltr']),
    style: z.strictObject({
      headerRow: z.boolean(),
      bandedRows: z.boolean(),
      firstColumn: z.boolean(),
      styleId: z.string().min(1).optional(),
    }),
  })
  .refine(
    (t) => t.cells.length === t.rows.length && t.cells.every((row) => row.length === t.cols.length),
    {
      message: 'cells must be a rows x cols grid',
    },
  );
export type TableElement = z.infer<typeof TableElement>;

export const ChartType = z.enum([
  'column',
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'radar',
]);
export type ChartType = z.infer<typeof ChartType>;

const ChartSeries = z.strictObject({
  name: z.string(),
  /** One value per category; null is a gap. */
  values: z.array(z.number().nullable()),
  /** For scatter charts: explicit points instead of per-category values. */
  points: z.array(Point).optional(),
  color: Color.optional(),
});

const ChartAxis = z.strictObject({
  show: z.boolean(),
  title: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  gridLines: z.boolean().optional(),
});

export const ChartElement = z.strictObject({
  ...base,
  type: z.literal('chart'),
  chartType: ChartType,
  data: z.strictObject({ categories: z.array(z.string()), series: z.array(ChartSeries) }),
  options: z.strictObject({
    title: z.string().optional(),
    legend: z.strictObject({
      show: z.boolean(),
      position: z.enum(['top', 'bottom', 'start', 'end']),
    }),
    axes: z.strictObject({ x: ChartAxis, y: ChartAxis }),
    labels: z.boolean(),
    /** Overrides the theme's chart palette. */
    palette: z.array(Color).optional(),
  }),
});
export type ChartElement = z.infer<typeof ChartElement>;

const Trim = z.strictObject({ startMs: z.number().nonnegative(), endMs: z.number().positive() });

export const VideoElement = z.strictObject({
  ...base,
  type: z.literal('video'),
  assetId: AssetId,
  /** A chosen frame of the video, or a separate image. */
  poster: z
    .union([
      z.strictObject({ timeMs: z.number().nonnegative() }),
      z.strictObject({ assetId: AssetId }),
    ])
    .optional(),
  autoplay: z.boolean(),
  loop: z.boolean(),
  muted: z.boolean(),
  trim: Trim.optional(),
  volume: z.number().min(0).max(1),
});
export type VideoElement = z.infer<typeof VideoElement>;

export const AudioElement = z.strictObject({
  ...base,
  type: z.literal('audio'),
  assetId: AssetId,
  autoplay: z.boolean(),
  loop: z.boolean(),
  trim: Trim.optional(),
  volume: z.number().min(0).max(1),
  showControls: z.boolean(),
});
export type AudioElement = z.infer<typeof AudioElement>;

/**
 * Any HTML/CSS/JS kept as it is (SPEC 5.9). A full element: it moves, resizes, rotates and
 * animates like the others; only its inside has no dedicated handles.
 */
export const HtmlElement = z.strictObject({
  ...base,
  type: z.literal('html'),
  markup: z.string(),
  /** Stylesheet scoped to this element. Distinct from `css` in the base, which styles the box. */
  styles: z.string().optional(),
  /** With scripts the element runs in a sandboxed frame instead of a shadow root (RND-06). */
  hasScripts: z.boolean(),
  /**
   * Size the markup was laid out at, in its own CSS pixels. The frame may be larger or smaller:
   * the content is scaled to it, never reflowed (ADR-005).
   */
  natural: z.strictObject({ w: z.number().positive(), h: z.number().positive() }).optional(),
});
export type HtmlElement = z.infer<typeof HtmlElement>;

/** Every element type except `group`, which contains elements and so is defined after them. */
const LeafElement = z.discriminatedUnion('type', [
  TextElement,
  ImageElement,
  ShapeElement,
  LineElement,
  SvgElement,
  TableElement,
  ChartElement,
  VideoElement,
  AudioElement,
  HtmlElement,
]);
type LeafElement = z.infer<typeof LeafElement>;

/** The fields shared by every element type. */
export const ElementBase = z.strictObject(base);
export type ElementBase = z.infer<typeof ElementBase>;

// The recursion has to be spelled out for TypeScript: a schema cannot infer its own type.
export interface GroupElement extends ElementBase {
  type: 'group';
  /** Frames of the children are relative to the group's frame. */
  children: Element[];
}
export type Element = LeafElement | GroupElement;

export const GroupElement: z.ZodType<GroupElement> = z.strictObject({
  ...base,
  type: z.literal('group'),
  children: z.lazy(() => z.array(Element)),
});

export const Element: z.ZodType<Element> = z.union([LeafElement, GroupElement]);

export const ElementType = z.enum([
  'text',
  'image',
  'shape',
  'line',
  'svg',
  'group',
  'table',
  'chart',
  'video',
  'audio',
  'html',
]);
export type ElementType = z.infer<typeof ElementType>;

/** The schema of one element type. Validating against it gives sharper errors than `Element`. */
export const elementSchemas: Record<ElementType, z.ZodType<Element>> = {
  text: TextElement,
  image: ImageElement,
  shape: ShapeElement,
  line: LineElement,
  svg: SvgElement,
  group: GroupElement,
  table: TableElement,
  chart: ChartElement,
  video: VideoElement,
  audio: AudioElement,
  html: HtmlElement,
};
