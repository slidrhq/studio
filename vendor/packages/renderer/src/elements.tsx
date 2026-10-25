import type {
  Accent,
  AudioElement,
  Element,
  Fill,
  GroupElement,
  HtmlElement,
  ImageElement,
  LineElement,
  Point,
  ShapeElement,
  Stroke,
  SvgElement,
  TextElement,
  VideoElement,
} from '@slidr/model';
import {
  artworkLayout,
  frameLayout,
  imageOpening,
  placedInFrame,
  windowLayout,
} from '@slidr/model';
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChartView } from './chart/view';
import { clipAttributes, CLIP_TOGGLE_ATTRIBUTE, nativeLoop, showsMark, videoSource } from './clip';
import { domId, useRenderContext, type HtmlEditing, type RenderContext } from './context';
import { num, passthroughStyle } from './css';
import { FillLayer } from './fill';
import {
  isBoxPreset,
  pathBounds,
  presetPath,
  scalePath,
  transformPath,
  type ShapePath,
} from './geometry';
import { Icon } from './icons';
import { imageLook } from './imageLook';
import { frameDocument, prepareSvg, resolveAssetRefs, resolveAssetUrls } from './markup';
import { parseFragment, sanitizeFragment } from './sanitize';
import { stretchSvg } from './stretchSvg';
import { TableView } from './table';
import { numberedText, opensAddress, TextBox, textFillStyle, textStrokeStyle } from './text';
import { colorCss, shadowCss } from './theme';

const FILL_PARENT: CSSProperties = { position: 'absolute', inset: 0, margin: 0, padding: 0 };

/** Mirroring happens inside the element's box, under the rotation of the box (ADR-007). */
function flipTransform(e: Element): string | undefined {
  if (!e.flipH && !e.flipV) return undefined;
  return `scale(${e.flipH ? -1 : 1}, ${e.flipV ? -1 : 1})`;
}

/** Whether pointer events may reach the inside of an element (see `RenderMode`). */
function interactive(ctx: RenderContext): boolean {
  return ctx.mode === 'present';
}

/**
 * The positioned, rotated box every element has. A shadow follows what is drawn, not the box:
 * `drop-shadow` shadows a text box's glyphs and a shape's outline. Only a shadow with spread,
 * which `drop-shadow` cannot draw, falls back to the box's own `box-shadow`.
 */
function boxStyle(e: Element): CSSProperties {
  const { x, y, w, h } = e.frame;
  const style: CSSProperties = {
    position: 'absolute',
    left: x,
    top: y,
    width: w,
    height: h,
    margin: 0,
    padding: 0,
    boxSizing: 'border-box',
  };
  if (e.rotation) style.transform = `rotate(${num(e.rotation)}deg)`;
  if (e.opacity < 1) style.opacity = e.opacity;
  const filters: string[] = [];
  const shadow = e.effects?.shadow;
  if (shadow?.spread) style.boxShadow = shadowCss(shadow);
  else if (shadow) {
    filters.push(
      `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px ${colorCss(shadow.color)})`,
    );
  }
  if (e.effects?.blur) filters.push(`blur(${e.effects.blur}px)`);
  if (filters.length) style.filter = filters.join(' ');
  if (e.effects?.radius) style.borderRadius = e.effects.radius;
  // A growing box is as tall as its text; the editor writes that height back to the frame.
  if (e.type === 'text' && e.autoFit === 'growHeight') style.height = 'auto';
  // Media and placeholders stay inside their frame. HTML is clipped only to round its corners:
  // anything it draws outside its box, such as a shadow, is part of how it looks (SPEC 5.9).
  if (e.type === 'video' || e.type === 'chart' || (e.type === 'html' && e.effects?.radius)) {
    style.overflow = 'hidden';
  }
  return style;
}

// ---------------------------------------------------------------------------------------------
// Text

