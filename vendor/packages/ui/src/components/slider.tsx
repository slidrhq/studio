import type { CSSProperties } from 'react';
import { Slider as RadixSlider } from 'radix-ui';
import { cx } from '../cx';

export interface SliderProps {
  value: number;
  /** Every step of a drag. */
  onValueChange: (value: number) => void;
  /** The end of a drag or a key press: the place to close an undo step. */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Names the slider for screen readers. */
  'aria-label': string;
  disabled?: boolean;
  /** Fixes the direction, for a track that is physical (a hue strip) rather than a quantity. */
  dir?: 'ltr' | 'rtl';
  /** Paints the track, e.g. with a gradient; the filled range is then left out. */
  trackStyle?: CSSProperties;
  className?: string;
}

/** A single-value slider. It follows the direction of the UI: the minimum is at the start. */
export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  dir,
  trackStyle,
  className,
  ...aria
}: SliderProps) {
  return (
    <RadixSlider.Root
      value={[value]}
      onValueChange={([next]) => next !== undefined && onValueChange(next)}
      onValueCommit={([next]) => next !== undefined && onValueCommit?.(next)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      {...(dir ? { dir } : {})}
      className={cx(
        'relative flex h-control-sm w-full touch-none items-center select-none data-disabled:opacity-50',
        className,
      )}
    >
      <RadixSlider.Track
        style={trackStyle}
        className={cx(
          'relative grow rounded-full',
          trackStyle ? 'h-3 border border-ui-line' : 'h-1 bg-ui-line-strong',
        )}
      >
        {!trackStyle && <RadixSlider.Range className="absolute h-full rounded-full bg-ui-accent" />}
      </RadixSlider.Track>
      <RadixSlider.Thumb
        aria-label={aria['aria-label']}
        className="block size-4 cursor-default rounded-full border border-ui-line-strong bg-ui-thumb shadow-raised transition-colors hover:border-ui-fg-subtle focus-visible:outline-offset-1"
      />
    </RadixSlider.Root>
  );
}
