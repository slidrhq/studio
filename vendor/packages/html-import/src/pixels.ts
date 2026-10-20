/**
 * Comparing two pictures of the same region (ADR-005). Plain typed arrays, no DOM, so the
 * thresholds are tested in Node. A picture is RGBA, row by row.
 */

export interface Picture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Averages blocks of `factor` x `factor` pixels. Edge noise of boxes and glyphs averages out. */
export function downsample(picture: Picture, factor: number): Picture {
  if (factor === 1) return picture;
  const width = Math.floor(picture.width / factor);
  const height = Math.floor(picture.height / factor);
  const data = new Uint8ClampedArray(width * height * 4);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < factor; j++) {
        let i = ((y * factor + j) * picture.width + x * factor) * 4;
        for (let n = 0; n < factor; n++, i += 4) {
          r += picture.data[i]!;
          g += picture.data[i + 1]!;
          b += picture.data[i + 2]!;
          a += picture.data[i + 3]!;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / area;
      data[o + 1] = g / area;
      data[o + 2] = b / area;
      data[o + 3] = a / area;
    }
  }
  return { width, height, data };
}

/**
 * Which pixels differ, as a mask of 0 and 1. The distance is the perceptual one of the YIQ
 * colour space (Kotsarenko and Ramos), and `threshold` is 0..1 of its largest value: 0.1 lets
 * rendering noise through, 0.03 still sees a light grey card move on white.
 */
export function differingPixels(a: Picture, b: Picture, threshold: number): Uint8Array {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const mask = new Uint8Array(width * height);
  const limit = 35215 * threshold * threshold;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const dr = a.data[i]! - b.data[j]!;
      const dg = a.data[i + 1]! - b.data[j + 1]!;
      const db = a.data[i + 2]! - b.data[j + 2]!;
      if (dr === 0 && dg === 0 && db === 0) continue;
      const dy = 0.29889531 * dr + 0.58662247 * dg + 0.11448223 * db;
      const di = 0.59597799 * dr - 0.2741761 * dg - 0.32180189 * db;
      const dq = 0.21147017 * dr - 0.52261711 * dg + 0.31114694 * db;
      if (0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq > limit) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Whether every pixel is the same colour, within a step or two of rounding. */
export function uniformColor(picture: Picture): { r: number; g: number; b: number } | undefined {
  const d = picture.data;
  for (let i = 4; i < d.length; i += 4) {
    if (
      Math.abs(d[i]! - d[0]!) > 2 ||
      Math.abs(d[i + 1]! - d[1]!) > 2 ||
      Math.abs(d[i + 2]! - d[2]!) > 2
    ) {
      return undefined;
    }
  }
  return { r: d[0]!, g: d[1]!, b: d[2]! };
}

export interface Ownership {
  /** The region each pixel belongs to: its index, -1 for none, -2 for a pixel not judged. */
  owner: Int32Array;
  /** Pixels each region owns. */
  owned: Int32Array;
  /** Differing pixels among them. */
  differing: Int32Array;
  /** Differing pixels no region owns, as indexes into the mask. */
  loose: number[];
  /** Every differing pixel that is judged, as indexes into the mask. */
  all: number[];
}

/**
 * Says whose pixels differ. A pixel belongs to the last region that covers it (regions come
 * in paint order, so that is the one on top). The outermost ring is not judged: the picture
 * is cut on whole pixels and the slide rarely is, so the edge row mixes the slide with
 * whatever lies outside it. Pixels inside `ignored` boxes are not judged either.
 *
 * `leaves`: whether a region leaves a pixel to the region under it. What shows through a
 * region is the look of what lies under it, and a difference there is judged as that is.
 */
export function attribute(
  mask: Uint8Array,
  width: number,
  height: number,
  regions: readonly Box[],
  ignored: readonly Box[] = [],
  leaves?: (above: number, under: number) => boolean,
): Ownership {
  const owner = new Int32Array(width * height).fill(-1);
  const paint = (box: Box, value: number) => {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(width, Math.ceil(box.x + box.w));
    const y1 = Math.min(height, Math.ceil(box.y + box.h));
    if (x1 <= x0) return;
    for (let y = y0; y < y1; y++) {
      if (!leaves || value < 0) {
        owner.fill(value, y * width + x0, y * width + x1);
        continue;
      }
      for (let i = y * width + x0; i < y * width + x1; i++) {
        const under = owner[i]!;
        if (under < 0 || !leaves(value, under)) owner[i] = value;
      }
    }
  };
  regions.forEach((box, index) => paint(box, index));
  for (const box of ignored) paint(box, -2);

  const owned = new Int32Array(regions.length);
  const differing = new Int32Array(regions.length);
  const loose: number[] = [];
  const all: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const o = owner[i]!;
      if (o === -2) continue;
      if (o >= 0) owned[o]!++;
      if (mask[i] === 0) continue;
      all.push(i);
      if (o >= 0) differing[o]!++;
      else loose.push(i);
    }
  }
  return { owner, owned, differing, loose, all };
}