function TextView({ element: e }: { element: TextElement }) {
  const ctx = useRenderContext();
  const { role, content } = e;
  const { slideNumber } = ctx;
  const text = useMemo(
    () => (role === 'slideNumber' ? numberedText(content, slideNumber) : content),
    [role, content, slideNumber],
  );
  return (
    <TextBox
      content={text}
      vAlign={e.vAlign}
      padding={e.padding}
      autoFit={e.autoFit}
      columns={e.columns}
      wrap={e.wrap}
      size={e.frame}
      color={e.color}
    >
      {ctx.textSlot?.(e)}
    </TextBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Image

/**
 * Where the whole original image goes so that its `crop` region fills the frame by `fit` (IMG-03,
 * IMG-04). The original is never cut: the frame clips it. Needs the asset's pixel size.
 */
export function imagePlacement(
  frame: { w: number; h: number },
  natural: { w: number; h: number },
  crop: ImageElement['crop'],
  fit: ImageElement['fit'],
): { left: number; top: number; width: number; height: number } {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = c.w * natural.w;
  const ch = c.h * natural.h;
  let sx: number;
  let sy: number;
  if (fit === 'fill') {
    sx = frame.w / cw;
    sy = frame.h / ch;
  } else {
    const s =
      fit === 'cover' ? Math.max(frame.w / cw, frame.h / ch) : Math.min(frame.w / cw, frame.h / ch);
    sx = s;
    sy = s;
  }
  const offX = (frame.w - cw * sx) / 2;
  const offY = (frame.h - ch * sy) / 2;
  return {
    left: num(offX - c.x * natural.w * sx, 3),
    top: num(offY - c.y * natural.h * sy, 3),
    width: num(natural.w * sx, 3),
    height: num(natural.h * sy, 3),
  };
}

/**
 * The window of a card as the mask of the photograph that shows through it: the card, laid out
 * as large as it is around the photograph (`windowLayout`) and placed so that its opening is the
 * photograph's box, taken out of the whole. The photograph shows wherever the card does not
 * paint, as it did with the card lying over it.
 */
function windowMask(
  mask: Extract<ImageElement['mask'], { kind: 'window' }>,
  size: { w: number; h: number },
): CSSProperties {
  const { scale, box, at } = windowLayout(mask, size);
  // A picture of its own does not see the slide's theme. Only where the card paints counts, not
  // in what colour, so every colour of the theme it takes is one that paints.
  const themed = new Set(Array.from(mask.markup.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]));
  const theme = themed.size
    ? `<style>:root{${[...themed].map((name) => `${name}:#000`).join(';')}}</style>`
    : '';
  const sized = mask.markup.replace(
    /^\s*<svg\b([^>]*)>/,
    `<svg width="${num(box.w, 3)}" height="${num(box.h, 3)}"$1>${theme}`,
  );
  const card = `url("data:image/svg+xml,${encodeURIComponent(sized)}")`;
  const image = `linear-gradient(#000, #000), ${card}`;
  const place = {
    size: `100% 100%, ${num(box.w * scale, 3)}px ${num(box.h * scale, 3)}px`,
    position: `0 0, ${num(-at.x * scale, 3)}px ${num(-at.y * scale, 3)}px`,
  };
  return {
    maskImage: image,
    maskSize: place.size,
    maskPosition: place.position,
    maskRepeat: 'no-repeat',
    maskComposite: 'exclude',
    WebkitMaskImage: image,
    WebkitMaskSize: place.size,
    WebkitMaskPosition: place.position,
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskComposite: 'xor',
  };
}

/** The clip of an image's frame: its mask, or else the element's corner radius (IMG-05, IMG-08). */
function imageClip(e: ImageElement): {
  style: CSSProperties;
  path?: ShapePath;
  radius?: number | string;
} {
  const mask = e.mask;
  if (mask?.kind === 'ellipse') return { style: { borderRadius: '50%' }, radius: '50%' };
  if (mask?.kind === 'rounded')
    return { style: { borderRadius: mask.radius }, radius: mask.radius };
  if (mask?.kind === 'shape') {
    const path = presetPath(mask.preset, e.frame.w, e.frame.h);
    if (path) return { style: { clipPath: `path('${path.d}')` }, path };
  }
  if (mask?.kind === 'path') {
    const path = {
      d: scalePath(mask.d, e.frame.w / mask.viewBox.w, e.frame.h / mask.viewBox.h),
      closed: true,
    };
    return { style: { clipPath: `path('${path.d}')` }, path };
  }
  if (mask?.kind === 'window') return { style: windowMask(mask, e.frame) };
  const r = e.effects?.radius;
  return r ? { style: { borderRadius: r }, radius: r } : { style: {} };
}

/**
 * Whether a box and its outline are drawn as one box, the way a page draws a background and a
 * border. As two layers, the fill and the outline over it, each is smoothed on its own along a
 * round corner, and the fill shows on the outer edge of the outline: a card with a border then
 * looks unlike the page it was read from. Only a width in whole pixels is a border: the browser
 * rounds any other down to whole device pixels, so that one stays an inset shadow (ADR-005). An
 * accent is laid out inside the outline, an image fill has an opacity the border must not take,
 * and a `css` fill is a shorthand that says for itself where it is laid out: those keep their
 * layers.
 */
function bordersItsFill(e: ShapeElement): e is ShapeElement & { stroke: Stroke } {
  const { stroke, fill } = e;
  return (
    stroke !== undefined &&
    stroke.width > 0 &&
    Number.isInteger(stroke.width) &&
    !e.accent &&
    fill.kind !== 'image' &&
    fill.kind !== 'css'
  );
}

function BoxStroke({ stroke, radius }: { stroke: Stroke; radius?: number | string }) {
  if (stroke.width <= 0) return null;
  const color = colorCss(stroke.color);
  const dashed = stroke.dash && stroke.dash !== 'solid';
  // A solid outline is an inset shadow: a border is snapped to whole device pixels (ADR-005).
  return (
    <div
      aria-hidden
      style={{
        ...FILL_PARENT,
        boxSizing: 'border-box',
        borderRadius: radius,
        pointerEvents: 'none',
        ...(dashed
          ? { border: `${stroke.width}px ${stroke.dash} ${color}` }
          : { boxShadow: `inset 0 0 0 ${stroke.width}px ${color}` }),
      }}
    />
  );
}

const BORDER_SIDE = {
  top: 'borderTop',
  right: 'borderRight',
  bottom: 'borderBottom',
  left: 'borderLeft',
} as const;

/** An accent that goes around the corners: one colour, on a box the browser can border. */
type BorderAccent = Accent & { fill: Extract<Fill, { kind: 'solid' }> };

function followsCorners(accent: Accent | undefined): accent is BorderAccent {
  return accent?.corners === 'follow' && accent.fill.kind === 'solid';
}

/**
 * The four sides of a box whose accent goes around its corners, as CSS borders: the outline on
 * three of them and the accent in its place on the fourth. Where two sides of unequal width
 * meet, each thins into the other along the corner, and only a real border is drawn that way.
 */
function borderSides(stroke: Stroke | undefined, accent: BorderAccent): CSSProperties {
  const line =
    stroke && stroke.width > 0
      ? `${stroke.width}px ${stroke.dash ?? 'solid'} ${colorCss(stroke.color)}`
      : '0 solid transparent';
  return {
    boxSizing: 'border-box',
    borderTop: line,
    borderRight: line,
    borderBottom: line,
    borderLeft: line,
    [BORDER_SIDE[accent.side]]: `${accent.size}px solid ${colorCss(accent.fill.color)}`,
  };
}

/**
 * An accent that the corners cut: a stripe along one side, inside the outline, as a page draws
 * one with a positioned box inside a card that clips it.
 */
function AccentBand({
  accent,
  inset,
  radius,
  ctx,
}: {
  accent: Accent;
  inset: number;
  radius?: number | string;
  ctx: RenderContext;
}) {
  const across = accent.side === 'top' || accent.side === 'bottom';
  // Every side is named whichever side the stripe is on: a property that came and went as the
  // accent moved from side to side is what React takes for a styling mistake.
  const stripe: CSSProperties = {
    top: accent.side === 'bottom' ? 'auto' : 0,
    right: accent.side === 'left' ? 'auto' : 0,
    bottom: accent.side === 'top' ? 'auto' : 0,
    left: accent.side === 'right' ? 'auto' : 0,
    width: across ? 'auto' : accent.size,
    height: across ? accent.size : 'auto',
  };
  return (
    <div
      aria-hidden
      style={{
        ...FILL_PARENT,
        inset,
        overflow: 'hidden',
        borderRadius: typeof radius === 'number' ? Math.max(0, radius - inset) : radius,
        pointerEvents: 'none',
      }}
    >
      <FillLayer fill={accent.fill} ctx={ctx} style={stripe} />
    </div>
  );
}

function dashArray(stroke: Stroke): string | undefined {
  const w = Math.max(stroke.width, 0.5);
  if (stroke.dash === 'dashed') return `${num(w * 4)} ${num(w * 3)}`;
  if (stroke.dash === 'dotted')
    return stroke.cap === 'round' ? `0 ${num(w * 2)}` : `${num(w)} ${num(w)}`;
  return undefined;
}

/**
 * The outline of a path. A closed shape is stroked inside its edge, like a CSS border, so the shape
 * never draws outside its frame: twice the width, clipped to the shape. Open paths are stroked
 * on the line.
 */
function PathStroke({
  path,
  stroke,
  w,
  h,
  clipId,
}: {
  path: ShapePath;
  stroke: Stroke;
  w: number;
  h: number;
  clipId: string;
}) {
  if (stroke.width <= 0) return null;
  return (
    <svg
      aria-hidden
      width={Math.max(w, 1)}
      height={Math.max(h, 1)}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
    >
      {path.closed ? (
        <defs>
          <clipPath id={clipId}>
            <path d={path.d} />
          </clipPath>
        </defs>
      ) : null}
      <path
        d={path.d}
        clipPath={path.closed ? `url(#${clipId})` : undefined}
        style={{
          fill: 'none',
          stroke: colorCss(stroke.color),
          strokeWidth: path.closed ? stroke.width * 2 : stroke.width,
          strokeDasharray: dashArray(stroke),
          strokeLinecap: stroke.cap ?? (stroke.dash === 'dotted' ? 'round' : 'butt'),
          strokeLinejoin: stroke.join ?? 'miter',
        }}
      />
    </svg>
  );
}

function PendingImage({ e, ctx }: { e: ImageElement; ctx: RenderContext }) {
  const showHint = ctx.mode !== 'present';
  const size = Math.min(e.frame.w, e.frame.h) * 0.22;
  return (
    <div
      data-slidr-placeholder="image"
      title={e.prompt}
      style={{
        ...FILL_PARENT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--color-surface)',
        color: 'color-mix(in srgb, var(--color-muted) 70%, transparent)',
      }}
    >
      {showHint && size >= 12 ? (
        <span
          data-slidr-picker-icon
          style={{ cursor: ctx.mode === 'edit' ? 'pointer' : undefined }}
        >
          <Icon name="image" size={Math.min(size, 96)} />
        </span>
      ) : null}
    </div>
  );
}

