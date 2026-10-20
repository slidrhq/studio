/** Additional editable shape presets. Each entry has its own path and a library label. */
type Group = 'basic' | 'polygons' | 'arrows' | 'callouts';
type Point = readonly [number, number];

export interface ExtraShape {
  group: Group;
  w: number;
  h: number;
  en: string;
  he: string;
  draw: (w: number, h: number) => string;
}

const shapes: Record<string, ExtraShape> = {};
const num = (value: number) => String(Math.round(value * 100) / 100);
const path = (points: readonly Point[]) =>
  `${points.map(([x, y], i) => `${i ? 'L' : 'M'}${num(x)} ${num(y)}`).join(' ')} Z`;
const scaled = (points: readonly Point[], w: number, h: number) =>
  path(points.map(([x, y]) => [x * w, y * h]));
const add = (id: string, shape: ExtraShape) => {
  shapes[id] = shape;
};
const radial = (count: number, radius: (point: number) => number, w: number, h: number) => {
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = radius(i);
    points.push([r * Math.cos(angle), r * Math.sin(angle)]);
  }
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const rangeX = Math.max(...xs) - minX;
  const rangeY = Math.max(...ys) - minY;
  return path(points.map(([x, y]) => [((x - minX) / rangeX) * w, ((y - minY) / rangeY) * h]));
};

// Polygons, stars, sunbursts, gears and lobed seals have different outlines.
for (const sides of [9, ...Array.from({ length: 16 }, (_, i) => i + 11)]) {
  add(`polygon${sides}`, {
    group: 'polygons',
    w: 360,
    h: 360,
    en: `${sides}-sided polygon`,
    he: `מצולע בעל ${sides} צלעות`,
    draw: (w, h) => radial(sides, () => 1, w, h),
  });
}
for (const points of [3, 7, 9, 10, 11, ...Array.from({ length: 12 }, (_, i) => i + 13)]) {
  add(`star${points}`, {
    group: 'polygons',
    w: 360,
    h: 360,
    en: `${points}-point star`,
    he: `כוכב בעל ${points} קודקודים`,
    draw: (w, h) => radial(points * 2, (i) => (i % 2 ? 0.48 : 1), w, h),
  });
}
for (let rays = 4; rays <= 18; rays++) {
  add(`sunburst${rays}`, {
    group: 'polygons',
    w: 360,
    h: 360,
    en: `${rays}-ray sunburst`,
    he: `קרני שמש ${rays}`,
    draw: (w, h) => radial(rays * 2, (i) => (i % 2 ? 0.72 : 1), w, h),
  });
}
for (let teeth = 6; teeth <= 20; teeth++) {
  add(`gear${teeth}`, {
    group: 'polygons',
    w: 360,
    h: 360,
    en: `${teeth}-tooth gear`,
    he: `גלגל שיניים עם ${teeth} שיניים`,
    draw: (w, h) => radial(teeth * 4, (i) => (i % 4 === 0 || i % 4 === 3 ? 0.79 : 1), w, h),
  });
}
for (let lobes = 6; lobes <= 20; lobes++) {
  add(`seal${lobes}`, {
    group: 'polygons',
    w: 360,
    h: 360,
    en: `${lobes}-lobe seal`,
    he: `חותם בעל ${lobes} אונות`,
    draw: (w, h) => radial(lobes * 4, (i) => (i % 4 === 0 ? 0.88 : 1), w, h),
  });
}

const directions = [
  { id: 'Right', en: 'right', he: 'ימינה' },
  { id: 'Left', en: 'left', he: 'שמאלה' },
  { id: 'Up', en: 'up', he: 'למעלה' },
  { id: 'Down', en: 'down', he: 'למטה' },
] as const;
const arrowStyles = [
  { id: 'Thin', en: 'thin', he: 'דק', shaft: 0.24, head: 0.32, notch: 0 },
  { id: 'Wide', en: 'wide', he: 'רחב', shaft: 0.72, head: 0.38, notch: 0 },
  { id: 'Long', en: 'long-head', he: 'ראש ארוך', shaft: 0.34, head: 0.62, notch: 0 },
  { id: 'Notched', en: 'notched', he: 'מחורץ', shaft: 0.56, head: 0.4, notch: 0.18 },
] as const;
for (const direction of directions)
  for (const style of arrowStyles) {
    add(`arrow${style.id}${direction.id}`, {
      group: 'arrows',
      w: direction.id === 'Up' || direction.id === 'Down' ? 240 : 480,
      h: direction.id === 'Up' || direction.id === 'Down' ? 480 : 240,
      en: `${style.en} arrow ${direction.en}`,
      he: `חץ ${style.he} ${direction.he}`,
      draw: (w, h) => {
        const p: Point[] = [
          [0, 0.5 - style.shaft / 2],
          [1 - style.head, 0.5 - style.shaft / 2],
          [1 - style.head, 0],
          [1, 0.5],
          [1 - style.head, 1],
          [1 - style.head, 0.5 + style.shaft / 2],
          [0, 0.5 + style.shaft / 2],
        ];
        if (style.notch) p.push([style.notch, 0.5]);
        return scaled(
          p.map(([x, y]) =>
            direction.id === 'Right'
              ? [x, y]
              : direction.id === 'Left'
                ? [1 - x, y]
                : direction.id === 'Down'
                  ? [y, x]
                  : [y, 1 - x],
          ),
          w,
          h,
        );
      },
    });
  }

