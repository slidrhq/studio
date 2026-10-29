import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  /** Shows the error state; set `aria-describedby` to the message. */
  invalid?: boolean;
  /** A row under the text, inside the frame: the buttons of a composer, a character count. */
  footer?: ReactNode;
  /** Classes for the frame (the element with the border), e.g. its width. */
  className?: string;
}

/**
 * A text field of several lines that grows with what is typed into it: one line when empty,
 * taller with every line, and scrolling once it reaches its limit. The frame carries the focus
 * ring, so a footer sits inside it, as the icon of an `Input` does.
 */
export function Textarea({
  invalid = false,
  footer,
  className,
  rows = 1,
  ...props
}: TextareaProps) {
  return (
    <div
      className={cx(
        'flex flex-col gap-1 rounded-panel border bg-ui-field p-1.5 text-ui-fg transition-colors',
        'focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ui-focus',
        // Faded when the field itself is disabled, and not when a button of the footer is: a
        // composer whose Send has nothing to send yet is still a field to type in.
        'has-[>textarea:disabled]:border-ui-line has-[>textarea:disabled]:text-ui-fg-subtle',
        invalid
          ? 'border-ui-danger-fg focus-within:outline-ui-danger-fg'
          : 'border-ui-line-strong hover:border-ui-fg-subtle',
        className,
      )}
    >
      <textarea
        rows={rows}
        aria-invalid={invalid || undefined}
        // No colour of its own: the frame's, which fades when the field is disabled.
        className="field-sizing-content max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-1.5 text-md leading-6 outline-none placeholder:text-ui-fg-muted focus-visible:outline-none disabled:placeholder:text-ui-fg-subtle"
        {...props}
      />
      {footer}
    </div>
  );
}
