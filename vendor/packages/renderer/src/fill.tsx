import type { Background, Fill } from '@slidr/model';
import { memo, type CSSProperties } from 'react';
import type { RenderContext } from './context';
import { cssUrl, num } from './css';
import { colorCss } from './theme';

type Stops = Extract<Fill, { kind: 'linear' }>['stops'];

function stopsCss(stops: Stops): string {
  return stops.map((s) => `${colorCss(s.color)} ${num(s.at * 100, 2)}%`).join(', ');
}

function centerCss(center: { x: number; y: number } | undefined): string {
  return center ? `${num(center.x * 100, 2)}% ${num(center.y * 100, 2)}%` : 'center';
}

const IMAGE_SIZE = { cover: 'cover', contain: 'contain', fill: '100% 100%', tile: 'auto' } as const;

/**
 * A fill as CSS background properties. Angles follow CSS: 0deg points up, clockwise. An image
 * fill's `opacity` is not here: a background has no opacity of its own, so `FillLayer` puts it on
 * the layer.
 */
export function fillStyle(fill: Fill, ctx: RenderContext): CSSProperties {
  switch (fill.kind) {
    case 'none':
      return {};
    case 'solid':
      return { backgroundColor: colorCss(fill.color) };
    case 'linear':
      return { backgroundImage: `linear-gradient(${num(fill.angle)}deg, ${stopsCss(fill.stops)})` };
    case 'radial':
      return {
        backgroundImage: `radial-gradient(ellipse at ${centerCss(fill.center)}, ${stopsCss(fill.stops)})`,
      };
    case 'conic':
      return {
        backgroundImage: `conic-gradient(from ${num(fill.angle)}deg at ${centerCss(fill.center)}, ${stopsCss(fill.stops)})`,
      };
    case 'image': {
      const url = ctx.assetUrl(fill.assetId);
      if (!url) return {};
      return {
        backgroundImage: cssUrl(url),
        backgroundSize: IMAGE_SIZE[fill.fit],
        backgroundPosition: 'center',
        backgroundRepeat: fill.fit === 'tile' ? 'repeat' : 'no-repeat',
      };
    }
    case 'css':
      return { background: fill.value };
  }
}

const LAYER: CSSProperties = { position: 'absolute', inset: 0, margin: 0, padding: 0 };

/** A fill painted on its own absolutely positioned layer. */
export function FillLayer({
  fill,
  ctx,
  style,
}: {
  fill: Fill;
  ctx: RenderContext;
  style?: CSSProperties;
}) {
  if (fill.kind === 'none') return null;
  const opacity = fill.kind === 'image' ? fill.opacity : undefined;
  // Keyed by kind: React warns when a re-render swaps `background` for `backgroundColor`.
  return (
    <div
      key={fill.kind}
      aria-hidden
      style={{
        ...LAYER,
        ...fillStyle(fill, ctx),
        ...(opacity !== undefined ? { opacity } : {}),
        ...style,
      }}
    />
  );
}

/**
 * A slide background (SLD-03): the fill, then for photos a blur and a dimming veil, then the
 * overlay. A blurred layer is extended past the slide's edges, so the blur does not fade them.
 */
export const BackgroundLayers = memo(function BackgroundLayers({
  background,
  ctx,
}: {
  background: Background;
  ctx: RenderContext;
}) {
  const blur = background.blur ?? 0;
  const bleed = blur > 0 ? -2 * blur : 0;
  return (
    <div data-slidr-background aria-hidden style={{ ...LAYER, overflow: 'hidden' }}>
      <FillLayer
        fill={background.fill}
        ctx={ctx}
        style={blur > 0 ? { inset: bleed, filter: `blur(${blur}px)` } : undefined}
      />
      {background.dim ? (
        <div style={{ ...LAYER, backgroundColor: `rgba(0, 0, 0, ${num(background.dim, 3)})` }} />
      ) : null}
      {background.overlay ? <FillLayer fill={background.overlay} ctx={ctx} /> : null}
    </div>
  );
});