// The side the tail is on first, then where along it: a tail at the bottom near the left and
// one on the left near the bottom are two shapes, and the Hebrew named both "on the left, below".
const tails = [
  { id: 'BottomLeft', en: 'bottom left', he: 'בתחתית, משמאל', side: 'bottom', pos: 0.25 },
  { id: 'BottomRight', en: 'bottom right', he: 'בתחתית, מימין', side: 'bottom', pos: 0.75 },
  { id: 'TopLeft', en: 'top left', he: 'בראש, משמאל', side: 'top', pos: 0.25 },
  { id: 'TopRight', en: 'top right', he: 'בראש, מימין', side: 'top', pos: 0.75 },
  { id: 'LeftTop', en: 'left top', he: 'בצד שמאל, למעלה', side: 'left', pos: 0.25 },
  { id: 'LeftBottom', en: 'left bottom', he: 'בצד שמאל, למטה', side: 'left', pos: 0.75 },
  { id: 'RightTop', en: 'right top', he: 'בצד ימין, למעלה', side: 'right', pos: 0.25 },
  { id: 'RightBottom', en: 'right bottom', he: 'בצד ימין, למטה', side: 'right', pos: 0.75 },
] as const;
for (const tail of tails)
  for (const rounded of [false, true]) {
    add(`bubble${rounded ? 'Round' : 'Square'}${tail.id}`, {
      group: 'callouts',
      w: 480,
      h: 320,
      en: `${rounded ? 'Rounded' : 'Square'} bubble, tail ${tail.en}`,
      he: `בועה ${rounded ? 'מעוגלת' : 'מרובעת'} עם זנב ${tail.he}`,
      draw: (w, h) => {
        const side = tail.side;
        const left = side === 'left' ? 0.2 : 0;
        const right = side === 'right' ? 0.8 : 1;
        const top = side === 'top' ? 0.2 : 0;
        const bottom = side === 'bottom' ? 0.8 : 1;
        const x = left + (right - left) * tail.pos;
        const y = top + (bottom - top) * tail.pos;
        const r = rounded ? 0.08 : 0;
        const base = 0.12;
        const p = (px: number, py: number) => `${num(px * w)} ${num(py * h)}`;
        const line = (px: number, py: number) => `L${p(px, py)}`;
        const corner = (cx: number, cy: number, ex: number, ey: number) =>
          r ? `Q${p(cx, cy)} ${p(ex, ey)}` : line(ex, ey);
        return [
          `M${p(left + r, top)}`,
          side === 'top'
            ? `${line(x - base / 2, top)} ${line(x, 0)} ${line(x + base / 2, top)}`
            : '',
          line(right - r, top),
          corner(right, top, right, top + r),
          side === 'right'
            ? `${line(right, y - base / 2)} ${line(1, y)} ${line(right, y + base / 2)}`
            : '',
          line(right, bottom - r),
          corner(right, bottom, right - r, bottom),
          side === 'bottom'
            ? `${line(x + base / 2, bottom)} ${line(x, 1)} ${line(x - base / 2, bottom)}`
            : '',
          line(left + r, bottom),
          corner(left, bottom, left, bottom - r),
          side === 'left'
            ? `${line(left, y + base / 2)} ${line(0, y)} ${line(left, y - base / 2)}`
            : '',
          line(left, top + r),
          corner(left, top, left + r, top),
          'Z',
        ]
          .filter(Boolean)
          .join(' ');
      },
    });
  }

for (let fold = 1; fold <= 8; fold++) {
  const depth = 0.04 + fold * 0.025;
  add(`ribbon${fold}`, {
    group: 'basic',
    w: 480,
    h: 240,
    en: `Ribbon ${fold}`,
    he: `סרט ${fold}`,
    draw: (w, h) =>
      scaled(
        [
          [0, 0],
          [1, 0],
          [1 - depth, 0.5],
          [1, 1],
          [0, 1],
          [depth, 0.5],
        ],
        w,
        h,
      ),
  });
}
for (let waves = 1; waves <= 8; waves++) {
  add(`waveBanner${waves}`, {
    group: 'basic',
    w: 480,
    h: 240,
    en: `${waves}-wave banner`,
    he: `כרזה גלית עם ${waves} גלים`,
    draw: (w, h) => {
      let d = `M0 ${num(h * 0.12)}`;
      for (let i = 0; i < waves; i++) {
        const start = (i * w) / waves;
        const end = ((i + 1) * w) / waves;
        d += ` Q${num(start + w / waves / 2)} ${num(i % 2 ? h * 0.02 : h * 0.22)} ${num(end)} ${num(h * 0.12)}`;
      }
      d += ` L${num(w)} ${num(h * 0.88)}`;
      for (let i = waves - 1; i >= 0; i--) {
        const start = ((i + 1) * w) / waves;
        const end = (i * w) / waves;
        d += ` Q${num(start - w / waves / 2)} ${num(i % 2 ? h * 0.78 : h * 0.98)} ${num(end)} ${num(h * 0.88)}`;
      }
      return `${d} Z`;
    },
  });
}

