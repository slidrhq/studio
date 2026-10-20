import type { CSSProperties } from 'react';

/**
 * The few glyphs the renderer itself draws: on placeholders that wait for content. Strokes follow
 * the Lucide grid (24 units, 2-unit stroke) so they match the app's icons.
 */
const PATHS = {
  image:
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M21 15l-5-5L5 21 M9 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  chart: 'M3 3v18h18 M7 16v-4 M12 16V8 M17 16v-7',
  audio: 'M11 5 6 9H2v6h4l5 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14',
} as const;

export type PlaceholderIcon = keyof typeof PATHS;

export function Icon({
  name,
  size,
  style,
}: {
  name: PlaceholderIcon;
  size: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{
        display: 'block',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...style,
      }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