function ImageView({ element: e }: { element: ImageElement }) {
  if (e.smartFrame) return <SmartFrameView element={e} />;
  return <PictureView element={e} />;
}

/**
 * A picture in a drawn frame. The artwork is laid out in its own units, in a box as large as the
 * picture is in those units, and drawn at its scale: it keeps its size when the picture is made
 * larger, and the photograph has what is left (`frameLayout`). A part of the artwork that says
 * its own size (an SVG with no `viewBox`, a box with an outline) is laid out in that box anew.
 * Artwork that says no scale is laid out in its own box and stretched to the picture's.
 */
function SmartFrameView({ element: e }: { element: ImageElement }) {
  const ctx = useRenderContext();
  const design = e.smartFrame!;
  const layout = frameLayout(design, e.frame);
  const opening = imageOpening(e);
  // Round corners of the cut are the artwork's, in its units, where the artwork has a scale.
  const mask =
    e.mask?.kind === 'rounded' && design.scale !== undefined
      ? { ...e.mask, radius: num(e.mask.radius * layout.scale.x, 3) }
      : e.mask;
  return (
    <div data-smart-image-frame style={{ ...FILL_PARENT, transform: flipTransform(e) }}>
      {design.background ? <FillLayer fill={design.background} ctx={ctx} /> : null}
      <div
        data-image-opening
        style={{
          position: 'absolute',
          left: opening.x,
          top: opening.y,
          width: opening.w,
          height: opening.h,
        }}
      >
        <PictureView
          element={{
            ...e,
            smartFrame: undefined,
            mask,
            frame: opening,
            flipH: false,
            flipV: false,
          }}
        />
      </div>
      <div
        data-frame-artwork
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: num(layout.box.w, 3),
          height: num(layout.box.h, 3),
          transform: `scale(${num(layout.scale.x, 6)}, ${num(layout.scale.y, 6)})`,
          transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
      >
        {design.decorations.map((decoration, index) => (
          <ElementView
            key={index}
            element={{ ...decoration, frame: placedInFrame(design, layout, decoration.frame) }}
            decoration
          />
        ))}
      </div>
    </div>
  );
}

