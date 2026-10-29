import { useId, type ComponentPropsWithRef } from 'react';
import { Switch as RadixSwitch } from 'radix-ui';
import { cx } from '../cx';

export interface SwitchProps extends Omit<
  ComponentPropsWithRef<typeof RadixSwitch.Root>,
  'children' | 'asChild' | 'checked' | 'defaultChecked' | 'onCheckedChange'
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The text beside the switch, and the accessible name. A click on it switches too. */
  label: string;
  /** A second line under the label. */
  hint?: string;
  /**
   * Where the switch sits. `start`: before its label, as a checkbox does. `end`: the label
   * first and the switch at the far end of the row, which then takes the full width: a row of
   * settings.
   */
  side?: 'start' | 'end';
}

/**
 * A setting that is on or off and takes effect at once, with its label. Off is an outline with
 * a muted thumb, on is the accent: the two differ in more than where the thumb is. The whole row
 * is the control, as in `Checkbox`.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  side = 'start',
  className,
  ...props
}: SwitchProps) {
  const id = useId();
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className={cx(
        'group min-w-0 cursor-default items-start gap-2 rounded-small text-start text-sm text-ui-fg select-none disabled:text-ui-fg-subtle',
        side === 'start' ? 'inline-flex' : 'flex w-full flex-row-reverse justify-between',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cx(
          // The track sits on the first line of the label, which is 20px tall.
          'mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors',
          checked
            ? 'border-transparent bg-ui-accent group-hover:bg-ui-accent-hover group-active:bg-ui-accent-pressed group-disabled:border-ui-line group-disabled:bg-ui-field'
            : 'border-ui-fg-muted group-hover:border-ui-fg group-active:bg-ui-pressed group-disabled:border-ui-fg-subtle',
        )}
      >
        {/* Moved by its margin, a logical property: in an RTL UI it travels the other way. */}
        <RadixSwitch.Thumb
          className={cx(
            'block size-2.5 rounded-full transition-[margin,background-color] group-disabled:bg-ui-fg-subtle',
            checked ? 'ms-3.5 bg-ui-on-accent' : 'ms-0.5 bg-ui-fg-muted group-hover:bg-ui-fg',
          )}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span id={`${id}-label`}>{label}</span>
        {hint && (
          <span
            id={`${id}-hint`}
            className="text-xs text-ui-fg-muted group-disabled:text-ui-fg-subtle"
          >
            {hint}
          </span>
        )}
      </span>
    </RadixSwitch.Root>
  );
}