const flowcharts: readonly [string, string, string, (w: number, h: number) => string][] = [
  [
    'document',
    'Document',
    'מסמך',
    (w, h) =>
      `M0 0 H${num(w)} V${num(h * 0.82)} Q${num(w * 0.75)} ${num(h * 0.65)} ${num(w * 0.5)} ${num(h * 0.82)} T0 ${num(h * 0.82)} Z`,
  ],
  [
    'delay',
    'Delay',
    'השהיה',
    (w, h) =>
      `M0 0 H${num(w * 0.62)} A${num(w * 0.38)} ${num(h / 2)} 0 0 1 ${num(w * 0.62)} ${num(h)} H0 Z`,
  ],
  [
    'storedData',
    'Stored data',
    'נתונים שמורים',
    (w, h) =>
      `M${num(w * 0.15)} 0 H${num(w)} Q${num(w * 0.72)} ${num(h / 2)} ${num(w)} ${num(h)} H${num(w * 0.15)} Q${num(-w * 0.15)} ${num(h / 2)} ${num(w * 0.15)} 0 Z`,
  ],
  [
    'manualInput',
    'Manual input',
    'קלט ידני',
    (w, h) =>
      scaled(
        [
          [0, 0.2],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        w,
        h,
      ),
  ],
  [
    'preparation',
    'Preparation',
    'הכנה',
    (w, h) =>
      scaled(
        [
          [0.2, 0],
          [0.8, 0],
          [1, 0.5],
          [0.8, 1],
          [0.2, 1],
          [0, 0.5],
        ],
        w,
        h,
      ),
  ],
  [
    'internalStorage',
    'Internal storage',
    'אחסון פנימי',
    (w, h) =>
      scaled(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0.15, 1],
          [0.15, 0.18],
          [0, 0.18],
        ],
        w,
        h,
      ),
  ],
  [
    'card',
    'Punched card',
    'כרטיס מנוקב',
    (w, h) =>
      scaled(
        [
          [0, 0],
          [0.8, 0],
          [1, 0.2],
          [1, 1],
          [0, 1],
        ],
        w,
        h,
      ),
  ],
  [
    'offPage',
    'Off-page connector',
    'מחבר בין דפים',
    (w, h) =>
      scaled(
        [
          [0, 0],
          [1, 0],
          [1, 0.7],
          [0.5, 1],
          [0, 0.7],
        ],
        w,
        h,
      ),
  ],
];
for (const [id, en, he, draw] of flowcharts)
  add(`flow${id[0]!.toUpperCase()}${id.slice(1)}`, {
    group: 'basic',
    w: 420,
    h: 300,
    en,
    he,
    draw,
  });

for (const angle of [30, 60, 90, 120, 150, 180, 210, 270]) {
  add(`pie${angle}`, {
    group: 'basic',
    w: 360,
    h: 360,
    en: `${angle}° pie sector`,
    he: `פלח עיגול ${angle}°`,
    draw: (w, h) => {
      const r = Math.min(w, h) / 2;
      const end = ((-90 + angle) * Math.PI) / 180;
      return `M${num(w / 2)} ${num(h / 2)} L${num(w / 2)} ${num(h / 2 - r)} A${num(r)} ${num(r)} 0 ${angle > 180 ? 1 : 0} 1 ${num(w / 2 + r * Math.cos(end))} ${num(h / 2 + r * Math.sin(end))} Z`;
    },
  });
}

for (let width = 1; width <= 7; width++) {
  const t = 0.05 + width * 0.035;
  add(`diagonalCross${width}`, {
    group: 'basic',
    w: 360,
    h: 360,
    en: `Diagonal cross ${width}`,
    he: `צלב אלכסוני ${width}`,
    draw: (w, h) =>
      scaled(
        [
          [0, t],
          [t, 0],
          [0.5, 0.5 - t],
          [1 - t, 0],
          [1, t],
          [0.5 + t, 0.5],
          [1, 1 - t],
          [1 - t, 1],
          [0.5, 0.5 + t],
          [t, 1],
          [0, 1 - t],
          [0.5 - t, 0.5],
        ],
        w,
        h,
      ),
  });
}

export const extraShapes: Readonly<Record<string, ExtraShape>> = shapes;