function PictureView({ element: e }: { element: ImageElement }) {
  const ctx = useRenderContext();
  const reactId = useId();
  const clip = imageClip(e);
  const url = e.assetId ? ctx.assetUrl(e.assetId) : undefined;
  const meta = e.assetId ? ctx.asset(e.assetId) : undefined;
  const { filter, defs } = imageLook(e, ctx.theme, (suffix) => domId(reactId, suffix));
  const imgBase: CSSProperties = {
    position: 'absolute',
    display: 'block',
    margin: 0,
    padding: 0,
    border: 0,
    maxWidth: 'none',
    maxHeight: 'none',
    userSelect: 'none',
    filter,
  };
  let img: ReactNode = null;
  if (url) {
    const placement =
      meta?.width && meta.height
        ? imagePlacement(e.frame, { w: meta.width, h: meta.height }, e.crop, e.fit)
        : undefined;
    img = (
      <img
        src={url}
        alt={e.alt ?? ''}
        draggable={false}
        decoding={ctx.decoding ?? 'async'}
        style={
          placement
            ? { ...imgBase, ...placement }
            : { ...imgBase, left: 0, top: 0, width: '100%', height: '100%', objectFit: e.fit }
        }
      />
    );
  }
  return (
    <div style={{ ...FILL_PARENT, overflow: 'hidden', ...clip.style, transform: flipTransform(e) }}>
      {defs}
      {e.assetId ? img : <PendingImage e={e} ctx={ctx} />}
      {e.border ? (
        clip.path ? (
          <PathStroke
            path={clip.path}
            stroke={e.border}
            w={e.frame.w}
            h={e.frame.h}
            clipId={domId(reactId, 'border')}
          />
        ) : (
          <BoxStroke stroke={e.border} radius={clip.radius} />
        )
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Shape

const EMPTY_TEXT = { paragraphs: [] };

/** Text inside a shape keeps clear of the outline, like other editors' default insets. */
const SHAPE_TEXT_PADDING = { top: 8, right: 16, bottom: 8, left: 16 };

function shapePath(e: ShapeElement): ShapePath {
  const { w, h } = e.frame;
  const g = e.geometry;
  if (g.kind === 'path')
    return {
      d: scalePath(g.d, w / g.viewBox.w, h / g.viewBox.h),
      closed: /z\s*$/i.test(g.d.trim()),
    };
  return presetPath(g.preset, w, h, g.adjust) ?? (presetPath('rect', w, h) as ShapePath);
}

/**
 * The fill layer of a path, clipped to it. A path may reach past the frame (a speech bubble's tail):
 * then the layer grows to the path's bounds, since a layer cannot paint outside itself.
 */
function pathFillStyle(d: string, w: number, h: number): CSSProperties {
  const b = pathBounds(d);
  const left = Math.min(0, b.x);
  const top = Math.min(0, b.y);
  const right = Math.max(w, b.x + b.w);
  const bottom = Math.max(h, b.y + b.h);
  if (left === 0 && top === 0 && right === w && bottom === h) return { clipPath: `path('${d}')` };
  return {
    inset: 'auto',
    left,
    top,
    width: right - left,
    height: bottom - top,
    clipPath: `path('${transformPath(d, 1, 1, -left, -top)}')`,
  };
}

function ShapeView({ element: e }: { element: ShapeElement }) {
  const ctx = useRenderContext();
  // A shape without text still takes the editor, to add text to it (SHP-04).
  const slotted = ctx.textSlot?.(e);
  const reactId = useId();
  const { w, h } = e.frame;
  const g = e.geometry;
  let geometry: ReactNode;
  if (g.kind === 'preset' && isBoxPreset(g.preset)) {
    const radius =
      g.preset === 'ellipse'
        ? '50%'
        : g.preset === 'roundRect'
          ? num(Math.min(Math.max(g.adjust?.[0] ?? 0.1667, 0), 0.5) * Math.min(w, h), 3)
          : e.effects?.radius;
    const accent = e.accent;
    let layers: ReactNode;
    // The corners cut the layers of a box. A box that is one with its outline has its own
    // corners, and cut a second time they would be smoothed twice.
    let cut = true;
    if (bordersItsFill(e)) {
      const box: CSSProperties = {
        boxSizing: 'border-box',
        border: `${e.stroke.width}px ${e.stroke.dash ?? 'solid'} ${colorCss(e.stroke.color)}`,
        borderRadius: radius,
        // A gradient covers the whole box, under the border, as it does on a layer of its own.
        backgroundOrigin: 'border-box',
      };
      layers =
        e.fill.kind === 'none' ? (
          <div aria-hidden style={{ ...FILL_PARENT, pointerEvents: 'none', ...box }} />
        ) : (
          <FillLayer fill={e.fill} ctx={ctx} style={box} />
        );
      cut = false;
    } else if (followsCorners(accent)) {
      // The fill and the borders are one box, as they are on a page: a gradient is then laid
      // out inside the borders and shows through them, as the page's own background does. An
      // image fill has an opacity of its own, which the borders must not take.
      const sides = { ...borderSides(e.stroke, accent), borderRadius: radius };
      layers =
        e.fill.kind === 'none' || e.fill.kind === 'image' ? (
          <>
            <FillLayer fill={e.fill} ctx={ctx} />
            <div aria-hidden style={{ ...FILL_PARENT, pointerEvents: 'none', ...sides }} />
          </>
        ) : (
          <FillLayer fill={e.fill} ctx={ctx} style={sides} />
        );
    } else {
      layers = (
        <>
          <FillLayer fill={e.fill} ctx={ctx} />
          {accent ? (
            <AccentBand accent={accent} inset={e.stroke?.width ?? 0} radius={radius} ctx={ctx} />
          ) : null}
          {e.stroke ? <BoxStroke stroke={e.stroke} radius={radius} /> : null}
        </>
      );
    }
    geometry = (
      <div
        style={{
          ...FILL_PARENT,
          ...(cut ? { overflow: 'hidden', borderRadius: radius } : {}),
          transform: flipTransform(e),
        }}
      >
        {layers}
      </div>
    );
  } else {
    const path = shapePath(e);
    geometry = (
      <div style={{ ...FILL_PARENT, transform: flipTransform(e) }}>
        {path.closed ? (
          <FillLayer fill={e.fill} ctx={ctx} style={pathFillStyle(path.d, w, h)} />
        ) : null}
        {e.stroke ? (
          <PathStroke path={path} stroke={e.stroke} w={w} h={h} clipId={domId(reactId, 'stroke')} />
        ) : null}
      </div>
    );
  }
  return (
    <>
      {geometry}
      {e.content || slotted !== undefined ? (
        // A gradient fill of the text is a background of the text's own box: the shape's fill
        // lies over the box of the element.
        <div style={{ ...FILL_PARENT, ...textFillStyle(e.css) }}>
          <TextBox
            content={e.content ?? EMPTY_TEXT}
            vAlign="middle"
            padding={e.padding ?? SHAPE_TEXT_PADDING}
            autoFit="none"
          >
            {slotted}
          </TextBox>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Line

type Head = LineElement['startHead'];

/** Size of a line head in slide pixels: four times the stroke, never smaller than 10. */
function headSize(stroke: Stroke): number {
  return Math.max(10, stroke.width * 4);
}

function moveToward(from: Point, to: Point, amount: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return from;
  const d = Math.min(amount, len * 0.9);
  return { x: from.x + (dx / len) * d, y: from.y + (dy / len) * d };
}

/** The line ends where a filled triangle head starts, so the stroke does not poke past its tip. */
function trimForHeads(points: Point[], e: LineElement): Point[] {
  const size = headSize(e.stroke);
  const out = [...points];
  const n = out.length;
  const horizontalEnds = e.curve !== 'straight' && n === 2;
  const toward = (end: number, next: number): Point => {
    const p = out[end] as Point;
    const q = out[next] as Point;
    // Elbow and curved lines leave their ends horizontally.
    return horizontalEnds ? moveToward(p, { x: q.x, y: p.y }, size) : moveToward(p, q, size);
  };
  if (e.startHead === 'triangle') out[0] = toward(0, 1);
  if (e.endHead === 'triangle') out[n - 1] = toward(n - 1, n - 2);
  return out;
}

export function linePath(points: readonly Point[], curve: LineElement['curve']): string {
  const p = points.map((pt) => ({ x: num(pt.x, 2), y: num(pt.y, 2) }));
  const first = p[0] as Point;
  const last = p[p.length - 1] as Point;
  if (curve === 'elbow') {
    if (p.length === 2) {
      const mx = num((first.x + last.x) / 2, 2);
      return `M${first.x} ${first.y} H${mx} V${last.y} H${last.x}`;
    }
    return `M${first.x} ${first.y} ${p
      .slice(1)
      .map((pt) => `H${pt.x} V${pt.y}`)
      .join(' ')}`;
  }
  if (curve === 'curved') {
    if (p.length === 2) {
      const mx = num((first.x + last.x) / 2, 2);
      return `M${first.x} ${first.y} C${mx} ${first.y} ${mx} ${last.y} ${last.x} ${last.y}`;
    }
    // Catmull-Rom through every point, as cubic Béziers.
    let d = `M${first.x} ${first.y}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] ?? p[i]!;
      const p1 = p[i]!;
      const p2 = p[i + 1]!;
      const p3 = p[i + 2] ?? p2;
      const c1 = { x: num(p1.x + (p2.x - p0.x) / 6, 2), y: num(p1.y + (p2.y - p0.y) / 6, 2) };
      const c2 = { x: num(p2.x - (p3.x - p1.x) / 6, 2), y: num(p2.y - (p3.y - p1.y) / 6, 2) };
      d += ` C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
    }
    return d;
  }
  return `M${first.x} ${first.y} ${p
    .slice(1)
    .map((pt) => `L${pt.x} ${pt.y}`)
    .join(' ')}`;
}

function HeadMarker({
  id,
  head,
  stroke,
}: {
  id: string;
  head: Exclude<Head, 'none'>;
  stroke: Stroke;
}) {
  const s = headSize(stroke);
  const color = colorCss(stroke.color);
  const filled = { fill: color, stroke: 'none' };
  let shape: ReactNode;
  let refX = s / 2;
  switch (head) {
    case 'triangle':
      // The path stops at the base (see trimForHeads), so the base sits on the end point.
      shape = <path d={`M0 0 L${s} ${s / 2} L0 ${s} Z`} style={filled} />;
      refX = 0;
      break;
    case 'arrow':
      shape = (
        <path
          d={`M${s * 0.15} ${s * 0.1} L${s} ${s / 2} L${s * 0.15} ${s * 0.9}`}
          style={{
            fill: 'none',
            stroke: color,
            strokeWidth: stroke.width,
            strokeLinejoin: 'miter',
            strokeLinecap: 'butt',
          }}
        />
      );
      refX = s;
      break;
    case 'circle':
      shape = <circle cx={s / 2} cy={s / 2} r={s / 2} style={filled} />;
      break;
    case 'diamond':
      shape = <path d={`M0 ${s / 2} L${s / 2} 0 L${s} ${s / 2} L${s / 2} ${s} Z`} style={filled} />;
      break;
    case 'bar':
      shape = (
        <rect x={s / 2 - stroke.width / 2} y={0} width={stroke.width} height={s} style={filled} />
      );
      break;
  }
  return (
    <marker
      id={id}
      viewBox={`0 0 ${s} ${s}`}
      markerWidth={s}
      markerHeight={s}
      markerUnits="userSpaceOnUse"
      refX={refX}
      refY={s / 2}
      orient="auto-start-reverse"
      overflow="visible"
    >
      {shape}
    </marker>
  );
}

function LineView({ element: e }: { element: LineElement }) {
  const reactId = useId();
  const startId = domId(reactId, 'start');
  const endId = domId(reactId, 'end');
  const d = linePath(trimForHeads(e.points, e), e.curve);
  return (
    <svg
      aria-hidden
      width={Math.max(e.frame.w, 1)}
      height={Math.max(e.frame.h, 1)}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        overflow: 'visible',
        transform: flipTransform(e),
      }}
    >
      {e.startHead !== 'none' || e.endHead !== 'none' ? (
        <defs>
          {e.startHead !== 'none' ? (
            <HeadMarker id={startId} head={e.startHead} stroke={e.stroke} />
          ) : null}
          {e.endHead !== 'none' ? (
            <HeadMarker id={endId} head={e.endHead} stroke={e.stroke} />
          ) : null}
        </defs>
      ) : null}
      <path
        d={d}
        markerStart={e.startHead !== 'none' ? `url(#${startId})` : undefined}
        markerEnd={e.endHead !== 'none' ? `url(#${endId})` : undefined}
        style={{
          fill: 'none',
          stroke: colorCss(e.stroke.color),
          strokeWidth: e.stroke.width,
          strokeDasharray: dashArray(e.stroke),
          strokeLinecap: e.stroke.cap ?? (e.stroke.dash === 'dotted' ? 'round' : 'butt'),
          strokeLinejoin: e.stroke.join ?? 'round',
        }}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// SVG

/** How many cleaned pictures `preparedSvg` keeps. */
const PREPARED_SVGS = 64;
/** Cleaned pictures by their markup, and by their colours under it; the latest used last. */
const preparedSvgs = new Map<string, Map<string, DocumentFragment>>();

/**
 * The picture of a markup cleaned and recoloured (`prepareSvg`), kept between the slides that
 * draw it and between the times a slide is drawn: cleaning a large picture took milliseconds, and
 * a step to another slide cleaned it again. The nodes kept here are not to be drawn or changed:
 * whoever draws the picture draws a copy of them (`cloneNode`, the very nodes that were cleaned).
 */
function preparedSvg(markup: string, overrides: SvgElement['colorOverrides']): DocumentFragment {
  const colours = overrides && Object.keys(overrides).length ? JSON.stringify(overrides) : '';
  let byColours = preparedSvgs.get(markup);
  if (byColours) preparedSvgs.delete(markup);
  else byColours = new Map();
  preparedSvgs.set(markup, byColours);
  if (preparedSvgs.size > PREPARED_SVGS) {
    const oldest = preparedSvgs.keys().next();
    if (!oldest.done) preparedSvgs.delete(oldest.value);
  }
  let picture = byColours.get(colours);
  if (!picture) {
    picture = prepareSvg(markup, overrides);
    byColours.set(colours, picture);
  }
  return picture;
}

/**
 * The picture of an `svg` element, in a shadow root of its own, like the content of an `html`
 * element. The nodes that were cleaned are the nodes that are drawn (`prepareSvg`); a stylesheet
 * and the ids inside the picture stay inside it, and the page's own styles do not reach in.
 * The theme's variables and the colour of the text around it do, by inheritance. The root is
 * serializable, so an export writes it out as a declarative shadow root.
 */
function SvgPicture({ e, style }: { e: SvgElement; style: CSSProperties }) {
  const host = useRef<HTMLDivElement>(null);
  const {
    markup,
    colorOverrides,
    stretch,
    frame: { w, h },
  } = e;
  // Cleaned and sized as the slide is drawn, so a slide drawn ahead and hidden (`Activity`) has
  // its pictures ready before it is shown, when only this effect runs.
  const prepared = useMemo(
    () => preparedSvg(markup ?? '', colorOverrides),
    [markup, colorOverrides],
  );
  // Only a picture that stretches is drawn for the size of its frame: any other is scaled to it,
  // and a resize leaves it as it is.
  const sw = stretch ? w : 0;
  const sh = stretch ? h : 0;
  const picture = useMemo(() => {
    const copy = prepared.cloneNode(true) as DocumentFragment;
    return stretch ? stretchSvg(copy, stretch, { w: sw, h: sh }) : copy;
  }, [prepared, stretch, sw, sh]);
  /** The picture the shadow root holds. */
  const drawn = useRef<DocumentFragment | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // A slide shown again after it was hidden runs this again, with the picture still in place.
    if (el.shadowRoot && drawn.current === picture) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open', serializable: true });
    root.replaceChildren(picture);
    drawn.current = picture;
  }, [picture]);
  return <div ref={host} data-slidr-svg="" style={style} />;
}

function SvgView({ element: e }: { element: SvgElement }) {
  const ctx = useRenderContext();
  const style: CSSProperties = { ...FILL_PARENT, transform: flipTransform(e) };
  if (e.markup && e.layout) {
    // Laid out in a box of its own units, and drawn at its scale (`artworkLayout`), as the
    // artwork of a frame is.
    const { scale, box } = artworkLayout(e.layout, e.frame);
    return (
      <div style={style}>
        <SvgPicture
          e={e}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: num(box.w, 3),
            height: num(box.h, 3),
            transform: `scale(${num(scale, 6)})`,
            transformOrigin: '0 0',
          }}
        />
      </div>
    );
  }
  if (e.markup) return <SvgPicture e={e} style={style} />;
  // An SVG asset is drawn as an image. Its colours cannot be overridden that way (SHP-06, WG5-T10).
  const url = e.assetId ? ctx.assetUrl(e.assetId) : undefined;
  return url ? (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{
        ...style,
        display: 'block',
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        border: 0,
      }}
    />
  ) : null;
}

// ---------------------------------------------------------------------------------------------
// HTML

/**
 * HTML without scripts, in a shadow root: its stylesheet stays inside, the slide's theme variables
 * and text style reach in by inheritance (RND-06, RND-08). The root is serializable, so an export
 * can write it out as a declarative shadow root.
 */
function ShadowContent({ e, style }: { e: HtmlElement; style: CSSProperties }) {
  const ctx = useRenderContext();
  const host = useRef<HTMLDivElement>(null);
  // The host that edits the text of this element in place, if one does (HTM-03).
  const editing = ctx.htmlSlot?.(e);
  const attached = useRef<{ editing: HtmlEditing; detach: () => void } | null>(null);
  // What the content is built from. The host may ask for it to be built again long after the
  // render that handed it over, and gets the element as it is then.
  const latest = useRef({ e, ctx });
  useLayoutEffect(() => {
    latest.current = { e, ctx };
  });
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const build = () => {
      const now = latest.current;
      attached.current?.detach();
      attached.current = null;
      const root = el.shadowRoot ?? el.attachShadow({ mode: 'open', serializable: true });
      const fragment = parseFragment(now.e.markup);
      // Paired now, while the two trees still have one shape: cleaning takes nodes out of one.
      const source = editing ? (fragment.cloneNode(true) as DocumentFragment) : undefined;
      const sources = source ? pairNodes(fragment, source) : undefined;
      sanitizeFragment(fragment);
      resolveAssetRefs(fragment, now.ctx);
      root.replaceChildren();
      if (now.e.styles) {
        const sheet = document.createElement('style');
        sheet.textContent = resolveAssetUrls(now.e.styles, now.ctx);
        root.append(sheet);
      }
      root.append(fragment);
      if (editing && source && sources) {
        const detach = editing.attach(root, source, (node) => sources.get(node), build);
        attached.current = { editing, detach };
      }
    };
    // The host typed this markup into the content itself: the content is already it.
    if (editing && attached.current?.editing === editing && editing.shows(e.markup)) return;
    build();
  }, [e.markup, e.styles, ctx, editing]);
  useEffect(
    () => () => {
      attached.current?.detach();
      attached.current = null;
    },
    [],
  );
  return <div ref={host} data-slidr-html="shadow" style={style} />;
}

