import { useId, type ReactNode } from 'react';
import { cx } from '../cx';

export interface FieldProps {
  label: string;
  /** Guidance under the control. */
  hint?: string;
  /** An error message replaces the hint. */
  error?: string;
  /**
   * The id of the control, when it is one a label can name (an input). A click on the label
   * then goes to it, and the message has the id `${htmlFor}-message`, for the control's
   * `aria-describedby`. Without it the field is a group that the label names, which suits a
   * control with a name of its own: a segmented control, a slider, a row of buttons.
   */
  htmlFor?: string;
  children: ReactNode;
  /** Classes for the field, e.g. its width. */
  className?: string;
}

/** A control under its label, with a hint or error line under it. */
export function Field({ label, hint, error, htmlFor, children, className }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const message = error ?? hint;
  const labelClass = 'text-xs font-medium text-ui-fg-muted';
  return (
    <div
      role={htmlFor ? undefined : 'group'}
      aria-labelledby={htmlFor ? undefined : `${id}-label`}
      aria-describedby={!htmlFor && message ? `${id}-message` : undefined}
      className={cx('flex min-w-0 flex-col gap-1.5', className)}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span id={`${id}-label`} className={labelClass}>
          {label}
        </span>
      )}
      {children}
      {message && (
        <p
          id={`${id}-message`}
          className={cx('text-xs', error ? 'text-ui-danger-fg' : 'text-ui-fg-muted')}
        >
          {message}
        </p>
      )}
    </div>
  );
}
