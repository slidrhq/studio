import { ToggleGroup } from 'radix-ui';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';
import { Tooltip } from './tooltip';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Show only the icon; the label becomes the tooltip and the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Names the group for screen readers. */
  'aria-label': string;
  size?: 'sm' | 'md';
  /** Stretch the segments over the full width. */
  fill?: boolean;
  disabled?: boolean;
  /**
   * Fixes the direction, for segments that are physical (arrows, left and right) rather than a
   * sequence: with `ltr` the first option is on the left in every UI language.
   */
  dir?: 'ltr' | 'rtl';
  className?: string;
}

/**
 * One choice out of a few, all visible: a track with a raised thumb on the selected segment. It
 * follows the direction of the UI: the first option is at the start.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size = 'md',
  fill = false,
  disabled = false,
  dir,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      // Radix sends '' when the selected segment is clicked again; a segmented control keeps it.
      onValueChange={(next) => next && onValueChange(next as T)}
      disabled={disabled}
      // Radix writes it on the element too, so the segments are laid out and the arrow keys
      // move in that direction.
      {...(dir ? { dir } : {})}
      aria-label={aria['aria-label']}
      className={cx(
        'inline-flex items-stretch gap-0.5 rounded-control bg-ui-field p-0.5',
        size === 'md' ? 'h-control' : 'h-control-sm',
        fill && 'flex w-full',
        className,
      )}
    >
      {options.map((option) => {
        const item = (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            aria-label={option.iconOnly ? option.label : undefined}
            className={cx(
              'inline-flex cursor-default items-center justify-center gap-1.5 rounded-inset text-sm font-medium whitespace-nowrap text-ui-fg-muted transition-colors select-none',
              'hover:text-ui-fg focus-visible:outline-offset-0 disabled:text-ui-fg-subtle',
              // By `aria-checked`, not `data-state`: the tooltip of an icon-only segment writes
              // its own `data-state` on the same element.
              'aria-checked:bg-ui-thumb aria-checked:text-ui-fg aria-checked:shadow-raised',
              option.iconOnly ? 'aspect-square' : 'px-2.5',
              fill && 'flex-1',
            )}
          >
            {option.icon && <Icon icon={option.icon} />}
            {!option.iconOnly && option.label}
          </ToggleGroup.Item>
        );
        return option.iconOnly ? (
          <Tooltip key={option.value} content={option.label}>
            {item}
          </Tooltip>
        ) : (
          item
        );
      })}
    </ToggleGroup.Root>
  );
}
