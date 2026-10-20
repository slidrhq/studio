import type { AssetMeta, Frame } from '@slidr/model';
import { slideArea } from '../geometry';
import type { Problem, Rule } from '../rule';

/** A picture may be drawn up to this many times its own resolution before it looks soft. */
export const MAX_ENLARGE = 1.5;
/** Width and height stretched by factors further apart than this are a distorted picture. */
const DISTORTED = 0.05;

const VECTOR = /svg/i;

interface Drawn {
  /** Slide pixels per pixel of the picture, along each axis. */
  x: number;
  y: number;
}

/** How large the visible part of a picture is drawn in a frame, by the way it is fitted. */
function drawn(
  asset: AssetMeta,
  frame: Pick<Frame, 'w' | 'h'>,
  fit: 'cover' | 'contain' | 'fill' | 'tile',
  crop?: { w: number; h: number },
): Drawn | undefined {
  // A drawing has no resolution to outgrow, and a picture of unknown size cannot be judged.
  if (!asset.width || !asset.height || VECTOR.test(asset.mime) || fit === 'tile') return undefined;
  const w = asset.width * (crop?.w ?? 1);
  const h = asset.height * (crop?.h ?? 1);
  if (w <= 0 || h <= 0 || frame.w <= 0 || frame.h <= 0) return undefined;
  const x = frame.w / w;
  const y = frame.h / h;
  if (fit === 'fill') return { x, y };
  const k = fit === 'cover' ? Math.max(x, y) : Math.min(x, y);
  return { x: k, y: k };
}

function describe(what: string, asset: AssetMeta, frame: Pick<Frame, 'w' | 'h'>, scale: Drawn) {
  const size = `${asset.width}x${asset.height}px`;
  const at = `${Math.round(frame.w)}x${Math.round(frame.h)}`;
  const problems: string[] = [];
  const most = Math.max(scale.x, scale.y);
  if (most > MAX_ENLARGE) {
    problems.push(
      `${what} is drawn at ${Math.round(most * 100)}% of its resolution (a ${size} picture in a ${at} frame; up to ${MAX_ENLARGE * 100}% holds), so it looks soft. Use a larger picture or a smaller frame.`,
    );
  }
  if (Math.abs(scale.x / scale.y - 1) > DISTORTED) {
    problems.push(
      `${what} is stretched: its width is drawn at ${Math.round(scale.x * 100)}% and its height at ${Math.round(scale.y * 100)}% (a ${size} picture in a ${at} frame). Fit it with "cover" or "contain", or give the frame the picture's proportions.`,
    );
  }
  return problems;
}

/**
 * L12: a picture enlarged past 150% of its resolution, or drawn out of proportion. Pictures on
 * the slide, and the slide's own background picture.
 */
export const L12: Rule = {
  id: 'L12',
  severity: 'warning',
  agent: false,
  check({ deck, slide, items }) {
    const problems: Problem[] = [];
    for (const { element } of items) {
      if (element.type !== 'image' || !element.assetId) continue;
      const asset = deck.assets[element.assetId];
      const scale = asset && drawn(asset, element.frame, element.fit, element.crop);
      if (!asset || !scale) continue;
      for (const message of describe('The picture', asset, element.frame, scale)) {
        problems.push({ elementIds: [element.id], message });
      }
    }
    const fill = slide.background?.fill;
    if (fill?.kind === 'image') {
      const asset = deck.assets[fill.assetId];
      const whole = slideArea(deck);
      const scale = asset && drawn(asset, whole, fill.fit);
      if (asset && scale) {
        for (const message of describe("The slide's background picture", asset, whole, scale)) {
          problems.push({ elementIds: [], message });
        }
      }
    }
    return problems;
  },
};