/** Every node of a tree with the node at the same place in a tree of the same shape. */
function pairNodes(tree: Node, twin: Node, pairs = new WeakMap<Node, Node>()): WeakMap<Node, Node> {
  pairs.set(tree, twin);
  tree.childNodes.forEach((child, i) => {
    const other = twin.childNodes[i];
    if (other) pairNodes(child, other, pairs);
  });
  return pairs;
}

function FrameContent({ e, style }: { e: HtmlElement; style: CSSProperties }) {
  const ctx = useRenderContext();
  // What the document is written from, and nothing else of the element: a new document loads the
  // frame again and runs its scripts from the start, and a move gives the element a new object
  // for every frame of the drag.
  const { markup, styles } = e;
  const { w, h } = e.natural ?? e.frame;
  const doc = useMemo(
    () => frameDocument({ markup, styles }, ctx, { w, h }),
    [markup, styles, ctx, w, h],
  );
  return (
    <iframe
      data-slidr-html="frame"
      title={e.name ?? 'HTML'}
      // Never same-origin: the frame cannot reach the editor or Tauri (SEC-03). Thumbnails do not run scripts.
      sandbox={ctx.mode === 'thumbnail' ? '' : 'allow-scripts'}
      srcDoc={doc}
      loading="eager"
      style={{
        ...style,
        border: 0,
        display: 'block',
        background: 'transparent',
        colorScheme: 'normal',
      }}
    />
  );
}

