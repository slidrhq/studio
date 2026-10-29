import { useId, type ComponentPropsWithRef } from 'react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cx } from '../cx';

export interface CheckboxProps extends Omit<
  ComponentPropsWithRef<typeof RadixCheckbox.Root>,
  'children' | 'asChild' | 'checked' | 'defaultChecked' | 'onCheckedChange'
> {
  /** `'mixed'` is a selection that has both: a dash, and a click checks it. */
  checked: boolean | 'mixed';
  onCheckedChange: (checked: boolean) => void;
  /** The text beside the box, and the accessible name. A click on it checks too. */
  label: string;
  /** A second line under the label. */
  hint?: string;
}

/**
 * A box to tick, with its label: one option that is on or off, in a form or a list of options.
 * The whole row is the control, so the label is part of the target and of the focus ring.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hint,
  className,
  ...props
}: CheckboxProps) {
  const id = useId();
  const on = checked !== false;
  return (
    <RadixCheckbox.Root
      checked={checked === 'mixed' ? 'indeterminate' : checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className={cx(
        'group inline-flex min-w-0 cursor-default items-start gap-2 rounded-small text-start text-sm text-ui-fg select-none disabled:text-ui-fg-subtle',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cx(
          // The box sits on the first line of the label, which is 20px tall.
          'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-small border transition-colors',
          on
            ? 'border-transparent bg-ui-accent text-ui-on-accent group-hover:bg-ui-accent-hover group-active:bg-ui-accent-pressed group-disabled:border-ui-line group-disabled:bg-ui-field group-disabled:text-ui-fg-subtle'
            : 'border-ui-fg-muted group-hover:border-ui-fg group-active:bg-ui-pressed group-disabled:border-ui-fg-subtle',
        )}
      >
        {/* Smaller and heavier than an icon of a toolbar: it is the mark of a 16px box. */}
        {checked === 'mixed' ? (
          <Minus size={12} strokeWidth={3} />
        ) : (
          checked && <Check size={12} strokeWidth={3} />
        )}
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
    </RadixCheckbox.Root>
  );
}