/**
 * For every region, how many blocks of `size` x `size` pixels differ in their average colour by
 * more than `threshold` (the distance of `differingPixels`). A block counts for the region
 * that owns nearly all of it, and the average is taken over that region's pixels alone: what a
 * neighbour drew in the rest is the neighbour's to answer for.
 *
 * What this measure is for: a difference that sits in one place of a text, whatever the size of
 * the text around it. Counting pixels cannot tell that from noise, since glyphs whose edges
 * fall on the other side of a pixel change pixels all along a text. An average over a block
 * can: a glyph that moved by a pixel carries at most a strip one pixel wide across a side of
 * the block, which changes the average by no more than 1 / `size` of the contrast, while a
 * word in another colour, a line drawn over it or text that is not there changes it by the
 * share of the block they cover. With `threshold` above 1 / `size`, the first is never counted.
 *
 * The same content drawn a little to the side is not what is asked about here either (where
 * things sit is for the geometry of lines, and for the shares of pixels, to say): a block that
 * differs is compared again with the other picture moved by up to `reach` pixels each way, and
 * counts only when it differs at every one of those places.
 */
export function differingBlocks(
  a: Picture,
  b: Picture,
  owner: Int32Array,
  regions: number,
  size: number,
  threshold: number,
  reach = 1,
): Int32Array {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const counts = new Int32Array(regions);
  const limit = 35215 * threshold * threshold;
  const enough = 0.75 * size * size;
  /** How far the block's average is from the other picture's, moved by (sx, sy). */
  const distance = (
    left: number,
    top: number,
    o: number,
    sx: number,
    sy: number,
  ): number | undefined => {
    let n = 0;
    let dr = 0;
    let dg = 0;
    let db = 0;
    for (let y = top; y < top + size; y++) {
      const v = y + sy;
      if (v < 0 || v >= height) continue;
      for (let x = left; x < left + size; x++) {
        const u = x + sx;
        if (u < 0 || u >= width || owner[y * width + x] !== o) continue;
        const i = (y * a.width + x) * 4;
        const j = (v * b.width + u) * 4;
        dr += a.data[i]! - b.data[j]!;
        dg += a.data[i + 1]! - b.data[j + 1]!;
        db += a.data[i + 2]! - b.data[j + 2]!;
        n++;
      }
    }
    // A block that is mostly someone else's, or mostly off the picture, says nothing.
    if (n < enough) return undefined;
    dr /= n;
    dg /= n;
    db /= n;
    const dy = 0.29889531 * dr + 0.58662247 * dg + 0.11448223 * db;
    const di = 0.59597799 * dr - 0.2741761 * dg - 0.32180189 * db;
    const dq = 0.21147017 * dr - 0.52261711 * dg + 0.31114694 * db;
    return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
  };
  for (let top = 0; top + size <= height; top += size) {
    for (let left = 0; left + size <= width; left += size) {
      const o = owner[(top + (size >> 1)) * width + left + (size >> 1)]!;
      if (o < 0) continue;
      const here = distance(left, top, o, 0, 0);
      if (here === undefined || here <= limit) continue;
      let elsewhere = false;
      for (let sy = -reach; sy <= reach && !elsewhere; sy++) {
        for (let sx = -reach; sx <= reach && !elsewhere; sx++) {
          if (sx === 0 && sy === 0) continue;
          const there = distance(left, top, o, sx, sy);
          elsewhere = there !== undefined && there <= limit;
        }
      }
      if (!elsewhere) counts[o]!++;
    }
  }
  return counts;
}

/**
 * Groups differing pixels that lie near each other, so that one difference is reported once,
 * with the box around it. `cell` is the grid the pixels are bucketed in. With `owner`, each
 * group also names the region most of its pixels belong to (-1: none).
 */
export function clusters(
  pixels: readonly number[],
  width: number,
  cell: number,
  owner?: Int32Array,
): { pixels: number; box: Box; owner: number }[] {
  const cells = new Map<string, number>();
  const owners = new Map<string, Map<number, number>>();
  for (const i of pixels) {
    const key = `${Math.floor((i % width) / cell)},${Math.floor(i / width / cell)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
    if (owner) {
      const counts = owners.get(key) ?? new Map<number, number>();
      owners.set(key, counts);
      counts.set(owner[i]!, (counts.get(owner[i]!) ?? 0) + 1);
    }
  }
  const seen = new Set<string>();
  const found: { pixels: number; box: Box; owner: number }[] = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    let count = 0;
    const votes = new Map<number, number>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    while (stack.length > 0) {
      const key = stack.pop()!;
      const [cx, cy] = key.split(',').map(Number) as [number, number];
      count += cells.get(key)!;
      for (const [o, n] of owners.get(key) ?? []) votes.set(o, (votes.get(o) ?? 0) + n);
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const next = `${cx + dx},${cy + dy}`;
          if (cells.has(next) && !seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
    }
    let most = -1;
    let mostVotes = 0;
    for (const [o, n] of votes) {
      if (n > mostVotes) {
        most = o;
        mostVotes = n;
      }
    }
    found.push({
      pixels: count,
      owner: most,
      box: {
        x: minX * cell,
        y: minY * cell,
        w: (maxX - minX + 1) * cell,
        h: (maxY - minY + 1) * cell,
      },
    });
  }
  return found;
}