function HtmlView({ element: e }: { element: HtmlElement }) {
  const ctx = useRenderContext();
  // Laid out at its natural size and scaled to the frame, never reflowed (ADR-005).
  const natural = e.natural ?? { w: e.frame.w, h: e.frame.h };
  const sx = natural.w ? e.frame.w / natural.w : 1;
  const sy = natural.h ? e.frame.h / natural.h : 1;
  const content: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: natural.w,
    height: natural.h,
    margin: 0,
    padding: 0,
    transformOrigin: '0 0',
    transform: sx !== 1 || sy !== 1 ? `scale(${num(sx, 6)}, ${num(sy, 6)})` : undefined,
    // While its text is edited in place the pointer reaches the content, for the caret.
    pointerEvents: interactive(ctx) || ctx.htmlSlot?.(e) ? 'auto' : 'none',
  };
  return (
    <div style={{ ...FILL_PARENT, transform: flipTransform(e) }}>
      {e.hasScripts ? (
        <FrameContent e={e} style={content} />
      ) : (
        <ShadowContent e={e} style={content} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Video and audio

/*
 * A media element only carries what its clip is (`clip.ts`): where it starts and ends, whether it
 * goes round, whether it starts by itself. Nothing here plays it. In a show and in an exported
 * file the runtime's player does; in the editor the media tools do, with the same code.
 */

function useVolume(ref: RefObject<HTMLMediaElement | null>, volume: number) {
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [ref, volume]);
}

function VideoView({ element: e }: { element: VideoElement }) {
  const ctx = useRenderContext();
  const ref = useRef<HTMLVideoElement>(null);
  useVolume(ref, e.volume);
  const url = ctx.assetUrl(e.assetId);
  const present = ctx.mode === 'present';
  const poster = e.poster && 'assetId' in e.poster ? ctx.assetUrl(e.poster.assetId) : undefined;
  return (
    <video
      ref={ref}
      // In a show the player puts the video at its poster; elsewhere nothing runs, and the
      // address itself asks the browser for the still frame.
      src={url ? (present ? url : videoSource(e, url)) : undefined}
      poster={poster}
      // Outside a show a video is silent unless the editor plays it in place.
      muted={e.muted || !present}
      loop={nativeLoop(e)}
      playsInline
      preload="metadata"
      {...clipAttributes(e)}
      style={{
        ...FILL_PARENT,
        display: 'block',
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        background: '#000',
        transform: flipTransform(e),
        pointerEvents: present ? 'auto' : 'none',
        // In a show a click plays and pauses it.
        cursor: present ? 'pointer' : undefined,
      }}
    />
  );
}

function AudioView({ element: e }: { element: AudioElement }) {
  const ctx = useRenderContext();
  const ref = useRef<HTMLAudioElement>(null);
  useVolume(ref, e.volume);
  const url = ctx.assetUrl(e.assetId);
  const present = ctx.mode === 'present';
  const controls = present && e.showControls;
  // A sound has no picture of its own. In the editor it shows as a mark; in a show the mark is
  // there only for a sound that waits to be clicked and has no controls to click.
  const marked = !present || showsMark(e);
  const size = Math.min(e.frame.h * 0.5, 48);
  return (
    <>
      {marked && (
        <div
          data-slidr-placeholder="audio"
          {...{ [CLIP_TOGGLE_ATTRIBUTE]: '' }}
          role={present ? 'button' : undefined}
          aria-label={present ? e.name : undefined}
          style={{
            ...FILL_PARENT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: Math.min(e.frame.h / 2, 32),
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-primary)',
            pointerEvents: present ? 'auto' : undefined,
            cursor: present ? 'pointer' : undefined,
          }}
        >
          <Icon name="audio" size={size} />
        </div>
      )}
      {/* A thumbnail never plays: it draws the mark alone. */}
      {ctx.mode !== 'thumbnail' && (
        <audio
          ref={ref}
          src={url}
          controls={controls}
          loop={nativeLoop(e)}
          // The editor reads the file only when the sound is played in place.
          preload={present ? 'metadata' : 'none'}
          {...clipAttributes(e)}
          style={
            controls
              ? { ...FILL_PARENT, display: 'block', width: '100%', height: '100%' }
              : { display: 'none' }
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Group and dispatch

function GroupView({ element: e, decoration }: { element: GroupElement; decoration: boolean }) {
  return (
    <div style={{ ...FILL_PARENT, transform: flipTransform(e) }}>
      {e.children.map((child) => (
        <ElementView key={child.id} element={child} decoration={decoration} />
      ))}
    </div>
  );
}

function inner(e: Element, decoration: boolean): ReactNode {
  switch (e.type) {
    case 'text':
      return <TextView element={e} />;
    case 'image':
      return <ImageView element={e} />;
    case 'shape':
      return <ShapeView element={e} />;
    case 'line':
      return <LineView element={e} />;
    case 'svg':
      return <SvgView element={e} />;
    case 'group':
      return <GroupView element={e} decoration={decoration} />;
    case 'table':
      return <TableView element={e} />;
    case 'chart':
      return <ChartView element={e} />;
    case 'video':
      return <VideoView element={e} />;
    case 'audio':
      return <AudioView element={e} />;
    case 'html':
      return <HtmlView element={e} />;
  }
}

/**
 * One element and everything inside it. Memoised on the element object: the model keeps the
 * identity of elements a change did not touch (ADR-007), so an edit re-renders only what it changed.
 *
 * The root carries `data-element-id` and `data-element-type`; hit-testing, lint, the animation
 * runtime and capture find elements by them. Layout decorations carry `data-decoration-id`
 * instead, so they are not picked as slide content.
 */
export const ElementView = memo(function ElementView({
  element,
  decoration = false,
}: {
  element: Element;
  decoration?: boolean;
}) {
  const ctx = useRenderContext();
  if (element.hidden) return null;
  // A link to an address that is not opened where the slide is shown is no link there: the
  // element is not marked as one, so a click on it is a click on the slide.
  const link =
    element.link &&
    (element.link.kind === 'slide' || (ctx.opensLink ?? opensAddress)(element.link.target))
      ? element.link
      : undefined;
  const ids = decoration
    ? { 'data-decoration-id': element.id }
    : { 'data-element-id': element.id, 'data-element-type': element.type };
  const rendered = (
    <div
      {...ids}
      data-name={element.name}
      data-link-kind={link?.kind}
      data-link-target={link?.target}
      // In a show an element with a link is a stop of Tab, and Enter on it follows it (UI-06).
      {...(link && ctx.mode === 'present' && !decoration ? { tabIndex: 0, role: 'link' } : {})}
      style={{
        ...boxStyle(element),
        ...passthroughStyle(element.css),
        ...textStrokeStyle(element.css),
      }}
    >
      {inner(element, decoration)}
    </div>
  );
  return ctx.slot && !decoration ? <>{ctx.slot(element, rendered)}</> : rendered;
});
