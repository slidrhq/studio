import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../cx';
import { Field } from './field';
import { Icon, type LucideIcon } from './icon';

export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** Leading icon, e.g. a magnifier on a search field. */
  icon?: LucideIcon;
  /** Shows the error state; set `aria-describedby` to the message. */
  invalid?: boolean;
  /** Something at the end of the field, such as a unit or a clear button. */
  end?: ReactNode;
  /** Classes for the frame (the element with the border), e.g. its width. */
  className?: string;
  /** Forces a state for the component gallery, as on every other component (theme.css). */
  'data-preview'?: string;
}

/** A single-line text field. The frame carries the focus ring, so the icon sits inside it. */
export function Input({
  icon,
  invalid = false,
  end,
  className,
  type = 'text',
  'data-preview': preview,
  ...props
}: InputProps) {
  return (
    <div
      data-preview={preview}
      className={cx(
        'flex h-control items-center gap-2 rounded-control border bg-ui-field px-2.5 text-sm text-ui-fg transition-colors',
        'focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ui-focus',
        // Faded when the field itself is disabled, and not when a control beside it in the frame is.
        'has-[>input:disabled]:border-ui-line has-[>input:disabled]:text-ui-fg-subtle',
        invalid
          ? 'border-ui-danger-fg focus-within:outline-ui-danger-fg'
          : 'border-ui-line-strong hover:border-ui-fg-subtle',
        className,
      )}
    >
      {icon && <Icon icon={icon} className="text-ui-fg-muted" />}
      <input
        type={type}
        aria-invalid={invalid || undefined}
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ui-fg-muted focus-visible:outline-none disabled:placeholder:text-ui-fg-subtle"
        {...props}
      />
      {end}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputProps, 'invalid'> {
  label: string;
  /** Guidance under the field. */
  hint?: string;
  /** An error message replaces the hint and marks the field invalid. */
  error?: string;
}

/** An input with its label and a hint or error line: a `Field` around an `Input`. */
export function TextField({ label, hint, error, id, className, ...props }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={className}>
      <Input
        id={inputId}
        invalid={Boolean(error)}
        aria-describedby={(error ?? hint) ? `${inputId}-message` : undefined}
        {...props}
      />
    </Field>
  );
}
