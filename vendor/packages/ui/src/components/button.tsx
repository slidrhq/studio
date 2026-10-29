import { useState, type ComponentPropsWithRef, type FocusEvent, type MouseEvent } from 'react';
import { cx } from '../cx';
import { Icon, type LucideIcon } from './icon';
import { Spinner } from './spinner';
import { Tooltip, type TooltipSide } from './tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger';
export type ButtonSize = 'sm' | 'md';

// A disabled button looks the same whether the browser disables it (`disabled`) or it keeps the
// keyboard until the focus leaves (`aria-disabled`, see `useKeepFocus`). A busy button takes no
// pointer, unless it opens something (see `opens`).
const base =
  'inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium select-none transition-colors disabled:pointer-events-none aria-disabled:pointer-events-none [&[aria-busy=true]:not([aria-haspopup])]:pointer-events-none';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-ui-accent text-ui-on-accent hover:bg-ui-accent-hover active:bg-ui-accent-pressed disabled:bg-ui-field disabled:text-ui-fg-subtle aria-disabled:bg-ui-field aria-disabled:text-ui-fg-subtle',
  secondary:
    'border border-ui-line-strong text-ui-fg hover:bg-ui-hover active:bg-ui-pressed disabled:border-ui-line disabled:text-ui-fg-subtle aria-disabled:border-ui-line aria-disabled:text-ui-fg-subtle',
  ghost:
    'text-ui-fg hover:bg-ui-hover active:bg-ui-pressed disabled:text-ui-fg-subtle aria-disabled:text-ui-fg-subtle',
  soft: 'bg-ui-accent-soft text-ui-accent-fg hover:bg-ui-accent-soft-hover active:bg-ui-accent-soft-hover disabled:bg-ui-field disabled:text-ui-fg-subtle aria-disabled:bg-ui-field aria-disabled:text-ui-fg-subtle',
  danger:
    'bg-ui-danger text-ui-on-danger hover:bg-ui-danger-hover active:bg-ui-danger-hover disabled:bg-ui-field disabled:text-ui-fg-subtle aria-disabled:bg-ui-field aria-disabled:text-ui-fg-subtle',
};

/**
 * Icon-only ghost buttons sit in toolbars: muted until hovered, like the text around them. One
 * that is a switch (`aria-pressed`) reads as selected when it is on, as a `Toggle` does.
 */
const quietGhost =
  'text-ui-fg-muted hover:bg-ui-hover hover:text-ui-fg active:bg-ui-pressed active:text-ui-fg disabled:text-ui-fg-subtle aria-disabled:text-ui-fg-subtle aria-pressed:bg-ui-accent-soft aria-pressed:text-ui-accent-fg aria-pressed:hover:bg-ui-accent-soft-hover';

/**
 * A button that becomes disabled while it has the keyboard keeps it until the focus leaves.
 * The browser would drop the focus of a disabled element to `<body>`, and the next Tab would
 * start again from the top of the window (measured after "Replace all", ADR-060). Until then
 * it is disabled in name (`aria-disabled`) and takes no click; once the focus is elsewhere it is
 * disabled for real, and leaves the order of Tab as a disabled button does.
 */
function useKeepFocus(
  disabled: boolean | undefined,
  onFocus: ButtonProps['onFocus'],
  onBlur: ButtonProps['onBlur'],
) {
  const [focused, setFocused] = useState(false);
  const holding = Boolean(disabled) && focused;
  return {
    holding,
    props: {
      /** Disabled for the browser: off while the button holds the focus. */
      disabled: Boolean(disabled) && !holding,
      'aria-disabled': holding || undefined,
      onFocus: (event: FocusEvent<HTMLButtonElement>) => {
        setFocused(true);
        onFocus?.(event);
      },
      onBlur: (event: FocusEvent<HTMLButtonElement>) => {
        setFocused(false);
        onBlur?.(event);
      },
    },
  };
}

const swallow = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

/**
 * What a busy button allows. It takes no press, whichever way the press comes: the pointer was
 * always kept off it, and Enter or Space pressed it all the same, so the work it was waiting for
 * could be started a second time from the keyboard alone.
 *
 * The one exception is a button that opens a menu or a popover (`aria-haspopup`, which a trigger
 * of this library sets). What it opens is where a way to stop the work can be, so it stays open
 * to the pointer as it already was to the keyboard, and its menu says what can be done meanwhile.
 */
const opens = (props: { 'aria-haspopup'?: unknown }) =>
  props['aria-haspopup'] !== undefined && props['aria-haspopup'] !== false;

const sizes: Record<ButtonSize, string> = {
  sm: 'h-control-sm px-2.5 text-sm',
  md: 'h-control px-3 text-sm',
};

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: LucideIcon;
  /** Trailing icon, e.g. a chevron on a menu button. */
  iconEnd?: LucideIcon;
  /**
   * Busy: shows a spinner in place of the leading icon and takes no press, from the pointer or
   * from the keyboard. A button that opens a menu or a popover still opens it.
   */
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  loading = false,
  className,
  children,
  type = 'button',
  disabled,
  onFocus,
  onBlur,
  onClick,
  ...props
}: ButtonProps) {
  const keep = useKeepFocus(disabled, onFocus, onBlur);
  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      className={cx(base, variants[variant], sizes[size], className)}
      {...props}
      {...keep.props}
      onClick={keep.holding || (loading && !opens(props)) ? swallow : onClick}
    >
      {loading ? <Spinner /> : icon && <Icon icon={icon} />}
      {children}
      {iconEnd && <Icon icon={iconEnd} className="-me-0.5 opacity-70" />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  icon: LucideIcon;
  /** The accessible name, also shown as the tooltip. */
  label: string;
  shortcut?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Flip the icon in right-to-left layouts (undo, redo, arrows). */
  mirror?: boolean;
  loading?: boolean;
  tooltipSide?: TooltipSide;
  /** Skip the tooltip, when the label is already visible nearby. */
  noTooltip?: boolean;
}

/** A square icon button with a tooltip. The label is required: an icon is not a name. */
export function IconButton({
  icon,
  label,
  shortcut,
  variant = 'ghost',
  size = 'md',
  mirror,
  loading = false,
  tooltipSide = 'bottom',
  noTooltip = false,
  className,
  type = 'button',
  disabled,
  onFocus,
  onBlur,
  onClick,
  ...props
}: IconButtonProps) {
  const keep = useKeepFocus(disabled, onFocus, onBlur);
  const button = (
    <button
      type={type}
      aria-label={label}
      aria-busy={loading || undefined}
      className={cx(
        base,
        variant === 'ghost' ? quietGhost : variants[variant],
        size === 'md' ? 'size-control' : 'size-control-sm',
        className,
      )}
      {...props}
      {...keep.props}
      onClick={keep.holding || (loading && !opens(props)) ? swallow : onClick}
    >
      {loading ? <Spinner /> : <Icon icon={icon} mirror={mirror} />}
    </button>
  );
  if (noTooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {/* A disabled button gets no pointer events; the wrapper still says what it is. One that
          holds the focus is not wrapped: a new parent would take the focus away. */}
      {keep.props.disabled ? <span className="inline-flex">{button}</span> : button}
    </Tooltip>
  );
}
